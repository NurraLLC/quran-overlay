// Local, deterministic parsing of explicit references ("2:255", "surah two verse two hundred
// fifty-five", "Surah Maryam ayah 3", "yaseen", "verse 10") and English numerals.
// Chapter aliases derive mechanically from the corpus chapter names; nothing is guessed.

import type { Chapter } from '../../shared/corpus-types';

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  won: 1, to: 2, too: 2, for: 4, ate: 8,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const HOMOPHONES = new Set(['won', 'to', 'too', 'for', 'ate']);

/**
 * Parse a run of English number words starting at tokens[i].
 * Supports "two hundred (and) fifty(-)five", "two fifty five" (= 255), ordinals, digits.
 */
export function parseNumberAt(tokens: string[], i: number): { value: number; next: number } | null {
  const t = tokens[i];
  if (t === undefined) return null;
  if (/^\d{1,3}$/.test(t)) return { value: Number(t), next: i + 1 };
  const small = (j: number): { value: number; next: number } | null => {
    const a = tokens[j];
    if (a === undefined) return null;
    if (a in TENS) {
      const u = tokens[j + 1];
      if (u !== undefined && u in UNITS && UNITS[u] > 0 && UNITS[u] < 10 && !HOMOPHONES.has(u)) return { value: TENS[a] + UNITS[u], next: j + 2 };
      return { value: TENS[a], next: j + 1 };
    }
    if (a in UNITS) return { value: UNITS[a], next: j + 1 };
    return null;
  };
  const first = small(i);
  if (!first) return null;
  if (HOMOPHONES.has(t) && i > 0 && !['surah', 'chapter', 'ayah', 'verse', 'number'].includes(tokens[i - 1])) return null;
  let value = first.value;
  let next = first.next;
  if (tokens[next] === 'hundred' && value > 0 && value < 10) {
    value *= 100;
    next++;
    if (tokens[next] === 'and') next++;
    const rest = small(next);
    if (rest && rest.value < 100) {
      value += rest.value;
      next = rest.next;
    }
    return { value, next };
  }
  // Colloquial "two fifty five" = 255, "one twenty" = 120 (a units word followed by a tens word).
  if (value > 0 && value < 10 && tokens[next] !== undefined && tokens[next] in TENS) {
    const rest = small(next);
    if (rest) return { value: value * 100 + rest.value, next: rest.next };
  }
  return { value, next };
}

export function normalizeEnglish(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d)\s*[:.]\s*(\d)/g, '$1 $2')
    .replace(/[-–—]/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

/** Transliteration key: articles, doubled letters, vowel spellings and trailing h collapsed. */
export function nameKey(s: string): string {
  let k = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[`'’ʿʾ]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .trim();
  k = k.replace(/^(al|an|ar|as|ash|at|ad|adh|az|ath|aț)\s+/, '').replace(/\s+/g, '');
  k = k
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/ou/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/ii/g, 'i')
    .replace(/uu/g, 'u')
    .replace(/(.)\1+/g, '$1')
    .replace(/kh/g, 'k')
    .replace(/q/g, 'k')
    .replace(/h$/g, '')
    .replace(/y/g, 'i')
    .replace(/w/g, 'u');
  return k;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export type ChapterMatch = { number: number; distance: number; name: string };

export class ChapterNames {
  private keys: Array<{ key: string; number: number; name: string }> = [];
  constructor(readonly chapters: readonly Chapter[]) {
    for (const c of chapters) {
      for (const n of new Set([c.nameSimple, c.nameComplex])) this.keys.push({ key: nameKey(n), number: c.number, name: c.nameSimple });
      // Names written with a leading article attached ("Al-Baqarah") also match without it.
      const parts = c.nameSimple.split(/[- ]/);
      if (parts.length > 1 && /^(al|an|ar|as|ash|at|ad|adh|az|ath)$/i.test(parts[0])) {
        this.keys.push({ key: nameKey(parts.slice(1).join(' ')), number: c.number, name: c.nameSimple });
      }
    }
  }

  /** Candidate chapters for a phrase, best first. Distance tolerance scales with length. */
  match(phrase: string): ChapterMatch[] {
    const k = nameKey(phrase);
    if (k.length < 2) return [];
    const best = new Map<number, ChapterMatch>();
    for (const e of this.keys) {
      const d = editDistance(k, e.key);
      const tol = e.key.length <= 3 ? 0 : e.key.length <= 5 ? 1 : 2;
      if (d > tol) continue;
      const prev = best.get(e.number);
      if (!prev || d < prev.distance) best.set(e.number, { number: e.number, distance: d, name: e.name });
    }
    return [...best.values()].sort((a, b) => a.distance - b.distance || a.number - b.number);
  }
}

/**
 * Curated named passages. Manually entered; each maps to a single well-known reference and is
 * checked against the corpus at startup. Not a semantic index.
 */
export const NAMED_PASSAGES: ReadonlyArray<{ phrases: string[]; key: string }> = [
  { phrases: ['ayat al kursi', 'ayatul kursi', 'ayat ul kursi', 'ayat kursi', 'throne verse', 'verse of the throne'], key: '2:255' },
];
