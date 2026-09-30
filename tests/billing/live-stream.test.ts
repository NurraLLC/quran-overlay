// Live on stream, through the real server: when a visitor's overlay link is open (OBS, a reading
// screen), their pages learn it at once, and talking with the audience between recitations never
// stops their listening; a visitor who is not live keeps the usual idle rule.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import type { ControlServerMessage } from '../../src/shared/contracts';
import { fullCorpus } from '../helpers';

let app: FastifyInstance;
let base = '';
let provider: WebSocketServer;
let credits: CreditStore;

beforeAll(async () => {
  // The recogniser stand-in accepts streams and never sends a result: nothing is heard as recitation.
  provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => provider.on('listening', r));
  const { corpus, ix } = fullCorpus();
  const resolver = new CommandResolver(corpus, null, null);
  credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 300, holdMinSeconds: 20, poolDailySecondsPerVisitor: 3600 });
  credits.grantPool(36_000, 'test');
  const hub = new SessionHub(() => new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => `view:${v}` }));
  const mint = (async () => new Response(JSON.stringify({ api_key: 'temp', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as unknown as typeof fetch;
  const port = 47700 + Math.floor(Math.random() * 400);
  ({ app } = await buildApp({ port, sonioxApiKey: 'server-key', fetchImpl: mint, speechIdleMs: 400, speechEndpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`, hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 6)), maxListeners: 5 } }));
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await app?.close();
  await new Promise((r) => setTimeout(r, 150));
  credits?.close();
  await new Promise<void>((r) => provider.close(() => r()));
});

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const visit = async () => (await fetch(`${base}/api/me`, { headers: { origin: base } })).headers.get('set-cookie')!.split(';')[0];
const socket = async (path: string, cookie?: string) => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers: { origin: base, ...(cookie ? { cookie } : {}) } });
  const msgs: ControlServerMessage[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise<void>((r) => ws.on('open', () => r()));
  return { ws, msgs };
};
async function listen(cookie: string) {
  const res = await fetch(`${base}/api/soniox/temporary-key`, { method: 'POST', headers: { origin: base, cookie } });
  expect(res.status).toBe(200);
  const { api_key, stt_ws_url } = (await res.json()) as { api_key: string; stt_ws_url: string };
  const ws = new WebSocket(stt_ws_url, { headers: { origin: base, cookie } });
  const frames: Array<{ error_type?: string }> = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  let open = true;
  ws.on('close', () => (open = false));
  await new Promise<void>((r) => ws.on('open', () => r()));
  ws.send(JSON.stringify({ api_key, audio_format: 'auto' }));
  return { ws, frames, open: () => open };
}

describe('live on stream', () => {
  it('is known to the pages at once, and never stops listening for lack of recitation', async () => {
    const streamer = await visit();
    const page = await socket('/ws/control', streamer);
    await until(() => page.msgs.some((m) => m.type === 'snapshot'));
    const first = page.msgs.find((m) => m.type === 'snapshot') as Extract<ControlServerMessage, { type: 'snapshot' }>;
    expect(first.snapshot.overlay.clients).toBe(0);
    // OBS opens the overlay link: the page hears of it without waiting for anything else to change.
    const obs = await socket('/ws/overlay');
    obs.ws.send(JSON.stringify({ type: 'hello', view: first.snapshot.overlay.url.replace('view:', ''), role: 'overlay' }));
    await until(() => page.msgs.some((m) => m.type === 'snapshot' && m.snapshot.overlay.clients === 1), 1000);

    const live = await listen(streamer);
    const plain = await listen(await visit());
    await until(() => provider.clients.size === 2);
    await until(() => !plain.open(), 3000); // not live: the usual idle rule (400 ms here)
    expect(plain.frames.at(-1)).toMatchObject({ error_type: 'listening_cooldown' });
    await new Promise((r) => setTimeout(r, 600));
    expect(live.open()).toBe(true);
    expect(live.frames.find((f) => f.error_type)).toBeUndefined();

    // OBS closes: the stream is no longer live, and the idle rule counts from then.
    obs.ws.close();
    await until(() => page.msgs.some((m) => m.type === 'snapshot' && m.snapshot.overlay.clients === 0), 1000);
    await until(() => !live.open(), 3000);
    expect(live.frames.at(-1)).toMatchObject({ error_type: 'listening_cooldown' });
    page.ws.close();
  });
});
