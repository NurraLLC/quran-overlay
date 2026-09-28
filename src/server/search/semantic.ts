// Optional local semantic retrieval for English meaning search (plan §8b). Confined to English
// search: never part of live recitation, never JEV generation. Missing package, weights or
// embeddings leave exact-reference and lexical search fully working with a reduced status.
//
// Model: Xenova/all-MiniLM-L6-v2 via @huggingface/transformers (feature-extraction, mean pooling,
// normalized). Verse embeddings are precomputed by `npm run search:embed` into data/processed.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROCESSED_DIR } from '../corpus/manifest';

export type SemanticStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'loading' }
  | { state: 'ready'; model: string; revision: string; dims: number; verses: number; warmupMs: number }
  | { state: 'error'; reason: string };

export const SEMANTIC_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDINGS_FILE = path.join(PROCESSED_DIR, 'embeddings-minilm.f32');
export const EMBEDDINGS_META = path.join(PROCESSED_DIR, 'embeddings-minilm.json');

type Extractor = (text: string | string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

export async function loadExtractor(revision?: string): Promise<Extractor> {
  const moduleName = '@huggingface/transformers';
  const mod = (await import(/* @vite-ignore */ moduleName)) as {
    pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Extractor>;
  };
  return mod.pipeline('feature-extraction', SEMANTIC_MODEL, { dtype: 'q8', ...(revision ? { revision } : {}) });
}

export class SemanticRetriever {
  status: SemanticStatus = { state: 'unavailable', reason: 'not started' };
  private vectors: Float32Array | null = null;
  private dims = 0;
  private extractor: Extractor | null = null;

  async init(): Promise<void> {
    if (!existsSync(EMBEDDINGS_FILE) || !existsSync(EMBEDDINGS_META)) {
      this.status = { state: 'unavailable', reason: 'verse embeddings not built (optional: npm run search:embed)' };
      return;
    }
    this.status = { state: 'loading' };
    try {
      const meta = JSON.parse(readFileSync(EMBEDDINGS_META, 'utf8')) as { dims: number; verses: number; model: string; revision: string };
      const buf = readFileSync(EMBEDDINGS_FILE);
      this.vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      this.dims = meta.dims;
      const t0 = performance.now();
      this.extractor = await loadExtractor(meta.revision);
      await this.extractor('warm up', { pooling: 'mean', normalize: true });
      this.status = { state: 'ready', model: meta.model, revision: meta.revision, dims: meta.dims, verses: meta.verses, warmupMs: Math.round(performance.now() - t0) };
    } catch (e) {
      this.status = { state: 'error', reason: e instanceof Error ? e.message.slice(0, 200) : 'failed to load' };
      this.extractor = null;
    }
  }

  get ready() {
    return this.status.state === 'ready';
  }

  async search(query: string, k = 30): Promise<Array<{ verseIndex: number; score: number }>> {
    if (!this.extractor || !this.vectors) return [];
    const out = await this.extractor(query, { pooling: 'mean', normalize: true });
    const q = out.data;
    const n = this.vectors.length / this.dims;
    const scores: Array<{ verseIndex: number; score: number }> = [];
    for (let v = 0; v < n; v++) {
      let dot = 0;
      const base = v * this.dims;
      for (let d = 0; d < this.dims; d++) dot += q[d] * this.vectors[base + d];
      scores.push({ verseIndex: v, score: dot });
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
