// Going back after a breath (waqf and ibtida), and words that must keep their highlight.
// Heard text is from a real session (Ya-Sin, Al-Baqarah) as Soniox delivered it.
import { describe, expect, it } from 'vitest';
import { alignRegion, type Obs } from '../../src/server/tracker/align';
import { TrackerEngine } from '../../src/server/tracker/reducer';
import { tokenize } from '../../src/server/tracker/normalize';
import { mapDisplayWords } from '../../src/server/corpus/word-map';
import type { Word } from '../../src/shared/transcript';
import { fullCorpus } from '../helpers';

const obsOf = (text: string): Obs[] => tokenize(text).map((t, i) => ({ key: t.key, cons: t.cons, foreign: false, startMs: i * 400, endMs: i * 400 + 350 }));
const wordsOf = (text: string): Word[] => text.split(' ').map((t, i) => ({ text: t, index: i, startMs: i * 400, endMs: i * 400 + 350 }));

describe('going back a few words', () => {
  const { corpus, ix } = fullCorpus();
  const start = (key: string) => ix.verseStart[corpus.verse(key)!.index];

  it('explains a restart within the ayah instead of leaving it unexplained', () => {
    const from = start('36:5');
    const a = alignRegion(ix, obsOf('تنزيل العزيز الرحيم لتنذر قوما ما لتنذر قوما ما'), from, from + 40)!;
    expect(a.trailing).toBe(0);
    expect(ix.wordVerse[a.endPos]).toBe(corpus.verse('36:6')!.index);
  });

  it('never goes back into an earlier ayah', () => {
    const from = start('2:2');
    const a = alignRegion(ix, obsOf('هدى للمتقين الذين يؤمنون بالغيب ويقيمون الصلاة ومما رزقناهم ينفقون الله لا'), from, from + 40)!;
    expect(a.trailing).toBeGreaterThan(0); // "لا ريب" in 2:2 is not a restart point from 2:3
  });

  it('stays on 36:10 when its words are repeated, though 2:6 shares them', () => {
    const e = new TrackerEngine(ix);
    const v = corpus.verse('36:10')!;
    e.seek(v.index, 0);
    const heard = wordsOf('وسواء عليهم أأنذرتهم أم لم تنذرهم أم لم تنذرهم لا يؤمنون');
    for (let n = 1; n <= heard.length; n++) {
      const r = e.step(heard.slice(0, n));
      expect(r.proposal?.verseIndex ?? v.index).toBe(v.index);
      expect(r.clear).toBe(false);
    }
  });
});

describe('Uthmani spellings keep the recited word highlighted', () => {
  const { corpus } = fullCorpus();
  it.each([
    ['2:285', 'وملائكته'],
    ['2:255', 'يئوده'],
    ['2:286', 'مولانا'],
    ['36:10', 'أأنذرتهم'],
    ['2:3', 'الصلاة'],
    ['92:1', 'والليل'],
  ])('%s %s', (key, word) => {
    const v = corpus.verse(key)!;
    const words = tokenize(v.searchText).filter((t) => !t.foreign).map((t) => t.key);
    const i = words.indexOf(tokenize(word)[0].key);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(mapDisplayWords(v.searchText, v.arabicDisplay)[i]).not.toBeNull();
  });
});
