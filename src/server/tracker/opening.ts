// Surah openings after a spoken basmala.
//
// A reciter who says "بسم الله الرحمن الرحيم" is about to start at an ayah boundary, almost always a
// surah's first ayah. That context identifies one-word opening ayahs ("والضحى", "يس") that ordinary
// acquisition, which needs three matched words, would skip entirely, and it makes the next surah
// after a finished one a one-word advance. The words after the basmala must begin exactly one ayah
// in the whole Quran (so a mid-surah start at another ayah can never be mistaken for an opening),
// except for the surah that directly follows the one just completed.

import { alignRegion, type Obs } from './align';
import { relationOf, type Candidate } from './candidates';
import type { CorpusIndex } from './index';
import { similarity, tokenize } from './normalize';

const BASMALA = tokenize('بسم الله الرحمن الرحيم').map((t) => t.key);
const MAX_AFTER = 8;
/** A lone word acquires only if it is this rare in the corpus (verses containing it). */
const LONE_WORD_MAX_DF = 2;

type Starts = { ayahStarts: Map<string, number[]>; openingOf: Map<number, number> };
const cache = new WeakMap<CorpusIndex, Starts>();

/** First-word key → ayah indexes starting with it; surah number → its opening ayah index. */
function starts(ix: CorpusIndex): Starts {
  let s = cache.get(ix);
  if (!s) {
    const ayahStarts = new Map<string, number[]>();
    const openingOf = new Map<number, number>();
    for (let v = 0; v < ix.verses.length; v++) {
      const first = ix.words[ix.verseStart[v]];
      const list = ayahStarts.get(first);
      if (list) list.push(v);
      else ayahStarts.set(first, [v]);
      const { surah, ayah } = ix.verses[v];
      // Al-Fatihah's basmala is its first ayah; what follows it is 1:2.
      if (surah !== 9 && ayah === (surah === 1 ? 2 : 1)) openingOf.set(surah, v);
    }
    s = { ayahStarts, openingOf };
    cache.set(ix, s);
  }
  return s;
}

/** Index in `obs` just after the latest spoken basmala (at most one near-miss word), or -1. */
function afterBasmala(obs: readonly Obs[]): number {
  for (let i = obs.length - BASMALA.length; i >= 0; i--) {
    let fuzzy = 0;
    let ok = true;
    for (let k = 0; k < BASMALA.length && ok; k++) {
      const o = obs[i + k];
      if (o.foreign || o.partial) ok = false;
      else if (o.key !== BASMALA[k]) ok = similarity(o.key, BASMALA[k]) >= 0.75 && ++fuzzy <= 1;
    }
    if (ok) return i + BASMALA.length;
  }
  return -1;
}

function wordMatches(o: Obs, key: string): boolean {
  if (o.foreign) return false;
  if (o.key === key) return true;
  return !!o.partial && o.key.length >= 3 && o.key.length * 2 >= key.length && key.startsWith(o.key);
}

/** Can a forming word still grow into a different Quran word? ("يس" → "يسبح"; "والضحى" cannot.) */
const growable = new Map<string, boolean>();
function canGrow(ix: CorpusIndex, key: string): boolean {
  let g = growable.get(key);
  if (g === undefined) {
    g = false;
    for (const w of ix.vocab.keys()) if (w.length > key.length && w.startsWith(key)) { g = true; break; }
    growable.set(key, g);
  }
  return g;
}

/** Does the corpus from position `pos` read exactly as `heard`? */
function readsAs(ix: CorpusIndex, pos: number, heard: readonly Obs[]): boolean {
  if (pos + heard.length > ix.totalWords) return false;
  for (let k = 0; k < heard.length; k++) if (!wordMatches(heard[k], ix.words[pos + k])) return false;
  return true;
}

export type OpeningMatch = { verseIndex: number; pos: number; candidate: Candidate; continuation: boolean };

/**
 * The surah opening the reciter has started after a basmala, when the heard words identify it.
 * `anchor` is the current location; finishing a surah's last ayah makes the next surah the prior.
 */
export function openingAfterBasmala(ix: CorpusIndex, obs: readonly Obs[], anchor: { verseIndex: number } | null): OpeningMatch | null {
  const at = afterBasmala(obs);
  if (at < 0) return null;
  let heard = obs.slice(at);
  // The next word's first letter or two cannot be judged yet; it must not veto what came before.
  if (heard.length > 1 && heard[heard.length - 1].partial && heard[heard.length - 1].key.length < 3) heard = heard.slice(0, -1);
  if (!heard.length || heard.length > MAX_AFTER || heard.some((o) => o.foreign)) return null;
  const { ayahStarts, openingOf } = starts(ix);

  let target: number | null = null;
  let continuation = false;
  if (anchor) {
    const cur = ix.verses[anchor.verseIndex];
    const next = ix.verses[anchor.verseIndex + 1];
    const nextOpening = next && next.surah === cur.surah + 1 ? openingOf.get(next.surah) : undefined;
    if (nextOpening !== undefined && next.ayah === 1 && readsAs(ix, ix.verseStart[nextOpening], heard)) {
      target = nextOpening;
      continuation = true;
    }
  }
  if (target === null) {
    // Every ayah in the Quran that begins with the heard words (exact; only the newest may be forming).
    const pool = ayahStarts.get(heard[0].key) ?? [];
    const hits = pool.filter((v) => readsAs(ix, ix.verseStart[v], heard));
    if (hits.length !== 1) return null;
    const v = hits[0];
    const { surah } = ix.verses[v];
    if (openingOf.get(surah) !== v) return null;
    if (heard.length === 1) {
      if (ix.df[ix.wordId[ix.verseStart[v]]] > LONE_WORD_MAX_DF) return null;
      if (heard[0].partial && canGrow(ix, heard[0].key)) return null;
    }
    target = v;
  }
  const start = ix.verseStart[target];
  const pos = start + heard.length - 1;
  const verseIndex = ix.wordVerse[pos];
  // Once tracking is on the span the heard words cover, ordinary following owns it.
  if (anchor && anchor.verseIndex >= target && anchor.verseIndex <= verseIndex) return null;
  const a = alignRegion(ix, heard, start, start + heard.length);
  if (!a) return null;
  const candidate: Candidate = {
    ...a,
    lastObs: a.lastObs + at,
    pairs: a.pairs.map(([oi, p, s]) => [oi + at, p, s] as [number, number, number]),
    merged: a.merged?.map((oi) => oi + at),
    verseIndex,
    inVerse: a.pairs.filter(([, p]) => ix.wordVerse[p] === verseIndex).length,
    source: 'global',
    relation: relationOf(ix, anchor?.verseIndex ?? null, verseIndex),
  };
  return { verseIndex, pos, candidate, continuation };
}

/** Shortest lone first word that may place the display (short words collide with speech). */
const LONE_START_MIN_LETTERS = 5;

/**
 * The first word of a session, when it occurs in exactly one verse of the whole Quran, identifies
 * that verse by itself ("والضحى", "والعصر"), wherever in the verse the reciter began. Ordinary
 * acquisition would wait for three words and never show a one-word opening ayah at all.
 */
export function uniqueFirstWord(ix: CorpusIndex, obs: readonly Obs[]): OpeningMatch | null {
  let heard = obs;
  if (heard.length === 2 && heard[1].partial && heard[1].key.length < 3) heard = heard.slice(0, 1);
  if (heard.length !== 1) return null;
  const o = heard[0];
  if (o.foreign || o.key.length < LONE_START_MIN_LETTERS) return null;
  const id = ix.vocab.get(o.key);
  if (id === undefined || ix.df[id] !== 1 || ix.postings[id].length !== 1) return null;
  if (o.partial && canGrow(ix, o.key)) return null;
  const pos = ix.postings[id][0];
  const verseIndex = ix.wordVerse[pos];
  const a = alignRegion(ix, heard, pos, pos + 1);
  if (!a) return null;
  const candidate: Candidate = { ...a, verseIndex, inVerse: 1, source: 'global', relation: relationOf(ix, null, verseIndex) };
  return { verseIndex, pos, candidate, continuation: false };
}
