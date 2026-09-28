// Optional local semantic retrieval for English meaning search (plan §8b). Confined to English
// search: never part of live recitation, never JEV generation. Missing package, weights or
// embeddings leave exact-reference and lexical search fully working with a reduced status.
//
// Model: Xenova/all-MiniLM-L6-v2 via @huggingface/transformers (feature-extraction, mean pooling,
// normalized). Verse embeddings are precomputed by `npm run search:embed` into data/processed.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROCESSED_DIR, ROOT } from '../corpus/manifest';

export type SemanticStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'loading' }
  | { state: 'ready'; model: string; revision: string; dims: number; verses: number; warmupMs: number }
  | { state: 'error'; reason: string };

export const SEMANTIC_MODEL = 'Xenova/all-MiniLM-L6-v2';
/** Pinned model repository commit (huggingface.co API, lastModified 2025-07-22). */
export const SEMANTIC_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
/**
 * Exact files used, fetched from the pinned revision by `npm run search:embed` and verified.
 * (Loading a pinned revision back from transformers.js 4.3.0's own cache produced a non-callable
 * tokenizer, so the model is loaded as a local directory instead; the server never downloads.)
 */
export const MODEL_FILES: ReadonlyArray<{ file: string; sha256: string; bytes: number }> = [
  { file: 'config.json', sha256: '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7', bytes: 650 },
  { file: 'tokenizer.json', sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0', bytes: 711661 },
  { file: 'tokenizer_config.json', sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3', bytes: 366 },
  { file: 'onnx/model_quantized.onnx', sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1', bytes: 22972370 },
];
export const EMBEDDINGS_FILE = path.join(PROCESSED_DIR, 'embeddings-minilm.f32');
export const EMBEDDINGS_META = path.join(PROCESSED_DIR, 'embeddings-minilm.json');

type Extractor = (text: string | string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

export const MODEL_ROOT = path.join(ROOT, 'data', 'models', 'local');
export const MODEL_DIR = path.join(MODEL_ROOT, ...SEMANTIC_MODEL.split('/'));

export function verifyModelFiles(): string | null {
  for (const f of MODEL_FILES) {
    const full = path.join(MODEL_DIR, f.file);
    if (!existsSync(full)) return `missing ${f.file}`;
    if (createHash('sha256').update(readFileSync(full)).digest('hex') !== f.sha256) return `hash mismatch for ${f.file}`;
  }
  return null;
}

export async function loadExtractor(): Promise<Extractor> {
  const moduleName = '@huggingface/transformers';
  const mod = (await import(/* @vite-ignore */ moduleName)) as {
    env: { allowRemoteModels: boolean; allowLocalModels: boolean; localModelPath: string };
    pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Extractor>;
  };
  mod.env.allowRemoteModels = false;
  mod.env.allowLocalModels = true;
  mod.env.localModelPath = MODEL_ROOT + path.sep;
  return mod.pipeline('feature-extraction', SEMANTIC_MODEL, { dtype: 'q8' });
}

export class SemanticRetriever {
  status: SemanticStatus = { state: 'unavailable', reason: 'not started' };
  private vectors: Float32Array | null = null;
  private verseOfVector: number[] = [];
  private dims = 0;
  private extractor: Extractor | null = null;

  async init(): Promise<void> {
    if (!existsSync(EMBEDDINGS_FILE) || !existsSync(EMBEDDINGS_META)) {
      this.status = { state: 'unavailable', reason: 'verse embeddings not built (optional: npm run search:embed)' };
      return;
    }
    this.status = { state: 'loading' };
    try {
      const meta = JSON.parse(readFileSync(EMBEDDINGS_META, 'utf8')) as { dims: number; verses: number; model: string; revision: string; verseOfVector: number[] };
      this.verseOfVector = meta.verseOfVector;
      const buf = readFileSync(EMBEDDINGS_FILE);
      this.vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      this.dims = meta.dims;
      const t0 = performance.now();
      const bad = verifyModelFiles();
      if (bad) throw new Error(`model files: ${bad} (run npm run search:embed)`);
      if (meta.revision !== SEMANTIC_REVISION) throw new Error('embeddings were built with a different model revision; rebuild them');
      this.extractor = await loadExtractor();
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
    const best = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      let dot = 0;
      const base = i * this.dims;
      for (let d = 0; d < this.dims; d++) dot += q[d] * this.vectors[base + d];
      const v = this.verseOfVector[i];
      if ((best.get(v) ?? -Infinity) < dot) best.set(v, dot);
    }
    const scores = [...best.entries()].map(([verseIndex, score]) => ({ verseIndex, score }));
    return scores.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
