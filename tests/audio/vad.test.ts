import { describe, expect, it } from 'vitest';
import { createVad } from '../../src/web/audio/vad';

const RATE = 48_000;
const BLOCK = 128;
/** Blocks of `ms` of a tone at `amp` (speech-like level) or near-silence. */
function feed(v: ReturnType<typeof createVad>, ms: number, amp: number) {
  const out: Array<'voice' | 'quiet'> = [];
  const n = Math.round((RATE * ms) / 1000 / BLOCK);
  for (let b = 0; b < n; b++) {
    const block = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) block[i] = amp * Math.sin((2 * Math.PI * 220 * (b * BLOCK + i)) / RATE) + (Math.random() - 0.5) * 0.0004;
    const r = v(block);
    if (r) out.push(r);
  }
  return out;
}

describe('silence skipper voice detection', () => {
  it('reports voice at the start of speech and quiet once after a long pause', () => {
    const v = createVad(RATE, 8000);
    expect(feed(v, 1000, 0)).toEqual([]);
    expect(feed(v, 2000, 0.2)).toEqual(['voice']);
    expect(feed(v, 7000, 0)).toEqual([]); // breaths and pauses between ayahs never close the stream
    expect(feed(v, 2000, 0)).toEqual(['quiet']);
    expect(feed(v, 5000, 0)).toEqual([]); // once
    expect(feed(v, 500, 0.2)).toEqual(['voice']);
  });

  it('keeps hearing a long unbroken recitation as voice', () => {
    const v = createVad(RATE, 8000);
    feed(v, 500, 0);
    expect(feed(v, 60_000, 0.1)).toEqual(['voice']);
  });

  it('ignores a click', () => {
    const v = createVad(RATE, 8000);
    feed(v, 500, 0);
    expect(feed(v, 10, 0.5)).toEqual([]);
  });

  it('hears a quiet reciter over a quiet room', () => {
    const v = createVad(RATE, 8000);
    feed(v, 1000, 0);
    expect(feed(v, 500, 0.01)).toEqual(['voice']); // about -40 dBFS
  });
});
