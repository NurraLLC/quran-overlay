import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { CreditStore } from '../../src/server/billing/credits';
import { ListeningSafety } from '../../src/server/billing/listening-safety';
import { HostedSpeech } from '../../src/server/providers/hosted-speech';
import { recitationActivity } from '../../src/server/providers/recitation-activity';

const until = async (test: () => boolean) => {
  const deadline = Date.now() + 4000;
  while (!test()) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());
async function harness(idleLimitMs = 90_000) {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const front = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([new Promise<void>((r) => provider.on('listening', r)), new Promise<void>((r) => front.on('listening', r))]);
  const configs: Array<Record<string, unknown>> = [];
  const audio: Buffer[] = [];
  provider.on('connection', (socket) => socket.on('message', (raw, binary) => binary ? audio.push(Buffer.from(raw as Buffer)) : configs.push(JSON.parse(raw.toString()))));
  const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 60, holdMinSeconds: 1 });
  credits.grantPool(3600, 'test');
  const safety = new ListeningSafety(':memory:');
  let settled = 0;
  const relay = new HostedSpeech({ credits, safety, apiKey: 'server-private-key', idleLimitMs,
    fetchImpl: (async () => new Response(JSON.stringify({ api_key: 'provider-private-temporary-key', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as typeof fetch,
    endpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`,
    isRecitation: recitationActivity(['قل', 'هو', 'الله', 'احد']), onSettled: () => settled++,
  });
  front.on('connection', (s, req) => relay.accept(s, req.url!.slice(1), 'network'));
  const connect = async (id = 'a', supplied?: string) => {
    const ticket = supplied ?? (relay.issue(id, 'network') as { api_key: string }).api_key;
    const ws = new WebSocket(`ws://127.0.0.1:${(front.address() as { port: number }).port}/${id}`);
    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ api_key: ticket, audio_format: 'auto', model: 'expensive-client-model', context: { text: 'untrusted' } }));
    return { ws, messages, ticket };
  };
  cleanup = async () => {
    relay.close();
    for (const s of front.clients) s.terminate();
    for (const s of provider.clients) s.terminate();
    await Promise.all([new Promise<void>((r) => front.close(() => r())), new Promise<void>((r) => provider.close(() => r()))]);
    safety.close(); credits.close();
  };
  return { relay, provider, credits, configs, audio, connect, settled: () => settled };
}

describe('hosted audio authority', () => {
  it('relays bytes, owns the provider options, and never exposes a provider key', async () => {
    const h = await harness();
    const c = await h.connect();
    c.ws.send(Buffer.from([1, 2, 3])); // may arrive while the provider is still connecting
    await until(() => h.audio.length === 1);
    expect(h.audio[0]).toEqual(Buffer.from([1, 2, 3]));
    expect(h.configs[0]).toMatchObject({ api_key: 'provider-private-temporary-key', model: 'stt-rt-v5', audio_format: 'auto' });
    expect(JSON.stringify(h.configs[0])).not.toContain('untrusted');
    expect(c.ticket).not.toContain('provider');
    c.ws.close();
    await until(() => h.provider.clients.size === 0 && h.settled() === 1);
    expect(h.credits.poolSeconds()).toBeLessThan(3600);
    expect(c.messages.join('')).not.toContain('private');
  });

  it('binds tickets to the visitor and prevents a concurrent second stream', async () => {
    const h = await harness();
    const ticket = (h.relay.issue('a', 'network') as { api_key: string }).api_key;
    const wrong = await h.connect('b', ticket);
    await until(() => wrong.ws.readyState === WebSocket.CLOSED);
    expect(h.configs).toHaveLength(0);
    const first = await h.connect('a', ticket);
    await until(() => h.configs.length === 1);
    const second = await h.connect('a');
    await until(() => second.ws.readyState === WebSocket.CLOSED);
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    expect(h.configs).toHaveLength(1);
    const replay = await h.connect('a', ticket);
    await until(() => replay.ws.readyState === WebSocket.CLOSED);
    expect(h.configs).toHaveLength(1);
  });

  it('cuts an idle upstream, while fresh provider recitation can keep it open', async () => {
    const h = await harness(600);
    const c = await h.connect();
    await until(() => h.configs.length === 1);
    const upstream = [...h.provider.clients][0];
    for (let i = 0; i < 4; i++) {
      upstream.send(JSON.stringify({ tokens: [{ text: 'قل هو الله احد', is_final: false, start_ms: i * 250, end_ms: i * 250 + 100 }], total_audio_proc_ms: i * 250 }));
      await new Promise((r) => setTimeout(r, 250));
      expect(c.ws.readyState).toBe(WebSocket.OPEN);
    }
    await until(() => c.ws.readyState === WebSocket.CLOSED && h.provider.clients.size === 0);
    expect(c.messages.join('')).toContain('listening_cooldown');
    expect(h.settled()).toBe(1);
  });

  it('does not accept invented client transcripts or arbitrary provider control messages', async () => {
    const h = await harness();
    const c = await h.connect();
    await until(() => h.configs.length === 1);
    c.ws.send(JSON.stringify({ tokens: [{ text: 'قل هو الله احد' }] }));
    await until(() => c.ws.readyState === WebSocket.CLOSED);
    expect(c.messages.join('')).toContain('Invalid listening request');
  });
});
