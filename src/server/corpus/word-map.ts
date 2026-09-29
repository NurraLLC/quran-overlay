// Map only textually supported groups between source scripts. Unmatched words stay unmapped;
// equal token counts alone never justify a highlight. Source display bytes remain untouched.
import { relaxed, tokenize } from '../tracker/normalize';
export type WordSpan = { from: number; to: number };
export function mapDisplayWords(search: string, display: string): Array<WordSpan | null> {
  const a = tokenize(search).filter(t => !t.foreign).map(t => t.key);
  // Standalone pause marks have screen coordinates but no spoken word. Exclude them from
  // alignment and restore original coordinates afterward; attaching them to either neighbour
  // would otherwise make a perfectly clear word appear ambiguous.
  const visibleWords = display.trim().split(/\s+/).map((text, index) => ({ text, index })).filter(w => relaxed(w.text));
  const displayTokens = visibleWords.map(w => w.text);
  const b = displayTokens.map(relaxed);
  // Uthmani spellings that Imlaei writes differently are accepted only when they exactly match the
  // ordered search group; displayed scripture is never changed. Each applicable rule may or may
  // not apply (every combination is tried): "وَمَلَـٰٓئِكَتِهِۦ" needs its small alif read as ا
  // but not its closing small ya (a sound extension Imlaei does not write) read as ي.
  const variants = displayTokens.map(spellings);
  const forms = (j: number, y: number) => {
    let parts = [''];
    for (let k = j; k < j + y; k++) parts = parts.flatMap(p => variants[k].map(v => p + v));
    return parts;
  };
  const groupForms = Array.from({ length: b.length }, (_, j) => Array.from({ length: 4 }, (_, y) => y && j + y <= b.length ? forms(j, y) : []));
  // Prefer the smallest supported split/join; do not absorb an adjacent exact word into it.
  const n = a.length, m = b.length;
  const cost = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(Infinity));
  cost[0][0] = 0;
  const visit = (i: number, j: number, ni: number, nj: number, extra: number) => {
    if (cost[i][j] + extra < cost[ni][nj]) {
      cost[ni][nj] = cost[i][j] + extra;
    }
  };
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    if (!Number.isFinite(cost[i][j])) continue;
    if (i < n) visit(i, j, i + 1, j, 2);
    if (j < m) visit(i, j, i, j + 1, 2);
    for (let x = 1; x <= 3 && i + x <= n; x++) for (let y = 1; y <= 3 && j + y <= m; y++) {
      const left = a.slice(i, i + x).join('');
      if (left && groupForms[j][y].includes(left)) visit(i, j, i + x, j + y, (x + y - 2) ** 2 * 0.05);
    }
  }
  // A repeated word can admit equally good coordinate mappings. Retain a span only if every
  // optimal alignment agrees; otherwise the verse stays readable without a guessed highlight.
  const back = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(Infinity));
  back[n][m] = 0;
  const edges = (i: number, j: number): Array<[number, number, number, boolean]> => {
    const result: Array<[number, number, number, boolean]> = [];
    if (i < n) result.push([i + 1, j, 2, false]);
    if (j < m) result.push([i, j + 1, 2, false]);
    for (let x = 1; x <= 3 && i + x <= n; x++) for (let y = 1; y <= 3 && j + y <= m; y++) {
      const left = a.slice(i, i + x).join('');
      if (left && groupForms[j][y].includes(left)) result.push([i + x, j + y, (x + y - 2) ** 2 * .05, true]);
    }
    return result;
  };
  for (let i = n; i >= 0; i--) for (let j = m; j >= 0; j--) for (const [ni, nj, extra] of edges(i, j)) back[i][j] = Math.min(back[i][j], extra + back[ni][nj]);
  const choices = Array.from({ length: n }, () => new Set<string>());
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) for (const [ni, nj, extra, matched] of edges(i, j)) {
    if (Math.abs(cost[i][j] + extra + back[ni][nj] - cost[n][m]) > 1e-7) continue;
    for (let k = i; k < ni; k++) choices[k].add(matched ? `${j}:${nj - 1}` : '?');
  }
  return choices.map(c => {
    if (c.size !== 1 || c.has('?')) return null;
    const [from, to] = [...c][0].split(':').map(Number);
    return { from: visibleWords[from].index, to: visibleWords[to].index };
  });
}

/** Uthmani → Imlaei spelling differences (pair rules first, so they take the dagger alif). */
const SPELLING_RULES: Array<[RegExp, string]> = [
  [/ى([ً-ْ]*)ٰ/g, 'ا$1'], // مَوْلَىٰنَا → مولانا
  [/و([ً-ْ]*)ٰ/g, 'ا$1'], // ٱلصَّلَوٰةَ → الصلاة
  [/ـ([ً-ْ]*)ٔ/g, 'ئ$1'], // يَـُٔودُهُۥ → يئوده
  [/^([وفب]?[ً-ْ]*)ٱل([ً-ِْ]*)ّ/g, '$1ٱلل$2'], // ٱلَّيْلِ → الليل
  [/ء/g, 'ا'], // ءَأَنذَرْتَهُمْ → أأنذرتهم
  [/ٰ/g, 'ا'], // small alif written in full
  [/ۥ/g, 'و'], // small waw
  [/ۦ/g, 'ي'], // small ya
];

function spellings(word: string): string[] {
  const applicable = SPELLING_RULES.filter(([re]) => new RegExp(re.source).test(word));
  const out = new Set<string>();
  for (let mask = 0; mask < 1 << applicable.length; mask++) {
    let w = word;
    applicable.forEach(([re, to], k) => {
      if (mask & (1 << k)) w = w.replace(re, to);
    });
    out.add(relaxed(w));
  }
  return [...out];
}
