import { randomBytes } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type { CreditStore } from '../billing/credits';
import { IDLE_LIMIT_MS, ListeningSafety } from '../billing/listening-safety';
import { mintTemporaryKey, SonioxKeyError } from './soniox';

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
  /** The waiting line's HOLD_MS, OFFER_MS and LIVE_BREAK_MS, shortened in tests. */
  holdMs?: number;
  offerMs?: number;
  liveBreakMs?: number;
  /** People reciting at once (each costs tracker CPU); more wait for a free place. */
  maxStreams?: number;
  /** The server is overloaded right now: no new listening until it recovers. */
  busy?: () => boolean;
  /** A place is free for this visitor, who is waiting in line: their page asks for it now. */
  onTurn?: (id: string) => void;
  /** This visitor has a page open (a waiting page whose timers the browser slows is still there). */
  present?: (id: string) => boolean;
  /**
   * Live on stream: an overlay shows this visitor's session (OBS, a reading screen). A broadcast is
   * not cut short: no daily limit or idle stop, first in line, and its place kept through breaks of
   * up to LIVE_BREAK_MS while listening is on (`listeningOn`).
   */
  live?: (id: string) => boolean;
  listeningOn?: (id: string) => boolean;
};
type Ticket = { value: string; expires: number; ip: string };
/** Someone waiting to listen: last heard from, offered a place (when), and back after reciting. */
type Waiting = { id: string; seen: number; offered: number | null; back: boolean };
/**
 * Bytes a browser may send ahead, and the refill below (128 KB/s): WebM/Opus is ~4 KB/s and the
 * reader's PCM (Safari before 18.4 records only MP4, which the real-time API doesn't list) 32 KB/s,
 * with room for the audio buffered while a stream connects.
 */
const MAX_BUFFER = 512 * 1024;
/** The one raw format a reader sends: 16 kHz mono 16-bit PCM. Anything else must be a container the provider detects. */
const PCM = { audio_format: 'pcm_s16le', sample_rate: 16_000, num_channels: 1 } as const;
/** Provider control messages a reader needs: finalize (spoken requests) and keepalive (the SDK's, while the microphone is muted). */
const CONTROL = new Set(['finalize', 'keepalive']);
/** Sockets not yet past their ticket (at most 5 s each): a flood of them never takes reciters' places. */
const MAX_PENDING = 64;
export const DEFAULT_MAX_STREAMS = 60;
/** Full, here or at the recogniser: a clear wait, and nothing in reading changes. */
const BUSY = 'Many people are reciting right now, so listening is full for the moment. Please try again in a minute. Reading, word meanings and translations work as usual.';
const UNAVAILABLE = 'Listening is unavailable right now. Reading, word meanings and translations work as usual.';
let balanceWarned = 0;
/**
 * The waiting line, when every place is taken: first come, first served. A waiting page asks again
 * every 12 s, and at once when told a place is free for it; a place not taken in OFFER_MS goes to
 * the next person (the first keeps their place in line). Someone not heard from in LINE_GONE_MS,
 * with no page open, has left. A stream that closes keeps its place for HOLD_MS (the new stream
 * after a long pause or a restart finds it); after that, for BACK_MS, its reciter goes to the front
 * of the line: they were already reciting. When the recogniser refuses a stream (its limits are
 * shared with other products), only the places it allowed are used for PROVIDER_FULL_MS.
 */
const OFFER_MS = 15_000;
const LINE_GONE_MS = 40_000;
const HOLD_MS = 20_000;
const BACK_MS = 3 * 60_000;
const PROVIDER_FULL_MS = 60_000;
const MAX_LINE = 5000;
/**
 * Live streams without limits per network at once (a household, a masjid); more have the usual
 * limits. A live stream keeps its place through a break of up to LIVE_BREAK_MS (a meal, a prayer);
 * after a longer one it is first in line when it comes back.
 */
const MAX_LIVE_PER_NETWORK = 3;
const LIVE_BREAK_MS = 30 * 60_000;
/** A ticket is used at once (the page connects with it); unused, it keeps a place this long. */
const TICKET_MS = 30_000;

/** Hosted-only audio relay. No recording, no client-controlled provider options or credentials. */
export class HostedSpeech {
  private tickets = new Map<string, Ticket>();
  private active = new Map<string, () => void>();
  /** The network of each open stream. */
  private streamIps = new Map<string, string>();
  private connections = new Set<() => void>();
  private pending = 0;
  private line: Waiting[] = [];
  /** Places kept for streams that just closed: since when, and whether it was a live stream without limits. */
  private held = new Map<string, { at: number; live: boolean }>();
  /** Reciters who go to the front of the line until then (their stream closed, or was refused). */
  private back = new Map<string, number>();
  private providerFull: { cap: number; until: number } | null = null;
  private lineTimer: ReturnType<typeof setInterval> | null = null;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private o: Options) {}

  private get maxStreams() {
    return this.o.maxStreams ?? DEFAULT_MAX_STREAMS;
  }

  /** People waiting in line to listen. */
  get waiting() {
    return this.line.length;
  }

  /** Places that may be used now: ours, or fewer while the recogniser says it is full. */
  private capacity(now: number) {
    if (this.providerFull && this.providerFull.until <= now) this.providerFull = null;
    return this.providerFull ? Math.min(this.maxStreams, this.providerFull.cap) : this.maxStreams;
  }

  /** Drops unused tickets and lapsed kept places. */
  private tidy(now: number) {
    for (const [key, ticket] of this.tickets) if (ticket.expires < now) this.tickets.delete(key);
    for (const [key, kept] of this.held) if (this.active.has(key) || this.lapsed(key, kept, now)) this.held.delete(key);
  }

  /** A kept place lapses after HOLD_MS; a live stream's, while its listening is on, after LIVE_BREAK_MS. */
  private lapsed(id: string, kept: { at: number; live: boolean }, now: number) {
    const onAir = kept.live && this.o.live?.(id) && this.o.listeningOn?.(id);
    return now - kept.at >= (onAir ? this.o.liveBreakMs ?? LIVE_BREAK_MS : this.o.holdMs ?? HOLD_MS);
  }

  /** Live on stream, without limits: at most MAX_LIVE_PER_NETWORK of them per network at once. */
  private unlimited(id: string, ip: string) {
    if (!this.o.live?.(id)) return false;
    let others = 0;
    for (const [key, at] of this.streamIps) if (key !== id && at === ip && this.o.live(key)) others++;
    return others < MAX_LIVE_PER_NETWORK;
  }

  /** Places in use: streams, unused tickets and kept places, apart from `id`'s own. */
  private taken(id: string | null) {
    const own = id === null ? 0 : (this.tickets.has(id) ? 1 : 0) + (this.held.has(id) ? 1 : 0);
    return this.active.size + this.tickets.size + this.held.size - own;
  }

  /** Offered a place and did not come for it: passed over (still in line) so the next person gets it. */
  private passed(w: Waiting, now: number) {
    return w.offered !== null && now - w.offered > (this.o.offerMs ?? OFFER_MS);
  }

  /**
   * How many people come before `id`: everyone ahead of where it stands in line (or would join),
   * and anyone offered a free place and still on their way to it.
   */
  private ahead(id: string, now: number) {
    const back = (this.back.get(id) ?? 0) > now;
    let n = 0;
    let reached = false;
    for (const w of this.line) {
      if (w.id === id) {
        if (w.offered !== null && !this.passed(w, now)) return 0; // the place offered is theirs
        reached = true;
        continue;
      }
      if (back && !w.back) reached = true;
      if (w.offered !== null ? !this.passed(w, now) : !reached) n++;
    }
    return n;
  }

  /** Joins the line or stays in it; returns the place in it (1: next), or 0 when the line is full. */
  private join(id: string, now: number) {
    let w = this.line.find((x) => x.id === id);
    if (!w) {
      if (this.line.length >= MAX_LINE) return 0;
      const back = (this.back.get(id) ?? 0) > now;
      const at = back ? this.line.findIndex((x) => !x.back) : -1;
      w = { id, seen: now, offered: null, back };
      this.line.splice(at < 0 ? this.line.length : at, 0, w);
      this.watchLine();
    }
    w.seen = now;
    if (this.passed(w, now)) w.offered = null; // missed a turn but still here: in the running again
    return this.ahead(id, now) + 1;
  }

  /** Leave the line (the page stopped listening). */
  leave(id: string) {
    const at = this.line.findIndex((w) => w.id === id);
    if (at < 0) return;
    this.line.splice(at, 1);
    this.offerSoon();
  }

  private watchLine() {
    if (this.lineTimer) return;
    // While anyone waits: let go of those who left, and offer places as they free up.
    this.lineTimer = setInterval(() => {
      const now = Date.now();
      this.line = this.line.filter((w) => now - w.seen < LINE_GONE_MS || this.o.present?.(w.id));
      for (const [key, until] of this.back) if (until <= now) this.back.delete(key);
      if (this.line.length) return this.offer(now);
      clearInterval(this.lineTimer!);
      this.lineTimer = null;
    }, 5000);
    this.lineTimer.unref?.();
  }

  private offerSoon() {
    if (this.offerTimer || !this.line.length) return;
    this.offerTimer = setTimeout(() => {
      this.offerTimer = null;
      this.offer(Date.now());
    }, 100);
    this.offerTimer.unref?.();
  }

  /** Tells the first people in line, as many as there are free places not yet offered, that a place is theirs. */
  private offer(now: number) {
    if (!this.line.length || this.o.busy?.()) return;
    this.tidy(now);
    let free = this.capacity(now) - this.taken(null);
    for (const w of this.line) if (w.offered !== null && !this.passed(w, now)) free--;
    for (const w of this.line) {
      if (free <= 0) break;
      if (w.offered !== null) continue; // on their way, or passed over (in the running again when they ask)
      w.offered = now;
      free--;
      this.o.onTurn?.(w.id);
    }
  }

  /**
   * The recogniser refused a new stream (too many at once, or too many starts; its limits are
   * shared with other products): use the places it allowed for a while, and this reciter is next.
   */
  private refused(id: string) {
    const now = Date.now();
    this.providerFull = { cap: this.active.size - (this.active.has(id) ? 1 : 0), until: now + PROVIDER_FULL_MS };
    this.back.set(id, now + BACK_MS);
  }

  /** People reciting through the relay now. */
  get streams() {
    return this.active.size;
  }

  /** This visitor has a stream open (their page's recogniser results can only come from it). */
  streaming(id: string) {
    return this.active.has(id);
  }

  issue(id: string, ip: string) {
    const now = Date.now();
    this.tidy(now);
    const unlimited = this.unlimited(id, ip);
    const safety = this.o.safety.status(id, ip, now);
    if (safety.retryAfter && !unlimited) return { error: 'LISTENING_COOLDOWN', retryAfter: safety.retryAfter };
    if (!this.o.apiKey) return { error: 'NOT_CONFIGURED' };
    if (this.tickets.size >= 5000 && !this.tickets.has(id)) return { error: 'SERVICE_BUSY' };
    // A live stream serves everyone watching it: it goes to the front of the line.
    if (this.o.live?.(id)) this.back.set(id, now + BACK_MS);
    const balance = this.o.credits.balance(id, ip, now, unlimited);
    if (balance.available < this.o.credits.cfg.holdMinSeconds) return { error: 'NO_CREDITS', limitedBy: balance.limitedBy, renewsAt: balance.renewsAt };
    // Every place taken: wait in line. A stream open, a ticket not yet used or a place kept is the
    // visitor's own; otherwise a free place goes to whoever is first.
    if (!this.active.has(id) && !this.tickets.has(id) && !this.held.has(id)) {
      const free = this.o.busy?.() ? 0 : this.capacity(now) - this.taken(id);
      if (this.ahead(id, now) >= free) {
        const position = this.join(id, now);
        return position ? { error: 'LISTENING_BUSY', position } : { error: 'LISTENING_BUSY' };
      }
      this.leave(id);
    }
    this.held.delete(id);
    this.back.delete(id);
    const ticket = { value: randomBytes(24).toString('base64url'), expires: now + TICKET_MS, ip };
    this.tickets.set(id, ticket);
    // This is a single-use relay ticket, not a Soniox credential.
    return { api_key: ticket.value, expires_at: new Date(ticket.expires).toISOString() };
  }

  accept(client: WebSocket, id: string, ip: string) {
    if (this.pending >= MAX_PENDING) { client.close(1013, 'Please try again shortly'); return; }
    this.pending++;
    let validated = false;
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
    /** Live on stream without limits (decided when the stream starts). */
    let exempt = false;
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
      if (this.active.get(id) === end) {
        this.active.delete(id);
        this.streamIps.delete(id);
        // A long pause (the page closes its stream) or a restart: the next stream finds its place kept.
        if (connectedAt && kind !== 'listening_cooldown' && !this.tickets.has(id)) {
          const now = Date.now();
          const live = exempt && !!this.o.live?.(id);
          this.held.set(id, { at: now, live });
          this.back.set(id, now + BACK_MS);
          // Not back by then: the place goes to whoever is first in line.
          setTimeout(() => this.offerSoon(), (this.o.holdMs ?? HOLD_MS) + 1).unref?.();
          if (live) setTimeout(() => this.offerSoon(), (this.o.liveBreakMs ?? LIVE_BREAK_MS) + 1).unref?.();
        }
        this.offerSoon();
      }
      if (!validated) this.pending--;
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
        let config: { api_key?: unknown; audio_format?: unknown; sample_rate?: unknown; num_channels?: unknown };
        try { config = JSON.parse(data.toString()); } catch { return end('Invalid listening request.'); }
        const ticket = this.tickets.get(id);
        if (!config || !ticket || config.api_key !== ticket.value || ticket.ip !== ip || ticket.expires < now) return end('Please start listening again.');
        this.tickets.delete(id);
        if (this.active.has(id)) return end('Listening is already open on another page. Stop it there first.');
        if (this.active.size >= this.capacity(now) || this.o.busy?.()) {
          this.back.set(id, now + BACK_MS); // let in, then full after all: next in line
          return end(BUSY, 'listening_busy');
        }
        this.held.delete(id);
        const unlimited = this.unlimited(id, ip);
        const safety = this.o.safety.status(id, ip, now);
        if (safety.retryAfter && !unlimited) return end('Listening is taking a short break. Please try again in five minutes.', 'listening_cooldown');
        previousIdle = safety.idleMs;
        // Exactly two audio forms: a detected container, or the reader's PCM described in full.
        const pcm = config.audio_format === PCM.audio_format;
        const detected = (config.audio_format === undefined || config.audio_format === 'auto') && config.sample_rate === undefined && config.num_channels === undefined;
        if (pcm ? config.sample_rate !== PCM.sample_rate || config.num_channels !== PCM.num_channels : !detected) return end('This audio format is not supported.');
        const hold = this.o.credits.reserve(id, ip, now, unlimited);
        if ('error' in hold) return end('Shared listening hours are unavailable. Reading and translations are still free.');
        holdId = hold.id;
        exempt = unlimited;
        this.active.set(id, end);
        this.streamIps.set(id, ip);
        validated = true;
        this.pending--;
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
            upstream!.send(JSON.stringify({ api_key: key.api_key, model: 'stt-rt-v5', ...(pcm ? PCM : { audio_format: 'auto' }), language_hints: ['ar'], enable_endpoint_detection: true,
              context: { general: [{ key: 'domain', value: 'Quran recitation in Arabic (Hafs)' }, { key: 'also', value: 'occasional short English navigation requests' }] } }));
            for (const chunk of queue) { if (!finished) forward(chunk); }
            queue = []; queuedBytes = 0;
            timer = setInterval(() => {
              const now = Date.now();
              if (now - connectedAt >= hold.maxSeconds * 1000) return end('Temporary API key session duration limit exceeded.', 'temp_api_key_session_expired');
              // Live on stream: talking with the audience between recitations never stops listening
              // (and once the stream ends, the usual idle rule counts from then).
              if (exempt && this.o.live?.(id)) {
                lastRecitation = now;
                heardRecitation = true;
                return;
              }
              if ((heardRecitation ? 0 : previousIdle) + now - (lastRecitation || connectedAt) >= idleLimit) end('We couldn’t recognise recitation for a while. Listening is paused; please try again in five minutes.', 'listening_cooldown');
            }, 250);
          });
          upstream.on('message', (body) => {
            if (finished) return;
            try {
              const result = JSON.parse(body.toString());
              // The recogniser's own limits: too many people at once, or its balance ran out. It
              // refused the stream, so nothing is charged: the time set aside goes back.
              if (result.error_code === 429 || result.error_type === 'limit_exceeded' || result.error_code === 402 || result.error_type === 'organization_balance_exhausted') connectedAt = 0;
              if (result.error_code === 429 || result.error_type === 'limit_exceeded') {
                this.refused(id);
                return end(BUSY, 'listening_busy');
              }
              if (result.error_code === 402 || result.error_type === 'organization_balance_exhausted') {
                if (Date.now() - balanceWarned > 60_000) {
                  balanceWarned = Date.now();
                  console.error('Soniox balance exhausted: listening is refused until it is topped up.');
                }
                return end(UNAVAILABLE, 'listening_unavailable');
              }
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
        }).catch((e) => {
          clearTimeout(setup);
          if (!(e instanceof SonioxKeyError && e.code === 'RATE_LIMITED')) return end('Listening could not connect. Please try again.');
          this.refused(id);
          end(BUSY, 'listening_busy');
        });
        return;
      }
      if (!binary) {
        // Finalize and keepalive pass on as fixed frames (a phone call mutes the microphone and the
        // SDK keeps the stream with keepalives); all other config/control messages are refused.
        if (!data.length) return end();
        if (data.length > 100) return end('Invalid listening request.');
        let type: unknown;
        try { type = JSON.parse(data.toString()).type; } catch { return end('Invalid listening request.'); }
        if (typeof type !== 'string' || !CONTROL.has(type)) return end('Invalid listening request.');
        if (upstream?.readyState === WebSocket.OPEN) forward(Buffer.from(JSON.stringify({ type })), false);
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
  close() {
    for (const stop of this.connections) stop();
    this.tickets.clear();
    this.line = [];
    if (this.lineTimer) clearInterval(this.lineTimer);
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.lineTimer = this.offerTimer = null;
  }
}
