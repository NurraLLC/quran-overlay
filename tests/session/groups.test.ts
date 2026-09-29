// Short ayahs share the screen in fixed groups.
import { describe, expect, it } from 'vitest';
import { shortGroup } from '../../src/server/corpus/groups';
import { fullCorpus } from '../helpers';

describe('short-ayah groups', () => {
  const { corpus } = fullCorpus();
  const keys = (k: string) => shortGroup(corpus, corpus.verse(k)!.index).map((i) => corpus.at(i)!.key);

  it('packs short ayahs of a surah together and leaves long ones alone', () => {
    expect(keys('93:1')).toEqual(['93:1', '93:2', '93:3', '93:4']);
    expect(keys('112:3')).toEqual(['112:1', '112:2', '112:3', '112:4']);
    expect(keys('2:255')).toEqual(['2:255']);
  });

  it('is the same group from every member, never crosses a surah, and holds at most four ayahs', () => {
    for (let i = 0; i < corpus.verses.length; i++) {
      const g = shortGroup(corpus, i);
      expect(g).toContain(i);
      expect(g.length).toBeLessThanOrEqual(4);
      expect(new Set(g.map((x) => corpus.at(x)!.surah)).size).toBe(1);
      for (const x of g) expect(shortGroup(corpus, x)).toEqual(g);
    }
  });
});
