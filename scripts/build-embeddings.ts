// npm run search:embed — optional English semantic search (plan §8b).
// Fetches the four files of Xenova/all-MiniLM-L6-v2 at a pinned revision from huggingface.co
// (download approved by the owner 2026-09-28), verifies each against a pinned sha256, stores them in
// data/models/local, then embeds every ayah's translation into data/processed/embeddings-minilm.*
// (all git-ignored). Long translations are embedded in chunks that keep their verse identity.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadCorpus } from '../src/server/corpus/load';
import { EMBEDDINGS_FILE, EMBEDDINGS_META, MODEL_DIR, MODEL_FILES, SEMANTIC_MODEL, SEMANTIC_REVISION, loadExtractor, verifyModelFiles } from '../src/server/search/semantic';

for (const f of MODEL_FILES) {
  const dest = path.join(MODEL_DIR, f.file);
  if (existsSync(dest) && !verifyModelFiles()) break;
  const url = `https://huggingface.co/${SEMANTIC_MODEL}/resolve/${SEMANTIC_REVISION}/${f.file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== f.sha256) throw new Error(`${f.file}: sha256 ${sha} does not match pinned ${f.sha256}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`fetched ${f.file} (${buf.length} bytes, sha256 ok)`);
}
const bad = verifyModelFiles();
if (bad) throw new Error(`model files: ${bad}`);

const CHUNK_WORDS = 120; // stays under the 256 word-piece encoder limit for English prose
const corpus = loadCorpus();
const extractor = await loadExtractor();
const vectors: number[] = [];
const verseOfVector: number[] = [];
let dims = 0;
const t0 = performance.now();
for (const v of corpus.verses) {
  const words = v.english.split(/\s+/);
  for (let i = 0; i < words.length; i += CHUNK_WORDS) {
    const out = await extractor(words.slice(i, i + CHUNK_WORDS).join(' '), { pooling: 'mean', normalize: true });
    dims = out.data.length;
    vectors.push(...out.data);
    verseOfVector.push(v.index);
  }
}
writeFileSync(EMBEDDINGS_FILE, Buffer.from(new Float32Array(vectors).buffer));
writeFileSync(
  EMBEDDINGS_META,
  JSON.stringify({ model: SEMANTIC_MODEL, revision: SEMANTIC_REVISION, modelFiles: MODEL_FILES, dims, verses: corpus.verses.length, vectors: verseOfVector.length, verseOfVector, corpusId: corpus.manifest.id }),
);
console.log(`Embedded ${verseOfVector.length} chunks for ${corpus.verses.length} verses in ${Math.round(performance.now() - t0)} ms`);
