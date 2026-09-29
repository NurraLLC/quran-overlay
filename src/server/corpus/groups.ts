// Short ayahs shown together, like a line of a mushaf page.
//
// Consecutive short ayahs of a surah are packed into fixed groups from the surah's first ayah, so a
// group is the same wherever recitation starts and the text never reshuffles while it is followed.
// Word counts only decide eligibility; the renderer still measures and falls back to one ayah when a
// group does not fit at a comfortable size.

import type { Corpus } from './load';

/** An ayah this short (display words) may share the screen. */
export const SHORT_AYAH_WORDS = 9;
const GROUP_MAX_WORDS = 20;
const GROUP_MAX_AYAHS = 4;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

const cache = new WeakMap<Corpus, Int32Array>();

/** For every verse index, the first verse index of its group (a verse alone is its own group). */
function groupStarts(corpus: Corpus): Int32Array {
  let starts = cache.get(corpus);
  if (starts) return starts;
  const n = corpus.data.verses.length;
  starts = new Int32Array(n);
  let start = 0;
  let count = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const v = corpus.at(i)!;
    const w = words(v.arabicDisplay);
    const prev = i > 0 ? corpus.at(i - 1)! : null;
    const joins = w <= SHORT_AYAH_WORDS && prev && prev.surah === v.surah && words(prev.arabicDisplay) <= SHORT_AYAH_WORDS && count < GROUP_MAX_AYAHS && total + w <= GROUP_MAX_WORDS;
    if (joins) {
      count++;
      total += w;
    } else {
      start = i;
      count = 1;
      total = w;
    }
    starts[i] = start;
  }
  cache.set(corpus, starts);
  return starts;
}

/** Verse indexes of the group containing `index` (a single index when the ayah stands alone). */
export function shortGroup(corpus: Corpus, index: number): number[] {
  const starts = groupStarts(corpus);
  const first = starts[index];
  const out: number[] = [];
  for (let i = first; i < starts.length && starts[i] === first; i++) out.push(i);
  return out;
}
