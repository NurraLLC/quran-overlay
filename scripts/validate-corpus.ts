// npm run corpus:validate — re-validates the processed corpus, its font and source hashes.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fontCodepoints } from '../src/server/corpus/font';
import { loadCorpus } from '../src/server/corpus/load';
import { PROCESSED_FONT_DIR, ROOT, sha256File } from '../src/server/corpus/manifest';
import { validateCorpus } from '../src/server/corpus/validate';

const corpus = loadCorpus();
const fontFile = path.join(PROCESSED_FONT_DIR, corpus.manifest.font.file);
const checks = validateCorpus(corpus, fontCodepoints(fontFile).codepoints);

const fontHash = sha256File(fontFile);
checks.push({ name: 'processed font hash matches manifest', ok: fontHash === corpus.manifest.font.sha256, detail: fontHash.slice(0, 16) });
for (const s of corpus.manifest.sourceFiles) {
  const raw = path.join(ROOT, 'data', 'raw', path.basename(s.path));
  const ok = existsSync(raw) && sha256File(raw) === s.sha256;
  checks.push({ name: `raw ${s.role} copy matches recorded sha256`, ok, detail: ok ? s.sha256.slice(0, 16) : `missing or changed: ${raw}` });
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed for corpus ${corpus.manifest.id}`);
process.exit(failed ? 1 : 0);
