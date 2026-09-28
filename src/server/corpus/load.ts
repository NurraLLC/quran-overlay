import { existsSync, readFileSync } from 'node:fs';
import type { Chapter, ProcessedCorpus, Verse, VerseKey } from '../../shared/corpus-types';
import { PROCESSED_CORPUS } from './manifest';

export class CorpusMissingError extends Error {
  constructor(file: string) {
    super(`Processed corpus not found at ${file}. Run: npm run corpus:import -- --manifest corpus/sources.json`);
  }
}

export function loadCorpus(file = PROCESSED_CORPUS): ProcessedCorpus {
  if (!existsSync(file)) throw new CorpusMissingError(file);
  const c = JSON.parse(readFileSync(file, 'utf8')) as ProcessedCorpus;
  if (c.manifest?.schemaVersion !== 1 || c.verses?.length !== c.manifest.verseCount) {
    throw new Error(`Processed corpus at ${file} is not schema v1 or is internally inconsistent; re-import it.`);
  }
  return c;
}

/** Lookup helpers over an immutable corpus. */
export class Corpus {
  readonly byKey = new Map<string, Verse>();
  readonly chapterStart: number[] = [];
  constructor(readonly data: ProcessedCorpus) {
    for (const v of data.verses) this.byKey.set(v.key, v);
    let i = 0;
    for (const ch of data.chapters) {
      this.chapterStart.push(i);
      i += ch.verseCount;
    }
  }
  get id() {
    return this.data.manifest.id;
  }
  get verses() {
    return this.data.verses;
  }
  chapter(n: number): Chapter | undefined {
    return this.data.chapters[n - 1];
  }
  verse(key: string): Verse | undefined {
    return this.byKey.get(key as VerseKey);
  }
  at(index: number): Verse | undefined {
    return this.data.verses[index];
  }
  indexOf(surah: number, ayah: number): number | null {
    const ch = this.chapter(surah);
    if (!ch || ayah < 1 || ayah > ch.verseCount) return null;
    return this.chapterStart[surah - 1] + ayah - 1;
  }
}
