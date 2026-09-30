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

const WORKLET = `
const createVad = (${createVad.toString()});
class QoVad extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.push = createVad(sampleRate, options.processorOptions.quietAfterMs);
    this.pause = createVad(sampleRate, options.processorOptions.pauseMs);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const r = this.push(ch);
      if (r) this.port.postMessage(r);
      const p = this.pause(ch);
      if (p) this.port.postMessage('pause:' + p);
    }
    return true;
  }
}
registerProcessor('qo-vad', QoVad);
`;

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
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array | null = null;
  private vad: AudioWorkletNode | null = null;
  private muteHandlers = new Set<(muted: boolean) => void>();

  private constructor(readonly stream: MediaStream) {}

  static async open(constraints: MediaTrackConstraints, quietAfterMs: number, onVoice: (e: 'voice' | 'quiet') => void, onPause: (speaking: boolean) => void = () => undefined): Promise<SharedMic> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new MicError('unavailable', 'navigator.mediaDevices.getUserMedia is not available');
    if (typeof MediaRecorder === 'undefined') throw new MicError('unavailable', 'MediaRecorder is not available');
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
    await mic.attach(quietAfterMs, onVoice, onPause);
    return mic;
  }

  /** Level meter and the voice detector. Without them listening still works, just never pauses. */
  private async attach(quietAfterMs: number, onVoice: (e: 'voice' | 'quiet') => void, onPause: (speaking: boolean) => void) {
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      const src = ctx.createMediaStreamSource(this.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.analyser = analyser;
      this.buf = new Float32Array(analyser.fftSize);
      // The detector runs on the audio thread: page timers are throttled in background tabs (a
      // streamer's control page), audio-thread messages are not.
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const vad = new AudioWorkletNode(ctx, 'qo-vad', { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { quietAfterMs, pauseMs: PAUSE_QUIET_MS } });
      vad.port.onmessage = (e: MessageEvent<'voice' | 'quiet' | 'pause:voice' | 'pause:quiet'>) => {
        if (e.data === 'pause:voice' || e.data === 'pause:quiet') onPause(e.data === 'pause:voice');
        else onVoice(e.data);
      };
      src.connect(vad);
      this.vad = vad;
    } catch {
      this.vad = null;
    }
  }

  /** The detector is running (otherwise the stream never pauses, as before the skipper). */
  get detecting() {
    return !!this.vad;
  }

  onMute(h: (muted: boolean) => void) {
    this.muteHandlers.add(h);
    return () => this.muteHandlers.delete(h);
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
    const recorder = new MediaRecorder(this.mic.stream);
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
