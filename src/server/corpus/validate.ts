// Corpus validation shared by `corpus:import` (fail before writing) and `corpus:validate`.

import {
  HAFS_VERSE_COUNTS,
  MUQATTAAT_KEYS,
  TOTAL_AYAHS,
  type ProcessedCorpus,
} from '../../shared/corpus-types';
import { MUQATTAAT_LETTERS, relaxed, tokenize } from '../tracker/normalize';

export type Check = { name: string; ok: boolean; detail: string };

const BASMALA = relaxed('بسم') + ' ' + relaxed('الله') + ' ' + relaxed('الرحمن') + ' ' + relaxed('الرحيم');

function searchKey(text: string): string {
  return tokenize(text)
    .filter((t) => !t.foreign)
    .map((t) => t.key)
    .join(' ');
}

export function validateCorpus(c: ProcessedCorpus, fontCodepoints?: Set<number>): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const declaredSum = HAFS_VERSE_COUNTS.reduce((a, b) => a + b, 0);
  add('declared Hafs verse map sums to 6,236', declaredSum === TOTAL_AYAHS, `sum=${declaredSum}`);
  add('114 chapters', c.chapters.length === 114, `chapters=${c.chapters.length}`);
  const chapterMismatch = c.chapters.filter((ch, i) => ch.number !== i + 1 || ch.verseCount !== HAFS_VERSE_COUNTS[i]);
  add('chapter verse counts match the declared Hafs map', chapterMismatch.length === 0,
    chapterMismatch.length ? `mismatch: ${chapterMismatch.map((c) => c.number).join(',')}` : 'all 114 match');
  add('6,236 verses', c.verses.length === TOTAL_AYAHS, `verses=${c.verses.length}`);
  add('manifest verseCount agrees', c.manifest.verseCount === c.verses.length, `manifest=${c.manifest.verseCount}`);

  const keys = new Set<string>();
  const dup: string[] = [];
  const orderErrors: string[] = [];
  let expectedIndex = 0;
  for (let s = 1; s <= 114; s++) {
    for (let a = 1; a <= HAFS_VERSE_COUNTS[s - 1]; a++) {
      const v = c.verses[expectedIndex];
      if (!v || v.key !== `${s}:${a}` || v.surah !== s || v.ayah !== a || v.index !== expectedIndex) {
        if (orderErrors.length < 5) orderErrors.push(`${s}:${a}@${expectedIndex}`);
      }
      expectedIndex++;
    }
  }
  for (const v of c.verses) {
    if (keys.has(v.key)) dup.push(v.key);
    keys.add(v.key);
  }
  add('no duplicate verse keys', dup.length === 0, dup.slice(0, 5).join(',') || 'none');
  add('canonical order and exact key set (every surah:ayah present once)', orderErrors.length === 0,
    orderErrors.join(',') || 'all 6,236 keys in order');

  const empty = c.verses.filter((v) => !v.arabicDisplay.trim() || !v.searchText.trim() || !v.english.trim());
  add('nonempty Arabic display, search and English for every verse', empty.length === 0,
    empty.slice(0, 5).map((v) => v.key).join(',') || 'all nonempty');

  const badUtf = c.verses.filter((v) => /�/.test(v.arabicDisplay + v.searchText + v.english));
  add('no UTF-8 replacement characters', badUtf.length === 0, badUtf.slice(0, 5).map((v) => v.key).join(',') || 'clean');

  const markup = c.verses.filter((v) => /[<>]/.test(v.english));
  add('English contains no markup after footnote-marker removal', markup.length === 0,
    markup.slice(0, 5).map((v) => v.key).join(',') || 'clean');

  const noSearchTokens = c.verses.filter((v) => searchKey(v.searchText).length === 0);
  add('every verse has search tokens', noSearchTokens.length === 0, noSearchTokens.map((v) => v.key).join(',') || 'all');

  const v11 = c.verses[0];
  add('1:1 is the basmala (Al-Fatihah counts it as an ayah)', searchKey(v11.searchText) === BASMALA, searchKey(v11.searchText));
  const firstAyahWithBasmala = c.verses.filter((v) => v.ayah === 1 && v.surah !== 1 && searchKey(v.searchText).startsWith(BASMALA));
  add('no other chapter includes the pre-chapter basmala as ayah 1', firstAyahWithBasmala.length === 0,
    firstAyahWithBasmala.map((v) => v.key).join(',') || 'none');
  const ch9 = c.chapters[8];
  add('chapter 9 has no basmala before it', ch9.bismillahPre === false, `bismillahPre=${ch9.bismillahPre}`);
  const others = c.chapters.filter((ch) => ch.number !== 1 && ch.number !== 9 && !ch.bismillahPre);
  add('every other chapter (except 1 and 9) is preceded by a basmala', others.length === 0,
    others.map((c) => c.number).join(',') || 'all 112');
  const v2730 = c.verses.find((v) => v.key === '27:30');
  add('27:30 contains the embedded basmala', !!v2730 && searchKey(v2730.searchText).includes(BASMALA),
    v2730 ? searchKey(v2730.searchText) : 'missing');

  const muqBad: string[] = [];
  for (const key of MUQATTAAT_KEYS) {
    const v = c.verses.find((x) => x.key === key);
    const first = v ? tokenize(v.searchText)[0]?.key ?? '' : '';
    if (!first || [...first].some((ch) => !MUQATTAAT_LETTERS.has(ch))) muqBad.push(`${key}:${first}`);
  }
  add('30 declared disjoint-letter openings begin with disjoint letters only', muqBad.length === 0, muqBad.join(',') || 'all 30');

  const attributions = c.manifest.sourceFiles.filter((s) => !s.attribution || !s.sha256 || !s.sourceUrl || !s.licenseStatus);
  add('every source file has URL, hash, attribution and license status', attributions.length === 0,
    attributions.map((s) => s.role).join(',') || `${c.manifest.sourceFiles.length} sources`);

  if (fontCodepoints) {
    const missing = new Set<string>();
    for (const v of c.verses) {
      for (const ch of v.arabicDisplay) {
        const cp = ch.codePointAt(0)!;
        if (cp === 0x20) continue;
        if (!fontCodepoints.has(cp)) missing.add(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
    add('display font maps every codepoint used by the Arabic display text', missing.size === 0,
      missing.size ? `missing: ${[...missing].join(' ')}` : 'full coverage');
  }
  return checks;
}
