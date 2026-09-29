// Candidate passages for the current heard window: the local path around the anchor plus global
// discovery seeds from every occurrence in the full corpus. Collisions are preserved, never trimmed
// to "the" answer here; the reducer decides whether the evidence distinguishes them.

import { alignRegion, type Alignment, type Obs } from './align';
import { lookupWord, type CorpusIndex } from './index';

export type Relation = 'same' | 'next' | 'skip' | 'repeat' | 'jump' | 'unlocated';

export type Candidate = Alignment & {
  verseIndex: number;
  /** Matched heard words whose corpus position lies in `verseIndex`. */
  inVerse: number;
  /** Matched heard words' corpus positions are all in the verse (and those just before it). */
  source: 'local' | 'global';
  relation: Relation;
};

const MAX_POSTINGS = 400;
const MAX_SEED_CLUSTERS = 28;

type Seed = { diag: number; vote: number };

export function globalSeeds(ix: CorpusIndex, obs: readonly Obs[]): Array<{ from: number; to: number; vote: number }> {
  const V = ix.vocab.size;
  const variants = obs.map((o) => (o.foreign ? [] : lookupWord(ix, o.key, 3)));
  const seeds: Seed[] = [];
  for (let i = 1; i < obs.length; i++) {
    for (const a of variants[i - 1]) {
      for (const b of variants[i]) {
        const hits = ix.bigrams.get(a.id * V + b.id);
        if (!hits || hits.length > MAX_POSTINGS) continue;
        const vote = (ix.weight[a.id] * a.sim + ix.weight[b.id] * b.sim) * (hits.length > 60 ? 0.5 : 1);
        for (const p of hits) seeds.push({ diag: p - i, vote });
      }
    }
  }
  for (let i = 0; i < obs.length; i++) {
    for (const a of variants[i]) {
      if (ix.df[a.id] > 40) continue;
      const vote = ix.weight[a.id] * a.sim * 0.8;
      for (const p of ix.postings[a.id]) seeds.push({ diag: p - i, vote });
    }
  }
  if (!seeds.length) return [];
  seeds.sort((x, y) => x.diag - y.diag);
  // Cluster diagonals within ±3 (tolerates a few insertions/deletions).
  const clusters: Array<{ lo: number; hi: number; vote: number }> = [];
  for (const s of seeds) {
    const last = clusters[clusters.length - 1];
    if (last && s.diag - last.hi <= 3) {
      last.hi = s.diag;
      last.vote += s.vote;
    } else clusters.push({ lo: s.diag, hi: s.diag, vote: s.vote });
  }
  clusters.sort((a, b) => b.vote - a.vote);
  const m = obs.length;
  return clusters
    .slice(0, MAX_SEED_CLUSTERS)
    .filter((c) => c.vote >= 0.5)
    .map((c) => ({ from: c.lo - 4, to: c.hi + m + 6, vote: c.vote }));
}

export function relationOf(ix: CorpusIndex, anchorVerse: number | null, verseIndex: number): Relation {
  if (anchorVerse === null) return 'unlocated';
  if (verseIndex === anchorVerse) return 'same';
  const a = ix.verses[anchorVerse];
  const b = ix.verses[verseIndex];
  if (verseIndex === anchorVerse + 1) return 'next';
  if (verseIndex === anchorVerse + 2 && a.surah === b.surah) return 'skip';
  if (verseIndex < anchorVerse && a.surah === b.surah && anchorVerse - verseIndex <= 5) return 'repeat';
  return 'jump';
}

/** Resource-backed collision neighbours of a verse (verse indices, strongest first). */
export type NeighbourProvider = (verseIndex: number) => readonly number[];

export const NEIGHBOUR_BUDGET = 24;

export type CandidateSet = Candidate[] & { neighbourRegions?: number; neighbourTruncated?: number };

export function buildCandidates(
  ix: CorpusIndex,
  obs: readonly Obs[],
  anchor: { pos: number; verseIndex: number } | null,
  priorVerse: number | null,
  extraRegions: ReadonlyArray<{ from: number; to: number }> = [],
  neighbours: NeighbourProvider | null = null,
): CandidateSet {
  const regions: Array<{ from: number; to: number; source: 'local' | 'global' | 'neighbour' }> = extraRegions.map((r) => ({ ...r, source: 'global' as const }));
  const m = obs.length;
  const localAround = (pos: number, verseIndex: number) => {
    const back = ix.verseStart[Math.max(0, verseIndex - 1)];
    regions.push({ from: Math.max(back, pos - 120), to: pos + 2 * m + 16, source: 'local' });
  };
  if (anchor) localAround(anchor.pos, anchor.verseIndex);
  else if (priorVerse !== null) localAround(ix.verseStart[priorVerse], priorVerse);
  for (const r of globalSeeds(ix, obs)) regions.push({ ...r, source: 'global' });

  const byEnd = new Map<number, Candidate>();
  const alignAll = (rs: typeof regions) => {
    for (const r of rs) {
      const a = alignRegion(ix, obs, r.from, r.to);
      if (!a) continue;
      const verseIndex = ix.wordVerse[a.endPos];
      const prev = byEnd.get(a.endPos);
      if (prev && prev.score >= a.score) continue;
      // Distinct words: a phrase recited twice (going back after a breath) is not twice the evidence.
      const inVerse = new Set(a.pairs.filter(([, pos]) => ix.wordVerse[pos] === verseIndex).map(([, pos]) => pos)).size;
      byEnd.set(a.endPos, {
        ...a,
        verseIndex,
        inVerse,
        source: r.source === 'neighbour' ? 'global' : r.source,
        relation: relationOf(ix, anchor?.verseIndex ?? null, verseIndex),
      });
    }
  };
  alignAll(regions);
  let result: CandidateSet = [...byEnd.values()].sort((a, b) => b.score - a.score);

  // Collision neighbours (exact shared phrases, curated similar ayahs) of the anchored verse and of
  // the strongest global hypotheses are aligned too, so plausible twins stay represented even when
  // seed clusters were capped. Bounded; truncation is reported, never taken as uniqueness.
  let added = 0;
  let truncated = 0;
  if (neighbours) {
    const present = new Set(result.map((c) => c.verseIndex));
    const focal = [...new Set([anchor?.verseIndex, ...result.filter((c) => c.trailing <= 1).slice(0, 2).map((c) => c.verseIndex)].filter((v): v is number => v !== undefined))];
    const extra: typeof regions = [];
    for (const f of focal) {
      for (const n of neighbours(f)) {
        if (present.has(n)) continue;
        present.add(n);
        if (extra.length >= NEIGHBOUR_BUDGET) {
          truncated++;
          continue;
        }
        extra.push({ from: ix.verseStart[n] - m - 4, to: ix.verseStart[n] + ix.verseLen[n] + 2 * m, source: 'neighbour' });
      }
    }
    added = extra.length;
    if (extra.length) {
      alignAll(extra);
      result = [...byEnd.values()].sort((a, b) => b.score - a.score);
    }
  }
  result.neighbourRegions = added;
  result.neighbourTruncated = truncated;
  return result;
}

/** Best candidate per verse (highest score), preserving order. */
export function bestPerVerse(cands: readonly Candidate[]): Candidate[] {
  const seen = new Set<number>();
  const out: Candidate[] = [];
  for (const c of cands) {
    if (seen.has(c.verseIndex)) continue;
    seen.add(c.verseIndex);
    out.push(c);
  }
  return out;
}
