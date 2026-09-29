// When speech stops matching, the place is given up; the screen keeps the ayah unless asked to clear.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKER_CONFIG, TrackerEngine } from '../../src/server/tracker/reducer';
import type { Word } from '../../src/shared/transcript';
import { fullCorpus } from '../helpers';

const talk = 'هذا كلام عادي عن يومنا وليس من الآيات أبدا وسنكمل بعد قليل إن شاء الله تعالى';
const wordsOf = (text: string): Word[] => text.split(' ').map((t, i) => ({ text: t, index: i, startMs: i * 400, endMs: i * 400 + 350 }));

describe('speech that stops matching', () => {
  const { corpus, ix } = fullCorpus();
  const run = (keepOnUncertain: boolean) => {
    const e = new TrackerEngine(ix, { ...DEFAULT_TRACKER_CONFIG, keepOnUncertain });
    e.seek(corpus.verse('2:3')!.index, 0);
    const heard = wordsOf(talk);
    for (let n = 1; n <= heard.length; n++) {
      const r = e.step(heard.slice(0, n));
      if (r.lost) return { lost: r.lost, clear: r.clear, anchor: e.anchor };
    }
    return null;
  };

  it('gives up the place but leaves the screen alone when keeping the last ayah', () => {
    expect(run(true)).toEqual({ lost: true, clear: false, anchor: null });
  });

  it('also clears the screen when the broadcaster chose that', () => {
    expect(run(false)).toEqual({ lost: true, clear: true, anchor: null });
  });
});
