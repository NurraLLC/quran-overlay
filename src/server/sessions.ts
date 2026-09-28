// Authoritative session: one reciter, one capture stream, one display state. Transport-agnostic
// (app.ts wires WebSockets; replay drives it directly with a virtual clock).
//
// Distinct actions, distinct effects:
//   Stop listening  → capture ends, the verse on screen stays (not "following").
//   Pause following → capture continues privately, the audience display is frozen.
//   Blank           → audience sees nothing; tracking continues underneath.
//   Manual navigation always publishes (it is explicit), and re-anchors the tracker.

import { randomBytes } from 'node:crypto';
import {
  DEFAULT_STYLE,
  DisplayStyleSchema,
  PROTOCOL_VERSION,
  type CapturePhase,
  type CommandResult,
  type ControlClientMessage,
  type ControlServerMessage,
  type ControlSnapshot,
  type DisplayState,
  type DisplayStyle,
  type TrackerPhase,
} from '../shared/contracts';
import { TranscriptBuffer } from '../shared/transcript';
import type { CommandResolver } from './commands/reducer';
import type { Corpus } from './corpus/load';
import type { DecisionClient } from './providers/jev';
import { RecitationFollower, type FollowerEvent, type TrackerMode } from './tracker/follower';
import type { CorpusIndex } from './tracker/index';
import { realClock, type Clock } from './tracker/scheduler';

export const DISCONNECT_GRACE_MS = 5000;

export type SessionSetup = {
  soniox: boolean;
  jev: { provider: 'typesafe' | 'openrouter' | null; configured: boolean; detail: string };
  semantic: () => string;
};

export type SessionOptions = {
  corpus: Corpus;
  ix: CorpusIndex;
  resolver: CommandResolver;
  decisionClient: DecisionClient | null;
  mode: TrackerMode;
  setup: SessionSetup;
  overlayUrl: (viewToken: string) => string;
  clock?: Clock;
};

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 100) / 100;
};

export class Session {
  readonly sessionEpoch = randomBytes(6).toString('hex');
  private viewToken = randomBytes(18).toString('base64url');
  readonly follower: RecitationFollower;
  private readonly clock: Clock;

  private revision = 0;
  private lastPublishedKey = '';
  display: DisplayState;
  private displayVerse: number | null = null;
  private trackerVerse: number | null = null;
  private held = false;
  private commandActive = false;
  private heldBySearch = false;
  private blanked = false;
  private pinned = false;
  private startHint: number | null = null;
  private style: DisplayStyle = { ...DEFAULT_STYLE };
  private englishPage = 0;
  private arabicPage: number | null = null;
  private progress: number | null = null;
  private layout: ControlSnapshot['layout'] = null;
  private notice: string | null = null;

  private capture: ControlSnapshot['capture'] = { phase: 'off', captureEpoch: 0, detail: null, since: 0 };
  private buffer = new TranscriptBuffer();
  private lastSeq = -1;
  private disconnectTimer: unknown = null;
  private pageTimer: unknown = null;

  private latestCommand: { id: string; ctrl: AbortController; keys: Set<string> } | null = null;
  private readonly sentAt = new Map<number, number>();
  readonly paintRtts: number[] = [];
  private snapshotTimer: unknown = null;

  private readonly displayListeners = new Set<(s: DisplayState) => void>();
  private readonly controlListeners = new Set<(m: ControlServerMessage) => void>();
  controlClients = 0;
  overlayClients = 0;
  readonly log: Array<{ t: number; event: string; key?: string | null; detail?: string }> = [];

  constructor(private readonly o: SessionOptions) {
    this.clock = o.clock ?? realClock;
    this.follower = new RecitationFollower(o.ix, o.corpus.id, this.sessionEpoch, o.decisionClient, o.mode, (e) => this.onFollower(e), this.clock);
    this.display = this.buildDisplay();
  }

  // ---------- subscriptions ----------

  onDisplay(fn: (s: DisplayState) => void) {
    this.displayListeners.add(fn);
    return () => this.displayListeners.delete(fn);
  }

  onControl(fn: (m: ControlServerMessage) => void) {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }

  checkView(token: string) {
    return token.length === this.viewToken.length && token === this.viewToken;
  }

  chapters() {
    return this.o.corpus.data.chapters.map((c) => ({ number: c.number, nameSimple: c.nameSimple, nameArabic: c.nameArabic, verseCount: c.verseCount }));
  }

  card(key: string) {
    const v = this.o.corpus.verse(key);
    return v ? this.o.resolver.card(v.index) : null;
  }

  get overlayUrl() {
    return this.o.overlayUrl(this.viewToken);
  }

  // ---------- display ----------

  private verseLabel(i: number | null) {
    return i === null ? null : this.o.corpus.at(i)!.key;
  }

  private buildDisplay(): DisplayState {
    const v = this.displayVerse === null ? null : this.o.corpus.at(this.displayVerse)!;
    const ch = v ? this.o.corpus.chapter(v.surah)! : null;
    return {
      v: PROTOCOL_VERSION,
      revision: this.revision,
      sessionEpoch: this.sessionEpoch,
      visible: !this.blanked && !!v,
      verse:
        v && ch
          ? {
              key: v.key,
              surah: v.surah,
              ayah: v.ayah,
              arabic: v.arabicDisplay,
              english: v.english,
              surahName: ch.nameSimple,
              surahNameArabic: ch.nameArabic,
              translationName: this.o.corpus.data.manifest.translation.name,
            }
          : null,
      style: this.style,
      englishPage: this.englishPage,
      arabicPage: this.arabicPage,
      progress: this.progress,
    };
  }

  /** Publish only real changes; a repeated frame is not dispatched. */
  private publish() {
    const next = this.buildDisplay();
    const key = JSON.stringify({ ...next, revision: 0 });
    if (key !== this.lastPublishedKey) {
      this.lastPublishedKey = key;
      this.revision++;
      this.display = { ...next, revision: this.revision };
      this.sentAt.set(this.revision, this.clock.now());
      if (this.sentAt.size > 64) this.sentAt.delete(this.sentAt.keys().next().value!);
      for (const fn of this.displayListeners) fn(this.display);
      this.schedulePageTimer();
    }
    this.queueSnapshot();
  }

  private showVerse(i: number | null) {
    if (i !== this.displayVerse) {
      this.englishPage = 0;
      this.arabicPage = null;
      this.progress = null;
      if (this.layout && this.layout.key !== this.verseLabel(i)) this.layout = null;
    }
    this.displayVerse = i;
  }

  private schedulePageTimer() {
    if (this.pageTimer !== null) this.clock.clearTimeout(this.pageTimer);
    this.pageTimer = null;
    const secs = this.style.translationPageSeconds;
    const pages = this.layout && this.layout.key === this.verseLabel(this.displayVerse) ? this.layout.englishPages : 1;
    if (!secs || pages <= 1 || !this.display.visible) return;
    this.pageTimer = this.clock.setTimeout(() => {
      this.pageTimer = null;
      this.englishPage = (this.englishPage + 1) % pages;
      this.publish();
    }, secs * 1000);
  }

  // ---------- follower events ----------

  private onFollower(e: FollowerEvent) {
    if (e.kind === 'commit') {
      this.trackerVerse = e.verseIndex;
      this.logEvent('commit', this.verseLabel(e.verseIndex), `${e.reason} via ${e.via}`);
      if (!this.held && !this.commandActive) this.showVerse(e.verseIndex);
      this.publish();
    } else if (e.kind === 'clear') {
      this.trackerVerse = null;
      this.logEvent('clear', null, e.reason);
      if (!this.held) this.showVerse(null);
      this.publish();
    } else if (e.kind === 'step') {
      this.candidatesView = e.step.top.slice(0, 5).map((c) => ({
        key: this.o.corpus.at(c.verseIndex)!.key,
        score: Math.round(c.score * 100) / 100,
        relation: c.relation,
        matched: c.matched,
        trailing: c.trailing,
      }));
      const p = e.step.progress;
      if (p && !this.held && p.verseIndex === this.displayVerse) {
        const len = this.o.ix.verseLen[p.verseIndex];
        const q = len ? Math.round((Math.min(p.word + 1, len) / len) * 20) / 20 : null;
        if (q !== this.progress) {
          this.progress = q;
          this.publish();
          return;
        }
      }
      this.queueSnapshot();
    } else {
      this.queueSnapshot();
    }
  }

  // ---------- control input ----------

  handle(msg: ControlClientMessage) {
    switch (msg.type) {
      case 'transcript':
        return this.onTranscript(msg);
      case 'capture':
        return this.onCapture(msg);
      case 'nav': {
        const base = this.displayVerse ?? this.trackerVerse ?? this.startHint;
        if (base === null) return this.say('Nothing is on screen yet — pick a starting ayah or search first.');
        const to = base + (msg.action === 'next' ? 1 : -1);
        if (to < 0 || to >= this.o.corpus.verses.length) return this.say(msg.action === 'next' ? 'That is the last ayah.' : 'That is the first ayah.');
        return this.gotoIndex(to, 'manual');
      }
      case 'goto': {
        const v = this.o.corpus.verse(msg.key);
        if (!v) return this.say(`${msg.key} is not a valid reference.`);
        return this.gotoIndex(v.index, 'manual');
      }
      case 'hold':
        return msg.on ? this.hold() : this.resume();
      case 'blank':
        this.blanked = msg.on;
        this.logEvent(msg.on ? 'blank' : 'unblank', this.verseLabel(this.displayVerse));
        return this.publish();
      case 'pin':
        this.pinned = msg.on;
        return this.queueSnapshot();
      case 'style': {
        const next = DisplayStyleSchema.safeParse({ ...this.style, ...msg.patch });
        if (next.success) this.style = next.data;
        return this.publish();
      }
      case 'page':
        if (msg.region === 'english') this.englishPage = msg.page;
        else this.arabicPage = msg.page;
        return this.publish();
      case 'arabic_auto':
        this.arabicPage = null;
        return this.publish();
      case 'layout':
        if (msg.revision === this.revision && msg.key === this.verseLabel(this.displayVerse)) {
          this.layout = { key: msg.key, englishPages: msg.englishPages, arabicPages: msg.arabicPages, promotedToFullFrame: msg.promotedToFullFrame };
          this.schedulePageTimer();
          this.queueSnapshot();
        }
        return;
      case 'mode':
        this.follower.setMode(msg.mode);
        this.logEvent('mode', null, msg.mode);
        return this.queueSnapshot();
      case 'start_hint': {
        const v = msg.key ? this.o.corpus.verse(msg.key) : null;
        if (msg.key && !v) return this.say(`${msg.key} is not a valid reference.`);
        this.startHint = v ? v.index : null;
        this.follower.setPrior(this.startHint);
        return this.queueSnapshot();
      }
      case 'uncertain_policy':
        this.follower.engine.cfg = { ...this.follower.engine.cfg, keepOnUncertain: msg.keep };
        return this.queueSnapshot();
      case 'command':
        void this.command(msg.requestId, msg.text);
        return;
      case 'show_result': {
        const c = this.latestCommand;
        if (!c || c.id !== msg.requestId || !c.keys.has(msg.key)) return this.say('That search result is out of date; search again.');
        const v = this.o.corpus.verse(msg.key)!;
        this.gotoIndex(v.index, 'search');
        this.held = true;
        this.heldBySearch = true;
        this.say(`Showing ${msg.key} from search. Following is paused — Resume following continues from here.`);
        return this.publish();
      }
      case 'command_capture':
        this.commandActive = msg.active;
        if (msg.active) this.follower.stop();
        return this.queueSnapshot();
      case 'rotate_view':
        this.viewToken = randomBytes(18).toString('base64url');
        this.logEvent('rotate_view', null);
        for (const fn of this.revokeListeners) fn();
        return this.queueSnapshot();
    }
  }

  readonly revokeListeners = new Set<() => void>();

  private say(text: string) {
    this.notice = text;
    this.queueSnapshot();
  }

  private logEvent(event: string, key?: string | null, detail?: string) {
    this.log.push({ t: this.clock.now(), event, key, detail });
    if (this.log.length > 500) this.log.shift();
  }

  gotoIndex(i: number, source: 'manual' | 'search' | 'command') {
    this.latestCommand?.ctrl.abort();
    this.showVerse(i);
    this.trackerVerse = i;
    this.follower.seek(i);
    this.notice = null;
    this.logEvent('goto', this.verseLabel(i), source);
    this.publish();
  }

  private hold() {
    this.held = true;
    this.heldBySearch = false;
    this.logEvent('hold', this.verseLabel(this.displayVerse));
    this.publish();
  }

  private resume() {
    this.held = false;
    if (this.heldBySearch && this.displayVerse !== null) {
      // New tracking epoch at the location the broadcaster chose to show.
      this.follower.seek(this.displayVerse);
      this.trackerVerse = this.displayVerse;
    } else if (this.trackerVerse !== null && this.trackerVerse !== this.displayVerse) {
      this.showVerse(this.trackerVerse);
    }
    this.heldBySearch = false;
    this.notice = null;
    this.logEvent('resume', this.verseLabel(this.displayVerse));
    this.publish();
  }

  private onTranscript(msg: Extract<ControlClientMessage, { type: 'transcript' }>) {
    if (msg.captureEpoch !== this.capture.captureEpoch) return; // an old stream can never apply
    if (this.capture.phase === 'stopped' || this.capture.phase === 'off') return; // late results after Stop
    if (msg.seq <= this.lastSeq) return; // duplicate delivery
    this.lastSeq = msg.seq;
    const r = this.buffer.apply(msg.tokens);
    const heard = this.buffer.heardText(1);
    this.follower.onTranscript(this.buffer.evidence(), heard.provisional, r.evidenceChanged);
    if (!r.evidenceChanged && r.provisionalChanged) this.queueSnapshot();
  }

  private onCapture(msg: Extract<ControlClientMessage, { type: 'capture' }>) {
    const now = this.clock.now();
    if (msg.captureEpoch < this.capture.captureEpoch) return;
    if (msg.captureEpoch > this.capture.captureEpoch) {
      this.capture = { phase: 'starting', captureEpoch: msg.captureEpoch, detail: null, since: now };
      this.buffer = new TranscriptBuffer();
      this.lastSeq = -1;
      this.follower.newCapture(msg.captureEpoch);
      if (this.trackerVerse === null) this.follower.setPrior(this.startHint);
    }
    this.cancelDisconnect();
    const phase: CapturePhase =
      msg.event === 'starting' ? 'starting' : msg.event === 'recording' || msg.event === 'unmuted' || msg.event === 'muted' ? 'recording' : msg.event === 'reconnecting' ? 'reconnecting' : msg.event === 'stopped' ? 'stopped' : 'error';
    this.capture = { ...this.capture, phase, detail: msg.detail ?? (msg.event === 'muted' ? 'Microphone muted at the system or device level.' : null), since: now };
    this.logEvent(`capture:${msg.event}`, null, msg.detail);
    if (msg.event === 'stopped') {
      this.follower.stop();
    } else if (msg.event === 'error') {
      this.follower.stop();
      this.startDisconnectGrace();
    }
    this.queueSnapshot();
  }

  // ---------- connection lifecycle ----------

  controlConnected() {
    this.controlClients++;
    this.queueSnapshot();
  }

  controlDisconnected() {
    this.controlClients = Math.max(0, this.controlClients - 1);
    if (this.controlClients === 0 && ['starting', 'recording', 'reconnecting'].includes(this.capture.phase)) {
      this.capture = { ...this.capture, phase: 'disconnected', detail: 'Control page disconnected while listening.', since: this.clock.now() };
      this.follower.stop();
      this.startDisconnectGrace();
    }
  }

  private startDisconnectGrace() {
    this.cancelDisconnect();
    this.disconnectTimer = this.clock.setTimeout(() => {
      this.disconnectTimer = null;
      if (this.pinned || this.displayVerse === null) return;
      this.showVerse(null);
      this.trackerVerse = null;
      this.follower.unlocate();
      this.notice = 'Overlay cleared: listening stopped unexpectedly for 5 seconds. Pin the display to keep a verse up during outages.';
      this.logEvent('disconnect_clear', null);
      this.publish();
    }, DISCONNECT_GRACE_MS);
  }

  private cancelDisconnect() {
    if (this.disconnectTimer !== null) this.clock.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  painted(revision: number) {
    const sent = this.sentAt.get(revision);
    if (sent === undefined) return;
    this.sentAt.delete(revision);
    this.paintRtts.push(this.clock.now() - sent);
    if (this.paintRtts.length > 500) this.paintRtts.shift();
  }

  // ---------- commands ----------

  private async command(requestId: string, text: string) {
    this.latestCommand?.ctrl.abort();
    const ctrl = new AbortController();
    const cmd = { id: requestId, ctrl, keys: new Set<string>() };
    this.latestCommand = cmd;
    this.emitControl({ type: 'command_pending', requestId });
    let result: CommandResult;
    try {
      result = await this.o.resolver.resolve(text, this.displayVerse ?? this.trackerVerse, ctrl.signal);
    } catch {
      result = { kind: 'no_match', message: 'Search failed unexpectedly; exact references still work.' };
    }
    if (this.latestCommand !== cmd || ctrl.signal.aborted) return; // an old search cannot publish after a newer request
    if (result.kind === 'navigate') {
      this.gotoIndex(this.o.corpus.verse(result.key)!.index, 'command');
      this.latestCommand = cmd;
    }
    // Cards and their adjacent-ayah context (browsable in the card) may be shown.
    if (result.kind === 'candidates') for (const c of result.cards) for (const k of [c.key, c.prevKey, c.nextKey]) if (k) cmd.keys.add(k);
    this.emitControl({ type: 'command_result', requestId, result });
  }

  private emitControl(m: ControlServerMessage) {
    for (const fn of this.controlListeners) fn(m);
  }

  // ---------- snapshot ----------

  private queueSnapshot() {
    if (this.snapshotTimer !== null) return;
    this.snapshotTimer = this.clock.setTimeout(() => {
      this.snapshotTimer = null;
      this.emitControl({ type: 'snapshot', snapshot: this.snapshot() });
    }, 30);
  }

  phase(): TrackerPhase {
    const c = this.capture.phase;
    if (c === 'error') return 'error';
    if (c === 'disconnected') return 'disconnected';
    if (this.held) return 'held';
    if (c === 'off') return 'idle';
    if (c === 'stopped') return 'stopped';
    const p = this.follower.engine.phase;
    return p === 'unlocated' ? 'listening_unlocated' : p;
  }

  snapshot(): ControlSnapshot {
    const heard = this.buffer.heardText(18);
    const st = this.follower.stats;
    const m = this.o.corpus.data.manifest;
    return {
      v: PROTOCOL_VERSION,
      sessionEpoch: this.sessionEpoch,
      corpus: { id: m.id, verses: m.verseCount, chapters: this.o.corpus.data.chapters.length, translation: m.translation.name, attribution: m.translation.attribution },
      display: this.display,
      layout: this.layout,
      trackerVerse: this.verseLabel(this.trackerVerse),
      phase: this.phase(),
      mode: this.follower.mode,
      held: this.held,
      blanked: this.blanked,
      pinned: this.pinned,
      keepOnUncertain: this.follower.engine.cfg.keepOnUncertain,
      startHint: this.verseLabel(this.startHint),
      capture: this.capture,
      heard,
      candidates: this.candidatesView,
      decisions: this.follower.decisions.slice(-8).map((d) => ({
        at: d.at,
        reason: d.reason,
        outcome: d.outcome,
        detail: d.detail,
        latencyMs: Math.round(d.latencyMs),
        shortlist: d.shortlist.slice(0, 6),
        truncated: d.truncated,
        changedOverlay: d.changedOverlay,
      })),
      setup: { soniox: this.o.setup.soniox, jev: this.o.setup.jev, semantic: this.o.setup.semantic() },
      overlay: { url: this.overlayUrl, clients: this.overlayClients, lastPaintRttMs: this.paintRtts.at(-1) ?? null },
      metrics: {
        trackerP50Ms: pct(this.follower.computeMs, 0.5),
        trackerP95Ms: pct(this.follower.computeMs, 0.95),
        updates: this.follower.computeMs.length,
        decisionCalls: st?.started ?? 0,
        decisionP50Ms: pct(st?.latencies ?? [], 0.5),
        paintRttP50Ms: pct(this.paintRtts, 0.5),
        paintRttP95Ms: pct(this.paintRtts, 0.95),
      },
      notice: this.notice,
    };
  }

  private candidatesView: ControlSnapshot['candidates'] = [];
}
