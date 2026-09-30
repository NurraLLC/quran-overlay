// The waiting line: when every place to listen is taken, people wait in order and are told when a
// place is theirs; a reciter pausing keeps their place for a moment and later comes first; a place
// offered and not taken passes on; the recogniser's own limit shrinks the places for a while.
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { CreditStore } from '../../src/server/billing/credits';
import { ListeningSafety } from '../../src/server/billing/listening-safety';
import { HostedSpeech } from '../../src/server/providers/hosted-speech';

const until = async (test: () => boolean) => {
  const deadline = Date.now() + 4000;
  while (!test()) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

async function harness(o: { maxStreams: number; holdMs?: number; offerMs?: number; liveBreakMs?: number; idleLimitMs?: number; live?: (id: string) => boolean; listeningOn?: (id: string) => boolean }) {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const front = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([new Promise<void>((r) => provider.on('listening', r)), new Promise<void>((r) => front.on('listening', r))]);
  let refuse = 0;
  // The recogniser stand-in: refuses the next streams on request, as Soniox does at its concurrency limit.
  provider.on('connection', (ws) => ws.once('message', () => {
    if (refuse <= 0) return;
    refuse--;
    ws.send(JSON.stringify({ error_code: 429, error_type: 'limit_exceeded', error_message: 'Too many concurrent requests.' }));
    ws.close();
  }));
  const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 60, holdMinSeconds: 1 });
  credits.grantPool(36_000, 'test');
  const safety = new ListeningSafety(':memory:');
  const turns: string[] = [];
  let busy = false;
  const relay = new HostedSpeech({ credits, safety, apiKey: 'server-private-key', maxStreams: o.maxStreams, holdMs: o.holdMs ?? 50, offerMs: o.offerMs, liveBreakMs: o.liveBreakMs, idleLimitMs: o.idleLimitMs, live: o.live, listeningOn: o.listeningOn,
    fetchImpl: (async () => new Response(JSON.stringify({ api_key: 'temp', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as typeof fetch,
    endpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`,
    isRecitation: () => true, onSettled: () => undefined, onTurn: (id) => turns.push(id), busy: () => busy,
  });
  front.on('connection', (s, req) => relay.accept(s, req.url!.slice(1), 'network'));
  const ask = (id: string) => relay.issue(id, 'network') as { api_key?: string; error?: string; position?: number };
  /** Takes a place with a ticket just asked for, and waits until the stream is open (or refused). */
  const stream = async (id: string, ticket: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${(front.address() as { port: number }).port}/${id}`);
    const frames: Array<{ error_type?: string }> = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ api_key: ticket, audio_format: 'auto' }));
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    return { ws, frames, closed };
  };
  const recite = async (id: string) => {
    const t = ask(id);
    expect(t.api_key, `${id} should have a place`).toBeTruthy();
    const s = await stream(id, t.api_key!);
    await until(() => relay.streaming(id));
    return s;
  };
  cleanup = async () => {
    relay.close();
    for (const s of front.clients) s.terminate();
    for (const s of provider.clients) s.terminate();
    await Promise.all([new Promise<void>((r) => front.close(() => r())), new Promise<void>((r) => provider.close(() => r()))]);
    safety.close(); credits.close();
  };
  return { relay, turns, ask, stream, recite, refuseNext: () => { refuse++; }, setBusy: (b: boolean) => { busy = b; } };
}

describe('the waiting line', () => {
  it('keeps order, tells the next person when a place frees, and lets them in', async () => {
    const h = await harness({ maxStreams: 1 });
    const a = await h.recite('a');
    expect(h.ask('b')).toEqual({ error: 'LISTENING_BUSY', position: 1 });
    expect(h.ask('c')).toEqual({ error: 'LISTENING_BUSY', position: 2 });
    expect(h.ask('b')).toEqual({ error: 'LISTENING_BUSY', position: 1 }); // asking again keeps the place
    expect(h.relay.waiting).toBe(2);
    a.ws.close();
    await until(() => h.turns.length === 1);
    expect(h.turns).toEqual(['b']); // only the first: one place
    expect(h.ask('c')).toEqual({ error: 'LISTENING_BUSY', position: 2 }); // b is on their way to it
    await h.recite('b');
    expect(h.ask('c')).toEqual({ error: 'LISTENING_BUSY', position: 1 });
    expect(h.relay.waiting).toBe(1);
  });

  it('never skips the line: a newcomer waits behind people already waiting', async () => {
    const h = await harness({ maxStreams: 2 });
    await h.recite('a');
    await h.recite('b');
    expect(h.ask('c').position).toBe(1);
    h.relay.leave('c');
    expect(h.relay.waiting).toBe(0);
    expect(h.ask('d').position).toBe(1); // c left: d is first
  });

  it('keeps a pausing reciter’s place, then brings them back to the front of the line', async () => {
    const h = await harness({ maxStreams: 1, holdMs: 400 });
    const a = await h.recite('a');
    expect(h.ask('b').position).toBe(1);
    a.ws.close(); // a long pause closes the stream
    await until(() => !h.relay.streaming('a'));
    await wait(150);
    expect(h.turns).toEqual([]); // the place is kept for a
    await h.recite('a'); // a recites again: straight in
    expect(h.ask('b').position).toBe(1);
    // A longer pause: the place goes to b, and a comes back first in line (ahead of c).
    h.relay.leave('b');
    expect(h.ask('c').position).toBe(1);
    const again = h.relay as unknown as { active: Map<string, () => void> };
    again.active.get('a')!(); // the stream ends (as the page closing it does)
    await wait(500); // longer than the kept place
    await until(() => h.turns.includes('c'));
    await h.recite('c');
    expect(h.ask('a')).toEqual({ error: 'LISTENING_BUSY', position: 1 });
    expect(h.ask('d')).toEqual({ error: 'LISTENING_BUSY', position: 2 });
  });

  it('passes an untaken place on, and the first person is in the running again when they ask', async () => {
    const h = await harness({ maxStreams: 1, offerMs: 150 });
    const a = await h.recite('a');
    expect(h.ask('b').position).toBe(1);
    expect(h.ask('c').position).toBe(2);
    a.ws.close();
    await until(() => h.turns.includes('b'));
    await wait(250); // b never came for it
    await h.recite('c'); // the place passed on to c
    expect(h.ask('b')).toEqual({ error: 'LISTENING_BUSY', position: 1 });
  });

  it('uses only the places the recogniser allows after it refuses, with the refused reciter next', async () => {
    const h = await harness({ maxStreams: 3 });
    await h.recite('a');
    h.refuseNext();
    const t = h.ask('b');
    const b = await h.stream('b', t.api_key!);
    await b.closed;
    expect(b.frames.at(-1)).toMatchObject({ error_type: 'listening_busy' });
    // The recogniser allowed one stream (a): no new ones for now, and b is first in line.
    expect(h.ask('c')).toEqual({ error: 'LISTENING_BUSY', position: 1 });
    expect(h.ask('b')).toEqual({ error: 'LISTENING_BUSY', position: 1 });
    expect(h.ask('c')).toEqual({ error: 'LISTENING_BUSY', position: 2 });
  });

  it('holds everyone in line while the server is overloaded, then offers places again', async () => {
    const h = await harness({ maxStreams: 2 });
    h.setBusy(true);
    expect(h.ask('a').position).toBe(1);
    h.setBusy(false);
    expect(h.ask('a').api_key).toBeTruthy();
  });
});

describe('live on stream', () => {
  // The recogniser stand-in sends no results, so nothing is ever heard as recitation.
  async function live(o: { maxStreams: number; idleLimitMs?: number; liveBreakMs?: number }) {
    const liveIds = new Set<string>();
    const listening = new Set<string>();
    const h = await harness({ maxStreams: o.maxStreams, live: (id) => liveIds.has(id), listeningOn: (id) => listening.has(id), idleLimitMs: o.idleLimitMs, liveBreakMs: o.liveBreakMs });
    return { ...h, liveIds, listening };
  }

  it('never stops for lack of recitation while live', async () => {
    const h = await live({ maxStreams: 2, idleLimitMs: 300 });
    h.liveIds.add('streamer');
    const s = await h.recite('streamer'); // talking with the audience: no recitation heard
    const plain = await h.recite('reciter');
    await plain.closed; // the usual idle rule still applies to others
    expect(plain.frames.at(-1)).toMatchObject({ error_type: 'listening_cooldown' });
    await wait(500);
    expect(h.relay.streaming('streamer')).toBe(true);
    expect(s.frames.find((f) => f.error_type)).toBeUndefined();
  });

  it('keeps its place through a break while listening is on, and goes first in line', async () => {
    const h = await live({ maxStreams: 1, liveBreakMs: 1500 });
    h.liveIds.add('streamer');
    h.listening.add('streamer');
    const s = await h.recite('streamer');
    expect(h.ask('b').position).toBe(1);
    s.ws.close(); // a long break: the stream dozes
    await until(() => !h.relay.streaming('streamer'));
    await wait(300); // far past the usual kept place (50 ms here)
    expect(h.turns).toEqual([]);
    expect(h.ask('b').position).toBe(1);
    await h.recite('streamer'); // back from the break: straight in
    // Stopped listening: the place goes on.
    h.relay['active'].get('streamer')!();
    h.listening.delete('streamer');
    await until(() => h.turns.includes('b'));
    // Live and waiting: first in line, ahead of people already waiting.
    await h.recite('b');
    expect(h.ask('c').position).toBe(1);
    h.liveIds.add('second-stream');
    expect(h.ask('second-stream').position).toBe(1);
    expect(h.ask('c').position).toBe(2);
  });

  it('gives up the place after a very long break, and is first in line when back', async () => {
    const h = await live({ maxStreams: 1, liveBreakMs: 200 });
    h.liveIds.add('streamer');
    h.listening.add('streamer');
    const s = await h.recite('streamer');
    expect(h.ask('b').position).toBe(1);
    expect(h.ask('c').position).toBe(2);
    s.ws.close();
    await until(() => h.turns.includes('b')); // the break outlasted the kept place
    await h.recite('b');
    expect(h.ask('streamer').position).toBe(1); // ahead of c, who was already waiting
    expect(h.ask('c').position).toBe(2);
  });

  it('lifts the limits for at most three live streams per network at once', async () => {
    const h = await live({ maxStreams: 10, idleLimitMs: 300 });
    for (const id of ['s1', 's2', 's3', 's4']) h.liveIds.add(id);
    const streams = [];
    for (const id of ['s1', 's2', 's3', 's4']) streams.push(await h.recite(id));
    await streams[3].closed; // the fourth on one network has the usual idle rule
    expect(streams[3].frames.at(-1)).toMatchObject({ error_type: 'listening_cooldown' });
    await wait(300);
    for (const id of ['s1', 's2', 's3']) expect(h.relay.streaming(id)).toBe(true);
  });
});
