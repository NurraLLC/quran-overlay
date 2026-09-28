// Soniox Web SDK lifecycle + transcript event adapter (verified against @soniox/client 2.3.0
// declarations: SonioxClient({config}), client.realtime.record(), MicrophoneSource, finalize(),
// cancel(), session_restart). The browser never sees the long-lived key: config() fetches a
// single-use temporary key from the local server for each stream (and each reconnect).

import { MicrophoneSource, SonioxClient, type RealtimeResult, type Recording } from '@soniox/client';
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

export class SonioxCapture {
  private recording: Recording | null = null;
  private epoch = 0;
  private seq = 0;
  private stopping = false;
  private startedAt = 0;
  private lastProcMs = 0;
  private lastResultAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
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
          const body = (await res.json().catch(() => ({}))) as { error?: string };
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
    const source = new MicrophoneSource({
      constraints: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const rec = this.client().realtime.record({
      model: 'stt-rt-v5',
      language_hints: ['ar', 'en'],
      enable_endpoint_detection: true,
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
      const detail = describeError(e);
      this.teardown();
      this.setStatus({ state: 'error', detail });
      if (!this.commandOnly) this.send({ type: 'capture', captureEpoch: this.epoch, event: 'error', detail });
      this.finalizeWaiter?.(true);
    });
    if (!this.commandOnly) {
      this.restartTimer = setTimeout(() => void this.restart(), PROACTIVE_RESTART_MS);
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
    const { recitation, finalized } = this.router.route(tokens);
    if (this.router.active) this.onHearing(this.router.hearing());
    if (finalized) this.finalizeWaiter?.(false);
    if (this.commandOnly || !recitation.length) return;
    this.send({ type: 'transcript', captureEpoch: epoch, seq: this.seq++, tokens: recitation, receivedAt: performance.now() });
  }

  private teardown() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
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
    this.setStatus({ state: 'off', detail: null });
    if (!wasCommandOnly) this.send({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
  }

  private async restart() {
    const device = this.deviceId;
    this.stop();
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
