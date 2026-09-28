// npm run resources:import [-- --dir data/inbox]
// Identifies each file by content, validates it against the complete corpus, keeps the original
// bytes (data/raw/qul, git-ignored), writes compiled artifacts (data/processed/resources) and records
// provenance/coverage in corpus/resources.lock.json and docs/RESOURCE_COVERAGE.md (committed).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { ROOT } from '../src/server/corpus/manifest';
import { artifactPath, LOCK_FILE, RESOURCE_DIR, type LockEntry } from '../src/server/resources/catalog';
import {
  detect,
  importDivision,
  importMutashabihatPhrases,
  importQpcAyah,
  importQpcWords,
  importSimilar,
  importThemes,
  importTopics,
  type Imported,
} from '../src/server/resources/importers';

const i = process.argv.indexOf('--dir');
const dir = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'data/inbox');
const corpus = new Corpus(loadCorpus());
const lock: { schemaVersion: 1; entries: LockEntry[] } = existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, 'utf8')) : { schemaVersion: 1, entries: [] };
const URLS: Record<string, string> = {
  'qul:similar-ayah:74': 'https://qul.tarteel.ai/resources/similar-ayah/74',
  'qul:mutashabihat:73': 'https://qul.tarteel.ai/resources/mutashabihat/73',
  'qul:ayah-topics:45': 'https://qul.tarteel.ai/resources/ayah-topics/45',
  'qul:ayah-theme:62': 'https://qul.tarteel.ai/resources/ayah-theme/62',
  'qul:quran-script:86': 'https://qul.tarteel.ai/resources/quran-script/86',
  'qul:quran-script:312': 'https://qul.tarteel.ai/resources/quran-script/312',
  'qul:quran-metadata:69': 'https://qul.tarteel.ai/resources/quran-metadata/69',
};

if (!existsSync(dir)) {
  console.error(`No inbox at ${dir}`);
  process.exit(1);
}
mkdirSync(RESOURCE_DIR, { recursive: true });
const rawDir = path.join(ROOT, 'data', 'raw', 'qul');
mkdirSync(rawDir, { recursive: true });

const report: string[] = [];
for (const name of readdirSync(dir).sort()) {
  const file = path.join(dir, name);
  if (!statSync(file).isFile()) continue;
  const d = detect(file);
  if (!d) {
    console.log(`skip  ${name}: not a recognised QUL export (content did not match any importer)`);
    report.push(`| ${name} | — | not recognised | — | — |`);
    continue;
  }
  let result: Imported<unknown>;
  switch (d.kind) {
    case 'similar-ayah':
      result = importSimilar(file, d.format, corpus);
      break;
    case 'mutashabihat-phrases':
      result = importMutashabihatPhrases(file, corpus);
      break;
    case 'mutashabihat-ayah-phrases':
      console.log(`note  ${name}: ayah→phrase index; the phrases file already carries every occurrence, so it is recorded but not needed at runtime.`);
      continue;
    case 'topics':
      result = importTopics(file, corpus);
      break;
    case 'themes':
      result = importThemes(file, corpus);
      break;
    case 'qpc-ayah-text':
    case 'ayah-metadata':
      result = importQpcAyah(file, corpus, d.kind);
      break;
    case 'qpc-word-text':
      result = importQpcWords(file, d.format, corpus);
      break;
    case 'division':
      result = importDivision(file, d.format, corpus);
      break;
  }
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  copyFileSync(file, path.join(rawDir, `${sha256.slice(0, 12)}-${name}`));
  writeFileSync(artifactPath(result.resourceId), JSON.stringify(result));
  const entry: LockEntry = {
    id: result.resourceId,
    category: result.category,
    title: result.title,
    kind: result.kind,
    sourceUrl: URLS[result.resourceId] ?? `https://qul.tarteel.ai/resources/${result.resourceId.split(':').slice(1).join('/')}`,
    file: name,
    sha256,
    bytes: bytes.length,
    downloadedAt: statSync(file).mtime.toISOString(),
    importedAt: new Date().toISOString(),
    format: d.format,
    coverage: result.coverage,
    notes: result.notes,
    rightsEvidence: null,
  };
  lock.entries = [...lock.entries.filter((e) => e.id !== entry.id), entry].sort((a, b) => a.id.localeCompare(b.id));
  console.log(`ok    ${name} → ${result.resourceId}: ${result.coverage.rows} rows, ${result.coverage.verseKeys} verse keys, ${result.coverage.rejectedRows} rejected`);
  for (const r of result.rejections.slice(0, 5)) console.log(`        rejected ${r.row}: ${r.reason}`);
  report.push(`| ${name} | ${result.resourceId} | ${result.coverage.rows} rows · ${result.coverage.verseKeys} verse keys · ${result.coverage.rejectedRows} rejected | ${sha256.slice(0, 16)} | ${result.notes.join(' ')} |`);
}
writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n');
writeFileSync(
  path.join(ROOT, 'docs', 'RESOURCE_COVERAGE.md'),
  [
    '# Resource import coverage',
    '',
    `Last import ${new Date().toISOString()} from \`${path.relative(ROOT, dir)}\`. Provenance and hashes: \`corpus/resources.lock.json\`. Rights for each export were not reviewed (rightsEvidence: null).`,
    '',
    '| File | Resource | Coverage | sha256 | Notes |',
    '|---|---|---|---|---|',
    ...report,
    '',
  ].join('\n'),
);
