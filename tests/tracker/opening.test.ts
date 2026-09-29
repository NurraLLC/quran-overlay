// Surah openings after a basmala, and a session's unique first word.
import { describe, expect, it } from 'vitest';
import type { Obs } from '../../src/server/tracker/align';
import { openingAfterBasmala, uniqueFirstWord } from '../../src/server/tracker/opening';
import { tokenize } from '../../src/server/tracker/normalize';
import { fullCorpus } from '../helpers';

const obsOf = (text: string, partialLast = false): Obs[] =>
  tokenize(text).map((t, i, all) => ({ key: t.key, cons: t.cons, foreign: false, startMs: i * 400, endMs: i * 400 + 350, partial: partialLast && i === all.length - 1 }));
const BASMALA = 'بسم الله الرحمن الرحيم';

describe('surah openings', () => {
  const { corpus, ix } = fullCorpus();
  const key = (m: { verseIndex: number } | null) => (m ? corpus.at(m.verseIndex)!.key : null);
  const at = (k: string) => ({ verseIndex: corpus.verse(k)!.index });

  it('identifies a one-word opening ayah from a rare word after the basmala', () => {
    expect(key(openingAfterBasmala(ix, obsOf(`${BASMALA} والضحى`), null))).toBe('93:1');
    expect(key(openingAfterBasmala(ix, obsOf(`${BASMALA} يس`), at('93:3')))).toBe('36:1');
  });

  it('waits while the forming word could still become another word, but not on the next word\'s first letter', () => {
    expect(openingAfterBasmala(ix, obsOf(`${BASMALA} يس`, true), null)).toBeNull();
    expect(key(openingAfterBasmala(ix, [...obsOf(`${BASMALA} يس`), ...obsOf('و', true)], null))).toBe('36:1');
  });

  it('advances to the next surah on its first word after finishing a surah', () => {
    expect(key(openingAfterBasmala(ix, obsOf(`${BASMALA} الم`), at('93:11')))).toBe('94:1');
    // Without that context "الم" begins several surahs: no guess.
    expect(openingAfterBasmala(ix, obsOf(`${BASMALA} الم`), null)).toBeNull();
  });

  it('never treats a mid-surah start after the basmala as an opening', () => {
    expect(openingAfterBasmala(ix, obsOf(`${BASMALA} الله لا اله الا هو`), null)).toBeNull();
    expect(openingAfterBasmala(ix, obsOf(`${BASMALA} الحمد لله`), null)).toBeNull();
  });

  it('stands down once tracking is inside the identified opening', () => {
    expect(openingAfterBasmala(ix, obsOf(`${BASMALA} الحمد لله رب العالمين الرحمن`), at('1:3'))).toBeNull();
  });

  it('places a session\'s first word only when it occurs in exactly one verse', () => {
    expect(key(uniqueFirstWord(ix, obsOf('والضحى')))).toBe('93:1');
    expect(key(uniqueFirstWord(ix, obsOf('والعصر')))).toBe('103:1');
    expect(uniqueFirstWord(ix, obsOf('الحمد'))).toBeNull();
    expect(uniqueFirstWord(ix, obsOf('يس'))).toBeNull();
    expect(uniqueFirstWord(ix, obsOf('والضحى والليل'))).toBeNull();
  });
});

describe('openings whose disjoint letters were not heard', () => {
  const { corpus, ix } = fullCorpus();
  it('treats the second ayah after a letters-only first ayah as the surah opening', () => {
    const m = openingAfterBasmala(ix, obsOf('بسم الله الرحمن الرحيم والقرآن الحكيم'), null);
    expect(m ? corpus.at(m.verseIndex)!.key : null).toBe('36:2');
    // Not for surahs whose first ayah is ordinary text.
    expect(openingAfterBasmala(ix, obsOf('بسم الله الرحمن الرحيم ما ودعك'), null)).toBeNull();
  });
});
