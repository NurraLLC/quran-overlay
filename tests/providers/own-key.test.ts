// A reciter's own Soniox key: their account pays, so a stream on it uses no shared hours and no
// shared place (only the server's own capacity), the key is used once to open the stream and never
// kept, and its account's refusals are told apart from the service's own limits.
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { CreditStore } from '../../src/server/billing/credits';
import { ListeningSafety } from '../../src/server/billing/listening-safety';
import { HostedSpeech } from '../../src/server/providers/hosted-speech';

const OWN = 'own-soniox-key-0123456789abcdef';
const until = async (test: () => boolean) => {
  const deadline = Date.now() + 4000;
  while (!test()) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

async function harness(o: { maxStreams: number; maxReciters?: number; mintStatus?: (key: string) => number; answer?: (key: string) => object | null }) {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const front = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([new Promise<void>((r) => provider.on('listening', r)), new Promise<void>((r) => front.on('listening', r))]);
  // Which account each stream's temporary key was minted with.
  const minted: string[] = [];
  const tempKeys = new Map<string, string>();
  provider.on('connection', (ws) => ws.once('message', (raw) => {
    const account = tempKeys.get(JSON.parse(String(raw)).api_key) ?? '?';
    const reply = o.answer?.(account);
    if (reply) { ws.send(JSON.stringify(reply)); ws.close(); }
  }));
  const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 600, holdMinSeconds: 1 });
  credits.grantPool(36_000, 'test');
  const safety = new ListeningSafety(':memory:');
  let n = 0;
  const relay = new HostedSpeech({ credits, safety, apiKey: 'service-key-0123456789', maxStreams: o.maxStreams, maxReciters: o.maxReciters, holdMs: 50,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const account = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
      minted.push(account);
      const status = o.mintStatus?.(account) ?? 201;
      const temp = `temp-${++n}`;
      tempKeys.set(temp, account);
      return new Response(JSON.stringify({ api_key: temp, expires_at: new Date(Date.now() + 60_000).toISOString() }), { status });
    }) as unknown as typeof fetch,
    endpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`,
    isRecitation: () => true, onSettled: () => undefined,
  });
  front.on('connection', (s, req) => relay.accept(s, req.url!.slice(1), 'network'));
  const stream = async (id: string, own?: string) => {
    const t = relay.issue(id, 'network', own) as { api_key?: string; error?: string };
    expect(t.api_key, `${id} should get a ticket (${t.error})`).toBeTruthy();
    const ws = new WebSocket(`ws://127.0.0.1:${(front.address() as { port: number }).port}/${id}`);
    const frames: Array<{ error_type?: string; error_message?: string }> = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ api_key: t.api_key, audio_format: 'auto' }));
    return { ws, frames, closed };
  };
  cleanup = async () => {
    relay.close();
    for (const s of front.clients) s.terminate();
    for (const s of provider.clients) s.terminate();
    await Promise.all([new Promise<void>((r) => front.close(() => r())), new Promise<void>((r) => provider.close(() => r()))]);
    safety.close(); credits.close();
  };
  return { relay, credits, minted, stream, ask: (id: string, own?: string) => relay.issue(id, 'network', own) as { api_key?: string; error?: string; position?: number } };
}

describe('a reciter’s own Soniox key', () => {
  it('pays for its stream: no shared hours, no shared place, and the key is used for that stream only', async () => {
    const h = await harness({ maxStreams: 1 });
    await h.stream('a'); // the one shared place
    await until(() => h.relay.streaming('a'));
    expect(h.ask('c')).toEqual({ error: 'LISTENING_BUSY', position: 1 });
    const pool = h.credits.poolSeconds();
    const b = await h.stream('b', OWN); // straight in: it needs no shared place
    await until(() => h.relay.streaming('b'));
    expect(h.minted).toEqual(['service-key-0123456789', OWN]);
    expect(h.ask('c')).toEqual({ error: 'LISTENING_BUSY', position: 1 }); // c still waits for the shared place
    b.ws.close();
    await b.closed;
    await until(() => !h.relay.streaming('b'));
    expect(h.credits.poolSeconds()).toBe(pool); // nothing drawn from the shared hours
    const tickets = (h.relay as unknown as { tickets: Map<string, { own?: string }> }).tickets;
    expect([...tickets.values()].some((t) => t.own)).toBe(false); // not kept once used
  });

  it('is limited only by what the server carries', async () => {
    const h = await harness({ maxStreams: 1, maxReciters: 2 });
    await h.stream('a');
    await h.stream('b', OWN);
    await until(() => h.relay.streaming('a') && h.relay.streaming('b'));
    expect(h.ask('d', OWN)).toEqual({ error: 'LISTENING_BUSY' }); // the server is full: try again later
  });

  it('says so when its account refuses, without touching the service’s own limits', async () => {
    const h = await harness({ maxStreams: 2, mintStatus: (k) => (k === 'rejected-key-0123456789' ? 401 : 201), answer: (k) => (k === OWN ? { error_code: 402, error_type: 'organization_balance_exhausted', error_message: 'no balance' } : null) });
    const rejected = await h.stream('b', 'rejected-key-0123456789');
    await rejected.closed;
    expect(rejected.frames.at(-1)).toMatchObject({ error_type: 'own_key_refused', error_message: expect.stringMatching(/did not accept your own key/) });
    const broke = await h.stream('e', OWN);
    await broke.closed;
    expect(broke.frames.at(-1)).toMatchObject({ error_type: 'own_key_refused', error_message: expect.stringMatching(/run out of balance/) });
    // The service's own places are untouched: two shared streams still fit.
    await h.stream('a');
    await h.stream('c');
    await until(() => h.relay.streaming('a') && h.relay.streaming('c'));
  });
});
