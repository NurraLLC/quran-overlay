// Reversible display following over the current complete ASR hypothesis. This never commits
// provisional text to the confirmed follower, sends JEV requests, or edits the Quran corpus.
import type { Word } from '../../shared/transcript';
import type { CorpusIndex } from './index';
import { TrackerEngine } from './reducer';
import type { NeighbourProvider } from './candidates';

export type LivePosition = { verseIndex: number; word: number; provisional: boolean };
type Anchor = { pos: number; verseIndex: number };

export class LiveCursor {
  private anchor: Anchor | null = null;
  constructor(private readonly ix: CorpusIndex) {}
  reset() { this.anchor = null; }

  update(words: readonly Word[], confirmed: Anchor | null, provisional: boolean, prior: number | null = null, neighbours: NeighbourProvider | null = null): LivePosition | null {
    if (!words.length) { this.reset(); return null; }
    // Re-align the complete latest hypothesis every time. A subword correction is not a new
    // location: preserve the local path as a prior while requiring present speech to support it.
    const engine = new TrackerEngine(this.ix);
    engine.prior = prior;
    engine.neighbours = neighbours;
    engine.anchor = this.anchor ?? confirmed;
    engine.phase = engine.anchor ? 'tracking' : 'unlocated';
    const step = engine.step(words);
    let pos: Anchor | null = null;
    if (step.proposal) pos = { verseIndex: step.proposal.verseIndex, pos: step.proposal.pos };
    else if (step.progress) {
      const candidate = step.top.find(c => c.verseIndex === step.progress!.verseIndex && c.trailing <= 1 && c.matched > 0);
      if (candidate) pos = { verseIndex: candidate.verseIndex, pos: candidate.endPos };
    }
    if (pos) this.anchor = pos;
    return pos ? { verseIndex: pos.verseIndex, word: Math.max(0, pos.pos - this.ix.verseStart[pos.verseIndex]), provisional } : null;
  }
}
