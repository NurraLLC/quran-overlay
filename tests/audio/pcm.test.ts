// The iPhone path: Safari before 18.4 records only MP4/AAC, which Soniox's real-time API doesn't
// list, so the audio thread sends 16 kHz mono 16-bit PCM. The resampler and the processor are
// tested from the same source text the browser runs (WORKLET), with stand-in audio-thread globals.
import { describe, expect, it } from 'vitest';
import { createDownsampler, PcmStreamSource, WORKLET, type SharedMic } from '../../src/web/audio/mic';

const BLOCK = 128;
function tone(rate: number, hz: number, seconds: number, amp: number) {
  const x = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
}
function run(down: (b: Float32Array) => Int16Array, x: Float32Array, block = BLOCK) {
  const parts: Int16Array[] = [];
  for (let i = 0; i < x.length; i += block) parts.push(down(x.subarray(i, i + block)));
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}
const rms = (s: Int16Array, from = 200) => Math.sqrt(s.subarray(from).reduce((a, v) => a + (v / 32767) ** 2, 0) / (s.length - from));
const crossings = (s: Int16Array) => s.reduce((n, v, i) => n + (i && (s[i - 1] < 0) !== (v < 0) ? 1 : 0), 0);

describe('16 kHz resampler', () => {
  it.each([48_000, 44_100])('keeps a voice-band tone from %i Hz: length, level and pitch', (rate) => {
    const out = run(createDownsampler(rate, 16_000), tone(rate, 440, 2, 0.5));
    expect(Math.abs(out.length - 32_000)).toBeLessThanOrEqual(2);
    expect(rms(out)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const settled = out.subarray(100); // past the filter's start
    expect(Math.abs(crossings(settled) - (2 * 440 * settled.length) / 16_000)).toBeLessThanOrEqual(2); // still 440 Hz
  });

  it('removes what would fold back below 8 kHz', () => {
    const out = run(createDownsampler(48_000, 16_000), tone(48_000, 12_000, 1, 0.5));
    expect(rms(out)).toBeLessThan(0.02); // a 12 kHz tone would alias to 4 kHz at full level
  });

  it('gives the same samples however the audio thread splits the blocks', () => {
    const x = tone(48_000, 997, 0.5, 0.4);
    const whole = run(createDownsampler(48_000, 16_000), x, x.length);
    const quanta = run(createDownsampler(48_000, 16_000), x, BLOCK);
    expect(quanta.length).toBe(whole.length);
    expect(Math.max(...quanta.map((v, i) => Math.abs(v - whole[i])))).toBeLessThanOrEqual(1);
  });

  it('clips instead of wrapping around', () => {
    const out = run(createDownsampler(48_000, 16_000), new Float32Array(4800).fill(1.5));
    expect(Math.max(...out.subarray(100))).toBe(32767);
    expect(Math.min(...out.subarray(100))).toBe(32767);
  });
});

/** Runs WORKLET with stand-ins for the audio thread's globals; returns the registered processors. */
function worklet(sampleRate: number) {
  const registered: Record<string, new (o: unknown) => { port: FakePort; process(inputs: Float32Array[][]): boolean }> = {};
  class FakePort {
    sent: unknown[] = [];
    onmessage: ((e: { data: unknown }) => void) | null = null;
    postMessage(m: unknown) { this.sent.push(m); }
  }
  class AudioWorkletProcessor { port = new FakePort(); }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WORKLET)(AudioWorkletProcessor, (name: string, cls: never) => (registered[name] = cls), sampleRate);
  return registered;
}

describe('audio-thread PCM processor', () => {
  it('sends 60 ms chunks of 16-bit PCM (1920 bytes) and treats a channel-less input as silence', () => {
    const P = worklet(48_000)['qo-pcm'];
    const p = new P({ processorOptions: { rate: 16_000, chunk: 960 } });
    const x = tone(48_000, 440, 0.12, 0.5);
    for (let i = 0; i < 23; i++) p.process([[x.subarray(i * BLOCK, (i + 1) * BLOCK)]]); // 61 ms
    expect(p.port.sent.map((b) => (b as ArrayBuffer).byteLength)).toEqual([1920]);
    expect(Math.max(...new Int16Array(p.port.sent[0] as ArrayBuffer))).toBeGreaterThan(15_000);
    // A muted track can arrive without channels: time still passes, as silence.
    for (let i = 0; i < 23; i++) p.process([[]]);
    expect(p.port.sent).toHaveLength(2);
    expect(Math.max(...new Int16Array(p.port.sent[1] as ArrayBuffer).subarray(200).map(Math.abs))).toBe(0);
    p.port.onmessage?.({ data: 'stop' });
    expect(p.process([[x.subarray(0, BLOCK)]])).toBe(false);
  });

  it('runs the voice detector without input channels', () => {
    const V = worklet(44_100)['qo-vad'];
    const v = new V({ processorOptions: { quietAfterMs: 8000, pauseMs: 180 } });
    expect(v.process([[]])).toBe(true);
  });
});

describe('PCM stream source', () => {
  function fakeMic() {
    const taps: Array<{ onChunk: (b: ArrayBuffer) => void; stopped: boolean }> = [];
    const mic = {
      onMute: () => () => undefined,
      pcm: (_ms: number, onChunk: (b: ArrayBuffer) => void) => {
        const tap = { onChunk, stopped: false };
        taps.push(tap);
        return () => (tap.stopped = true);
      },
    } as unknown as SharedMic;
    return { mic, taps };
  }

  it('delivers chunks until stopped, drops them while paused, and restarts on a fresh tap', async () => {
    const { mic, taps } = fakeMic();
    const got: number[] = [];
    const s = new PcmStreamSource(mic, 60);
    await s.start({ onData: (b) => got.push(b.byteLength), onError: (e) => { throw e; } });
    taps[0].onChunk(new ArrayBuffer(1920));
    s.pause();
    taps[0].onChunk(new ArrayBuffer(1920));
    s.resume();
    s.restart(); // a reconnected provider session: a new tap, so its first chunk is its audio time 0
    expect(taps[0].stopped).toBe(true);
    taps[0].onChunk(new ArrayBuffer(1920)); // late chunk from the old tap is ignored
    taps[1].onChunk(new ArrayBuffer(1920));
    s.stop();
    expect(taps[1].stopped).toBe(true);
    expect(got).toEqual([1920, 1920]);
  });
});
