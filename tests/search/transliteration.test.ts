// Finding an ayah by how it sounds in English letters (needs `npm run wbw:import`; skipped without it).
import { describe, expect, it } from 'vitest';
import { Transliteration } from '../../src/server/search/transliteration';
import { fullCorpus } from '../helpers';

const { corpus } = fullCorpus();
const sounds = Transliteration.load(corpus);
const top = (q: string) => {
  const m = sounds!.match(q);
  return m.length ? corpus.at(m[0].verseIndex)!.key : null;
};

describe.skipIf(!sounds)('ayah openings in English letters', () => {
  it('finds openings however they are spelled or run together', () => {
    expect(top('Go to Inna Fatahna')).toBe('48:1');
    expect(top('Bismillahirrahmanirrahim')).toBe('1:1');
    expect(top('qul huwallahu ahad')).toBe('112:1');
    expect(top('yasin wal quran il hakim')).toBe('36:1');
    expect(top('ar rahman allamal quran')).toBe('55:1');
  });

  it('does not match ordinary English', () => {
    expect(sounds!.match('the ayah about patience')).toEqual([]);
    expect(sounds!.match('thanks for joining everyone')).toEqual([]);
  });
});
