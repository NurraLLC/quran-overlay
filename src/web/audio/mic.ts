// One microphone for a whole listening session, shared by every provider stream it opens. The
// silence skipper closes the provider stream during long pauses (it is billed while open) and opens
// a new one when the voice returns; the microphone stays open locally in between so the return of
// the voice is heard at once. Nothing leaves the device while no stream is open.
import type { AudioSource, AudioSourceHandlers } from '@soniox/client';
import { createVad } from './vad';

/**
 * Silence this long between words is a pause (a breath, a stop at a pause mark). Longer than the
 * closure of a doubled stop consonant, shorter than a breath. The tracker hears it at once instead
 * of ~0.8 s later from the recogniser, so the highlight waits instead of running ahead.
 */
export const PAUSE_QUIET_MS = 180;
/** Voiced audio needed before the voice counts as back (createVad's onset). */
export const VOICE_ONSET_MS = 30;

/**
 * Provider audio. WebM/Opus where MediaRecorder makes it (Chrome, Android, Firefox, Safari 18.4+);
 * the provider detects it. Safari before 18.4 records only MP4/AAC, which Soniox's real-time API
 * does not list, so there the audio thread sends 16 kHz mono 16-bit PCM instead (32 KB/s).
 */
export const WEBM_OPUS = 'audio/webm;codecs=opus';
export const PCM_RATE = 16_000;
export const PCM_FORMAT = { audio_format: 'pcm_s16le', sample_rate: PCM_RATE, num_channels: 1 } as const;

/**
 * The PCM path's resampler: a low-pass below the new Nyquist (Hann-windowed sinc, so the voice's
 * upper harmonics don't fold back as noise), then linear interpolation. Float blocks in, 16-bit
 * samples out, state carried across blocks. Like createVad it runs on the audio thread from its
 * source text, so it must stay one self-contained function.
 */
export function createDownsampler(inRate: number, outRate: number): (block: Float32Array) => Int16Array {
  const step = inRate / outRate;
  const half = step > 1 ? 8 * Math.ceil(step) : 0;
  const taps = new Float32Array(2 * half + 1);
  const fc = (0.45 * Math.min(inRate, outRate)) / inRate;
  let sum = 0;
  for (let k = -half; k <= half; k++) {
    const h = (k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k)) * (half ? 0.5 + 0.5 * Math.cos((Math.PI * k) / (half + 1)) : 1);
    taps[k + half] = h;
    sum += h;
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum;
  const keep = taps.length - 1;
  let ext = new Float32Array(keep); // the previous block's last inputs, then the current block
  let y = new Float32Array(0);
  let prev = 0; // the previous block's last filtered sample
  let pos = 0; // the next output position, in filtered samples after `prev`
  return function push(block: Float32Array): Int16Array {
    const n = block.length;
    if (ext.length !== keep + n) {
      const grown = new Float32Array(keep + n);
      grown.set(ext.subarray(0, keep));
      ext = grown;
      y = new Float32Array(n);
    }
    ext.set(block, keep);
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let m = 0; m <= keep; m++) acc += taps[m] * ext[j + m];
      y[j] = acc;
    }
    ext.copyWithin(0, n);
    const out = new Int16Array(Math.max(0, Math.ceil((n - pos) / step)) + 1);
    let o = 0;
    for (; pos < n; pos += step) {
      const i = Math.floor(pos);
      const a = i === 0 ? prev : y[i - 1];
      const v = (a + (y[i] - a) * (pos - i)) * 32767;
      out[o++] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
    }
    pos -= n;
    if (n) prev = y[n - 1];
    return out.subarray(0, o);
  };
}

/** Both audio-thread processors: the voice detector and the PCM path. */
export const WORKLET = `
const createVad = (${createVad.toString()});
const createDownsampler = (${createDownsampler.toString()});
// A muted or not-yet-flowing input can arrive without channels: it counts as silence, so a muted
// microphone dozes like a quiet one and the PCM clock keeps wall time.
const SILENCE = new Float32Array(128);
class QoVad extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.push = createVad(sampleRate, options.processorOptions.quietAfterMs);
    this.pause = createVad(sampleRate, options.processorOptions.pauseMs);
  }
  process(inputs) {
    const ch = (inputs[0] && inputs[0][0]) || SILENCE;
    const r = this.push(ch);
    if (r) this.port.postMessage(r);
    const p = this.pause(ch);
    if (p) this.port.postMessage('pause:' + p);
    return true;
  }
}
registerProcessor('qo-vad', QoVad);
class QoPcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.down = createDownsampler(sampleRate, options.processorOptions.rate);
    this.size = options.processorOptions.chunk;
    this.buf = new Int16Array(this.size);
    this.n = 0;
    this.on = true;
    this.port.onmessage = () => { this.on = false; };
  }
  process(inputs) {
    if (!this.on) return false;
    const pcm = this.down((inputs[0] && inputs[0][0]) || SILENCE);
    for (let i = 0; i < pcm.length; i++) {
      this.buf[this.n++] = pcm[i];
      if (this.n === this.size) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('qo-pcm', QoPcm);
`;

/** Loads both processors: from a blob: address, or a data: address if that one is refused. */
async function loadWorklet(ctx: AudioContext) {
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } catch {
    await ctx.audioWorklet.addModule(`data:text/javascript;charset=utf-8,${encodeURIComponent(WORKLET)}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const canRecordWebm = () => typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(WEBM_OPUS);

export type MicErrorKind = 'permission' | 'device' | 'busy' | 'unavailable';
export class MicError extends Error {
  constructor(
    readonly kind: MicErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export class SharedMic {
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  /** A silent path to the output: worklet nodes are then pulled by the audio graph in every engine. */
  private sink: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array | null = null;
  private vad: AudioWorkletNode | null = null;
  private muteHandlers = new Set<(muted: boolean) => void>();

  private constructor(readonly stream: MediaStream) {}

  /**
   * `onChange`: the system ended the microphone, or suspended or resumed the audio thread (iOS does
   * both while the screen is off or during a call).
   */
  static async open(constraints: MediaTrackConstraints, quietAfterMs: number, onVoice: (e: 'voice' | 'quiet') => void, onPause: (speaking: boolean) => void = () => undefined, onChange: () => void = () => undefined): Promise<SharedMic> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new MicError('unavailable', 'navigator.mediaDevices.getUserMedia is not available');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') throw new MicError('permission', 'Microphone access denied');
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') throw new MicError('device', 'No microphone found');
      if (name === 'NotReadableError' || name === 'TrackStartError') throw new MicError('busy', 'Microphone is in use or not readable');
      throw new MicError('unavailable', err instanceof Error ? err.message : 'Failed to access the microphone');
    }
    const mic = new SharedMic(stream);
    const track = stream.getAudioTracks()[0];
    track?.addEventListener('mute', () => mic.muteHandlers.forEach((h) => h(true)));
    track?.addEventListener('unmute', () => mic.muteHandlers.forEach((h) => h(false)));
    track?.addEventListener('ended', onChange);
    await mic.attach(quietAfterMs, onVoice, onPause, onChange);
    // Provider audio needs a MediaRecorder or the audio thread's PCM path.
    if (typeof MediaRecorder === 'undefined' && !mic.pcmReady) {
      mic.close();
      throw new MicError('unavailable', 'Neither MediaRecorder nor AudioWorklet is available');
    }
    return mic;
  }

  /** Level meter, voice detector and PCM path. Without the worklet listening still works on WebM, just never pauses. */
  private async attach(quietAfterMs: number, onVoice: (e: 'voice' | 'quiet') => void, onPause: (speaking: boolean) => void, onChange: () => void) {
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      ctx.addEventListener('statechange', onChange);
      const src = ctx.createMediaStreamSource(this.stream);
      this.src = src;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.analyser = analyser;
      this.buf = new Float32Array(analyser.fftSize);
      // The detector runs on the audio thread: page timers are throttled in background tabs (a
      // streamer's control page), audio-thread messages are not.
      await loadWorklet(ctx);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);
      this.sink = sink;
      const vad = new AudioWorkletNode(ctx, 'qo-vad', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { quietAfterMs, pauseMs: PAUSE_QUIET_MS } });
      vad.port.onmessage = (e: MessageEvent<'voice' | 'quiet' | 'pause:voice' | 'pause:quiet'>) => {
        if (e.data === 'pause:voice' || e.data === 'pause:quiet') onPause(e.data === 'pause:voice');
        else onVoice(e.data);
      };
      src.connect(vad);
      vad.connect(sink);
      this.vad = vad;
    } catch {
      this.vad = null;
    }
  }

  /** The detector is running (otherwise the stream never pauses, as before the skipper). */
  get detecting() {
    return !!this.vad;
  }

  /** The audio thread can send PCM (the worklet loaded). */
  get pcmReady() {
    return !!this.vad && !!this.src && !!this.sink;
  }

  /** The system has not ended the microphone. */
  get live() {
    return this.stream.getAudioTracks().some((t) => t.readyState === 'live');
  }

  /** The system suspended the audio thread (level meter, voice detector, PCM). False without one. */
  get suspended() {
    return !!this.ctx && this.ctx.state !== 'running';
  }

  /**
   * Wakes an audio thread the system suspended (iOS sets it "interrupted" when the screen goes off
   * and may keep it so until the next touch). Resolves true once nothing is suspended; never waits long.
   */
  async resume(): Promise<boolean> {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    return !this.suspended;
  }

  onMute(h: (muted: boolean) => void) {
    this.muteHandlers.add(h);
    return () => this.muteHandlers.delete(h);
  }

  /**
   * One provider stream's audio: WebM/Opus from MediaRecorder where available, else 16 kHz PCM from
   * the audio thread. `forcePcm` takes the PCM path anyway (tests, lab).
   */
  streamSource(timesliceMs: number, forcePcm = false): { source: AudioSource; pcm: boolean } {
    if (!forcePcm && canRecordWebm()) return { source: new MicStreamSource(this, timesliceMs, WEBM_OPUS), pcm: false };
    if (this.pcmReady) return { source: new PcmStreamSource(this, timesliceMs), pcm: true };
    return { source: new MicStreamSource(this, timesliceMs), pcm: false }; // last resort: the browser's own format
  }

  /** Starts sending PCM chunks of `chunkMs` to `onChunk`; returns the stop. Null without the worklet. */
  pcm(chunkMs: number, onChunk: (chunk: ArrayBuffer) => void): (() => void) | null {
    const { ctx, src, sink } = this;
    if (!ctx || !src || !sink || !this.vad) return null;
    const node = new AudioWorkletNode(ctx, 'qo-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { rate: PCM_RATE, chunk: Math.round((PCM_RATE * chunkMs) / 1000) } });
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onChunk(e.data);
    src.connect(node);
    node.connect(sink);
    return () => {
      // The processor ends itself on 'stop'; disconnected, it is no longer pulled by the graph anyway.
      node.port.onmessage = null;
      node.port.postMessage('stop');
      try {
        src.disconnect(node);
      } catch {
        /* already disconnected */
      }
      node.disconnect();
    };
  }

  /** Current input level, 0..1 (speech sits around 0.2–0.7). */
  level(): number {
    const a = this.analyser;
    const buf = this.buf;
    if (!a || !buf) return 0;
    a.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    return Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 60) / 45));
  }

  close() {
    this.vad?.port.close();
    this.vad = null;
    this.src = null;
    this.sink = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * A provider stream's audio: a fresh MediaRecorder on the shared microphone (so each stream starts
 * with its own container header). Stopping it leaves the microphone open.
 */
export class MicStreamSource implements AudioSource {
  private recorder: MediaRecorder | null = null;
  private offMute: (() => void) | null = null;
  private handlers: AudioSourceHandlers | null = null;

  constructor(
    private readonly mic: SharedMic,
    private readonly timesliceMs: number,
    private readonly mimeType?: string,
  ) {}

  async start(handlers: AudioSourceHandlers) {
    this.stop();
    this.handlers = handlers;
    this.offMute = this.mic.onMute((muted) => (muted ? handlers.onMuted?.() : handlers.onUnmuted?.()));
    this.begin();
  }

  private begin() {
    const h = this.handlers;
    if (!h) return;
    const recorder = new MediaRecorder(this.mic.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    this.recorder = recorder;
    recorder.addEventListener('dataavailable', (e) => {
      if (this.recorder !== recorder || e.data.size === 0) return;
      e.data.arrayBuffer().then(
        (b) => this.recorder === recorder && h.onData(b),
        (err) => h.onError(err instanceof Error ? err : new Error(String(err))),
      );
    });
    recorder.addEventListener('error', (e) => this.recorder === recorder && h.onError(new Error((e as ErrorEvent).message || 'MediaRecorder error')));
    recorder.start(this.timesliceMs);
  }

  stop() {
    const r = this.recorder;
    this.recorder = null;
    if (r && r.state !== 'inactive') r.stop();
    this.offMute?.();
    this.offMute = null;
    this.handlers = null;
  }

  pause() {
    if (this.recorder?.state === 'recording') this.recorder.pause();
  }

  resume() {
    if (this.recorder?.state === 'paused') this.recorder.resume();
  }

  /** New container header for a reconnected provider session. */
  restart() {
    const r = this.recorder;
    this.recorder = null;
    if (r && r.state !== 'inactive') r.stop();
    this.begin();
  }
}

/**
 * A provider stream's audio as 16 kHz mono 16-bit PCM from the audio thread, in chunks of
 * `chunkMs` (the same length as a recorder timeslice, so the first chunk still marks the stream's
 * audio time 0 the same way). Stopping it leaves the microphone open.
 */
export class PcmStreamSource implements AudioSource {
  private stopTap: (() => void) | null = null;
  private offMute: (() => void) | null = null;
  private handlers: AudioSourceHandlers | null = null;
  private paused = false;

  constructor(
    private readonly mic: SharedMic,
    private readonly chunkMs: number,
  ) {}

  async start(handlers: AudioSourceHandlers) {
    this.stop();
    this.handlers = handlers;
    this.offMute = this.mic.onMute((muted) => (muted ? handlers.onMuted?.() : handlers.onUnmuted?.()));
    this.begin();
  }

  private begin() {
    const h = this.handlers;
    if (!h) return;
    const stop = this.mic.pcm(this.chunkMs, (chunk) => {
      if (this.stopTap === stop && !this.paused) h.onData(chunk);
    });
    if (!stop) return h.onError(new Error('The audio thread is not available.'));
    this.stopTap = stop;
  }

  stop() {
    this.stopTap?.();
    this.stopTap = null;
    this.offMute?.();
    this.offMute = null;
    this.handlers = null;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  /** A reconnected provider session starts from a fresh chunk (its audio time 0). */
  restart() {
    this.stopTap?.();
    this.stopTap = null;
    this.begin();
  }
}
