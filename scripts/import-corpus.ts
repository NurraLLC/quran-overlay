// npm run corpus:import -- --manifest corpus/sources.json
// Verifies source hashes, builds data/processed/corpus.json and copies the display font.
// Fails (and writes nothing) if any validation check fails.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Chapter, ProcessedCorpus, SourceFile, Verse, VerseKey } from '../src/shared/corpus-types';
import { fontCodepoints } from '../src/server/corpus/font';
import {
  PROCESSED_CORPUS,
  PROCESSED_FONT_DIR,
  ROOT,
  readSourcesManifest,
  sha256File,
  sourceFor,
} from '../src/server/corpus/manifest';
import { validateCorpus } from '../src/server/corpus/validate';
import { NORMALIZATION_VERSION } from '../src/server/tracker/normalize';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

const manifestPath = path.resolve(ROOT, arg('manifest', 'corpus/sources.json'));
const m = readSourcesManifest(manifestPath);

const rawDir = path.join(ROOT, 'data', 'raw');
mkdirSync(rawDir, { recursive: true });
for (const s of m.sources) {
  const file = path.resolve(ROOT, s.path);
  const got = sha256File(file);
  if (got !== s.sha256) throw new Error(`Hash mismatch for ${s.role} (${s.path}): expected ${s.sha256}, got ${got}`);
  copyFileSync(file, path.join(rawDir, path.basename(file)));
  console.log(`ok  ${s.role.padEnd(13)} ${s.sha256.slice(0, 12)}  ${s.path}`);
}

const read = (s: SourceFile) => JSON.parse(readFileSync(path.resolve(ROOT, s.path), 'utf8'));

const uth = read(sourceFor(m, 'arabicDisplay')).verses as Array<{ verse_key: string; text_uthmani: string }>;
const iml = read(sourceFor(m, 'arabicSearch')).verses as Array<{ verse_key: string; text_imlaei: string }>;
const eng = read(sourceFor(m, 'english')).translations as Array<{ verse_key: string; text: string }>;
const chaptersRaw = read(sourceFor(m, 'chapters')).chapters as Array<{
  id: number; name_arabic: string; name_simple: string; name_complex: string; verses_count: number; bismillah_pre: boolean;
}>;

const byKey = <T extends { verse_key: string }>(rows: T[], label: string) => {
  const map = new Map<string, T>();
  for (const r of rows) {
    if (map.has(r.verse_key)) throw new Error(`${label}: duplicate ${r.verse_key}`);
    map.set(r.verse_key, r);
  }
  return map;
};
const uthMap = byKey(uth, 'display');
const imlMap = byKey(iml, 'search');
const engMap = byKey(eng, 'english');

const FOOTNOTE = /<sup foot_note=(\d+)>\d+<\/sup>/g;
function cleanEnglish(text: string): { english: string; footnoteIds: number[] } {
  const footnoteIds = [...text.matchAll(FOOTNOTE)].map((x) => Number(x[1]));
  const english = text.replace(FOOTNOTE, '').replace(/[ \t]{2,}/g, ' ').trim();
  return { english, footnoteIds };
}

const chapters: Chapter[] = chaptersRaw
  .map((c) => ({
    number: c.id,
    nameArabic: c.name_arabic,
    nameSimple: c.name_simple,
    nameComplex: c.name_complex,
    verseCount: c.verses_count,
    bismillahPre: c.bismillah_pre,
  }))
  .sort((a, b) => a.number - b.number);

const verses: Verse[] = [];
const missing: string[] = [];
for (const ch of chapters) {
  for (let a = 1; a <= ch.verseCount; a++) {
    const key = `${ch.number}:${a}` as VerseKey;
    const u = uthMap.get(key);
    const s = imlMap.get(key);
    const e = engMap.get(key);
    if (!u || !s || !e) {
      missing.push(key);
      continue;
    }
    const { english, footnoteIds } = cleanEnglish(e.text);
    verses.push({
      index: verses.length,
      key,
      surah: ch.number,
      ayah: a,
      arabicDisplay: u.text_uthmani.trim(),
      searchText: s.text_imlaei.trim(),
      english,
      footnoteIds,
    });
  }
}
if (missing.length) throw new Error(`Missing ${missing.length} verses in a source, e.g. ${missing.slice(0, 5).join(',')}`);
for (const [label, map] of [['display', uthMap], ['search', imlMap], ['english', engMap]] as const) {
  if (map.size !== verses.length) throw new Error(`${label} has ${map.size} keys; expected exactly ${verses.length}`);
}

const fontSrc = sourceFor(m, 'font');
const fontPath = path.resolve(ROOT, fontSrc.path);
const { codepoints, family } = fontCodepoints(fontPath);
const eng20 = sourceFor(m, 'english');
const idHash = m.sources.map((s) => s.sha256.slice(0, 6)).join('');

const corpus: ProcessedCorpus = {
  manifest: {
    id: `hafs-v1-${idHash.slice(0, 16)}`,
    narration: 'hafs',
    schemaVersion: 1,
    normalizationVersion: NORMALIZATION_VERSION,
    verseCount: verses.length,
    builtAt: new Date().toISOString(),
    sourceFiles: m.sources,
    translation: {
      name: eng20.displayName ?? 'English translation',
      resource: eng20.sourceResourceId ?? eng20.sourceUrl,
      attribution: eng20.attribution,
    },
    font: { family, file: path.basename(fontPath), sha256: fontSrc.sha256 },
  },
  chapters,
  verses,
};

const checks = validateCorpus(corpus, codepoints);
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
}
if (failed) {
  console.error(`\n${failed} validation check(s) failed; nothing written.`);
  process.exit(1);
}

mkdirSync(PROCESSED_FONT_DIR, { recursive: true });
copyFileSync(fontPath, path.join(PROCESSED_FONT_DIR, path.basename(fontPath)));
writeFileSync(PROCESSED_CORPUS, JSON.stringify(corpus));
console.log(`\nWrote ${path.relative(ROOT, PROCESSED_CORPUS)}: ${verses.length} verses, ${chapters.length} chapters, corpus id ${corpus.manifest.id}`);
