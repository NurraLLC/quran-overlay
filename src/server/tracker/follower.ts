// Recitation follower: engine proposals + optional JEV decisions under one of three modes.
//   deterministic  retrieval + temporal alignment only (cost/latency baseline)
//   hybrid         deterministic obvious matches; JEV only for ambiguity/recovery
//   jev_required   every proposed location transition must be confirmed by JEV
//
// Every decision is bound to the evidence and authority it was computed from. A result is
// applied only if session, capture, manual revision, mode and corpus are unchanged; the chosen
// candidate is then re-aligned against the newest words and its *newly validated* position is
// published (never the request's old cursor).

import type { Word } from '../../shared/transcript';
import { buildLocate, readLocate, type LocatePacket, type LocateVerdict } from '../providers/decisions';
import { JevError, type DecisionClient } from '../providers/jev';
import type { CorpusIndex } from './index';
import { TrackerEngine, type Ask, type Proposal, type StepResult, type TrackerConfig } from './reducer';
import { DecisionScheduler, RECITATION_SCHEDULE, realClock, type Clock, type Job, type Outcome, type SchedulerConfig } from './scheduler';

export type TrackerMode = 'deterministic' | 'hybrid' | 'jev_required';
export const TRACKER_MODES: readonly TrackerMode[] = ['deterministic', 'hybrid', 'jev_required'];

export type Binding = {
  sessionEpoch: string;
  captureEpoch: number;
  corpusId: string;
  manualRevision: number;
  modeRevision: number;
  evidenceTo: number;
};

type Packet = { binding: Binding; ask: Ask; locate: LocatePacket; proposal: Proposal | null };

export type DecisionRecord = {
  at: number;
  reason: string;
  shortlist: string[];
  truncated: boolean;
  outcome: 'accepted' | 'wait' | 'below_gate' | 'tied' | 'stale' | 'error' | 'deadline' | 'unsupported_now' | 'collision';
  detail: string;
  latencyMs: number;
  decisionId: string | null;
  changedOverlay: boolean;
  usage: { inputTokens: number; outputTokens: number; cost: number | null } | null;
};

export type FollowerEvent =
  | { kind: 'commit'; verseIndex: number; reason: string; via: 'deterministic' | 'jev'; margin: number; decisionId: string | null }
  | { kind: 'clear'; reason: 'contradictory_speech' }
  | { kind: 'step'; step: StepResult }
  | { kind: 'decision'; record: DecisionRecord };

export class RecitationFollower {
  readonly engine: TrackerEngine;
  mode: TrackerMode;
  private modeRevision = 0;
  private manualRevision = 0;
  private captureEpoch = 0;
  private finals: readonly Word[] = [];
  private provisionalText = '';
  private scheduler: DecisionScheduler<Packet, Awaited<ReturnType<DecisionClient['evaluate']>>> | null = null;
  private providerBackoffUntil = -Infinity;
  private committedVerse: number | null = null;
  readonly decisions: DecisionRecord[] = [];
  readonly computeMs: number[] = [];

  constructor(
    readonly ix: CorpusIndex,
    readonly corpusId: string,
    readonly sessionEpoch: string,
    private client: DecisionClient | null,
    mode: TrackerMode,
    private readonly emit: (e: FollowerEvent) => void,
    private readonly clock: Clock = realClock,
    trackerConfig?: TrackerConfig,
    private readonly schedule: SchedulerConfig = RECITATION_SCHEDULE,
  ) {
    this.engine = new TrackerEngine(ix, trackerConfig);
    this.mode = mode;
    this.rebuildScheduler();
  }

  get decisionsAvailable() {
    return !!this.client;
  }

  get stats() {
    return this.scheduler?.stats ?? null;
  }

  get currentVerse() {
    return this.committedVerse;
  }

  setClient(client: DecisionClient | null) {
    this.client = client;
    this.rebuildScheduler();
  }

  private rebuildScheduler() {
    this.scheduler?.cancelAll();
    this.scheduler = this.client
      ? new DecisionScheduler<Packet, Awaited<ReturnType<DecisionClient['evaluate']>>>(
          this.schedule,
          (p, signal, deadlineMs) => this.client!.evaluate(p.locate.state, p.locate.questions, { timeoutMs: deadlineMs, signal }),
          (job, outcome) => this.onOutcome(job, outcome),
          this.clock,
          (e) => (e instanceof JevError ? { code: e.code, retryAfterMs: e.retryAfterMs } : { code: 'PROVIDER_FAILED', retryAfterMs: null }),
        )
      : null;
  }

  setMode(mode: TrackerMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeRevision++;
    this.scheduler?.cancelAll();
  }

  /** Authoritative manual location (navigation, Show on stream + Resume, starting point). */
  seek(verseIndex: number) {
    this.manualRevision++;
    this.scheduler?.cancelAll();
    this.engine.seek(verseIndex, this.finals.length);
    this.committedVerse = verseIndex;
  }

  /** Location given up (display cleared by the user or disconnect). */
  unlocate() {
    this.manualRevision++;
    this.scheduler?.cancelAll();
    this.engine.unlocate(this.finals.length);
    this.committedVerse = null;
  }

  /** Starting-location hint: a prior for recovery, never an exclusion. */
  setPrior(verseIndex: number | null) {
    this.engine.setPrior(verseIndex);
  }

  /** New capture epoch: old results can never apply; the location (if any) carries over. */
  newCapture(epoch: number) {
    this.captureEpoch = epoch;
    this.scheduler?.cancelAll();
    this.finals = [];
    this.engine.floor = 0;
  }

  stop() {
    this.scheduler?.cancelAll();
  }

  /** `finals` is the finalized evidence (closed words + open final word) of the current capture. */
  onTranscript(finals: readonly Word[], provisionalText: string, evidenceChanged: boolean) {
    this.finals = finals;
    this.provisionalText = provisionalText;
    if (!evidenceChanged) return;
    const step = this.engine.step(finals);
    if (!step.changed) return;
    this.computeMs.push(step.computeMs);
    if (this.computeMs.length > 5000) this.computeMs.splice(0, 1000);
    this.emit({ kind: 'step', step });

    if (step.proposal) {
      if (this.mode === 'jev_required') this.submit(this.askFromProposal(step), step.proposal);
      else this.commit(step.proposal, 'deterministic', null);
    } else if (step.ask && this.mode !== 'deterministic') {
      this.submit(step.ask, null);
    }
    if (step.clear) {
      this.committedVerse = null;
      this.scheduler?.cancelAll();
      this.emit({ kind: 'clear', reason: 'contradictory_speech' });
    }
  }

  private askFromProposal(step: StepResult): Ask {
    const p = step.proposal!;
    const { shortlist, truncated } = this.engine.shortlist([p.candidate, ...step.top.filter((c) => c.verseIndex !== p.verseIndex)]);
    const n = this.finals.length;
    return {
      reason: 'ambiguous_transition',
      shortlist,
      truncated,
      evidence: { from: Math.max(this.engine.floor, n - this.engine.cfg.window), to: n },
      obs: this.engine.toObs(this.finals.slice(Math.max(this.engine.floor, n - this.engine.cfg.window))),
    };
  }

  private commit(p: Proposal, via: 'deterministic' | 'jev', decisionId: string | null) {
    this.engine.applyCommit(p);
    const changed = this.committedVerse !== p.verseIndex;
    this.committedVerse = p.verseIndex;
    if (changed) this.emit({ kind: 'commit', verseIndex: p.verseIndex, reason: p.reason, via, margin: p.margin, decisionId });
    return changed;
  }

  private binding(to: number): Binding {
    return {
      sessionEpoch: this.sessionEpoch,
      captureEpoch: this.captureEpoch,
      corpusId: this.corpusId,
      manualRevision: this.manualRevision,
      modeRevision: this.modeRevision,
      evidenceTo: to,
    };
  }

  private isCurrent(b: Binding) {
    return (
      b.sessionEpoch === this.sessionEpoch &&
      b.captureEpoch === this.captureEpoch &&
      b.corpusId === this.corpusId &&
      b.manualRevision === this.manualRevision &&
      b.modeRevision === this.modeRevision &&
      this.finals.length >= b.evidenceTo
    );
  }

  private submit(ask: Ask, proposal: Proposal | null) {
    if (!this.scheduler || !this.client) return;
    if (this.clock.now() < this.providerBackoffUntil) return;
    const currentKey = this.committedVerse !== null ? this.ix.verses[this.committedVerse].key : null;
    const locate = buildLocate(this.ix, this.client.gateway, ask.obs, this.provisionalText, currentKey, ask.shortlist);
    const fingerprint = [
      ask.reason,
      this.captureEpoch,
      this.manualRevision,
      this.modeRevision,
      [...locate.options.values()].join(','),
    ].join('|');
    const job: Job<Packet> = { fingerprint, packet: { binding: this.binding(ask.evidence.to), ask, locate, proposal } };
    this.scheduler.submit(job);
  }

  private record(job: Job<Packet>, r: Omit<DecisionRecord, 'at' | 'reason' | 'shortlist' | 'truncated'>) {
    const rec: DecisionRecord = {
      at: this.clock.now(),
      reason: job.packet.ask.reason,
      shortlist: [...job.packet.locate.options.values()].map((v) => this.ix.verses[v].key),
      truncated: job.packet.locate.truncated,
      ...r,
    };
    this.decisions.push(rec);
    if (this.decisions.length > 200) this.decisions.shift();
    this.emit({ kind: 'decision', record: rec });
  }

  private onOutcome(job: Job<Packet>, outcome: Outcome<Awaited<ReturnType<DecisionClient['evaluate']>>>) {
    const base = { latencyMs: outcome.latencyMs, decisionId: null, changedOverlay: false, usage: null };
    if (outcome.kind === 'deadline') {
      this.providerBackoffUntil = this.clock.now() + 1000;
      return this.record(job, { ...base, outcome: 'deadline', detail: 'deadline exceeded; late answer will be ignored' });
    }
    if (outcome.kind === 'error') {
      const hard = outcome.code === 'AUTHENTICATION_FAILED' || outcome.code === 'CREDITS_EXHAUSTED' || outcome.code === 'NOT_CONFIGURED';
      this.providerBackoffUntil = this.clock.now() + (hard ? 60_000 : outcome.code === 'RATE_LIMITED' ? (outcome.retryAfterMs ?? 5000) : 2000);
      return this.record(job, { ...base, outcome: 'error', detail: outcome.code });
    }
    const d = outcome.result;
    const withUsage = { ...base, decisionId: d.id, usage: d.usage };
    if (!this.isCurrent(job.packet.binding)) {
      return this.record(job, { ...withUsage, outcome: 'stale', detail: 'authority or evidence changed while deciding' });
    }
    const verdict: LocateVerdict = readLocate(d, job.packet.locate);
    if (verdict.kind !== 'selected') return this.record(job, { ...withUsage, outcome: verdict.kind, detail: verdict.detail });
    const check = this.engine.revalidate(verdict.verseIndex, this.finals);
    if (!check.ok) {
      return this.record(job, {
        ...withUsage,
        outcome: check.reason,
        detail:
          check.reason === 'collision'
            ? `${this.ix.verses[verdict.verseIndex].key}: the heard words occur identically elsewhere; waiting for more speech`
            : `${this.ix.verses[verdict.verseIndex].key} no longer supported by newest words`,
      });
    }
    const now = check.proposal;
    const changed = this.commit({ ...now, reason: job.packet.proposal?.reason ?? 'jump', margin: verdict.margin }, 'jev', d.id);
    this.record(job, {
      ...withUsage,
      outcome: 'accepted',
      detail: `p=${verdict.probability} conf=${verdict.confidence} has_match=${verdict.hasMatch} → ${this.ix.verses[now.verseIndex].key}`,
      changedOverlay: changed,
    });
  }
}
