// Complete corpus-derived exact phrase collisions (no download required). Every 4-word sequence of
// the normalized search text (all 6,236 ayahs) is indexed; verses sharing one are collision
// neighbours. This is exhaustive for exact text under NORMALIZATION_VERSION, unlike curated
// resources, and is the baseline that QUL similar-ayah/mutashabihat edges supplement.

import type { CorpusIndex } from '../tracker/index';
import { NORMALIZATION_VERSION } from '../tracker/normalize';
import type { VerseEdge } from './types';

export const PHRASE_N = 4;
export const DERIVED_ID = `derived:exact-phrase-${PHRASE_N}gram:${NORMALIZATION_VERSION}`;

export type PhraseIndex = {
  id: string;
  /** verse index -> neighbour verse index -> number of shared phrase occurrences */
  neighbours: Map<number, Map<number, number>>;
  /** Phrase occurrences in more than one verse. */
  sharedPhrases: number;
  /** Verses with at least one collision neighbour. */
  versesWithCollisions: number;
  buildMs: number;
};

export function buildPhraseIndex(ix: CorpusIndex): PhraseIndex {
  const t0 = performance.now();
  const V = ix.vocab.size;
  const occ = new Map<string, number[]>();
  for (let v = 0; v < ix.verses.length; v++) {
    const start = ix.verseStart[v];
    const len = ix.verseLen[v];
    for (let i = 0; i + PHRASE_N <= len; i++) {
      let key = '';
      for (let k = 0; k < PHRASE_N; k++) key += (k ? ',' : '') + ix.wordId[start + i + k];
      let l = occ.get(key);
      if (!l) occ.set(key, (l = []));
      if (l[l.length - 1] !== v) l.push(v);
    }
  }
  void V;
  const neighbours = new Map<number, Map<number, number>>();
  let shared = 0;
  for (const verses of occ.values()) {
    if (verses.length < 2) continue;
    shared++;
    for (const a of verses) {
      let m = neighbours.get(a);
      if (!m) neighbours.set(a, (m = new Map()));
      for (const b of verses) if (b !== a) m.set(b, (m.get(b) ?? 0) + 1);
    }
  }
  return { id: DERIVED_ID, neighbours, sharedPhrases: shared, versesWithCollisions: neighbours.size, buildMs: performance.now() - t0 };
}

export function derivedEdges(p: PhraseIndex, verseIndex: number): VerseEdge[] {
  const m = p.neighbours.get(verseIndex);
  if (!m) return [];
  return [...m.entries()].map(([to, count]) => ({ from: verseIndex, to, source: p.id, fromRanges: [], toRanges: [], strength: count }));
}
