// Keeping the highlight on the word being recited (pace.ts), not the last one the recogniser
// reported ~0.8 s later.
import { describe, expect, it } from 'vitest';
import { fullCorpus, VirtualClock } from '../helpers';
import { Pace, PACE } from '../../src/server/tracker/pace';
import { mapDisplayWords } from '../../src/server/corpus/word-map';
import { Session } from '../../src/server/sessions';
import { CommandResolver } from '../../src/server/commands/reducer';

describe('pace', () => {
  const { corpus, ix } = fullCorpus();
  const at = (key: string, word: number) => ix.verseStart[corpus.verse(key)!.index] + word;

  it('takes a word as begun from its first letters, only for the next word of the same ayah', () => {
    const pace = new Pace(ix, corpus);
    const first = { pos: at('36:9', 0), startMs: 1000 };
    expect(pace.begun(first, { key: 'م', startMs: 1800 })).toEqual({ pos: at('36:9', 1), startMs: 1800 });
    expect(pace.begun(first, { key: 'ب', startMs: 1800 })).toEqual(first); // not the next word
    expect(pace.begun(first, { key: 'م', startMs: 900 })).toEqual(first); // heard before it
    // 36:10 begins "وسواء": its first letter is never taken as the next ayah beginning.
    const last = { pos: at('36:9', ix.verseLen[corpus.verse('36:9')!.index] - 1), startMs: 5000 };
    expect(pace.begun(last, { key: 'و', startMs: 5800 })).toEqual(last);
  });

  it('moves on at the reciter’s pace, at most two words ahead and never past the ayah’s end', () => {
    const pace = new Pace(ix, corpus);
    const from = { pos: at('36:9', 0), startMs: 0 };
    const due = pace.unitMs() * pace.unitsOf(from.pos);
    expect(pace.predict(from, due - 50, 850)).toEqual({ pos: from.pos, nextAt: due });
    expect(pace.predict(from, due + 10, 850).pos).toBe(from.pos + 1);
    expect(pace.predict(from, 60_000, 120_000)).toEqual({ pos: from.pos + PACE.maxLead, nextAt: null });
    const len = ix.verseLen[corpus.verse('36:9')!.index];
    expect(pace.predict({ pos: at('36:9', len - 2), startMs: 0 }, 60_000, 120_000).pos).toBe(at('36:9', len - 1));
  });

  it('waits for evidence when the next word was due long enough ago to have been heard', () => {
    const pace = new Pace(ix, corpus);
    const from = { pos: at('36:9', 0), startMs: 0 };
    expect(pace.predict(from, 5000, 850)).toEqual({ pos: from.pos, nextAt: null });
  });

  it('holds during a breath and moves on when the voice returns', () => {
    const pace = new Pace(ix, corpus);
    const from = { pos: at('36:9', 0), startMs: 0 };
    const due = pace.unitMs() * pace.unitsOf(from.pos);
    expect(pace.predict(from, due + 100, 850, [{ from: due - 300, to: null }])).toEqual({ pos: from.pos, nextAt: null });
    const back = due + 700;
    const p = pace.predict(from, back + 20, 850, [{ from: due - 300, to: back }]);
    expect(p.pos).toBe(from.pos + 1);
    expect(p.nextAt).toBeCloseTo(back + pace.unitMs() * pace.unitsOf(from.pos + 1));
  });

  it('passes a pause mark only when the voice returns after it, never on the clock', () => {
    const pace = new Pace(ix, corpus);
    // 67:3 "... طباقا ۖ ما ترى ...": word 4 is followed by a pause mark.
    const from = { pos: at('67:3', 4), startMs: 0 };
    expect(pace.predict(from, 1500, 5000)).toEqual({ pos: from.pos, nextAt: null });
    expect(pace.predict(from, 2500, 5000, [{ from: 1200, to: 2300 }]).pos).toBe(from.pos + 1);
    expect(pace.predict({ pos: at('67:3', 3), startMs: 0 }, 60_000, 120_000).pos).toBe(at('67:3', 4));
  });

  it('learns the reciter’s pace from consecutive words, not from breaths or pause marks', () => {
    const pace = new Pace(ix, corpus);
    const slow = 2 * PACE.defaultUnitMs;
    let t = 0;
    const path = [0, 1, 2, 3, 4, 5, 6].map((w) => {
      const step = { pos: at('36:9', w), startMs: t };
      t += slow * pace.unitsOf(at('36:9', w));
      return step;
    });
    pace.learn(path);
    expect(pace.unitMs()).toBeGreaterThan(1.5 * PACE.defaultUnitMs);
    const before = pace.unitMs();
    // A long gap across 67:3's pause mark is a stop, not pace.
    pace.learn([{ pos: at('67:3', 4), startMs: 0 }, { pos: at('67:3', 5), startMs: 2400 }]);
    expect(pace.unitMs()).toBe(before);
  });
});

describe('the session keeps the highlight in step', () => {
  const { corpus, ix } = fullCorpus();
  const verse = corpus.verse('36:9')!;
  const words = verse.searchText.split(/\s+/);
  const spans = mapDisplayWords(verse.searchText, verse.arabicDisplay);
  const STEP = 700;
  const LAG = 750;

  function reciting(withClock = true) {
    const clock = new VirtualClock();
    const s = new Session({ corpus, ix, resolver: new CommandResolver(corpus, null, null), decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: () => '', clock });
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    s.handle({ type: 'goto', key: '36:9' });
    let seq = 0;
    /** The recogniser reports words 0..n-1 (word i began at i × STEP), LAG after the newest began. */
    const hear = async (n: number) => {
      await clock.advance(Math.max(0, (n - 1) * STEP + LAG - clock.t));
      const tokens = words.slice(0, n).map((w, i) => ({ text: `${i ? ' ' : ''}${w}`, isFinal: false, startMs: i * STEP, endMs: i * STEP + 400 }));
      s.handle({ type: 'transcript', captureEpoch: 1, seq: seq++, receivedAt: clock.t, tokens, ...(withClock ? { audioMs: clock.t } : {}) });
    };
    return { s, clock, hear };
  }
  const word = (s: Session) => spans.findIndex((x) => x?.from === s.display.cursor?.from);

  it('moves to the next word when it is due, between recogniser reports', async () => {
    const { s, clock, hear } = reciting();
    await hear(4);
    expect(s.display.verse?.key).toBe('36:9');
    const now = word(s);
    expect(now).toBeGreaterThanOrEqual(3);
    await clock.advance(1500);
    expect(word(s)).toBeGreaterThan(now);
  });

  it('stays put during a breath and moves on as the voice returns', async () => {
    const { s, clock, hear } = reciting();
    await hear(4);
    // Word 4 begins at 2800 and ends by 3300, where the reciter takes a breath: the page's detector
    // reports it 180 ms later, before the recogniser reports word 4 itself.
    await clock.advance(3480 - clock.t);
    s.handle({ type: 'voice', captureEpoch: 1, speaking: false, audioMs: 3300 });
    await hear(5);
    expect(word(s)).toBe(4);
    await clock.advance(2500);
    expect(word(s)).toBe(4);
    s.handle({ type: 'voice', captureEpoch: 1, speaking: true, audioMs: clock.t });
    expect(word(s)).toBe(5);
  });

  it('follows the reciter back when they restart a few words back after a breath', async () => {
    const { s, clock, hear } = reciting();
    await hear(6);
    const ahead = word(s);
    expect(ahead).toBeGreaterThanOrEqual(5);
    // After a breath the reciter goes back to "وجعلنا من بين": later audio, earlier words.
    const restart = (n: number) => {
      const tokens = [...words.slice(0, 6), ...words.slice(0, n)].map((w, i) => ({ text: `${i ? ' ' : ''}${w}`, isFinal: false, startMs: i * STEP, endMs: i * STEP + 400 }));
      s.handle({ type: 'transcript', captureEpoch: 1, seq: 100 + n, receivedAt: clock.t, tokens, audioMs: clock.t });
    };
    await clock.advance(6 * STEP + 2 * STEP + LAG - clock.t);
    restart(3);
    expect(word(s)).toBeLessThan(ahead);
    expect(word(s)).toBeLessThanOrEqual(3);
  });

  it('passes through the words between when it catches up, instead of jumping over them', async () => {
    const { s, clock, hear } = reciting(false);
    await hear(3);
    expect(word(s)).toBe(2);
    await hear(6);
    expect(word(s)).toBe(3);
    await clock.advance(90);
    expect(word(s)).toBe(4);
    await clock.advance(90);
    expect(word(s)).toBe(5);
  });

  it('without the page’s audio clock, follows the recogniser only (no timers)', async () => {
    const { s, clock, hear } = reciting(false);
    await hear(4);
    const now = word(s);
    await clock.advance(3000);
    expect(word(s)).toBe(now);
  });
});
