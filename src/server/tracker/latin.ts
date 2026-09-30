// Recitation written in Latin letters. When a reader recites plainly (without melody), or right after
// speaking English, the recogniser sometimes writes the Arabic it hears in English letters: "Inna
// fatahna laka fathan mubina", "Bismillahirrahmanirrahim". Nothing can follow that as Arabic, so
// runs of Latin words are matched by sound against the Quran's word-by-word transliteration
// (consonant skeletons: vowels, doubled letters, spaces and diacritics vary freely between
// spellings, consonants much less) and replaced by the Arabic words they match. Output keeps one
// word per input word (an index-stable view), so everything downstream is unchanged; a Latin word
// that matched nothing Quranic is left as it was (English requests stay English).
//
// Near the current place a moderate match is enough; anywhere else the match must be long and
// unique. The tracker still applies its own evidence rules to the Arabic it receives.

import type { Word } from '../../shared/transcript';
import type { Corpus } from '../corpus/load';
import { mapDisplayWords } from '../corpus/word-map';
import { assimilate, skeleton } from '../search/transliteration';
import type { CorpusIndex } from './index';
import { tokenize } from './normalize';

const LATIN = /[A-Za-z]/;
const ARABIC = /[ء-ي]/;
/** Everyday English words: a run containing them is speech to the app, not recitation. */
const ENGLISH = new Set(['go', 'to', 'the', 'surah', 'sura', 'ayah', 'verse', 'show', 'me', 'find', 'about', 'please', 'next', 'previous', 'and', 'is', 'of', 'in', 'what', 'where', 'this', 'that', 'english', 'arabic', 'only', 'mode', 'pause', 'resume', 'hide', 'stop', 'start', 'okay', 'ok', 'yes', 'no', 'thanks', 'thank', 'you', 'guys', 'everyone', 'so', 'now', 'let', 'lets', 'we', 'i', 'it']);
const isEnglish = (w: string) => ENGLISH.has(w.toLowerCase().replace(/[^a-z']/g, ''));
const MIN_LOCAL = 6;
const MIN_GLOBAL = 12;
const LOCAL_BEFORE = 80;
const LOCAL_AFTER = 400;
/**
 * A run is read at most this many words at a time, and a longer consonant pattern is not searched:
 * a whole-Quran search costs ~pattern × 220,000 steps, so an unbounded run (a long transliterated
 * passage, or a crafted message) could hold the server for seconds. Recited runs are far shorter.
 */
const MAX_RUN_WORDS = 8;
const MAX_PATTERN = 64;

type QWord = { verseIndex: number; skel: string; arabic: string };

export class LatinReader {
  private readonly words: QWord[] = [];
  private readonly verseFirst: Int32Array;
  private text = '';
  private charWord: Int32Array = new Int32Array(0);
  private readonly cache = new Map<string, Array<string | null>>();

  constructor(ix: CorpusIndex, corpus: Corpus, translit: Record<string, string[]>) {
    this.verseFirst = new Int32Array(ix.verseStart.length).fill(-1);
    const chars: number[] = [];
    let text = '';
    for (let v = 0; v < corpus.verses.length; v++) {
      const verse = corpus.at(v)!;
      const sounds = translit[verse.key];
      if (!sounds) continue;
      const display = verse.arabicDisplay.split(/\s+/).filter(Boolean);
      const spoken = display.map((t, d) => ({ t, d })).filter(({ t }) => ARABIC.test(t) || /[ٱ-ۓ]/.test(t));
      if (spoken.length !== sounds.length) continue;
      // Tracker spelling (search script) for each displayed word, where the scripts map exactly.
      const searchTokens = tokenize(verse.searchText).filter((t) => !t.foreign).map((t) => t.key);
      const spans = mapDisplayWords(verse.searchText, verse.arabicDisplay);
      const forDisplay = new Map<number, string[]>();
      spans.forEach((s, i) => {
        if (!s) return;
        const list = forDisplay.get(s.from) ?? [];
        list.push(searchTokens[i]);
        forDisplay.set(s.from, list);
      });
      this.verseFirst[v] = this.words.length;
      spoken.forEach(({ t, d }, k) => {
        const skel = skeleton(assimilate(sounds[k]));
        this.words.push({ verseIndex: v, skel, arabic: (forDisplay.get(d) ?? [tokenize(t)[0]?.key ?? t]).join(' ') });
        text += skel;
        for (let c = 0; c < skel.length; c++) chars.push(this.words.length - 1);
      });
    }
    this.text = text;
    this.charWord = Int32Array.from(chars);
  }

  get size() {
    return this.words.length;
  }

  /**
   * An index-stable view of `words` in which Latin runs that are recitation carry the Arabic words
   * they match. `near` is the verse the reciter is at (null if unknown).
   */
  apply(words: readonly Word[], near: number | null): Word[] {
    let out: Word[] | null = null;
    let i = 0;
    while (i < words.length) {
      if (!LATIN.test(words[i].text) || ARABIC.test(words[i].text)) {
        i++;
        continue;
      }
      // A run of Latin words may mix requests and recitation ("Go to Inna Fatahna. Inna fatahna
      // laka fathan mubina"): it is cut at English words and sentence ends, and each piece is read
      // on its own.
      let j = i;
      while (j < words.length && j - i < MAX_RUN_WORDS && LATIN.test(words[j].text) && !ARABIC.test(words[j].text) && !isEnglish(words[j].text)) {
        j++;
        if (/[.?!]$/.test(words[j - 1].text.trim())) break;
      }
      if (j === i) {
        i++;
        continue;
      }
      const run = words.slice(i, j);
      const arabic = this.convert(run.map((w) => w.text), near);
      if (arabic) {
        out ??= [...words];
        arabic.forEach((a, k) => {
          if (a !== null) out![i + k] = { ...words[i + k], text: a };
        });
      }
      i = j;
    }
    return out ?? (words as Word[]);
  }

  /** Arabic for each Latin word of a run ("" for a word absorbed by its neighbour), or null. */
  private convert(latin: string[], near: number | null): Array<string | null> | null {
    const lower = latin.map((w) => w.toLowerCase().replace(/[^a-z'-]/g, ''));
    if (lower.some((w) => ENGLISH.has(w))) return null;
    const key = `${near}|${lower.join(' ')}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const result = this.match(lower, near);
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, result as Array<string | null>);
    return result;
  }

  private match(latin: string[], near: number | null): Array<string | null> | null {
    // Pattern: consonant skeleton of the run, remembering which Latin word each letter came from.
    let pattern = '';
    const from: number[] = [];
    latin.forEach((w, k) => {
      const s = skeleton(w);
      pattern += s;
      for (let c = 0; c < s.length; c++) from.push(k);
    });
    // Re-collapse doubles across word boundaries, as the corpus text is collapsed per word only.
    if (pattern.length < MIN_LOCAL || pattern.length > MAX_PATTERN) return null;

    let region: [number, number] | null = null;
    if (near !== null && this.verseFirst[near] >= 0) {
      const w0 = Math.max(0, this.verseFirst[near] - LOCAL_BEFORE);
      const w1 = Math.min(this.words.length, this.verseFirst[near] + LOCAL_AFTER);
      region = [this.charIndexOfWord(w0), this.charIndexOfWord(w1)];
    }
    const local = region ? this.best(pattern, region[0], region[1]) : null;
    const tolLocal = Math.max(1, Math.floor(pattern.length * 0.25));
    let found = local && local.dist <= tolLocal ? local : null;
    if (!found && pattern.length >= MIN_GLOBAL) {
      const g = this.best(pattern, 0, this.text.length);
      // Anywhere in the Quran: strict, and clearly better than any other place, unless the rival
      // place reads identically (the basmala of 1:1 and 27:30): the Arabic is then the same, and
      // telling the places apart is the tracker's job.
      if (g.dist <= Math.floor(pattern.length * 0.15)) {
        if (g.second >= g.dist + 2) found = g;
        else if (g.second === g.dist) {
          const mine = this.assign(pattern, from, latin.length, g.start, g.end);
          const other = this.assign(pattern, from, latin.length, this.startOf(pattern, Math.max(0, g.secondEnd - 2 * pattern.length), g.secondEnd), g.secondEnd);
          if (mine.join('|') === other.join('|')) return mine;
        }
      }
    }
    if (!found) return null;
    return this.assign(pattern, from, latin.length, found.start, found.end);
  }

  private charIndexOfWord(w: number): number {
    // First text position of word w (binary search over charWord).
    let lo = 0;
    let hi = this.charWord.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.charWord[mid] < w) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Best approximate occurrence of `p` inside text[a, b) (semi-global edit distance). */
  private best(p: string, a: number, b: number): { dist: number; start: number; end: number; second: number; secondEnd: number } {
    const m = p.length;
    let col = new Int32Array(m + 1);
    let prev = new Int32Array(m + 1);
    for (let i = 0; i <= m; i++) prev[i] = i;
    let bestD = Infinity;
    let bestJ = a;
    const ends: Array<[number, number]> = [];
    for (let j = a; j < b; j++) {
      const tc = this.text.charCodeAt(j);
      col[0] = 0;
      for (let i = 1; i <= m; i++) {
        const sub = prev[i - 1] + (p.charCodeAt(i - 1) === tc ? 0 : 1);
        const del = prev[i] + 1;
        const ins = col[i - 1] + 1;
        col[i] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
      }
      if (col[m] < bestD) {
        bestD = col[m];
        bestJ = j + 1;
      }
      if (col[m] <= Math.floor(m * 0.4)) ends.push([col[m], j + 1]);
      [prev, col] = [col, prev];
    }
    // Second best: the best end position that does not overlap the winner.
    let second = Infinity;
    let secondEnd = -1;
    for (const [d, e] of ends)
      if (Math.abs(e - bestJ) > m && d < second) {
        second = d;
        secondEnd = e;
      }
    // Start of the winner: rerun on a small window with a full matrix for the traceback.
    const start = this.startOf(p, Math.max(a, bestJ - 2 * m), bestJ);
    return { dist: bestD, start, end: bestJ, second, secondEnd };
  }

  private startOf(p: string, a: number, end: number): number {
    const m = p.length;
    const n = end - a;
    const D: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 0; i <= m; i++) D[i][0] = i;
    for (let j = 0; j <= n; j++) D[0][j] = 0;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++) D[i][j] = Math.min(D[i - 1][j - 1] + (p[i - 1] === this.text[a + j - 1] ? 0 : 1), D[i - 1][j] + 1, D[i][j - 1] + 1);
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
      const c = D[i][j];
      if (c === D[i - 1][j - 1] + (p[i - 1] === this.text[a + j - 1] ? 0 : 1)) {
        i--;
        j--;
      } else if (c === D[i - 1][j] + 1) i--;
      else j--;
    }
    return a + j;
  }

  /** Hand each matched Quran word to the Latin word most of its letters were heard in. */
  private assign(p: string, from: number[], runLength: number, start: number, end: number): Array<string | null> {
    const firstWord = this.charWord[start];
    const lastWord = this.charWord[Math.max(start, end - 1)];
    const out: Array<string[]> = Array.from({ length: runLength }, () => []);
    const span = Math.max(1, end - start);
    for (let w = firstWord; w <= lastWord; w++) {
      // Position of the word's middle within the matched text, mapped proportionally onto the pattern.
      const w0 = this.charIndexOfWord(w);
      const mid = Math.min(end - 1, Math.max(start, w0 + Math.floor(this.words[w].skel.length / 2)));
      const at = Math.min(p.length - 1, Math.floor(((mid - start) / span) * p.length));
      out[from[at]].push(this.words[w].arabic);
    }
    return out.map((list) => list.join(' '));
  }
}
