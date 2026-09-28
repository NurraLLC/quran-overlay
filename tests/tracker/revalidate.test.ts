// Decisions are re-checked in the real tracker context with the same rules as deterministic
// decisions: continuity of a confirmed/manual anchor distinguishes identical text; without one, an
// identical occurrence elsewhere is a collision no model answer can resolve.
import { describe, expect, it } from 'vitest';
import { TrackerEngine } from '../../src/server/tracker/reducer';
import { asrSurface } from '../../src/replay/synth';
import type { Word } from '../../src/shared/transcript';
import { fullCorpus } from '../helpers';

function heard(keys: string[]): Word[] {
  const { corpus } = fullCorpus();
  const words = keys.flatMap((k) => corpus.verse(k)!.searchText.split(/\s+/).map(asrSurface).filter((w) => /[ء-ي]/.test(w)));
  return words.map((text, i) => ({ text, startMs: i * 500, endMs: i * 500 + 400, index: i }));
}
const idx = (k: string) => fullCorpus().corpus.verse(k)!.index;

describe('contextual revalidation', () => {
  it('55:13 refrain: accepted after an anchor at 55:12, a collision from an unknown start', () => {
    const { ix } = fullCorpus();
    const anchored = new TrackerEngine(ix);
    anchored.seek(idx('55:12'), 0);
    const w1 = heard(['55:12', '55:13']);
    expect(anchored.revalidate(idx('55:13'), w1)).toMatchObject({ ok: true, proposal: { verseIndex: idx('55:13') } });

    const unknown = new TrackerEngine(ix);
    expect(unknown.revalidate(idx('55:13'), heard(['55:13']))).toEqual({ ok: false, reason: 'collision' });
  });

  it('3:2 versus the identical opening of 2:255: the manual anchor at 3:1 distinguishes them', () => {
    const { ix } = fullCorpus();
    const w = heard(['3:2']);
    const anchored = new TrackerEngine(ix);
    anchored.seek(idx('3:1'), 0);
    expect(anchored.revalidate(idx('3:2'), w)).toMatchObject({ ok: true, proposal: { verseIndex: idx('3:2') } });
    // Without the anchor the same words are indistinguishable from 2:255's opening.
    const unknown = new TrackerEngine(ix);
    expect(unknown.revalidate(idx('3:2'), w)).toEqual({ ok: false, reason: 'collision' });
    expect(unknown.revalidate(idx('2:255'), w)).toEqual({ ok: false, reason: 'collision' });
  });

  it('rejects a decided verse the heard words do not support', () => {
    const { ix } = fullCorpus();
    const e = new TrackerEngine(ix);
    expect(e.revalidate(idx('36:1'), heard(['112:1', '112:2']))).toEqual({ ok: false, reason: 'unsupported_now' });
  });

  it('a unique passage is accepted from an unknown start and reports the newest position', () => {
    const { ix } = fullCorpus();
    const e = new TrackerEngine(ix);
    const r = e.revalidate(idx('67:1'), heard(['67:1', '67:2']));
    expect(r.ok).toBe(true);
    if (r.ok) expect([idx('67:1'), idx('67:2')]).toContain(r.proposal.verseIndex);
  });
});
