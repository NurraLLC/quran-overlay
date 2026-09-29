import { randomBytes } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type { CreditStore } from '../billing/credits';
import { IDLE_LIMIT_MS, ListeningSafety } from '../billing/listening-safety';
import { mintTemporaryKey } from './soniox';

type Options = {
  credits: CreditStore;
  safety: ListeningSafety;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  isRecitation: (text: string) => boolean;
  onSettled: (id: string) => void;
  /** Server-owned injection points for local provider tests only. */
  endpoint?: string;
  idleLimitMs?: number;
};
type Ticket = { value: string; expires: number; ip: string };
const MAX_BUFFER = 512 * 1024;

/** Hosted-only audio relay. No recording, no client-controlled provider options or credentials. */
export class HostedSpeech {
  private tickets = new Map<string, Ticket>();
  private active = new Map<string, () => void>();
  private connections = new Set<() => void>();
  constructor(private o: Options) {}

  issue(id: string, ip: string) {
    const now = Date.now();
    for (const [key, ticket] of this.tickets) if (ticket.expires < now) this.tickets.delete(key);
    const safety = this.o.safety.status(id, ip, now);
    if (safety.retryAfter) return { error: 'LISTENING_COOLDOWN', retryAfter: safety.retryAfter };
    if (!this.o.apiKey) return { error: 'NOT_CONFIGURED' };
    if (this.tickets.size >= 5000 && !this.tickets.has(id)) return { error: 'SERVICE_BUSY' };
    const balance = this.o.credits.balance(id, ip, now);
    if (balance.available < this.o.credits.cfg.holdMinSeconds) return { error: 'NO_CREDITS', limitedBy: balance.limitedBy, renewsAt: balance.renewsAt };
    const ticket = { value: randomBytes(24).toString('base64url'), expires: now + 60_000, ip };
    this.tickets.set(id, ticket);
    // This is a single-use relay ticket, not a Soniox credential.
    return { api_key: ticket.value, expires_at: new Date(ticket.expires).toISOString() };
  }

  accept(client: WebSocket, id: string, ip: string) {
    if (this.connections.size >= 128) { client.close(1013, 'Please try again shortly'); return; }
    let upstream: WebSocket | null = null;
    let holdId: string | null = null;
    let connectedAt = 0;
    let lastRecitation = 0;
    let heardRecitation = false;
    let finished = false;
    let initializing = false;
    let queuedBytes = 0;
    let queue: Buffer[] = [];
    let finalTail = '';
    let previousEvidence = '';
    let timer: ReturnType<typeof setInterval> | null = null;
    let byteBudget = MAX_BUFFER;
    let budgetAt = Date.now();
    const idleLimit = this.o.idleLimitMs ?? IDLE_LIMIT_MS;
    let previousIdle = this.o.safety.status(id, ip).idleMs;
    const end = (message?: string, kind = 'listening_paused') => {
      if (finished) return;
      finished = true;
      clearTimeout(handshake);
      if (timer) clearInterval(timer);
      // Sever the actual upstream connection before returning unused hours.
      upstream?.terminate();
      if (holdId) {
        if (connectedAt) {
          const now = Date.now();
          this.o.credits.settle(id, now);
          this.o.safety.record(id, ip, now - (lastRecitation || connectedAt), heardRecitation, now);
        } else this.o.credits.release(holdId);
      }
      if (this.active.get(id) === end) this.active.delete(id);
      this.connections.delete(end);
      queue = []; queuedBytes = 0;
      if (message && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ error_code: 403, error_type: kind, error_message: message }));
      if (client.readyState === WebSocket.OPEN) client.close(1000);
      if (holdId) this.o.onSettled(id);
    };
    const handshake = setTimeout(() => end('Please start listening again.'), 5000);
    this.connections.add(end);
    client.on('close', () => end());
    client.on('error', () => end());
    const forward = (data: Buffer, binary = true) => {
      if (!upstream || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_BUFFER) return end('The connection is too slow. Please start again.');
      upstream.send(data, { binary });
    };
    client.on('message', (raw: RawData, binary: boolean) => {
      if (finished) return;
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      const now = Date.now();
      byteBudget = Math.min(MAX_BUFFER, byteBudget + (now - budgetAt) * 128);
      budgetAt = now;
      byteBudget -= data.length;
      if (byteBudget < 0) return end('Audio arrived too quickly. Please start again.');
      if (!initializing) {
        initializing = true;
        if (binary || data.length > 16_384) return end('Invalid listening request.');
        let config: { api_key?: unknown; audio_format?: unknown };
        try { config = JSON.parse(data.toString()); } catch { return end('Invalid listening request.'); }
        const ticket = this.tickets.get(id);
        if (!config || !ticket || config.api_key !== ticket.value || ticket.ip !== ip || ticket.expires < now) return end('Please start listening again.');
        this.tickets.delete(id);
        if (this.active.has(id)) return end('Listening is already open on another page. Stop it there first.');
        const safety = this.o.safety.status(id, ip, now);
        if (safety.retryAfter) return end('Listening is taking a short break. Please try again in five minutes.', 'listening_cooldown');
        previousIdle = safety.idleMs;
        if (config.audio_format && config.audio_format !== 'auto') return end('This audio format is not supported.');
        const hold = this.o.credits.reserve(id, ip, now);
        if ('error' in hold) return end('Shared listening hours are unavailable. Reading and translations are still free.');
        holdId = hold.id;
        this.active.set(id, end);
        clearTimeout(handshake);
        // An upstream setup failure cannot leave a reservation open indefinitely.
        const setup = setTimeout(() => end('Listening could not connect. Please try again.'), 10_000);
        void mintTemporaryKey(this.o.apiKey, `quran-reader:${id}`, this.o.fetchImpl, hold.maxSeconds).then((key) => {
          if (finished) { clearTimeout(setup); return; }
          upstream = new WebSocket(this.o.endpoint ?? 'wss://stt-rt.soniox.com/transcribe-websocket', { handshakeTimeout: 5000, maxPayload: MAX_BUFFER });
          upstream.on('error', () => { clearTimeout(setup); end('Listening could not connect. Please try again.'); });
          upstream.on('close', () => { clearTimeout(setup); end(); });
          upstream.on('open', () => {
            clearTimeout(setup);
            if (finished) return upstream?.terminate();
            connectedAt = Date.now();
            // Never forward arbitrary client options: model, context and output costs are bounded here.
            upstream!.send(JSON.stringify({ api_key: key.api_key, model: 'stt-rt-v5', audio_format: 'auto', language_hints: ['ar'], enable_endpoint_detection: true,
              context: { general: [{ key: 'domain', value: 'Quran recitation in Arabic (Hafs)' }, { key: 'also', value: 'occasional short English navigation requests' }] } }));
            for (const chunk of queue) { if (!finished) forward(chunk); }
            queue = []; queuedBytes = 0;
            timer = setInterval(() => {
              const now = Date.now();
              if (now - connectedAt >= hold.maxSeconds * 1000) return end('Temporary API key session duration limit exceeded.', 'temp_api_key_session_expired');
              if ((heardRecitation ? 0 : previousIdle) + now - (lastRecitation || connectedAt) >= idleLimit) end('We couldn’t recognise recitation for a while. Listening is paused; please try again in five minutes.', 'listening_cooldown');
            }, 250);
          });
          upstream.on('message', (body) => {
            if (finished) return;
            try {
              const result = JSON.parse(body.toString());
              // A browser cannot claim future audio to obtain more processing than real time.
              if (Number(result.total_audio_proc_ms) > Date.now() - connectedAt + 10_000) return end('Audio arrived too quickly. Please start again.');
              const tokens: Array<{ text: string; is_final?: boolean; start_ms?: number; end_ms?: number }> = Array.isArray(result.tokens) ? result.tokens : [];
              const evidence = JSON.stringify(tokens);
              if (tokens.length && evidence !== previousEvidence) {
                previousEvidence = evidence;
                const text = tokens.map((t) => typeof t.text === 'string' ? t.text : '').join('');
                if (this.o.isRecitation(`${finalTail} ${text}`)) { heardRecitation = true; lastRecitation = Date.now(); }
                finalTail = `${finalTail}${tokens.filter((t) => t.is_final).map((t) => t.text).join('')}`.slice(-400);
              }
              if (client.readyState === WebSocket.OPEN) {
                if (client.bufferedAmount > MAX_BUFFER) return end('The connection is too slow. Please start again.');
                client.send(body.toString());
              }
            } catch { end('Listening returned an invalid response. Please try again.'); }
          });
        }).catch(() => { clearTimeout(setup); end('Listening could not connect. Please try again.'); });
        return;
      }
      if (!binary) {
        // Finalize is useful for spoken navigation; all other config/control messages are refused.
        if (!data.length) return end();
        if (data.length > 100) return end('Invalid listening request.');
        try { if (JSON.parse(data.toString()).type !== 'finalize') return end('Invalid listening request.'); }
        catch { return end('Invalid listening request.'); }
        if (upstream?.readyState === WebSocket.OPEN) forward(Buffer.from('{"type":"finalize"}'), false);
        return;
      }
      if (upstream?.readyState === WebSocket.OPEN) forward(data);
      else {
        queuedBytes += data.length;
        if (queuedBytes > MAX_BUFFER) return end('Listening could not connect. Please try again.');
        queue.push(data);
      }
    });
  }
  close() { for (const stop of this.connections) stop(); this.tickets.clear(); }
}
