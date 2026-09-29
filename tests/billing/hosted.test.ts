// Hosted mode over real HTTP + WebSocket: one session per visitor, keys minted only against a
// reservation of the visitor's remaining time, and streams settled when they stop.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import type { ControlServerMessage, CreditView } from '../../src/shared/contracts';
import { fullCorpus } from '../helpers';

let app: FastifyInstance;
let base = '';
let origin = '';
let credits: CreditStore;
let hub: SessionHub;
let provider: WebSocketServer;
const minted: Array<{ max_session_duration_seconds: number; client_reference_id: string }> = [];

beforeAll(async () => {
  provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => provider.on('listening', r));
  const { corpus, ix } = fullCorpus();
  const resolver = new CommandResolver(corpus, null, null);
  credits = new CreditStore(':memory:', { freeSecondsPerMonth: 600, ipDailyFreeSeconds: 3600, globalDailyFreeSeconds: 36000, holdMaxSeconds: 300, holdMinSeconds: 20 });
  hub = new SessionHub(
    () =>
      new Session({
        corpus,
        ix,
        resolver,
        decisionClient: null,
        mode: 'deterministic',
        setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => 'unavailable' },
        overlayUrl: (v) => `${origin}/overlay#view=${v}`,
      }),
  );
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    minted.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ api_key: 'temp-key', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
  }) as unknown as typeof fetch;
  const port = 44170 + Math.floor(Math.random() * 500);
  ({ app } = await buildApp({ port, sonioxApiKey: 'server-key', fetchImpl, speechEndpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`, hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 7)) } }));
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
  origin = base;
});
afterAll(async () => {
  await app?.close();
  // Socket close handlers settle credits just after the server closes; let them finish first.
  await new Promise((r) => setTimeout(r, 200));
  credits?.close();
  await new Promise<void>((r) => provider.close(() => r()));
});

async function visit(): Promise<{ cookie: string; credits: CreditView }> {
  const r = await fetch(`${base}/api/me`, { headers: { origin } });
  const body = (await r.json()) as { mode: string; credits: CreditView };
  expect(body.mode).toBe('hosted');
  return { cookie: r.headers.get('set-cookie')!.split(';')[0], credits: body.credits };
}
const key = (cookie: string) => fetch(`${base}/api/soniox/temporary-key`, { method: 'POST', headers: { origin, cookie } });
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
async function audio(cookie: string) {
  const res = await key(cookie);
  expect(res.status).toBe(200);
  const config = await res.json() as { api_key: string; stt_ws_url: string };
  expect(config.api_key).not.toBe('temp-key');
  const count = minted.length;
  const ws = new WebSocket(config.stt_ws_url, { headers: { origin, cookie } });
  await new Promise<void>((r) => ws.on('open', r));
  ws.send(JSON.stringify({ api_key: config.api_key, audio_format: 'auto' }));
  await until(() => minted.length > count && provider.clients.size > 0);
  return ws;
}

describe('hosted service', () => {
  it('gives each visitor an identity, their own session and the free allowance', async () => {
    const a = await visit();
    const b = await visit();
    expect(a.cookie).not.toBe(b.cookie);
    expect(a.credits).toMatchObject({ available: 600, freePerMonth: 600, listeningSeconds: 0 });
    for (const v of [a, b]) expect((await fetch(`${base}/api/chapters`, { headers: { origin, cookie: v.cookie } })).status).toBe(200);
    expect(hub.size).toBe(2);
    // No cookie, no session; a forged cookie is not a visitor.
    expect((await fetch(`${base}/api/chapters`, { headers: { origin } })).status).toBe(401);
    expect((await fetch(`${base}/api/chapters`, { headers: { origin, cookie: 'qo_visitor=abcdefghijklmnopqrstuv.forged' } })).status).toBe(401);
    // The self-hosting owner link does not exist here.
    expect((await fetch(`${base}/api/owner/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{"token":"x"}' })).status).toBe(404);
  });

  it('keeps provider keys on the server and caps the actual relay stream', async () => {
    const v = await visit();
    const stream = await audio(v.cookie);
    expect(minted.at(-1)!.max_session_duration_seconds).toBe(300);
    stream.close();
    await until(() => provider.clients.size === 0);
  });

  it('charges only the time a stream ran once it stops, and pushes the balance to the page', async () => {
    const v = await visit();
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/control`, { headers: { origin, cookie: v.cookie } });
    const msgs: ControlServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on('open', () => r()));
    await until(() => msgs.some((m) => m.type === 'credits'));
    const epoch = Date.now();
    ws.send(JSON.stringify({ type: 'capture', captureEpoch: epoch, event: 'starting' }));
    const stream = await audio(v.cookie);
    ws.send(JSON.stringify({ type: 'capture', captureEpoch: epoch, event: 'recording' }));
    await new Promise((r) => setTimeout(r, 1200));
    ws.send(JSON.stringify({ type: 'capture', captureEpoch: epoch, event: 'stopped' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(provider.clients.size).toBe(1); // a fake client stop cannot refund a live connection
    stream.close();
    await until(() => {
      const last = msgs.filter((m): m is Extract<ControlServerMessage, { type: 'credits' }> => m.type === 'credits').at(-1);
      return !!last && last.credits.freeUsedThisMonth > 0 && last.credits.listeningSeconds === 0;
    });
    const last = msgs.filter((m): m is Extract<ControlServerMessage, { type: 'credits' }> => m.type === 'credits').at(-1)!;
    expect(last.credits.freeUsedThisMonth).toBeGreaterThanOrEqual(1);
    expect(last.credits.freeUsedThisMonth).toBeLessThanOrEqual(3);
    expect(last.credits.available).toBe(600 - last.credits.freeUsedThisMonth);
    ws.close();
  });

  it('stops charging while dozing (a long pause closed the stream) and keeps the session listening', async () => {
    const v = await visit();
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/control`, { headers: { origin, cookie: v.cookie } });
    const msgs: ControlServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on('open', () => r()));
    await until(() => msgs.some((m) => m.type === 'credits'));
    const epoch = Date.now();
    ws.send(JSON.stringify({ type: 'capture', captureEpoch: epoch, event: 'starting' }));
    const stream = await audio(v.cookie);
    ws.send(JSON.stringify({ type: 'capture', captureEpoch: epoch, event: 'recording' }));
    await new Promise((r) => setTimeout(r, 1200));
    ws.send(JSON.stringify({ type: 'capture', captureEpoch: epoch, event: 'dozing' }));
    stream.close();
    const credits = () => msgs.filter((m): m is Extract<ControlServerMessage, { type: 'credits' }> => m.type === 'credits').at(-1)!.credits;
    await until(() => credits().freeUsedThisMonth > 0 && credits().listeningSeconds === 0);
    const used = credits().freeUsedThisMonth;
    expect(used).toBeLessThanOrEqual(3);
    // Nothing is charged while dozing.
    await new Promise((r) => setTimeout(r, 1500));
    expect(credits().freeUsedThisMonth).toBe(used);
    const snaps = msgs.filter((m): m is Extract<ControlServerMessage, { type: 'snapshot' }> => m.type === 'snapshot');
    expect(snaps.at(-1)!.snapshot.capture.phase).toBe('dozing');
    expect(snaps.at(-1)!.snapshot.phase).toBe('dozing');
    ws.close();
  });

  it('limits key requests per visitor, not for the whole service', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await key((await visit()).cookie)).status);
    expect(statuses).not.toContain(429);
  });

  it('keeps visitors apart: one visitor cannot see or drive another\'s session', async () => {
    const a = await visit();
    const b = await visit();
    const open = (cookie: string) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/control`, { headers: { origin, cookie } });
      const msgs: ControlServerMessage[] = [];
      ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
      return { ws, msgs, ready: new Promise<void>((r) => ws.on('open', () => r())) };
    };
    const ca = open(a.cookie);
    const cb = open(b.cookie);
    await Promise.all([ca.ready, cb.ready]);
    ca.ws.send(JSON.stringify({ type: 'goto', key: '36:1' }));
    await until(() => ca.msgs.some((m) => m.type === 'snapshot' && m.snapshot.display.verse?.key === '36:1'));
    await new Promise((r) => setTimeout(r, 200));
    expect(cb.msgs.some((m) => m.type === 'snapshot' && m.snapshot.display.verse?.key === '36:1')).toBe(false);
    ca.ws.close();
    cb.ws.close();
  });
});
