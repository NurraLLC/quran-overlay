// At capacity: a full relay (or a recogniser at its own limit) puts people in line and tells their
// page when a place frees, returns the listening time it had set aside, and never lets a page inject
// results without a stream.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { fullCorpus } from '../helpers';

let app: FastifyInstance;
let base = '';
let provider: WebSocketServer;
let credits: CreditStore;
let hub: SessionHub;
let refuseNext = false;
const identity = new VisitorIdentity(Buffer.alloc(48, 5));

beforeAll(async () => {
  provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => provider.on('listening', r));
  // The recogniser stand-in: on request, answer the next stream as Soniox does at its concurrency limit.
  provider.on('connection', (ws) => ws.once('message', () => {
    if (!refuseNext) return;
    refuseNext = false;
    ws.send(JSON.stringify({ error_code: 429, error_type: 'limit_exceeded', error_message: 'Too many concurrent requests.' }));
    ws.close();
  }));
  const { corpus, ix } = fullCorpus();
  const resolver = new CommandResolver(corpus, null, null);
  credits = new CreditStore(':memory:', { freeSecondsPerMonth: 3600, ipDailyFreeSeconds: 3600, globalDailyFreeSeconds: 36000, holdMaxSeconds: 300, holdMinSeconds: 20 });
  hub = new SessionHub(() => new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => v }));
  const mint = (async () => new Response(JSON.stringify({ api_key: 'temp', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as unknown as typeof fetch;
  const port = 47170 + Math.floor(Math.random() * 500);
  ({ app } = await buildApp({ port, sonioxApiKey: 'server-key', fetchImpl: mint, speechHoldMs: 50, speechEndpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`, hosted: { hub, credits, identity, maxListeners: 1 } }));
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
const ticket = (cookie: string) => fetch(`${base}/api/soniox/temporary-key`, { method: 'POST', headers: { origin: base, cookie } });
async function relay(cookie: string) {
  const res = await ticket(cookie);
  expect(res.status).toBe(200);
  const { api_key, stt_ws_url } = (await res.json()) as { api_key: string; stt_ws_url: string };
  const ws = new WebSocket(stt_ws_url, { headers: { origin: base, cookie } });
  const frames: Array<{ error_type?: string; error_message?: string }> = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  const closed = new Promise<void>((r) => ws.on('close', () => r()));
  await new Promise<void>((r) => ws.on('open', () => r()));
  ws.send(JSON.stringify({ api_key, audio_format: 'auto' }));
  return { ws, frames, closed };
}

const page = async (cookie: string) => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/control`, { headers: { origin: base, cookie } });
  const told: string[] = [];
  ws.on('message', (d) => told.push(JSON.parse(String(d)).type));
  await new Promise<void>((r) => ws.on('open', () => r()));
  return { ws, told };
};
const settle = async () => {
  await until(() => provider.clients.size === 0);
  await new Promise((r) => setTimeout(r, 150)); // closed streams' kept places lapse
};

describe('listening at capacity', () => {
  it('puts the next person in line while the relay is full, and tells their page when a place frees', async () => {
    const a = await relay(await visit());
    await until(() => provider.clients.size === 1);
    const cookie = await visit();
    const b = await page(cookie);
    const res = await ticket(cookie);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'LISTENING_BUSY', position: 1 });
    a.ws.close();
    await until(() => b.told.includes('listen_turn'));
    const stream = await relay(cookie); // the place is theirs
    await until(() => provider.clients.size === 1);
    stream.ws.close();
    b.ws.close();
    await settle();
  });

  it('lets a page that stops waiting leave the line at once', async () => {
    const a = await relay(await visit());
    await until(() => provider.clients.size === 1);
    const first = await visit();
    const b = await page(first);
    expect(((await (await ticket(first)).json()) as { position: number }).position).toBe(1);
    const second = await visit();
    expect(((await (await ticket(second)).json()) as { position: number }).position).toBe(2);
    b.ws.send(JSON.stringify({ type: 'capture', captureEpoch: 1, event: 'stopped' }));
    await new Promise((r) => setTimeout(r, 200)); // the message reaches the server
    expect(((await (await ticket(second)).json()) as { position: number }).position).toBe(1);
    a.ws.close();
    b.ws.close();
    await settle();
    await relay(second).then((s) => s.ws.close()); // leave nothing held for the next test
    await settle();
  });

  it('turns the recogniser’s own limit into a wait, and returns the time set aside', async () => {
    const cookie = await visit();
    const id = identity.verify(cookie.split('=')[1])!;
    const before = credits.balance(id, '127.0.0.1').available;
    refuseNext = true;
    const r = await relay(cookie);
    await r.closed;
    expect(r.frames.at(-1)).toMatchObject({ error_type: 'listening_busy' });
    expect(r.frames.at(-1)!.error_message).toMatch(/reciting right now/);
    expect(credits.balance(id, '127.0.0.1').available).toBe(before);
  });

  it('ignores recogniser results from a page without a stream', async () => {
    const cookie = await visit();
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/control`, { headers: { origin: base, cookie } });
    await new Promise<void>((r) => ws.on('open', () => r()));
    const id = identity.verify(cookie.split('=')[1])!;
    ws.send(JSON.stringify({ type: 'capture', captureEpoch: 1, event: 'recording' }));
    ws.send(JSON.stringify({ type: 'transcript', captureEpoch: 1, seq: 0, receivedAt: 0, tokens: [{ text: 'قل هو الله احد الله الصمد', isFinal: true }] }));
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.peek(id)?.display.verse ?? null).toBeNull();
    ws.close();
  });
});
