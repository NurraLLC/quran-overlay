// Alignment across ASR word-boundary errors at attached particles (real Soniox output, 93:4).
import { describe, expect, it } from 'vitest';
import { alignRegion, type Obs } from '../../src/server/tracker/align';
import { tokenize } from '../../src/server/tracker/normalize';
import { fullCorpus } from '../helpers';

const obsOf = (text: string, partialLast = false): Obs[] =>
  tokenize(text).map((t, i, all) => ({ key: t.key, cons: t.cons, foreign: false, startMs: i * 400, endMs: i * 400 + 350, partial: partialLast && i === all.length - 1 }));

describe('alignRegion word joins', () => {
  const { corpus, ix } = fullCorpus();
  const start = (key: string) => ix.verseStart[corpus.verse(key)!.index];

  it('matches two heard words to one Quran word when ASR splits a particle ("ولا الآخرة")', () => {
    const from = start('93:3');
    const a = alignRegion(ix, obsOf('ما ودعك ربك وما قلى ولا الآخرة'), from, from + 30)!;
    expect(a.endPos).toBe(start('93:4'));
    expect(a.trailing).toBe(0);
  });

  it('matches one heard word to two Quran words when ASR merges them', () => {
    const from = start('93:3');
    const a = alignRegion(ix, obsOf('ما ودعك ربك وماقلى'), from, from + 30)!;
    expect(a.endPos).toBe(start('93:3') + 4);
    expect(a.trailing).toBe(0);
  });

  it('never lets a still-forming word swallow the next Quran word', () => {
    const from = start('114:1');
    const a = alignRegion(ix, obsOf('قل اعوذ برب الناس', true), from, from + 30)!;
    expect(a.endPos).toBe(start('114:1') + 3);
  });

  it('rejects short joins that collide by chance ("الله" vs "إلا له")', () => {
    for (let p = 0; p + 1 < ix.totalWords; p++) {
      if (ix.words[p] + ix.words[p + 1] !== 'الاله') continue;
      const a = alignRegion(ix, obsOf('الله'), p, p + 2);
      expect(a === null || a.pairs.every(([, , s]) => s < 0.9)).toBe(true);
      return;
    }
  });
});
