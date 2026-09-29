import { describe, expect, it } from 'vitest';
import { ArabicSurahRequests } from '../../src/server/commands/arabic-request';
import { fullCorpus } from '../helpers';

describe('a surah requested by name in Arabic script', () => {
  const r = new ArabicSurahRequests(fullCorpus().corpus.data.chapters);
  const find = (text: string) => r.find(text.split(' '))?.chapter ?? null;

  it('opens the named surah, including English the recogniser wrote in Arabic', () => {
    expect(find('قولت سورة الرحمن.')).toBe(55); // "go to Surah Rahman", from a live session
    expect(find('اذكروا سورة الرحمن')).toBe(55);
    expect(find('سورة الملك')).toBe(67);
    expect(find('سورة يس')).toBe(36);
    expect(find('سورة آل عمران')).toBe(3);
    expect(find('سورة رحمن')).toBe(55);
  });

  it('never fires on "سورة" inside recitation', () => {
    expect(find('وإن كنتم في ريب مما نزلنا على عبدنا فأتوا بسورة من مثله')).toBeNull(); // 2:23
    expect(find('سورة أنزلناها وفرضناها')).toBeNull(); // 24:1
    expect(find('لولا نزلت سورة فإذا أنزلت سورة محكمة')).toBeNull(); // 47:20
    expect(find('الرحمن علم القرآن')).toBeNull(); // a name alone is recitation
  });

  it('acts on a still-forming name only when it cannot become another name', () => {
    expect(r.find('قولت سورة الرحمن'.split(' '), 0, true)?.chapter).toBe(55);
    expect(r.find('سورة ق'.split(' '), 0, true)).toBeNull(); // may still become قريش
    expect(r.find('سورة ق'.split(' '), 0, false)?.chapter).toBe(50);
  });
});
