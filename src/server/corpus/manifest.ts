import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SourceFile } from '../../shared/corpus-types';
import { activeContent } from './active';

export type SourcesManifest = { schemaVersion: 1; narration: 'hafs'; sources: SourceFile[] };

export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const PROCESSED_DIR = process.env.QO_CONTENT_STORE && existsSync(path.join(process.env.QO_CONTENT_STORE,'active.json')) ? activeContent(process.env.QO_CONTENT_STORE).path : path.join(ROOT, 'data', 'processed');
export const PROCESSED_CORPUS = path.join(PROCESSED_DIR, 'corpus.json');
export const PROCESSED_FONT_DIR = path.join(PROCESSED_DIR, 'fonts');

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function readSourcesManifest(file: string): SourcesManifest {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as SourcesManifest;
  if (parsed.schemaVersion !== 1 || parsed.narration !== 'hafs' || !Array.isArray(parsed.sources)) {
    throw new Error(`Unsupported sources manifest: ${file}`);
  }
  for (const role of ['arabicDisplay', 'arabicSearch', 'english', 'chapters', 'font'] as const) {
    if (parsed.sources.filter((s) => s.role === role).length !== 1) {
      throw new Error(`Sources manifest must declare exactly one "${role}" source`);
    }
  }
  return parsed;
}

export function sourceFor(m: SourcesManifest, role: SourceFile['role']): SourceFile {
  return m.sources.find((s) => s.role === role)!;
}
