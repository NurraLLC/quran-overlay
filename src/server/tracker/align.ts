// Bounded, ordered alignment of recently heard words against a corpus region.
//
// Local alignment (free start in both the heard window and the corpus), scored by word
// informativeness. The heard window's *end* is where the reciter is now; trailing heard words the
// alignment cannot explain are reported (`trailing`) rather than hidden, so a candidate that only
// matched old words cannot pretend to describe current speech.

import type { CorpusIndex } from './index';
import { similarity } from './normalize';

export type Obs = {
  key: string;
  cons: string;
  foreign: boolean;
  startMs: number | null;
  endMs: number | null;
  /** The newest heard word is still forming (provisional prefix of a longer word). */
  partial?: boolean;
};

export type Alignment = {
  score: number;
  /** Corpus global positions of the first and last matched corpus words. */
  startPos: number;
  endPos: number;
  matched: number;
  matchedWeight: number;
  subs: number;
  ins: number;
  dels: number;
  /** Heard-window index of the last matched heard word. */
  lastObs: number;
  /** Heard words after the last matched one (not explained by this alignment). */
  trailing: number;
  /** Length of the final run of exact, consecutive heard/corpus word matches. */
  run: number;
  /** [heard index, corpus position, similarity] for matched/near-matched pairs, in order. */
  pairs: Array<[number, number, number]>;
  /** Heard indices that end a two-heard-words-as-one-Quran-word join (see joinSim). */
  merged?: number[];
};

export const ALIGN = {
  insArabic: 0.55,
  insForeign: 0.35,
  delBase: 0.3,
  delWeighted: 0.2,
  mismatch: 0.6,
  /** Per-word decay for older heard words: current speech dominates, older context still counts. */
  recency: 0.85,
  recencyFloor: 0.1,
};

const simCache = new Map<string, number>();
function sim(a: string, b: string): number {
  if (a === b) return 1;
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  let s = simCache.get(k);
  if (s === undefined) {
    s = similarity(a, b);
    if (simCache.size > 200_000) simCache.clear();
    simCache.set(k, s);
  }
  return s;
}

function pairScore(o: Obs, key: string, cons: string, w: number): { score: number; s: number } {
  if (o.foreign) return { score: -ALIGN.mismatch, s: 0 };
  if (o.key === key) return { score: w + (o.cons === cons ? 0.05 : 0), s: 1 };
  // A still-forming word counts as the corpus word it is a substantial prefix of (≥3 letters and
  // ≥ half the word): Soniox streams "ف" → "فلع" → "فلعلك", and waiting for the whole word cost
  // ~0.5 s at every ayah change. Shorter prefixes get no credit.
  if (o.partial && o.key.length >= 3 && o.key.length * 2 >= key.length && key.startsWith(o.key)) return { score: w * 0.9, s: 1 };
  const s = sim(o.key, key);
  if (s >= 0.75) return { score: w * s * 0.8, s };
  if (s >= 0.6) return { score: w * 0.3, s };
  return { score: -ALIGN.mismatch, s };
}

const DIAG = 1;
const UP = 2; // heard word inserted
const LEFT = 3; // corpus word skipped
const MERGE = 4; // two heard words = one corpus word ("ولا الآخرة" for "وللآخرة")
const SPLIT = 5; // one heard word = two corpus words

/**
 * ASR engines split and merge Arabic words at attached particles, usually inserting or dropping an
 * alif at the break ("ولا الآخرة" for "وللآخرة"). A join counts only when both sides agree once
 * alifs are ignored and the skeleton is long enough not to collide by chance ("الله" vs "إلا له"),
 * or when they are near-identical outright. Joins never take a still-forming word's prefix
 * credit, which would let any word swallow the next one.
 */
const JOIN_SIM = 0.9;
const JOIN_MIN_SKELETON = 5;
const skeletons = new Map<string, string>();
const skeleton = (k: string) => {
  let s = skeletons.get(k);
  if (s === undefined) {
    s = k.replace(/ا/g, '');
    if (skeletons.size > 100_000) skeletons.clear();
    skeletons.set(k, s);
  }
  return s;
};
function joinSim(heard: string, corpus: string): number {
  if (heard[0] !== corpus[0] || Math.abs(heard.length - corpus.length) > 2) return 0;
  const a = skeleton(heard);
  if (a.length >= JOIN_MIN_SKELETON && a === skeleton(corpus)) return JOIN_SIM;
  const s = sim(heard, corpus);
  return s >= JOIN_SIM ? s : 0;
}

let H = new Float64Array(0);
let D = new Uint8Array(0);
let S = new Float32Array(0);

/** Align heard words `obs` against corpus positions [from, to). */
export function alignRegion(ix: CorpusIndex, obs: readonly Obs[], from: number, to: number): Alignment | null {
  from = Math.max(0, from);
  to = Math.min(ix.totalWords, to);
  const m = obs.length;
  const n = to - from;
  if (m === 0 || n <= 0) return null;
  const size = (m + 1) * (n + 1);
  if (H.length < size) {
    H = new Float64Array(size * 2);
    D = new Uint8Array(size * 2);
    S = new Float32Array(size * 2);
  }
  const W = n + 1;
  for (let j = 0; j <= n; j++) {
    H[j] = 0;
    D[j] = 0;
  }
  for (let i = 1; i <= m; i++) {
    const o = obs[i - 1];
    const prevObs = i >= 2 ? obs[i - 2] : null;
    // Built once per heard word, not per corpus cell (this loop is the tracker's hot path).
    const mergedKey = prevObs && !prevObs.foreign && !o.foreign ? prevObs.key + o.key : null;
    const canSplit = !o.foreign;
    const f = Math.max(ALIGN.recencyFloor, ALIGN.recency ** (m - i));
    const ins = (o.foreign ? ALIGN.insForeign : ALIGN.insArabic) * f;
    H[i * W] = 0;
    D[i * W] = 0;
    for (let j = 1; j <= n; j++) {
      const pos = from + j - 1;
      const w = ix.weight[ix.wordId[pos]];
      const ps = pairScore(o, ix.words[pos], ix.consWords[pos], w);
      let best = 0;
      let dir = 0;
      const diag = H[(i - 1) * W + j - 1] + ps.score * f;
      if (diag > best) {
        best = diag;
        dir = DIAG;
      }
      const up = H[(i - 1) * W + j] - ins;
      if (up > best) {
        best = up;
        dir = UP;
      }
      const left = H[i * W + j - 1] - (ALIGN.delBase + ALIGN.delWeighted * w) * f;
      if (left > best) {
        best = left;
        dir = LEFT;
      }
      let cellSim = ps.s;
      if (mergedKey && mergedKey[0] === ix.words[pos][0]) {
        const js = joinSim(mergedKey, ix.words[pos]);
        const v = H[(i - 2) * W + j - 1] + w * js * 0.8 * f;
        if (js && v > best) {
          best = v;
          dir = MERGE;
          cellSim = js;
        }
      }
      // Cheap checks first: a split must start with the same letter and be about as long.
      if (canSplit && j >= 2 && o.key[0] === ix.words[pos - 1][0] && Math.abs(o.key.length - ix.words[pos - 1].length - ix.words[pos].length) <= 2) {
        const js = joinSim(o.key, ix.words[pos - 1] + ix.words[pos]);
        const v = H[(i - 1) * W + j - 2] + (w + ix.weight[ix.wordId[pos - 1]]) * js * 0.8 * f;
        if (js && v > best) {
          best = v;
          dir = SPLIT;
          cellSim = js;
        }
      }
      H[i * W + j] = best;
      D[i * W + j] = dir;
      S[i * W + j] = cellSim;
    }
  }
  // Best cell ending at *any* heard row; trailing rows after it are unexplained speech.
  let bi = 0;
  let bj = 0;
  let bestScore = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const v = H[i * W + j];
      // Prefer later heard rows on ties so current speech is explained when possible.
      if (v > bestScore + 1e-9 || (Math.abs(v - bestScore) <= 1e-9 && v > 0 && i > bi)) {
        bestScore = v;
        bi = i;
        bj = j;
      }
    }
  }
  if (bestScore <= 0) return null;
  // Penalize unexplained trailing heard words so the score describes the *current* position.
  let trailingPenalty = 0;
  for (let i = bi; i < m; i++) trailingPenalty += obs[i].foreign ? ALIGN.insForeign : ALIGN.insArabic;

  const pairs: Array<[number, number, number]> = [];
  const merged: number[] = [];
  let i = bi;
  let j = bj;
  let subs = 0;
  let ins = 0;
  let dels = 0;
  let matched = 0;
  let matchedWeight = 0;
  while (i > 0 && j > 0 && H[i * W + j] > 0) {
    const dir = D[i * W + j];
    if (dir === DIAG) {
      const s = S[i * W + j];
      const pos = from + j - 1;
      if (s >= 0.6) {
        pairs.push([i - 1, pos, s]);
        matched++;
        matchedWeight += ix.weight[ix.wordId[pos]] * (s === 1 ? 1 : s * 0.8);
        if (s < 1) subs++;
      } else subs++;
      i--;
      j--;
    } else if (dir === MERGE) {
      const sm = S[i * W + j];
      const pos = from + j - 1;
      pairs.push([i - 1, pos, sm]);
      merged.push(i - 1);
      matched++;
      matchedWeight += ix.weight[ix.wordId[pos]] * (sm === 1 ? 1 : sm * 0.8);
      if (sm < 1) subs++;
      i -= 2;
      j--;
    } else if (dir === SPLIT) {
      const sm = S[i * W + j];
      const pos = from + j - 1;
      pairs.push([i - 1, pos, sm], [i - 1, pos - 1, sm]);
      matched += 2;
      matchedWeight += (ix.weight[ix.wordId[pos]] + ix.weight[ix.wordId[pos - 1]]) * (sm === 1 ? 1 : sm * 0.8);
      if (sm < 1) subs++;
      i--;
      j -= 2;
    } else if (dir === UP) {
      ins++;
      i--;
    } else if (dir === LEFT) {
      dels++;
      j--;
    } else break;
  }
  pairs.reverse();
  if (!pairs.length) return null;
  const endPos = pairs[pairs.length - 1][1];
  const lastObs = pairs[pairs.length - 1][0];
  let run = 0;
  for (let k = pairs.length - 1; k >= 0; k--) {
    const [oi, pos, s] = pairs[k];
    if (s !== 1) break;
    if (k < pairs.length - 1) {
      const [noi, npos] = pairs[k + 1];
      if (noi !== oi + 1 || npos !== pos + 1) break;
    }
    run++;
  }
  return {
    score: bestScore - trailingPenalty,
    startPos: pairs[0][1],
    endPos,
    matched,
    matchedWeight,
    subs,
    ins,
    dels,
    lastObs,
    trailing: m - 1 - lastObs,
    run,
    pairs,
    merged,
  };
}
