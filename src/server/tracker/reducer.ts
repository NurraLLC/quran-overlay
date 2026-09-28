// Recitation tracker: heard words → supported location changes.
//
// The engine proposes; the follower (follower.ts) decides whether a proposal commits directly
// (deterministic/hybrid) or needs a decision (jev_required, or ambiguity in hybrid). Only
// within-verse progress mutates the anchor here without a commit.

import type { Word } from '../../shared/transcript';
import type { Obs } from './align';
import { bestPerVerse, buildCandidates, type Candidate, type NeighbourProvider, type Relation } from './candidates';
import { canonicalizeLetterNames, type CorpusIndex } from './index';
import { tokenize } from './normalize';

export type Phase = 'unlocated' | 'tracking' | 'uncertain';

export type TrackerConfig = {
  window: number;
  uncertainClearMs: number;
  /** Extra time allowed before clearing while a different location is already forming. */
  formingGraceMs: number;
  /** Keep the last verse on screen when speech stops matching (broadcaster preference). */
  keepOnUncertain: boolean;
};

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  window: 16,
  uncertainClearMs: 3000,
  formingGraceMs: 1500,
  keepOnUncertain: false,
};

export type ProposalReason = 'acquire' | 'advance' | 'skip' | 'repeat' | 'jump';

export type Proposal = {
  verseIndex: number;
  pos: number;
  reason: ProposalReason;
  candidate: Candidate;
  margin: number;
};

export type AskReason = 'ambiguous_acquire' | 'ambiguous_transition' | 'recover';

export type Ask = {
  reason: AskReason;
  shortlist: Candidate[];
  truncated: boolean;
  /** Closed-final word span [from, to) used as evidence. */
  evidence: { from: number; to: number };
  obs: Obs[];
};

export type StepResult = {
  changed: boolean;
  phase: Phase;
  proposal: Proposal | null;
  ask: Ask | null;
  clear: boolean;
  top: Candidate[];
  /** Within-verse word progress for the committed verse (search-word index). */
  progress: { verseIndex: number; word: number } | null;
  computeMs: number;
  /** Collision-neighbour regions aligned this step, and neighbours skipped by the budget. */
  neighbourRegions?: number;
  neighbourTruncated?: number;
};

const SHORTLIST = 12;
const SHORTLIST_CAP = 24;

export class TrackerEngine {
  phase: Phase = 'unlocated';
  anchor: { pos: number; verseIndex: number } | null = null;
  /** Last location we lost, used as a recovery prior (never an exclusion). */
  prior: number | null = null;
  /** First closed-final word index that counts as evidence (authority changes move it). */
  floor = 0;
  private unexplainedSince: number | null = null;
  private lastKey = '';

  /** Resource-backed collision neighbours (null = enrichment off; the corpus seeds still run). */
  neighbours: NeighbourProvider | null = null;

  constructor(
    readonly ix: CorpusIndex,
    public cfg: TrackerConfig = DEFAULT_TRACKER_CONFIG,
  ) {}

  /** Manual anchor or resume: authoritative location, old evidence discarded. */
  seek(verseIndex: number, finalsLength: number) {
    this.anchor = { pos: Math.max(0, this.ix.verseStart[verseIndex] - 1), verseIndex };
    this.phase = 'tracking';
    this.floor = finalsLength;
    this.unexplainedSince = null;
    this.lastKey = '';
  }

  /** Forget location (Stop, capture restart without anchor). Keeps the prior for recovery. */
  unlocate(finalsLength: number) {
    if (this.anchor) this.prior = this.anchor.verseIndex;
    this.anchor = null;
    this.phase = 'unlocated';
    this.floor = finalsLength;
    this.unexplainedSince = null;
    this.lastKey = '';
  }

  setPrior(verseIndex: number | null) {
    this.prior = verseIndex;
  }

  applyCommit(p: Proposal) {
    this.anchor = { pos: p.pos, verseIndex: p.verseIndex };
    this.phase = 'tracking';
    this.unexplainedSince = null;
  }

  toObs(words: readonly Word[]): Obs[] {
    const out: Obs[] = [];
    for (const w of words) {
      const toks = tokenize(w.text);
      for (const t of toks) out.push({ ...t, startMs: w.startMs, endMs: w.endMs });
    }
    return canonicalizeLetterNames(this.ix, out) as Obs[];
  }

  step(finals: readonly Word[], provisional: readonly Word[] = [], useProvisional = false): StepResult {
    const t0 = performance.now();
    const n = finals.length;
    const from = Math.max(this.floor, n - this.cfg.window);
    const words = useProvisional ? [...finals.slice(from), ...provisional] : finals.slice(from);
    const key = `${from}:${n}:${useProvisional ? provisional.map((w) => w.text).join(' ') : ''}:${this.anchor?.pos}:${this.phase}`;
    const base: StepResult = {
      changed: false,
      phase: this.phase,
      proposal: null,
      ask: null,
      clear: false,
      top: [],
      progress: null,
      computeMs: 0,
    };
    if (key === this.lastKey) return base;
    this.lastKey = key;
    const obs = this.toObs(words).slice(-this.cfg.window);
    const res: StepResult = { ...base, changed: true };
    if (!obs.length) {
      res.computeMs = performance.now() - t0;
      return res;
    }
    const all = buildCandidates(this.ix, obs, this.anchor, this.prior, [], this.neighbours);
    const top = bestPerVerse(all);
    res.top = top.slice(0, 8);
    res.neighbourRegions = all.neighbourRegions ?? 0;
    res.neighbourTruncated = all.neighbourTruncated ?? 0;
    this.decide(top, obs, { from, to: n }, res, useProvisional);
    res.phase = this.phase;
    if (this.anchor) {
      res.progress = { verseIndex: this.anchor.verseIndex, word: Math.max(0, this.anchor.pos - this.ix.verseStart[this.anchor.verseIndex]) };
    }
    res.computeMs = performance.now() - t0;
    return res;
  }

  private verseLen(v: number) {
    return this.ix.verseLen[v];
  }

  private decide(top: Candidate[], obs: Obs[], evidence: { from: number; to: number }, res: StepResult, preview: boolean) {
    let B = top[0];
    // Continuity breaks exact ties: when a distant passage is textually identical to the
    // continuation of the confirmed/manual anchor, the anchor is the only distinguishing evidence.
    if (B && this.anchor && B.relation === 'jump') {
      const cont = top.find((c) => (c.relation === 'next' || c.relation === 'same') && c.score >= B.score - 1e-6);
      if (cont) B = cont;
    }
    const makeAsk = (reason: AskReason): Ask => {
      const { shortlist, truncated } = this.shortlist(top);
      return { reason, shortlist, truncated, evidence, obs };
    };
    const need = (v: number, k: number) => Math.min(k, this.verseLen(v));

    if (!B) {
      if (this.anchor) this.noteUnexplained(obs, obs.length, res, preview);
      return;
    }
    // Margin is measured only against alternatives that also explain *current* speech; an old
    // alignment that stopped matching is not a rival explanation of what is being recited now.
    const explainsNow = (c: Candidate) => c.verseIndex !== B.verseIndex && c.trailing <= Math.max(1, B.trailing + 1);
    const continuing = B.relation === 'next' || B.relation === 'same';
    // A continuation needs a margin over local alternatives; a distant twin only must not beat it.
    const rival = top.find((c) => explainsNow(c) && (!continuing || c.relation !== 'jump'));
    const margin = B.score - (rival?.score ?? 0);
    const rel: Relation = B.relation;
    const current = B.trailing <= 1;

    if (!this.anchor || rel === 'jump') {
      // A new or distant location needs distinguishing evidence from *fresh* words: those the
      // current location cannot already explain. Words shared with the committed passage (e.g.
      // 36:4 "على صراط مستقيم" also ends 67:22) must not be double-counted as evidence for a jump.
      const local = this.anchor ? top.find((c) => c.relation === 'same' || c.relation === 'next') : undefined;
      const fresh = this.freshStats(B, local ? obs.length - local.trailing : 0);
      const evidenced = fresh.matched >= 3 && (fresh.weight >= (this.anchor ? 2.0 : 1.6) || fresh.run >= 4);
      const target = B.inVerse >= need(B.verseIndex, 2) ? { verseIndex: B.verseIndex, pos: B.endPos } : null;
      // A long exact run of fresh words is itself distinguishing, so it needs less score margin.
      const needMargin = fresh.run >= 4 ? 0.8 : this.anchor ? 1.2 : 1.0;
      if (current && evidenced && target && margin >= needMargin) {
        res.proposal = { ...target, reason: this.anchor ? 'jump' : 'acquire', candidate: B, margin };
      } else if (current && fresh.matched >= (this.anchor ? 2 : 3) && (!this.anchor || !this.localExplains(top))) {
        res.ask = makeAsk(this.anchor ? 'recover' : 'ambiguous_acquire');
      }
    } else if (rel === 'same') {
      if (current && !preview) this.anchor = { pos: B.endPos, verseIndex: B.verseIndex };
    } else if (rel === 'next') {
      if (current && B.inVerse >= need(B.verseIndex, 2) && margin >= 0.5) {
        res.proposal = { verseIndex: B.verseIndex, pos: B.endPos, reason: 'advance', candidate: B, margin };
      }
    } else if (rel === 'skip' || rel === 'repeat') {
      if (current && B.inVerse >= need(B.verseIndex, 3) && margin >= 1.0) {
        res.proposal = { verseIndex: B.verseIndex, pos: B.endPos, reason: rel, candidate: B, margin };
      } else if (current && B.inVerse >= 2) {
        res.ask = makeAsk('ambiguous_transition');
      }
    }

    if (!this.anchor) return;
    const explainedLocally = (rel === 'same' || rel === 'next') && current;
    if (explainedLocally || res.proposal) {
      this.unexplainedSince = null;
      if (this.phase === 'uncertain' && !preview) this.phase = 'tracking';
      return;
    }
    const local = top.find((c) => c.relation === 'same' || c.relation === 'next');
    const unexplained = local ? local.trailing : obs.length;
    const forming = rel !== 'same' && rel !== 'next' && B.matched >= 2 && current;
    this.noteUnexplained(obs, unexplained, res, preview, forming);
  }

  /** Evidence from heard words at window index >= `fromObs` only. */
  private freshStats(c: Candidate, fromObs: number): { matched: number; weight: number; run: number } {
    let matched = 0;
    let weight = 0;
    for (const [oi, pos, sim] of c.pairs) {
      if (oi < fromObs) continue;
      matched++;
      weight += this.ix.weight[this.ix.wordId[pos]] * (sim === 1 ? 1 : sim * 0.8);
    }
    return { matched, weight, run: Math.min(c.run, matched) };
  }

  private localExplains(top: Candidate[]) {
    return top.some((c) => (c.relation === 'same' || c.relation === 'next') && c.trailing <= 1);
  }

  /** Contradictory speech accounting; ordinary silence never reaches here (no new words). */
  private noteUnexplained(obs: Obs[], unexplainedCount: number, res: StepResult, preview: boolean, forming = false) {
    if (preview || unexplainedCount < 2) return;
    const firstUnexplained = obs[obs.length - unexplainedCount];
    const last = obs[obs.length - 1];
    const start = firstUnexplained.startMs ?? firstUnexplained.endMs;
    const end = last.endMs ?? last.startMs;
    if (start === null || end === null) return;
    if (this.unexplainedSince === null || start < this.unexplainedSince) this.unexplainedSince = start;
    if (this.anchor) this.phase = 'uncertain';
    const limit = this.cfg.uncertainClearMs + (forming ? this.cfg.formingGraceMs : 0);
    if (end - this.unexplainedSince >= limit && this.anchor) {
      if (!this.cfg.keepOnUncertain) res.clear = true;
      this.prior = this.anchor.verseIndex;
      this.anchor = null;
      this.phase = 'unlocated';
      this.unexplainedSince = null;
    }
  }

  /**
   * Shortlist for a decision: preserve the incumbent (continuing current verse), the best global
   * match and the strongest distinct alternatives; record truncation instead of hiding it.
   */
  shortlist(top: Candidate[]): { shortlist: Candidate[]; truncated: boolean } {
    const keep: Candidate[] = [];
    const add = (c: Candidate | undefined) => {
      if (c && !keep.includes(c) && keep.length < SHORTLIST_CAP) keep.push(c);
    };
    add(top.find((c) => c.relation === 'same'));
    add(top.find((c) => c.relation === 'next'));
    add(top.find((c) => c.source === 'global'));
    for (const c of top) {
      if (keep.length >= SHORTLIST) break;
      add(c);
    }
    return { shortlist: keep, truncated: top.length > keep.length };
  }

  /**
   * Re-check a decided verse against the newest heard words in the tracker's *real* context
   * (confirmed/manual anchor and prior), with the same rules `decide` applies: fresh evidence for a
   * jump, continuity of the real anchor breaking exact textual ties, and no publication when another
   * location explains the same fresh words identically. Returns the position to publish (possibly
   * the following verse if the reciter moved on). A decision can never resolve a true collision.
   */
  revalidate(verseIndex: number, finals: readonly Word[]): { ok: true; proposal: Proposal } | { ok: false; reason: 'unsupported_now' | 'collision' } {
    const n = finals.length;
    const from = Math.max(this.floor, n - this.cfg.window);
    const obs = this.toObs(finals.slice(from));
    if (!obs.length) return { ok: false, reason: 'unsupported_now' };
    const m = obs.length;
    const chosenRegion = { from: this.ix.verseStart[verseIndex] - m - 4, to: this.ix.verseStart[verseIndex] + this.ix.verseLen[verseIndex] + 2 * m };
    const top = bestPerVerse(buildCandidates(this.ix, obs, this.anchor, this.prior, [chosenRegion], this.neighbours));
    const onPath = (c: Candidate) => c.verseIndex >= verseIndex && c.verseIndex <= verseIndex + 2;
    const path = top.find((c) => onPath(c) && c.trailing <= 1 && c.inVerse >= 1 && (c.verseIndex === verseIndex || c.pairs.some(([, pos]) => this.ix.wordVerse[pos] === verseIndex)));
    if (!path) return { ok: false, reason: 'unsupported_now' };
    const continuing = path.relation === 'same' || path.relation === 'next';
    const local = this.anchor ? top.find((c) => c.relation === 'same' || c.relation === 'next') : undefined;
    const freshFrom = local && local !== path ? obs.length - local.trailing : 0;
    if (this.anchor && !continuing && this.freshStats(path, freshFrom).matched < 2) return { ok: false, reason: 'unsupported_now' };
    const signature = (c: Candidate) =>
      c.pairs
        .filter(([oi]) => oi >= freshFrom)
        .map(([oi, pos]) => `${oi}:${this.ix.words[pos]}`)
        .join(' ');
    const sig = signature(path);
    const rivals = top.filter((c) => !onPath(c) && c.trailing <= 1);
    const twin = rivals.find((c) => signature(c) === sig || c.score >= path.score - 0.05);
    // Same rule as decide(): continuity of the real anchor distinguishes it from a distant twin.
    if (twin && !(continuing && twin.relation === 'jump')) return { ok: false, reason: 'collision' };
    if (rivals.some((c) => c.score > path.score + 1.0)) return { ok: false, reason: 'unsupported_now' };
    return { ok: true, proposal: { verseIndex: path.verseIndex, pos: path.endPos, reason: continuing ? 'advance' : 'jump', candidate: path, margin: 0 } };
  }

}
