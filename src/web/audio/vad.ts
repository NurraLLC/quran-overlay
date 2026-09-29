// Voice activity for the silence skipper. Speech recognition is billed for as long as a stream is
// open, so after a long silence the stream is closed and reopened when the voice returns. This is
// the decision, kept free of browser APIs so it can be tested; the audio-thread worklet in mic.ts
// embeds its source text, so it must stay one self-contained function (no imports, no classes,
// nothing the bundler could replace with a shared helper).

export type VadEvent = 'voice' | 'quiet';

/**
 * A detector for blocks of samples at `sampleRate`. Each call returns 'voice' when speech starts
 * after a long pause (or at first), 'quiet' once when a pause reaches `quietAfterMs`, else null.
 */
export function createVad(sampleRate: number, quietAfterMs: number): (block: Float32Array) => VadEvent | null {
  let floor = 0.001;
  let onset = 0;
  let sinceVoice = 0;
  let quietSent = true;
  return function push(block: Float32Array): VadEvent | null {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / Math.max(1, block.length));
    // Background level: follows quiet quickly, rises very slowly (it tracks a noisy room over a
    // minute but never learns continuous recitation as "noise").
    if (rms < floor) floor += (rms - floor) * 0.2;
    else floor *= 1 + 0.02 * (block.length / sampleRate);
    if (floor < 0.0002) floor = 0.0002;
    // Speech: 12 dB over the background and above -50 dBFS, for about 30 ms (not a click).
    const voiced = rms > floor * 4 && rms > 0.003;
    onset = voiced ? onset + block.length : 0;
    if (onset >= sampleRate * 0.03) {
      sinceVoice = 0;
      if (quietSent) {
        quietSent = false;
        return 'voice';
      }
      return null;
    }
    sinceVoice += block.length;
    if (!quietSent && sinceVoice >= (sampleRate * quietAfterMs) / 1000) {
      quietSent = true;
      return 'quiet';
    }
    return null;
  };
}
