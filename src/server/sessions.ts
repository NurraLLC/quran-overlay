// Authoritative session: one reciter, one capture stream, one display state. Transport-agnostic
// (app.ts wires WebSockets; replay drives it directly with a virtual clock).
//
// Distinct actions, distinct effects:
//   Stop listening  → capture ends, the verse on screen stays (not "following").
//   Pause following → capture continues privately, the audience display is frozen.
//   Blank           → audience sees nothing; tracking continues underneath.
//   Manual navigation always publishes (it is explicit), and re-anchors the tracker.

import { shortGroup } from './corpus/groups';
import type { WordGlosses } from './corpus/wbw';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { EOL } from 'node:os';
import path from 'node:path';
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
import type { ResourceCatalog } from './resources/catalog';
import { realClock, type Clock } from './tracker/scheduler';
import { LiveCursor } from './tracker/live-cursor';
import { mapDisplayWords, type WordSpan } from './corpus/word-map';
import { ListeningCommands } from './commands/listening';

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
  /** Explicit, bounded, local diagnostic capture of provider token events (no audio). */
  captureDir?: string | null;
  /** Resource relationships (collision neighbours, topics, divisions); optional. */
  catalog?: ResourceCatalog | null;
  /** Word-by-word English glosses (optional resource). */
  glosses?: WordGlosses | null;
};

const CAPTURE_MAX_BYTES = 20 * 1024 * 1024;

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
  private cursor: DisplayState['cursor'] = null;
  private readonly liveCursor: LiveCursor;
  private liveFloor = 0;
  private liveVerse: number | null = null;
  private readonly wordMaps = new Map<number, Array<WordSpan | null>>();
  private batchingTranscript = false;
  private readonly listeningCommands: ListeningCommands;
  private englishTail = false;
  private layout: ControlSnapshot['layout'] = null;
  private notice: string | null = null;

  private capture: ControlSnapshot['capture'] = { phase: 'off', captureEpoch: 0, detail: null, since: 0 };
  private buffer = new TranscriptBuffer();
  private lastSeq = -1;
  private captureFile: string | null = null;
  private captureStart = 0;
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
    this.liveCursor = new LiveCursor(o.ix);
    this.listeningCommands = new ListeningCommands(o.decisionClient, this.clock, (text, id, intent) => {
      if (this.capture.phase !== 'recording' || this.commandActive) return;
      void this.command(id, text, intent === 'show');
    }, message => this.say(message));
    this.follower = new RecitationFollower(o.ix, o.corpus.id, this.sessionEpoch, o.decisionClient, o.mode, (e) => this.onFollower(e), this.clock);
    if (o.catalog) attachCatalog(this.follower, o.catalog);
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
    const grouped = v && this.style.groupShort && this.style.readingMode !== 'word' ? shortGroup(this.o.corpus, this.displayVerse!) : [];
    const group = grouped.length > 1 ? grouped.map((i) => this.o.corpus.at(i)!) : null;
    // Within a group the upcoming ayahs are already on screen; preview only what follows the group.
    const nextIndex = group ? (grouped.at(-1) === this.displayVerse ? this.displayVerse! + 1 : -1) : (this.displayVerse ?? -2) + 1;
    const n = v && this.style.showNext && this.style.readingMode !== 'word' && nextIndex >= 0 ? this.o.corpus.at(nextIndex) : undefined;
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
              glosses: this.o.glosses?.get(v.key) ?? null,
              glossCredit: this.o.glosses ? this.o.glosses.attribution : null,
            }
          : null,
      style: this.style,
      englishPage: this.englishPage,
      arabicPage: this.arabicPage,
      progress: this.progress,
      cursor: this.cursor,
      group: group ? group.map((g) => ({ key: g.key, ayah: g.ayah, arabic: g.arabicDisplay, english: g.english })) : null,
      next: n ? { key: n.key, surah: n.surah, ayah: n.ayah, arabic: n.arabicDisplay, english: n.english, surahName: n.surah !== v!.surah ? this.o.corpus.chapter(n.surah)!.nameSimple : null } : null,
    };
  }

  /** Publish only real changes; a repeated frame is not dispatched. */
  private publish() {
    if (this.batchingTranscript) return;
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
      if (this.pendingSpeed) this.speed = { revision: this.revision, captureEpoch: this.capture.captureEpoch, ...this.pendingSpeed };
    }
    this.pendingSpeed = null;
    this.queueSnapshot();
  }

  private showVerse(i: number | null) {
    if (i !== this.displayVerse) {
      this.englishPage = 0;
      this.arabicPage = null;
      this.progress = null;
      this.cursor = null;
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
      if (!this.held && !this.commandActive && this.liveVerse === null) this.showVerse(e.verseIndex);
      this.publish();
    } else if (e.kind === 'clear') {
      this.trackerVerse = null;
      this.liveVerse = null;
      this.liveCursor.reset();
      this.cursor = null;
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
      if (p && !this.held && !this.commandActive && this.liveVerse === null && p.verseIndex === this.displayVerse) {
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
        this.listeningCommands.cancel();
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
    this.listeningCommands.cancel();
    this.liveCursor.reset();
    this.liveVerse = null;
    this.liveFloor = this.buffer.liveWords().length;
    this.cursor = null;
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
    if (this.capture.phase === 'recording' && !this.commandActive && !this.englishTail) this.updateLiveCursor();
    this.logEvent('resume', this.verseLabel(this.displayVerse));
    this.publish();
  }

  private onTranscript(msg: Extract<ControlClientMessage, { type: 'transcript' }>) {
    if (msg.captureEpoch !== this.capture.captureEpoch) return; // an old stream can never apply
    if (this.capture.phase === 'stopped' || this.capture.phase === 'off') return; // late results after Stop
    if (msg.seq <= this.lastSeq) return; // duplicate delivery
    this.lastSeq = msg.seq;
    this.writeCapture(msg.tokens);
    const r = this.buffer.apply(msg.tokens);
    const heard = this.buffer.heardText(1);
    const liveWords = this.buffer.liveWords();
    const english = !this.commandActive && this.listeningCommands.observe(liveWords, this.buffer.hasProvisional, r.endpoint);
    if (english) {
      this.englishTail = true;
      this.cursor = null;
      this.liveCursor.reset();
      this.follower.stop();
      this.publish();
      return;
    }
    if (this.englishTail) {
      // Resume at Arabic after the English utterance. No English words become recitation evidence.
      const lastEnglish = liveWords.findLastIndex(w => /[A-Za-z]/.test(w.text));
      this.liveFloor = Math.max(this.liveFloor, lastEnglish + 1);
      this.follower.engine.floor = Math.max(this.follower.engine.floor, Math.min(this.buffer.evidence().length, lastEnglish + 1));
      if (this.latestCommand?.id.startsWith('listen:')) this.latestCommand.ctrl.abort();
      this.englishTail = false;
    }
    this.batchingTranscript = true;
    try {
      this.follower.onTranscript(this.buffer.evidence(), heard.provisional, r.evidenceChanged);
      if (!this.held && !this.commandActive && (r.evidenceChanged || r.provisionalChanged)) {
        this.updateLiveCursor();
      }
    } finally { this.batchingTranscript = false; }
    this.publish();
  }

  private updateLiveCursor() {
    const words = this.buffer.liveWords().slice(this.liveFloor);
    const live = this.liveCursor.update(words, this.follower.engine.anchor, this.buffer.hasProvisional, this.follower.engine.prior, this.follower.engine.neighbours);
    if (live && (this.follower.mode !== 'jev_required' || live.verseIndex === this.trackerVerse)) {
      const verseChanged = live.verseIndex !== this.displayVerse;
      const heardEndMs = words.at(-1)?.endMs ?? null;
      if (heardEndMs !== null && (verseChanged || live.word !== this.lastLiveWord)) {
        this.pendingSpeed = { verseKey: this.o.corpus.at(live.verseIndex)!.key, verseChanged, heardEndMs };
      }
      this.lastLiveWord = live.word;
      this.liveVerse = live.verseIndex;
      this.showVerse(live.verseIndex);
      const v = this.o.corpus.at(live.verseIndex)!;
      let mapping = this.wordMaps.get(live.verseIndex);
      if (!mapping) { mapping = mapDisplayWords(v.searchText, v.arabicDisplay); this.wordMaps.set(live.verseIndex, mapping); }
      const span = mapping[live.word];
      this.cursor = span ? { ...span, provisional: live.provisional } : null;
      this.progress = Math.min(1, (live.word + 1) / this.o.ix.verseLen[live.verseIndex]);
    } else {
      this.cursor = null;
      // A provisional subword is frequently rewritten. Hold the source verse without an
      // active cursor while it forms; never flash an older finalized verse between updates.
    }
  }

  private onCapture(msg: Extract<ControlClientMessage, { type: 'capture' }>) {
    const now = this.clock.now();
    if (msg.captureEpoch < this.capture.captureEpoch) return;
    if (msg.captureEpoch > this.capture.captureEpoch) {
      this.capture = { phase: 'starting', captureEpoch: msg.captureEpoch, detail: null, since: now };
      this.buffer = new TranscriptBuffer();
      this.listeningCommands.cancel(true);
      this.englishTail = false;
      this.liveCursor.reset();
      this.liveVerse = null;
      this.liveFloor = 0;
      this.cursor = null;
      this.lastSeq = -1;
      this.follower.newCapture(msg.captureEpoch);
      this.openCapture(msg.captureEpoch);
      if (this.trackerVerse === null) this.follower.setPrior(this.startHint);
    }
    this.cancelDisconnect();
    const phase: CapturePhase =
      msg.event === 'starting' ? 'starting' : msg.event === 'recording' || msg.event === 'unmuted' || msg.event === 'muted' ? 'recording' : msg.event === 'reconnecting' ? 'reconnecting' : msg.event === 'stopped' ? 'stopped' : 'error';
    this.capture = { ...this.capture, phase, detail: msg.detail ?? (msg.event === 'muted' ? 'Microphone muted at the system or device level.' : null), since: now };
    this.logEvent(`capture:${msg.event}`, null, msg.detail);
    if (msg.event === 'stopped') {
      this.listeningCommands.cancel();
      if (this.latestCommand?.id.startsWith('listen:')) this.latestCommand.ctrl.abort();
      this.follower.stop();
      this.liveCursor.reset();
      this.liveVerse = null;
      this.cursor = null;
      this.publish();
    } else if (msg.event === 'error') {
      this.listeningCommands.cancel();
      this.follower.stop();
      this.startDisconnectGrace();
    }
    this.queueSnapshot();
  }

  // ---------- diagnostic capture ----------

  private openCapture(epoch: number) {
    this.captureFile = null;
    if (!this.o.captureDir) return;
    mkdirSync(this.o.captureDir, { recursive: true });
    this.captureFile = path.join(this.o.captureDir, `capture-${epoch}.jsonl`);
    this.captureStart = this.clock.now();
  }

  /** Replay-format lines ({t, type:'result', tokens}); stops at the size bound. */
  private writeCapture(tokens: unknown) {
    if (!this.captureFile) return;
    try {
      if ((statSync(this.captureFile, { throwIfNoEntry: false })?.size ?? 0) > CAPTURE_MAX_BYTES) {
        this.captureFile = null;
        return this.say('Diagnostic capture stopped at its 20 MB limit.');
      }
      appendFileSync(this.captureFile, JSON.stringify({ t: Math.round(this.clock.now() - this.captureStart), type: 'result', tokens }) + EOL);
    } catch {
      this.captureFile = null;
    }
  }

  // ---------- connection lifecycle ----------

  controlConnected() {
    this.controlClients++;
    this.queueSnapshot();
  }

  controlDisconnected() {
    this.listeningCommands.cancel();
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

  /** `show`: a spoken "show the ayah about ..." puts JEV's confirmed best match on screen. */
  private async command(requestId: string, text: string, show = false) {
    this.latestCommand?.ctrl.abort();
    const ctrl = new AbortController();
    const cmd = { id: requestId, ctrl, keys: new Set<string>() };
    this.latestCommand = cmd;
    this.emitControl({ type: 'command_pending', requestId });
    let result: CommandResult;
    try {
      result = await this.o.resolver.resolve(text, this.displayVerse ?? this.trackerVerse, ctrl.signal, (pre) => {
        if (this.latestCommand !== cmd || ctrl.signal.aborted || pre.kind !== 'candidates') return;
        for (const c of pre.cards) for (const k of [c.key, c.prevKey, c.nextKey]) if (k) cmd.keys.add(k);
        this.emitControl({ type: 'command_result', requestId, result: pre });
      });
    } catch {
      result = { kind: 'no_match', message: 'Search failed unexpectedly; exact references still work.' };
    }
    if (this.latestCommand !== cmd || ctrl.signal.aborted) return; // an old search cannot publish after a newer request
    if (result.kind === 'control') {
      if (result.style) this.handle({ type: 'style', patch: result.style });
      if (result.hold !== null) this.handle({ type: 'hold', on: result.hold });
      if (result.blank !== null) this.handle({ type: 'blank', on: result.blank });
      this.say(result.label);
    }
    if (result.kind === 'navigate') {
      this.gotoIndex(this.o.corpus.verse(result.key)!.index, 'command');
      if (requestId.startsWith('listen:')) { this.held = false; this.heldBySearch = false; this.publish(); }
      this.latestCommand = cmd;
    }
    // Cards and their adjacent-ayah context (browsable in the card) may be shown.
    if (result.kind === 'candidates') for (const c of result.cards) for (const k of [c.key, c.prevKey, c.nextKey]) if (k) cmd.keys.add(k);
    if (show && result.kind === 'candidates') {
      if (result.confirmedKey) {
        this.gotoIndex(this.o.corpus.verse(result.confirmedKey)!.index, 'command');
        this.held = false;
        this.heldBySearch = false;
        this.say(`Showing ${result.confirmedKey}, the best match for “${text}”. Other matches are in Recite or ask.`);
        this.publish();
      } else this.say(`No single passage clearly matched “${text}”. Pick one of the matches to show it.`);
    }
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
    if (this.liveVerse !== null && this.cursor) return 'tracking';
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
      setup: { soniox: this.o.setup.soniox, jev: this.o.setup.jev, semantic: this.o.setup.semantic(), resources: this.resourceView() },
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
      speed: this.speed,
    };
  }

  private candidatesView: ControlSnapshot['candidates'] = [];
  private lastLiveWord = -1;
  private pendingSpeed: { verseKey: string; verseChanged: boolean; heardEndMs: number } | null = null;
  private speed: ControlSnapshot['speed'] = null;
  private resourceCache: ControlSnapshot['setup']['resources'] | null = null;

  private resourceView(): ControlSnapshot['setup']['resources'] {
    if (!this.o.catalog) return [];
    if (this.resourceCache) return this.resourceCache;
    this.resourceCache = this.o.catalog.status().map((r) => {
      const st = r.stage;
      const state = st.consumers.length ? 'in use' : st.indexed ? 'imported, not used yet' : st.downloaded ? 'downloaded' : 'not imported';
      const cov = r.coverage ? `${r.coverage.verseKeys.toLocaleString()} ayahs covered, ${r.coverage.rejectedRows} rejected rows. ` : '';
      const used = st.consumers.length ? `Used by: ${st.consumers.join(', ')}. ` : '';
      return { id: r.id, title: r.title, state, detail: `${cov}${used}${r.note ?? ''}`.trim() };
    });
    return this.resourceCache;
  }
}

/** Connect resource relationships to the tracker and decision evidence, recording the consumers. */
export function attachCatalog(follower: RecitationFollower, catalog: ResourceCatalog) {
  // Candidate regions only when curated near-match edges exist (see ResourceCatalog.neighbours).
  follower.engine.neighbours = catalog.similar || catalog.mutashabihat ? catalog.neighbours : null;
  follower.relate = (a, b) => catalog.relationSources(a, b);
  catalog.consume(catalog.phrases.id, 'decision.evidence');
  if (catalog.similar) {
    catalog.consume('qul:similar-ayah:74', 'tracker.candidates');
    catalog.consume('qul:similar-ayah:74', 'decision.evidence');
  }
  if (catalog.mutashabihat) {
    catalog.consume('qul:mutashabihat:73', 'tracker.candidates');
    catalog.consume('qul:mutashabihat:73', 'decision.evidence');
  }
}
