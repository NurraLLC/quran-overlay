// npm run corpus:fetch
// Downloads the corpus sources listed in corpus/sources.json into their (git-ignored) paths so a
// fresh clone can run `npm run corpus:import`. Every file must match the pinned SHA-256; a changed
// upstream file is refused, never silently used. Files already present and matching are skipped.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Source = { role: string; path: string; sourceUrl: string; sha256: string; bytes: number };
const manifest = JSON.parse(readFileSync('corpus/sources.json', 'utf8')) as { sources: Source[] };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Chapter names and counts, in the exact layout the importer pins. */
async function chapters(url: string): Promise<Buffer> {
  const j = (await (await fetch(url)).json()) as { chapters: Array<Record<string, unknown>> };
  const rows = j.chapters.map((c) => ({ id: c.id, name_arabic: c.name_arabic, name_simple: c.name_simple, name_complex: c.name_complex, verses_count: c.verses_count, bismillah_pre: c.bismillah_pre }));
  return Buffer.from(`${JSON.stringify({ source: 'Quran.com API v4 chapters (names, verse counts, basmala flag)', chapters: rows }, null, 2)}\n`);
}

let failed = 0;
for (const s of manifest.sources) {
  const file = path.resolve(s.path);
  if (existsSync(file) && sha(readFileSync(file)) === s.sha256) {
    console.log(`ok       ${s.role} (already present)`);
    continue;
  }
  const body = s.role === 'chapters' ? await chapters(s.sourceUrl) : Buffer.from(await (await fetch(s.sourceUrl)).arrayBuffer());
  if (sha(body) !== s.sha256) {
    failed++;
    console.error(`REFUSED  ${s.role}: ${s.sourceUrl} no longer matches the pinned hash (got ${body.length} bytes, pinned ${s.bytes}). Review the change before updating corpus/sources.json.`);
    continue;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  console.log(`fetched  ${s.role} (${body.length} bytes, hash verified)`);
}
if (failed) process.exit(1);
console.log('\nAll sources present and verified. Next: npm run corpus:import -- --manifest corpus/sources.json');
