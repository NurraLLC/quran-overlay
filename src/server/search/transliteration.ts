// Find an ayah by how it sounds, written in English letters ("go to inna fatahna",
// "Bismillahirrahmanirrahim"). Compares consonant skeletons of the query and of each ayah's
// word-by-word transliteration (Quran.com): vowels, doubled letters, spaces and diacritics vary
// freely between spellings, consonants much less. Only the beginning of an ayah is matched, which
// is how people name one.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../corpus/manifest';
import type { Corpus } from '../corpus/load';

/** Command words around a transliterated name ("go to ... please") are not part of its sound. */
const IGNORE = new Set(['go', 'to', 'the', 'ayah', 'aya', 'ayat', 'verse', 'show', 'me', 'open', 'take', 'jump', 'please', 'where', 'it', 'says', 'that', 'starts', 'with', 'begins', 'recite', 'play', 'find', 'one', 'a', 'of', 'surah', 'sura', 'from']);
const MIN_SKELETON = 5;
/** Consonants of following ayahs appended to a short ayah's opening. */
const RUN_ON = 40;

/** The article's l is not pronounced before sun letters ("l-raḥmāni" is said "r-raḥmāni"). */
function assimilate(word: string): string {
  return word.replace(/^(.*?)l-(?=(t|th|d|dh|r|z|s|sh|ṣ|ḍ|ṭ|ẓ|n|l)[^h]?)/i, '$1');
}

export function skeleton(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/q/g, 'k')
    .replace(/[aeiouy'w]/g, '')
    .replace(/(.)\1+/g, '$1');
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export type SoundMatch = { verseIndex: number; distance: number };

export class Transliteration {
  private constructor(private readonly starts: Array<{ verseIndex: number; skel: string }>) {}

  static load(corpus: Corpus, file = path.join(ROOT, 'data', 'processed', 'translit-en.json')): Transliteration | null {
    if (!existsSync(file)) return null;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { verses?: Record<string, string[]> };
      const starts: Array<{ verseIndex: number; skel: string }> = [];
      for (const [key, words] of Object.entries(j.verses ?? {})) {
        const v = corpus.verse(key);
        if (v) starts.push({ verseIndex: v.index, skel: skeleton(words.map(assimilate).join('')) });
      }
      starts.sort((a, b) => a.verseIndex - b.verseIndex);
      // A named opening may run on into the next ayahs ("ar-rahman, allamal quran" is 55:1-2).
      const own = starts.map((s) => s.skel);
      for (let i = 0; i < starts.length; i++) {
        const surah = corpus.at(starts[i].verseIndex)!.surah;
        for (let j = i + 1; j < starts.length && starts[i].skel.length < RUN_ON && corpus.at(starts[j].verseIndex)!.surah === surah && starts[j].verseIndex === starts[j - 1].verseIndex + 1; j++) starts[i].skel += own[j];
      }
      return new Transliteration(starts);
    } catch {
      return null;
    }
  }

  /** Ayahs whose beginning sounds like the query, best first; empty when the query is not one. */
  match(query: string): SoundMatch[] {
    const words = query.toLowerCase().split(/[^a-z'À-ɏ-]+/).filter((w) => w && !IGNORE.has(w));
    const q = skeleton(words.join(''));
    if (q.length < MIN_SKELETON) return [];
    const tol = q.length <= 8 ? 1 : q.length <= 14 ? 2 : 3;
    const out: SoundMatch[] = [];
    for (const s of this.starts) {
      let best = Infinity;
      for (let len = q.length - 2; len <= q.length + 2; len++) if (len > 0 && len <= s.skel.length) best = Math.min(best, distance(q, s.skel.slice(0, len)));
      if (best <= tol) out.push({ verseIndex: s.verseIndex, distance: best });
    }
    return out.sort((a, b) => a.distance - b.distance || a.verseIndex - b.verseIndex);
  }
}
