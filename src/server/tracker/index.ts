// Full-corpus word index: every Imlaei search word of all 6,236 ayahs, flattened in canonical order.
// Built once at startup (~100 ms); no per-update allocation proportional to corpus size.

import { MUQATTAAT_KEYS, type Verse } from '../../shared/corpus-types';
import { MUQATTAAT_LETTERS, relaxed, similarity, spokenLetterNames, tokenize, type NormToken } from './normalize';

export type CorpusIndex = {
  verses: Verse[];
  /** Relaxed word key per global word position. */
  words: string[];
  /** Conservative word form per position (exact-credit comparisons). */
  consWords: string[];
  wordVerse: Int32Array;
  verseStart: Int32Array;
  verseLen: Int32Array;
  vocab: Map<string, number>;
  wordId: Int32Array;
  postings: Int32Array[];
  df: Int32Array;
  /** Informativeness weight per vocab id in [0.2, 1]. */
  weight: Float32Array;
  /** bigram (id1*V+id2) -> end positions */
  bigrams: Map<number, Int32Array>;
  /** SymSpell-style single-deletion index: deletion string -> vocab ids */
  deletes: Map<string, number[]>;
  /** Muqatta'at words (relaxed) that can be recited as letter names. */
  letterWords: Set<string>;
  totalWords: number;
};

export function buildIndex(verses: Verse[]): CorpusIndex {
  const words: string[] = [];
  const consWords: string[] = [];
  const wordVerseArr: number[] = [];
  const verseStart = new Int32Array(verses.length);
  const verseLen = new Int32Array(verses.length);
  const letterWords = new Set<string>();

  for (const v of verses) {
    verseStart[v.index] = words.length;
    const toks = tokenize(v.searchText).filter((t) => !t.foreign);
    for (const t of toks) {
      words.push(t.key);
      consWords.push(t.cons);
      wordVerseArr.push(v.index);
    }
    verseLen[v.index] = toks.length;
    if (MUQATTAAT_KEYS.has(v.key) && toks.length && isMuqattaatWord(toks[0].key)) letterWords.add(toks[0].key);
  }

  const vocab = new Map<string, number>();
  const wordId = new Int32Array(words.length);
  const counts: number[] = [];
  for (let i = 0; i < words.length; i++) {
    let id = vocab.get(words[i]);
    if (id === undefined) {
      id = vocab.size;
      vocab.set(words[i], id);
      counts.push(0);
    }
    counts[id]++;
    wordId[i] = id;
  }
  const V = vocab.size;
  const df = Int32Array.from(counts);
  const postingLists: number[][] = Array.from({ length: V }, () => []);
  for (let i = 0; i < words.length; i++) postingLists[wordId[i]].push(i);
  const postings = postingLists.map((p) => Int32Array.from(p));

  const N = words.length;
  const maxInfo = Math.log2(N);
  const weight = new Float32Array(V);
  for (let id = 0; id < V; id++) {
    const info = Math.log2(N / df[id]);
    weight[id] = Math.max(0.2, Math.min(1, info / (maxInfo * 0.75)));
  }

  const bigramLists = new Map<number, number[]>();
  for (let i = 1; i < words.length; i++) {
    const k = wordId[i - 1] * V + wordId[i];
    let l = bigramLists.get(k);
    if (!l) bigramLists.set(k, (l = []));
    l.push(i);
  }
  const bigrams = new Map<number, Int32Array>();
  for (const [k, l] of bigramLists) bigrams.set(k, Int32Array.from(l));

  const deletes = new Map<string, number[]>();
  for (const [w, id] of vocab) {
    if (w.length < 3) continue;
    for (const d of deletions(w)) {
      let l = deletes.get(d);
      if (!l) deletes.set(d, (l = []));
      if (l[l.length - 1] !== id) l.push(id);
    }
  }

  return {
    verses,
    words,
    consWords,
    wordVerse: Int32Array.from(wordVerseArr),
    verseStart,
    verseLen,
    vocab,
    wordId,
    postings,
    df,
    weight,
    bigrams,
    deletes,
    letterWords,
    totalWords: N,
  };
}

function isMuqattaatWord(key: string): boolean {
  if (!key || key.length > 5) return false;
  for (const ch of key) if (!MUQATTAAT_LETTERS.has(ch)) return false;
  return true;
}

function deletions(w: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < w.length; i++) out.add(w.slice(0, i) + w.slice(i + 1));
  return out;
}

export type WordMatch = { id: number; sim: number };

/** Vocabulary candidates for one transcript word: exact, then edit-distance-1/2 neighbours. */
export function lookupWord(ix: CorpusIndex, key: string, limit = 6): WordMatch[] {
  const exact = ix.vocab.get(key);
  const out: WordMatch[] = exact !== undefined ? [{ id: exact, sim: 1 }] : [];
  if (key.length < 3) return out;
  const seen = new Set<number>(out.map((m) => m.id));
  const probes = new Set<string>([key, ...deletions(key)]);
  for (const p of probes) {
    const hit = ix.vocab.get(p);
    if (hit !== undefined && !seen.has(hit)) {
      seen.add(hit);
      out.push({ id: hit, sim: similarity(key, p) });
    }
    for (const id of ix.deletes.get(p) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, sim: similarity(key, ix.words[ix.postings[id][0]]) });
    }
  }
  return out
    .filter((m) => m.sim >= 0.6)
    .sort((a, b) => b.sim - a.sim || ix.df[a.id] - ix.df[b.id])
    .slice(0, limit);
}

const LETTER_NAME_TO_LETTER = new Map<string, string>([
  ['الف', 'ا'],
  ['لام', 'ل'],
  ['ميم', 'م'],
  ['را', 'ر'],
  ['صاد', 'ص'],
  ['كاف', 'ك'],
  ['ها', 'ه'],
  ['يا', 'ي'],
  ['عين', 'ع'],
  ['طا', 'ط'],
  ['سين', 'س'],
  ['حا', 'ح'],
  ['قاف', 'ق'],
  ['نون', 'ن'],
]);

function lettersOfFusedNames(key: string): string | null {
  // Greedy parse of a token made only of concatenated letter names (e.g. "حاميم" -> "حم").
  let rest = key;
  let letters = '';
  outer: while (rest) {
    for (const [name, letter] of LETTER_NAME_TO_LETTER) {
      if (rest.startsWith(name)) {
        letters += letter;
        rest = rest.slice(name.length);
        continue outer;
      }
    }
    return null;
  }
  return letters;
}

/**
 * Recognizers may write a disjoint-letter opening as letter names ("الف لام ميم", "حاميم").
 * Collapse such runs into the written muqatta'at word *only* when the result is an actual
 * muqatta'at word in this corpus; ordinary words like "يا" or "لام" are otherwise untouched.
 */
/**
 * Whole words the recogniser writes for a recited disjoint-letter opening that are neither the
 * letters nor their names (measured: "يس", recited "yaa-seen", came back as "إياس").
 */
const HEARD_LETTER_WORDS: Record<string, string> = { اياس: 'يس', ياس: 'يس' };

export function canonicalizeLetterNames(ix: CorpusIndex, toks: NormToken[]): NormToken[] {
  const out: NormToken[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.foreign) {
      out.push(t);
      continue;
    }
    // Run of separate letter-name tokens.
    let j = i;
    let letters = '';
    while (j < toks.length && !toks[j].foreign && LETTER_NAME_TO_LETTER.has(toks[j].key)) {
      letters += LETTER_NAME_TO_LETTER.get(toks[j].key);
      j++;
    }
    const single = j - i === 1;
    const singleOk = single && ['صاد', 'قاف', 'نون'].includes(t.key);
    if (j - i >= 2 || singleOk) {
      // Longest prefix of the run that forms a corpus muqatta'at word.
      for (let end = j; end > i; end--) {
        const cand = relaxed(lettersFor(toks, i, end));
        if (ix.letterWords.has(cand) && (end - i >= 2 || singleOk)) {
          out.push({ key: cand, cons: cand, foreign: false });
          i = end - 1;
          letters = '';
          break;
        }
      }
      if (letters === '') continue;
    }
    const heard = HEARD_LETTER_WORDS[t.key];
    if (heard && ix.letterWords.has(heard)) {
      out.push({ key: heard, cons: heard, foreign: false });
      continue;
    }
    const fused = lettersOfFusedNames(t.key);
    if (fused && fused.length >= 2 && ix.letterWords.has(fused)) {
      out.push({ key: fused, cons: fused, foreign: false });
      continue;
    }
    out.push(t);
  }
  return out;
}

function lettersFor(toks: NormToken[], from: number, to: number): string {
  let s = '';
  for (let k = from; k < to; k++) s += LETTER_NAME_TO_LETTER.get(toks[k].key) ?? '';
  return s;
}

export { spokenLetterNames };
