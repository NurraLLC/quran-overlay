// Soniox Web SDK lifecycle + transcript event adapter (verified against @soniox/client 2.3.0
// declarations: SonioxClient({config}), client.realtime.record(), MicrophoneSource, finalize(),
// cancel(), session_restart). The browser never sees the long-lived key: config() fetches a
// single-use temporary key from the local server for each stream (and each reconnect).

import { MicrophoneSource, SonioxClient, type AudioSource, type AudioSourceHandlers, type RealtimeResult, type Recording } from '@soniox/client';
import type { ControlClientMessage } from '../../shared/contracts';
import type { WireToken } from '../../shared/transcript';
import { TokenRouter, type CommandCapture } from './command-lane';

/** Restart before the explicit per-stream cap minted by the server (3 h), without replaying captions. */
const PROACTIVE_RESTART_MS = 175 * 60 * 1000;
const FINALIZE_WAIT_MS = 2500;

export type CaptureStatus = { state: 'off' | 'starting' | 'recording' | 'reconnecting' | 'error'; detail: string | null };

function describeError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  const code = (e as { code?: string })?.code ?? '';
  if (name === 'AudioPermissionError' || code === 'permission_denied') return 'Microphone permission was denied. Allow the microphone for this page in the browser’s site settings, then start again.';
  if (name === 'AudioDeviceError' || code === 'device_not_found') return 'The selected microphone was not found. It may have been unplugged; pick another microphone.';
  if (name === 'AudioUnavailableError') return 'This browser cannot capture audio here. Use a current Chrome or Edge on this computer.';
  if (code === 'auth_error') return 'Soniox rejected the temporary key. Check SONIOX_API_KEY permissions.';
  if (code === 'quota_exceeded') return 'Soniox quota or rate limit reached.';
  if (code === 'network_error' || code === 'connection_error') return 'Lost the connection to Soniox.';
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 200) || 'Listening stopped because of an unexpected error.';
}

/**
 * Lab-only recognition tuning from the page URL (`?stt={"timeslice":20,...}`), used by the speed
 * lab to A/B provider settings on identical audio. Only these known keys are read.
 */
type SttTuning = { hints?: string[]; timeslice?: number; max_endpoint_delay_ms?: number; endpoint_sensitivity?: number; endpoint_latency_adjustment_level?: number; language_hints_strict?: boolean };
function sttTuning(): SttTuning {
  try {
    const raw = JSON.parse(new URLSearchParams(location.search).get('stt') ?? '{}') as Record<string, unknown>;
    const num = (k: string, lo: number, hi: number) => (typeof raw[k] === 'number' && (raw[k] as number) >= lo && (raw[k] as number) <= hi ? (raw[k] as number) : undefined);
    return {
      hints: Array.isArray(raw.hints) && raw.hints.every((h) => typeof h === 'string') ? (raw.hints as string[]).slice(0, 4) : undefined,
      timeslice: num('timeslice', 10, 250),
      max_endpoint_delay_ms: num('max_endpoint_delay_ms', 500, 3000),
      endpoint_sensitivity: num('endpoint_sensitivity', -1, 1),
      endpoint_latency_adjustment_level: num('endpoint_latency_adjustment_level', 0, 3),
      language_hints_strict: typeof raw.language_hints_strict === 'boolean' ? raw.language_hints_strict : undefined,
    };
  } catch {
    return {};
  }
}
const TUNING = sttTuning();
const TIMESLICE_MS = TUNING.timeslice ?? 60;

/**
 * Pass-through microphone source that records when audio starts flowing. Soniox token times are
 * relative to the first audio of the stream, so this is the zero point for the live speed meter.
 * restart() (SDK reconnect) starts a new stream and a new zero point.
 */
class TimedSource implements AudioSource {
  firstChunkAt: number | null = null;
  constructor(private readonly inner: MicrophoneSource) {}
  start(handlers: AudioSourceHandlers) {
    return this.inner.start({
      ...handlers,
      onData: (chunk) => {
        if (this.firstChunkAt === null) this.firstChunkAt = performance.now();
        handlers.onData(chunk);
      },
    });
  }
  stop() {
    this.inner.stop();
  }
  pause() {
    this.inner.pause();
  }
  resume() {
    this.inner.resume();
  }
  restart() {
    this.firstChunkAt = null;
    this.inner.restart();
  }
  /** performance.now() of provider audio time 0 (first chunk carries TIMESLICE_MS of audio). */
  get audioOrigin(): number | null {
    return this.firstChunkAt === null ? null : this.firstChunkAt - TIMESLICE_MS;
  }
}

/**
 * Listening stops by itself after this long without Arabic recitation (silence, noise or only
 * English talk): audio is billed while it streams, so an idle microphone must not stay open.
 */
export const IDLE_STOP_MS = 60_000;
const ARABIC = /[ء-ي]/;

/**
 * After English speech the recogniser tends to stay in English and writes the following recitation
 * in Latin letters ("Inna fatahna ... Bismillahirrahmanirrahim"), which nothing can follow. A fresh
 * stream starts without that bias, so English speech ending, or recitation arriving in Latin
 * letters, restarts the stream (the display and tracker keep their place).
 */
const LATIN = /[A-Za-z]/;
const TRANSLITERATED = /^(bismillah\w*|allah\w*|alhamd\w*|rahman\w*|rahim\w*|ar-?rahman\w*|inna|qul|subhan\w*|ya-?ayyuha\w*|ayyuha\w*|lillah\w*)$/i;
/** At most one language reset per this long, so a stubborn case can never loop restarts. */
const RESET_MIN_GAP_MS = 15_000;

export class SonioxCapture {
  private timed: TimedSource | null = null;
  /** performance.now() corresponding to Soniox audio time 0 of the current stream, if known. */
  get audioOrigin(): number | null {
    return this.timed?.audioOrigin ?? null;
  }

  private recording: Recording | null = null;
  private epoch = 0;
  private seq = 0;
  private stopping = false;
  private startedAt = 0;
  private lastProcMs = 0;
  private lastResultAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** performance.now() of the last recognised Arabic (kept across proactive restarts). */
  private lastArabicAt = 0;
  /** The newest recognised words are English (Latin script). */
  private latinTail = false;
  private lastResetAt = 0;
  /** Set when the server refused a key for lack of listening time (a clean stop, not a failure). */
  private noCredits: string | null = null;
  private resetting = false;
  /** Resets triggered by recitation in Latin letters this session (the server can read those too). */
  private latinResets = 0;
  private deviceId: string | null = null;
  private commandOnly = false;
  readonly router = new TokenRouter();
  private finalizeWaiter: ((timedOut: boolean) => void) | null = null;
  status: CaptureStatus = { state: 'off', detail: null };

  constructor(
    private readonly send: (m: ControlClientMessage) => void,
    private readonly onStatus: (s: CaptureStatus) => void,
    private readonly onHearing: (text: string) => void,
  ) {}

  /** Current capture epoch (matches the server's speed evidence). */
  get captureEpoch() {
    return this.epoch;
  }

  get listening() {
    return !!this.recording && !this.commandOnly;
  }

  private setStatus(s: CaptureStatus) {
    this.status = s;
    this.onStatus(s);
  }

  private nextEpoch() {
    this.epoch = Math.max(this.epoch + 1, Date.now());
    this.seq = 0;
    return this.epoch;
  }

  private client() {
    return new SonioxClient({
      config: async () => {
        const res = await fetch('/api/soniox/temporary-key', { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; limitedBy?: string | null; renewsAt?: number };
          if (body.error === 'NO_CREDITS') {
            const renews = body.renewsAt ? new Date(body.renewsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' }) : 'next month';
            this.noCredits =
              body.limitedBy === 'network'
                ? "Today's free listening on this network is used up. It comes back tomorrow."
                : body.limitedBy === 'service'
                  ? "Today's free listening for everyone is used up. It comes back tomorrow."
                  : `This month's free listening is used up. It renews on ${renews}.`;
            throw new Error(this.noCredits);
          }
          throw new Error(body.error === 'NOT_CONFIGURED' ? 'Soniox is not set up: add SONIOX_API_KEY to .env and restart the server.' : `Could not get a Soniox key (${body.error ?? res.status}).`);
        }
        const { api_key } = (await res.json()) as { api_key: string };
        return { api_key };
      },
    });
  }

  /** Estimated provider audio clock now (ms since the stream's audio start). */
  audioNowMs(): number {
    if (this.lastResultAt) return this.lastProcMs + (performance.now() - this.lastResultAt);
    return performance.now() - this.startedAt;
  }

  async start(deviceId: string | null, opts: { commandOnly?: boolean } = {}) {
    if (this.recording) return;
    this.deviceId = deviceId;
    this.commandOnly = !!opts.commandOnly;
    this.stopping = false;
    const epoch = this.nextEpoch();
    if (!this.commandOnly) this.send({ type: 'capture', captureEpoch: epoch, event: 'starting' });
    this.setStatus({ state: 'starting', detail: null });
    this.startedAt = performance.now();
    this.lastResultAt = 0;
    this.lastProcMs = 0;
    const source = new TimedSource(
      new MicrophoneSource({
        constraints: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        timesliceMs: TIMESLICE_MS,
      }),
    );
    this.timed = source;
    const rec = this.client().realtime.record({
      model: 'stt-rt-v5',
      // Arabic only: with English also hinted, plainly read (unmelodic) recitation is often written
      // in Latin letters. English requests are still transcribed as English (measured in the lab).
      language_hints: TUNING.hints ?? ['ar'],
      enable_endpoint_detection: true,
      ...(TUNING.max_endpoint_delay_ms !== undefined ? { max_endpoint_delay_ms: TUNING.max_endpoint_delay_ms } : {}),
      ...(TUNING.endpoint_sensitivity !== undefined ? { endpoint_sensitivity: TUNING.endpoint_sensitivity } : {}),
      ...(TUNING.endpoint_latency_adjustment_level !== undefined ? { endpoint_latency_adjustment_level: TUNING.endpoint_latency_adjustment_level } : {}),
      ...(TUNING.language_hints_strict !== undefined ? { language_hints_strict: TUNING.language_hints_strict } : {}),
      context: {
        general: [
          { key: 'domain', value: 'Quran recitation in Arabic (Hafs)' },
          { key: 'also', value: 'occasional short English navigation requests' },
        ],
      },
      source,
      auto_reconnect: true,
      max_reconnect_attempts: 3,
      reset_transcript_on_reconnect: true,
    });
    this.recording = rec;
    rec.on('result', (r) => {
      if (this.recording === rec) this.onResult(r, this.epoch);
    });
    rec.on('finalized', () => {
      this.finalizeWaiter?.(false);
    });
    rec.on('session_restart', () => {
      // Provider coordinates reset on reconnect: bind a new epoch so old offsets never apply.
      if (this.recording !== rec || this.commandOnly) return;
      const e = this.nextEpoch();
      this.send({ type: 'capture', captureEpoch: e, event: 'recording' });
      this.lastResultAt = 0;
      this.startedAt = performance.now();
    });
    rec.on('state_change', ({ new_state }) => {
      if (this.recording !== rec || this.stopping) return;
      if (new_state === 'recording') {
        this.setStatus({ state: 'recording', detail: null });
        if (!this.commandOnly) this.send({ type: 'capture', captureEpoch: this.epoch, event: 'recording' });
      } else if (new_state === 'reconnecting') {
        this.setStatus({ state: 'reconnecting', detail: 'Reconnecting to Soniox…' });
        if (!this.commandOnly) this.send({ type: 'capture', captureEpoch: this.epoch, event: 'reconnecting' });
      }
    });
    rec.on('source_muted', () => !this.commandOnly && this.send({ type: 'capture', captureEpoch: this.epoch, event: 'muted' }));
    rec.on('source_unmuted', () => !this.commandOnly && this.send({ type: 'capture', captureEpoch: this.epoch, event: 'unmuted' }));
    rec.on('error', (e) => {
      if (this.recording !== rec || this.stopping) return;
      // Out of listening time: stop cleanly (the page keeps its place) and say why.
      if (this.noCredits) {
        const detail = this.noCredits;
        this.noCredits = null;
        this.stop();
        this.setStatus({ state: 'off', detail });
        return;
      }
      // Each provider key has a maximum length (hosted: at most the time left, and 20 min per key).
      // Reaching it is not a failure: continue on a fresh key, which the server grants only if time
      // remains.
      const msg = e instanceof Error ? e.message : String(e);
      if (!this.commandOnly && /session duration limit/i.test(msg) && performance.now() - this.startedAt > 10_000) {
        void this.restart();
        return;
      }
      const detail = describeError(e);
      this.teardown();
      this.setStatus({ state: 'error', detail });
      if (!this.commandOnly) this.send({ type: 'capture', captureEpoch: this.epoch, event: 'error', detail });
      this.finalizeWaiter?.(true);
    });
    if (!this.commandOnly) {
      this.restartTimer = setTimeout(() => void this.restart(), PROACTIVE_RESTART_MS);
      if (!this.lastArabicAt) this.lastArabicAt = performance.now();
      this.idleTimer = setInterval(() => {
        if (performance.now() - this.lastArabicAt < IDLE_STOP_MS) return;
        this.stop();
        this.setStatus({ state: 'off', detail: `Stopped listening after ${Math.round(IDLE_STOP_MS / 60_000)} minute without recitation, so nothing is used while idle. Start again when you are ready.` });
      }, 2000);
    }
  }

  private onResult(r: RealtimeResult, epoch: number) {
    if (this.stopping || epoch !== this.epoch) return; // late results after Stop never resume the overlay
    this.lastProcMs = r.total_audio_proc_ms;
    this.lastResultAt = performance.now();
    const tokens: WireToken[] = r.tokens.map((t) => ({
      text: t.text,
      isFinal: t.is_final,
      startMs: t.start_ms,
      endMs: t.end_ms,
      confidence: t.confidence,
    }));
    if (tokens.some((t) => ARABIC.test(t.text))) this.lastArabicAt = performance.now();
    if (!this.commandOnly) this.watchLanguage(tokens);
    const { recitation, finalized } = this.router.route(tokens);
    if (this.router.active) this.onHearing(this.router.hearing());
    if (finalized) this.finalizeWaiter?.(false);
    if (this.commandOnly || !recitation.length) return;
    this.send({ type: 'transcript', captureEpoch: epoch, seq: this.seq++, tokens: recitation, receivedAt: performance.now() });
  }

  private watchLanguage(tokens: WireToken[]) {
    let endpoint = false;
    let transliterated = 0;
    let latinWords = 0;
    for (const t of tokens) {
      const text = t.text.trim();
      if (text === '<end>' || text === '<fin>') endpoint = true;
      else if (ARABIC.test(text)) this.latinTail = false;
      else if (LATIN.test(text)) {
        this.latinTail = true;
        for (const w of text.split(/[^A-Za-z-]+/).filter(Boolean)) {
          latinWords++;
          if (TRANSLITERATED.test(w)) transliterated++;
        }
      }
    }
    // Recitation in Latin letters: reset now. English that just ended: reset before recitation resumes.
    // (An English request that mentions "Allah" is mostly other words; recitation is mostly these.)
    const recitingInLatin = transliterated >= 2 && transliterated * 2 >= latinWords;
    // A plain (unmelodic) reader may always be written in Latin letters; the server reads those, so
    // stop spending audio on restarts after two tries. English speech ending still resets.
    if (recitingInLatin && this.latinResets < 2) {
      this.latinResets++;
      void this.resetLanguage();
    } else if (endpoint && this.latinTail && !recitingInLatin) void this.resetLanguage();
  }

  /** Restart the stream so the recogniser starts without an English bias; keeps the idle clock. */
  private async resetLanguage() {
    const now = performance.now();
    if (this.resetting || now - this.lastResetAt < RESET_MIN_GAP_MS) return;
    this.resetting = true;
    this.lastResetAt = now;
    this.latinTail = false;
    try {
      await this.restart();
    } finally {
      this.resetting = false;
    }
  }

  private teardown() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    const rec = this.recording;
    this.recording = null;
    try {
      rec?.cancel();
    } catch {
      /* already closed */
    }
  }

  /** Stop listening: close tracks and the connection immediately; ignore anything after. */
  stop() {
    if (!this.recording) return;
    this.stopping = true;
    const epoch = this.epoch;
    const wasCommandOnly = this.commandOnly;
    this.teardown();
    this.router.cancel();
    this.lastArabicAt = 0;
    if (!this.resetting) this.latinResets = 0;
    this.setStatus({ state: 'off', detail: null });
    if (!wasCommandOnly) this.send({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
  }

  private async restart() {
    const device = this.deviceId;
    const lastArabic = this.lastArabicAt;
    this.stop();
    this.lastArabicAt = lastArabic; // a proactive reconnect is not new speech
    await this.start(device);
  }

  // ---------- push-to-talk ----------

  async beginCommand(deviceId: string | null): Promise<void> {
    this.send({ type: 'command_capture', active: true });
    if (!this.recording) await this.start(deviceId, { commandOnly: true });
    this.router.begin(this.audioNowMs());
    this.onHearing('');
  }

  async endCommand(): Promise<CommandCapture> {
    const rec = this.recording;
    this.router.release(this.audioNowMs());
    let result: CommandCapture;
    if (!rec) {
      result = this.router.finish(true);
    } else {
      // Manual finalize is right here: the user explicitly ended the command.
      const timedOut = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), FINALIZE_WAIT_MS);
        this.finalizeWaiter = (to) => {
          clearTimeout(t);
          resolve(to);
        };
        try {
          rec.finalize();
        } catch {
          clearTimeout(t);
          resolve(true);
        }
      });
      this.finalizeWaiter = null;
      result = this.router.finish(timedOut);
    }
    if (this.commandOnly) this.stop();
    this.send({ type: 'command_capture', active: false });
    return result;
  }
}
