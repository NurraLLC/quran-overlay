// npm run search:embed — OPTIONAL semantic-search experiment (plan §8b).
// Requires `npm install @huggingface/transformers` and downloads Xenova/all-MiniLM-L6-v2 weights
// (~23 MB quantized) from huggingface.co on first run. Not run in this build: it needs the owner's
// approval for that download. Output: data/processed/embeddings-minilm.{f32,json} (git-ignored).
// Long translations are embedded in word chunks that keep their verse identity (max over chunks).
import { writeFileSync } from 'node:fs';
import { loadCorpus } from '../src/server/corpus/load';
import { EMBEDDINGS_FILE, EMBEDDINGS_META, SEMANTIC_MODEL, loadExtractor } from '../src/server/search/semantic';

const CHUNK_WORDS = 120; // stays under the 256 word-piece encoder limit for English prose
const revision = process.env.EMBED_REVISION || 'main';
const corpus = loadCorpus();
const extractor = await loadExtractor(revision);
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
  if (v.index % 500 === 0) console.log(`${v.index}/${corpus.verses.length}`);
}
writeFileSync(EMBEDDINGS_FILE, Buffer.from(new Float32Array(vectors).buffer));
writeFileSync(EMBEDDINGS_META, JSON.stringify({ model: SEMANTIC_MODEL, revision, dims, verses: corpus.verses.length, vectors: verseOfVector.length, verseOfVector, corpusId: corpus.manifest.id }));
console.log(`Embedded ${verseOfVector.length} chunks for ${corpus.verses.length} verses in ${Math.round(performance.now() - t0)} ms`);
