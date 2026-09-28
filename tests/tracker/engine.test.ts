// Deterministic tracker over corpus-derived synthetic streams (labelled synthetic; not ASR evidence).
import { describe, expect, it } from 'vitest';
import { TrackerEngine } from '../../src/server/tracker/reducer';
import { canonicalizeLetterNames } from '../../src/server/tracker/index';
import { tokenize } from '../../src/server/tracker/normalize';
import { Timeline, type TruthWord } from '../../src/replay/synth';
import { TranscriptBuffer } from '../../src/shared/transcript';
import { fullCorpus } from '../helpers';

type Commit = { t: number; key: string; reason: string; truthNow: string | null };

function run(ranges: string[], build?: (tl: Timeline) => void) {
  const { corpus, ix } = fullCorpus();
  const tl = new Timeline();
  for (const r of ranges) {
    const [a, b] = r.split('-');
    for (let i = corpus.verse(a)!.index; i <= corpus.verse(b ?? a)!.index; i++) tl.reciteVerse(corpus.at(i)!);
  }
  build?.(tl);
  const buf = new TranscriptBuffer();
  const eng = new TrackerEngine(ix);
  const commits: Commit[] = [];
  let clears = 0;
  const truthAt = (t: number, truth: TruthWord[]) => [...truth].reverse().find((w) => w.endMs <= t)?.verseKey ?? null;
  for (const ev of tl.sorted()) {
    if (ev.type !== 'result') continue;
    if (!buf.apply(ev.tokens).evidenceChanged) continue;
    const out = eng.step(buf.evidence());
    if (out.proposal) {
      eng.applyCommit(out.proposal);
      commits.push({ t: ev.t, key: corpus.at(out.proposal.verseIndex)!.key, reason: out.proposal.reason, truthNow: truthAt(ev.t, tl.truth) });
    }
    if (out.clear) clears++;
  }
  return { commits, clears, keys: commits.map((c) => c.key) };
}

/** A commit is wrong if it names a verse that was not recited within the last few words. */
function wrongCommits(commits: Commit[], recited: Set<string>) {
  return commits.filter((c) => !recited.has(c.key));
}

describe('deterministic tracker', () => {
  it('follows the 55:13 refrain by context, not by the repeated phrase', () => {
    const { keys, clears } = run(['55:10-55:20']);
    expect(keys.slice(-9)).toEqual(['55:12', '55:13', '55:14', '55:15', '55:16', '55:17', '55:18', '55:19', '55:20']);
    expect(clears).toBe(0);
  });

  it('waits through the Al-Fatihah basmala ambiguity (identical to 27:30 text) and never guesses 27:30', () => {
    const { keys } = run(['1:1-1:7']);
    expect(keys).not.toContain('27:30');
    expect(keys.slice(-6)).toEqual(['1:2', '1:3', '1:4', '1:5', '1:6', '1:7']);
  });

  it('jumps to a different surah directly, without a blank or stale-verse flash', () => {
    const { keys, clears, commits } = run(['112:1-112:4', '2:281-2:283']);
    expect(keys).toEqual(['112:1', '112:2', '112:3', '112:4', '2:281', '2:282', '2:283']);
    expect(clears).toBe(0);
    expect(wrongCommits(commits, new Set(['112:1', '112:2', '112:3', '112:4', '2:281', '2:282', '2:283']))).toEqual([]);
  });

  it('does not double-count words shared with the current passage as evidence for a jump (36:4 = end of 67:22)', () => {
    const { keys } = run(['36:1-36:4', '112:1-112:4']);
    expect(keys).not.toContain('67:23');
    expect(keys).toContain('112:1');
  });

  it('handles the longest ayah (2:282) and advances out of it', () => {
    const { keys } = run(['2:281-2:283']);
    expect(keys).toEqual(expect.arrayContaining(['2:282', '2:283']));
  });

  it('follows a repeated previous ayah', () => {
    const { corpus } = fullCorpus();
    const { keys } = run(['2:1-2:4'], (tl) => {
      tl.reciteVerse(corpus.verse('2:3')!);
      tl.reciteVerse(corpus.verse('2:4')!);
      tl.reciteVerse(corpus.verse('2:5')!);
    });
    const afterFirst = keys.slice(keys.indexOf('2:4') + 1);
    expect(afterFirst).toEqual(['2:3', '2:4', '2:5']);
  });

  it('clears after ~3 s of unrelated speech, and ordinary silence alone never clears', () => {
    const { clears: silentClears } = run(['36:1-36:4'], (tl) => tl.pause(20_000));
    expect(silentClears).toBe(0);
    const { clears, keys } = run(['36:1-36:4'], (tl) => tl.speak('so let us now take a short break and talk about the meaning of this passage together'.split(' '), null));
    expect(clears).toBe(1);
    expect(keys.at(-1)).toBe('36:4');
  });

  it('recognizes a disjoint-letter opening recited as letter names', () => {
    const { ix } = fullCorpus();
    const toks = tokenize('الف لام ميم ذلك الكتاب');
    expect(canonicalizeLetterNames(ix, toks).map((t) => t.key)[0]).toBe('الم');
    const fused = canonicalizeLetterNames(ix, tokenize('حاميم تنزيل'));
    expect(fused[0].key).toBe('حم');
    // Ordinary words that happen to be letter names are untouched.
    expect(canonicalizeLetterNames(ix, tokenize('يا أيها الناس')).map((t) => t.key)[0]).toBe('يا');
  });

  it('keeps per-update compute bounded on the test machine', () => {
    const { ix, corpus } = fullCorpus();
    const eng = new TrackerEngine(ix);
    const tl = new Timeline();
    for (let i = corpus.verse('2:255')!.index; i <= corpus.verse('2:260')!.index; i++) tl.reciteVerse(corpus.at(i)!);
    const buf = new TranscriptBuffer();
    const times: number[] = [];
    for (const ev of tl.sorted()) {
      if (ev.type !== 'result' || !buf.apply(ev.tokens).evidenceChanged) continue;
      const out = eng.step(buf.evidence());
      if (out.proposal) eng.applyCommit(out.proposal);
      times.push(out.computeMs);
    }
    times.sort((a, b) => a - b);
    // Target from the plan: p95 <= 10 ms per material update (test machine).
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(10);
  });
});
