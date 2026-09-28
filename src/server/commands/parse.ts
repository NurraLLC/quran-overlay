// Typed/voice English command → intent. Purely local and deterministic; ordinary text that is not
// an explicit reference or navigation word becomes a meaning search (never an action).

import { HAFS_VERSE_COUNTS } from '../../shared/corpus-types';
import { NAMED_PASSAGES, normalizeEnglish, parseNumberAt, type ChapterMatch, type ChapterNames } from '../search/references';

export type Intent =
  | { kind: 'empty' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'reference'; surah: number; ayah: number | null; route: 'numeric' | 'named_chapter' | 'named_passage' | 'current_chapter' }
  | { kind: 'invalid_reference'; message: string }
  | { kind: 'ambiguous_chapter'; options: ChapterMatch[]; ayah: number | null }
  | { kind: 'division'; type: 'juz' | 'hizb' | 'rub' | 'manzil'; number: number }
  | { kind: 'search'; query: string };

const LEADING = [
  ['please'],
  ['can', 'you'],
  ['go', 'to'],
  ['goto'],
  ['jump', 'to'],
  ['take', 'me', 'to'],
  ['show', 'me'],
  ['show'],
  ['open'],
  ['display'],
  ['go'],
];
const CHAPTER_WORDS = new Set(['surah', 'sura', 'surat', 'soorah', 'chapter']);
const AYAH_WORDS = new Set(['ayah', 'aya', 'ayat', 'verse', 'number', 'ayahs', 'verses']);
const NEXT = new Set(['next', 'next ayah', 'next verse', 'forward', 'continue', 'next one']);
const PREV = new Set(['previous', 'prev', 'back', 'go back', 'previous ayah', 'previous verse', 'last verse', 'last ayah', 'previous one']);

function stripLeading(tokens: string[]): string[] {
  let t = tokens;
  let changed = true;
  while (changed && t.length) {
    changed = false;
    for (const p of LEADING) {
      if (p.every((w, i) => t[i] === w) && t.length > p.length) {
        t = t.slice(p.length);
        changed = true;
        break;
      }
    }
  }
  if (t[0] === 'the' && t.length > 1) t = t.slice(1);
  return t;
}

/** Number that may be spoken digit-by-digit ("two five five" = 255). */
function numberAt(t: string[], i: number) {
  const n = parseNumberAt(t, i);
  if (!n) return null;
  if (n.value < 10 && n.next === i + 1) {
    const b = parseNumberAt(t, n.next);
    const c = b ? parseNumberAt(t, b.next) : null;
    if (b && c && b.value < 10 && c.value < 10 && b.next === n.next + 1 && c.next === b.next + 1) {
      return { value: n.value * 100 + b.value * 10 + c.value, next: c.next };
    }
  }
  return n;
}

function validate(surah: number, ayah: number | null, route: Extract<Intent, { kind: 'reference' }>['route'], names: ChapterNames): Intent {
  if (surah < 1 || surah > 114) return { kind: 'invalid_reference', message: `There is no surah ${surah}. Surahs are numbered 1 to 114.` };
  const count = HAFS_VERSE_COUNTS[surah - 1];
  const name = names.chapters[surah - 1].nameSimple;
  if (ayah !== null && (ayah < 1 || ayah > count)) {
    return { kind: 'invalid_reference', message: `Surah ${name} (${surah}) has ${count} ayahs; ${ayah} is out of range.` };
  }
  return { kind: 'reference', surah, ayah, route };
}

export function parseIntent(text: string, names: ChapterNames, currentSurah: number | null): Intent {
  const all = normalizeEnglish(text);
  if (!all.length) return { kind: 'empty' };
  const joined = all.join(' ');
  if (NEXT.has(joined)) return { kind: 'next' };
  if (PREV.has(joined)) return { kind: 'previous' };
  const t = stripLeading(all);
  const phrase = t.join(' ');
  if (NEXT.has(phrase)) return { kind: 'next' };
  if (PREV.has(phrase)) return { kind: 'previous' };

  // "juz 30", "para 30", "hizb five", "manzil 3", "rub 12"
  const DIV: Record<string, 'juz' | 'hizb' | 'rub' | 'manzil'> = { juz: 'juz', juzz: 'juz', para: 'juz', parah: 'juz', hizb: 'hizb', rub: 'rub', manzil: 'manzil' };
  if (t.length >= 2 && DIV[t[0]]) {
    const n = numberAt(t, 1);
    if (n && n.next === t.length) {
      const type = DIV[t[0]];
      const max = { juz: 30, hizb: 60, rub: 240, manzil: 7 }[type];
      if (n.value < 1 || n.value > max) return { kind: 'invalid_reference', message: `There are ${max} ${type === 'rub' ? 'rub‘ sections' : `${type}s`}; ${n.value} is out of range.` };
      return { kind: 'division', type, number: n.value };
    }
  }

  // "2 255" (from "2:255" / "2.255")
  if (t.length === 2 && /^\d{1,3}$/.test(t[0]) && /^\d{1,3}$/.test(t[1])) return validate(Number(t[0]), Number(t[1]), 'numeric', names);

  for (const p of NAMED_PASSAGES) {
    if (p.phrases.includes(phrase)) {
      const [s, a] = p.key.split(':').map(Number);
      return validate(s, a, 'named_passage', names);
    }
  }

  // Optional trailing "(ayah|verse) N" or bare N.
  const readAyah = (i: number): { ayah: number | null; ok: boolean } => {
    if (i >= t.length) return { ayah: null, ok: true };
    let j = i;
    if (AYAH_WORDS.has(t[j])) j++;
    const n = numberAt(t, j);
    if (n && n.next === t.length) return { ayah: n.value, ok: true };
    return { ayah: null, ok: false };
  };

  const ci = t.findIndex((w) => CHAPTER_WORDS.has(w));
  if (ci >= 0) {
    const n = numberAt(t, ci + 1);
    if (n) {
      const rest = readAyah(n.next);
      if (rest.ok) return validate(n.value, rest.ayah, 'numeric', names);
    }
    // Name words until an ayah keyword / number / end.
    let end = ci + 1;
    while (end < t.length && !AYAH_WORDS.has(t[end]) && !numberAt(t, end)) end++;
    const namePhrase = t.slice(ci + 1, end).join(' ');
    const rest = readAyah(end);
    if (namePhrase && rest.ok) {
      const matches = names.match(namePhrase);
      if (matches.length === 1 || (matches.length > 1 && matches[0].distance < matches[1].distance)) {
        return validate(matches[0].number, rest.ayah, 'named_chapter', names);
      }
      if (matches.length > 1) return { kind: 'ambiguous_chapter', options: matches.slice(0, 5), ayah: rest.ayah };
      return { kind: 'invalid_reference', message: `No surah named “${namePhrase}”.` };
    }
  }

  // "(ayah|verse) N" in the current surah.
  if (AYAH_WORDS.has(t[0])) {
    const n = numberAt(t, 1);
    if (n && n.next === t.length) {
      if (currentSurah === null) return { kind: 'invalid_reference', message: 'No current surah yet — say the surah too, e.g. “Surah Maryam ayah 3”.' };
      return validate(currentSurah, n.value, 'current_chapter', names);
    }
  }

  // Bare chapter name, optionally followed by an ayah: "baqarah 255", "yaseen", "al kahf verse 10".
  for (let len = Math.min(3, t.length); len >= 1; len--) {
    const rest = readAyah(len);
    if (!rest.ok) continue;
    const matches = names.match(t.slice(0, len).join(' '));
    if (!matches.length) continue;
    if (matches.length === 1 || matches[0].distance < matches[1].distance) return validate(matches[0].number, rest.ayah, 'named_chapter', names);
    return { kind: 'ambiguous_chapter', options: matches.slice(0, 5), ayah: rest.ayah };
  }

  return { kind: 'search', query: text.trim() };
}
