import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { buildIndex, type CorpusIndex } from '../src/server/tracker/index';
import type { Clock } from '../src/server/tracker/scheduler';

let cached: { corpus: Corpus; ix: CorpusIndex } | null = null;

/** Full processed corpus (all 6,236 ayahs) and index, built once per test worker. */
export function fullCorpus() {
  if (!cached) {
    const corpus = new Corpus(loadCorpus());
    cached = { corpus, ix: buildIndex(corpus.verses) };
  }
  return cached;
}

/** Deterministic virtual clock for scheduler/session tests. */
export class VirtualClock implements Clock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  /** Advance time, firing due timers in order (and flushing microtasks between them). */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
  /** Promise that resolves after `ms` of virtual time (for fake providers). */
  wait(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const id = this.setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        this.clearTimeout(id);
        reject(Object.assign(new Error('aborted'), { code: 'CANCELLED' }));
      });
    });
  }
}

export async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
