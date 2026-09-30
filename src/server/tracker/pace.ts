// Keeping the highlight in step with the reciter.
//
// The recogniser reports each piece of a word about 0.65 s after it is spoken, and the tracker needs
// some of its letters before it can place it, so evidence always describes where the reciter *was*:
// measured on owner recitation, the highlight trailed the voice by about a word (it reached a word
// ~0.9 s after the word began). Two things close that gap:
//   - A word counts as begun as soon as its first letters arrive, when they begin the next word of
//     the ayah (`begun`): a new word's first piece carries its own start time.
//   - From the newest evidenced word and when it began, the reciter's own pace (learned from their
//     recent words, `learn`) says which word they are on now (`predict`).
// Bounded so a guess cannot run away: never past the end of the ayah or a pause mark (where
// reciters stop and breathe), at most `maxLead` words beyond the evidence, and never while nothing
// new has been heard for a while (a breath, a long madd). Ayah changes stay evidence-only: this
// moves the highlight within the ayah on screen and never decides which ayah that is.
import type { Corpus } from '../corpus/load';
import { mapDisplayWords } from '../corpus/word-map';
import type { CorpusIndex } from './index';
import { tokenize } from './normalize';

export const PACE = {
  /** Words the highlight may be ahead of the newest evidenced word. */
  maxLead: 2,
  /**
   * How late the recogniser reports the start of a word, before this stream's own delays are
   * measured (owner sessions: 0.7–0.85 s). A next word due before `now - lag` would already have
   * been reported; when it has not, the reciter has paused or is holding a madd, and the highlight
   * waits for evidence instead of guessing past it.
   */
  defaultLagMs: 850,
  /** Percentile of this stream's measured delays used as that lag (high: a late report is not a pause). */
  lagQuantile: 0.9,
  /** Milliseconds per pace unit before the reciter's own pace is known (owner recitation ≈ 150–200). */
  defaultUnitMs: 170,
  /** Predicted word lengths are stretched by this much: arriving a little late beats running ahead. */
  stepScale: 1,
  /** Recent word steps the pace is learned from. */
  samples: 12,
  /** Steps outside this range are a split, a breath or a restart, not pace. */
  minStepMs: 150,
  maxStepMs: 2500,
};

/** A recited word: global corpus position and when it began (provider audio ms). */
export type Timed = { pos: number; startMs: number };
/** A silence the microphone heard (provider audio ms); `to` is null while it lasts. */
export type Quiet = { from: number; to: number | null };

const stopTables = new WeakMap<CorpusIndex, Uint8Array>();
/** 1 where a pause mark follows the word at that global position (built once per corpus). */
function stopsOf(ix: CorpusIndex): Uint8Array {
  let stops = stopTables.get(ix);
  if (stops) return stops;
  stops = new Uint8Array(ix.totalWords);
  for (const v of ix.verses) {
    let n = 0;
    for (const raw of v.searchText.split(/\s+/)) {
      if (STOP_MARK.test(raw)) {
        if (n) stops[ix.verseStart[v.index] + n - 1] = 1;
      } else if (tokenize(raw).some((t) => !t.foreign)) n++;
    }
  }
  stopTables.set(ix, stops);
  return stops;
}

/** Pause marks that invite a stop (ۖ ۗ ۘ ۚ ۛ ۜ); ۙ (lā: do not stop) is not one. */
const STOP_MARK = /^[ۖ-ۘۚ-ۜ]+$/;
const MADDAH = /ٓ/g;

export class Pace {
  /** 1 where a pause mark follows the word at this global position. */
  private readonly stops: Uint8Array;
  private readonly units = new Map<number, Float32Array>();
  /** Learned steps keyed by the word they start from, oldest first. */
  private readonly steps = new Map<number, { units: number; ms: number }>();

  constructor(
    private readonly ix: CorpusIndex,
    private readonly corpus: Corpus,
  ) {
    this.stops = stopsOf(ix);
  }

  /** A new listening stream keeps the learned pace (same reciter); only `forget` clears it. */
  forget() {
    this.steps.clear();
  }

  /** Pace units of the word at `pos`: its letters, one for the word itself, two per written madd. */
  unitsOf(pos: number): number {
    const v = this.ix.wordVerse[pos];
    let u = this.units.get(v);
    if (!u) {
      const verse = this.corpus.at(v)!;
      const spans = mapDisplayWords(verse.searchText, verse.arabicDisplay);
      const shown = verse.arabicDisplay.split(/\s+/);
      const start = this.ix.verseStart[v];
      u = new Float32Array(this.ix.verseLen[v]);
      for (let k = 0; k < u.length; k++) {
        const s = spans[k];
        const madd = s ? (shown.slice(s.from, s.to + 1).join(' ').match(MADDAH)?.length ?? 0) : 0;
        u[k] = this.ix.words[start + k].length + 1 + 2 * madd;
      }
      this.units.set(v, u);
    }
    return u[pos - this.ix.verseStart[v]];
  }

  /** Learn the reciter's pace from consecutive recited words (in heard order). */
  learn(path: readonly Timed[]) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (b.pos !== a.pos + 1 || this.ix.wordVerse[a.pos] !== this.ix.wordVerse[b.pos] || this.stops[a.pos]) continue;
      const ms = b.startMs - a.startMs;
      if (ms < PACE.minStepMs || ms > PACE.maxStepMs) continue;
      this.steps.delete(a.pos);
      this.steps.set(a.pos, { units: this.unitsOf(a.pos), ms });
      if (this.steps.size > PACE.samples) this.steps.delete(this.steps.keys().next().value!);
    }
  }

  /** Current milliseconds per pace unit (the default counts as two steps until enough are heard). */
  unitMs(): number {
    let ms = 0;
    let units = 0;
    for (const s of this.steps.values()) {
      ms += s.ms;
      units += s.units;
    }
    const prior = 2 * 6;
    return (ms + prior * PACE.defaultUnitMs) / (units + prior);
  }

  /**
   * The newest evidence: the matched word, or the next word of the same ayah when the newest heard
   * piece is its beginning (any of its first letters). A piece that fits nothing is not evidence.
   */
  begun(matched: Timed, newest: { key: string; startMs: number } | null): Timed {
    const next = matched.pos + 1;
    if (!newest || next >= this.ix.totalWords || this.ix.wordVerse[next] !== this.ix.wordVerse[matched.pos]) return matched;
    if (newest.startMs <= matched.startMs || !this.ix.words[next].startsWith(newest.key)) return matched;
    return { pos: next, startMs: newest.startMs };
  }

  /**
   * Where the reciter is at audio time `now`, from `from` (evidence). `lagMs`: how late the
   * recogniser reports a word's start (see `Lag`). `quiet`: silences the control page's microphone
   * heard (audio ms; `to` null while still quiet), when it reports them. `nextAt` is when the next
   * word is due (audio ms), or null when the highlight should wait for evidence or the voice.
   */
  predict(from: Timed, now: number, lagMs: number, quiet: readonly Quiet[] = []): { pos: number; nextAt: number | null } {
    const v = this.ix.wordVerse[from.pos];
    const last = this.ix.verseStart[v] + this.ix.verseLen[v] - 1;
    const unit = this.unitMs() * PACE.stepScale;
    let pos = from.pos;
    let t = from.startMs;
    while (pos < last && pos - from.pos < PACE.maxLead) {
      let at = t + unit * this.unitsOf(pos);
      // A silence after this word began: the reciter stopped (a breath, a pause mark). The next
      // word begins when the voice returns; after a pause reciters nearly always continue (a
      // restart shows in the evidence and moves the highlight back).
      const q = quiet.find((x) => x.from > t && (x.from < at || this.stops[pos]));
      if (q) {
        if (q.to === null) return { pos, nextAt: null };
        at = Math.max(q.to, t + PACE.minStepMs);
      } else if (this.stops[pos]) return { pos, nextAt: null }; // at a pause mark only the voice returning moves on
      // Due long enough ago to have been heard, yet not heard: a pause or a held madd.
      if (at < now - lagMs) return { pos, nextAt: null };
      // Within a millisecond counts as due: a timer set for `at` must see it as reached.
      if (at > now + 1) return { pos, nextAt: at };
      t = at;
      pos++;
    }
    return { pos, nextAt: null };
  }
}

/** How late this stream's recogniser reports the start of what was said (recent pieces). */
export class Lag {
  private recent: number[] = [];
  observe(ms: number) {
    this.recent.push(ms);
    if (this.recent.length > 40) this.recent.shift();
  }
  reset() {
    this.recent = [];
  }
  get ms(): number {
    if (this.recent.length < 8) return PACE.defaultLagMs;
    const s = [...this.recent].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * PACE.lagQuantile))];
  }
}
