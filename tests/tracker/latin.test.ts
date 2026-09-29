// Recitation that arrives in Latin letters (needs `npm run wbw:import`; skipped without it).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LatinReader } from '../../src/server/tracker/latin';
import { fullCorpus } from '../helpers';

const file = 'data/processed/translit-en.json';
const { corpus, ix } = fullCorpus();
const reader = existsSync(file) ? new LatinReader(ix, corpus, JSON.parse(readFileSync(file, 'utf8')).verses) : null;
const words = (s: string) => s.split(' ').map((text, index) => ({ text, index, startMs: index * 400, endMs: index * 400 + 300 }));
const read = (s: string, near: string | null = null) => reader!.apply(words(s), near ? corpus.verse(near)!.index : null).map((w) => w.text);

describe.skipIf(!reader)('recitation in Latin letters', () => {
  it('reads a real session\'s Latin recitation as the Arabic it matches, even with slips', () => {
    // From an owner session: 48:1 recited plainly, written by the recogniser in English letters.
    expect(read('Inna Fatahna, like Fataham Mubina.')).toEqual(['انا', 'فتحنا', 'لك', 'فتحا', 'مبينا']);
  });

  it('reads the continuation near the current place, and a basmala that reads the same in two places', () => {
    expect(read('Liyaghfira lakallahu ma taqaddama min dhanbika', '48:1')).toEqual(['ليغفر', 'لك الله', 'ما', 'تقدم', 'من', 'ذنبك']);
    expect(read('Bismillahirrahmanirrahim.')).toEqual(['بسم الله الرحمن الرحيم']);
  });

  it('leaves English requests and talk alone, even when mixed with recitation', () => {
    expect(read('Go to Surah Fatih.')).toEqual(['Go', 'to', 'Surah', 'Fatih.']);
    expect(read('Thanks for joining the stream everyone')).toEqual(['Thanks', 'for', 'joining', 'the', 'stream', 'everyone']);
    const mixed = read('Go to Inna Fatahna. Inna Fatahna, like Fataham Mubina.');
    expect(mixed.slice(0, 2)).toEqual(['Go', 'to']);
    expect(mixed.slice(4)).toEqual(['انا', 'فتحنا', 'لك', 'فتحا', 'مبينا']);
  });

  it('does not guess from a short phrase with no current place', () => {
    expect(read('Qul huwallahu ahad')).toEqual(['Qul', 'huwallahu', 'ahad']);
  });
});
