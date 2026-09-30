// The hosted relay and phones: the SDK keeps a muted stream (a call, Siri) with keepalive frames,
// and Safari before 18.4 sends 16 kHz PCM (it records only MP4, which the real-time API doesn't
// list). The provider is a local stand-in; nothing here reaches Soniox.
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { SonioxClient, type AudioSourceHandlers } from '@soniox/client';
import { CreditStore } from '../../src/server/billing/credits';
import { ListeningSafety } from '../../src/server/billing/listening-safety';
import { HostedSpeech } from '../../src/server/providers/hosted-speech';

const until = async (test: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (!test()) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

async function relay() {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const front = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([new Promise<void>((r) => provider.on('listening', r)), new Promise<void>((r) => front.on('listening', r))]);
  const texts: Array<Record<string, unknown>> = [];
  const audio: Buffer[] = [];
  provider.on('connection', (s) => s.on('message', (raw, binary) => (binary ? audio.push(Buffer.from(raw as Buffer)) : texts.push(JSON.parse(raw.toString())))));
  const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 600, holdMinSeconds: 1 });
  credits.grantPool(3600, 'test');
  const safety = new ListeningSafety(':memory:');
  const speech = new HostedSpeech({ credits, safety, apiKey: 'server-private-key',
    fetchImpl: (async () => new Response(JSON.stringify({ api_key: 'provider-temporary-key', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as typeof fetch,
    endpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`,
    isRecitation: () => false, onSettled: () => undefined,
  });
  front.on('connection', (s, req) => speech.accept(s, req.url!.slice(1), 'network'));
  const url = (id: string) => `ws://127.0.0.1:${(front.address() as { port: number }).port}/${id}`;
  /** A raw browser connection that sends `config` (with a fresh ticket) first. */
  const open = async (config: Record<string, unknown>, id = 'a') => {
    const ws = new WebSocket(url(id));
    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ api_key: (speech.issue(id, 'network') as { api_key: string }).api_key, ...config }));
    return { ws, messages };
  };
  cleanup = async () => {
    speech.close();
    for (const s of front.clients) s.terminate();
    for (const s of provider.clients) s.terminate();
    await Promise.all([new Promise<void>((r) => front.close(() => r())), new Promise<void>((r) => provider.close(() => r()))]);
    safety.close(); credits.close();
  };
  return { speech, texts, audio, url, open };
}

describe('hosted relay on phones', () => {
  it('keeps a muted stream open: the SDK’s keepalive frames reach the provider', async () => {
    // Regression: the relay refused {"type":"keepalive"}, so any mute of 5 s or more (a phone
    // call, Siri) ended listening with "Invalid listening request.".
    const r = await relay();
    let handlers: AudioSourceHandlers | null = null;
    const source = { async start(h: AudioSourceHandlers) { handlers = h; }, stop() {}, pause() {}, resume() {}, restart() {} };
    const client = new SonioxClient({ config: async () => ({ api_key: (r.speech.issue('muted', 'network') as { api_key: string }).api_key, stt_ws_url: r.url('muted') }) });
    const rec = client.realtime.record({ model: 'stt-rt-v5', source, auto_reconnect: true, session_options: { keepalive_interval_ms: 1000 } });
    const errors: unknown[] = [];
    rec.on('error', (e) => errors.push(e));
    await new Promise<void>((resolve) => rec.on('connected', () => resolve()));
    handlers!.onData(new Uint8Array([1, 2, 3]).buffer);
    await until(() => r.texts.length === 1 && r.audio.length === 1); // the provider stream is up
    handlers!.onMuted!();
    await until(() => r.texts.filter((t) => t.type === 'keepalive').length >= 2);
    expect(errors).toEqual([]);
    expect(rec.state).toBe('recording');
    expect(r.texts.filter((t) => t.type === 'finalize')).toHaveLength(1); // the SDK finalizes on pause
    handlers!.onUnmuted!();
    handlers!.onData(new Uint8Array([4, 5, 6]).buffer);
    await until(() => r.audio.length === 2);
    rec.cancel();
  });

  it('still refuses every other control message', async () => {
    const r = await relay();
    const c = await r.open({ audio_format: 'auto' });
    await until(() => r.texts.length === 1);
    c.ws.send(JSON.stringify({ type: 'config', model: 'expensive' }));
    await until(() => c.ws.readyState === WebSocket.CLOSED);
    expect(c.messages.join('')).toContain('Invalid listening request');
  });

  it('passes the reader’s 16 kHz PCM on as exactly that, at real-time pace within the byte budget', async () => {
    const r = await relay();
    const c = await r.open({ audio_format: 'pcm_s16le', sample_rate: 16_000, num_channels: 1 });
    await until(() => r.texts.length === 1);
    expect(r.texts[0]).toMatchObject({ api_key: 'provider-temporary-key', model: 'stt-rt-v5', audio_format: 'pcm_s16le', sample_rate: 16_000, num_channels: 1 });
    for (let i = 0; i < 25; i++) { // 1.5 s of 60 ms chunks (32 KB/s)
      c.ws.send(Buffer.alloc(1920, i));
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await until(() => r.audio.length === 25);
    expect(r.audio.every((b) => b.length === 1920)).toBe(true);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it.each([
    ['another sample rate', { audio_format: 'pcm_s16le', sample_rate: 48_000, num_channels: 1 }],
    ['stereo', { audio_format: 'pcm_s16le', sample_rate: 16_000, num_channels: 2 }],
    ['an undescribed PCM stream', { audio_format: 'pcm_s16le' }],
    ['another raw encoding', { audio_format: 'pcm_s16be', sample_rate: 16_000, num_channels: 1 }],
    ['companded audio', { audio_format: 'mulaw', sample_rate: 8_000, num_channels: 1 }],
    ['a detected container with raw fields', { audio_format: 'auto', sample_rate: 16_000 }],
  ])('refuses %s before reserving or contacting the provider', async (_label, config) => {
    const r = await relay();
    const c = await r.open(config);
    await until(() => c.ws.readyState === WebSocket.CLOSED);
    expect(c.messages.join('')).toContain('This audio format is not supported.');
    expect(r.texts).toHaveLength(0);
  });
});
