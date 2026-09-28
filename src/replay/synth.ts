// Corpus-derived synthetic Soniox-like event streams for replay tests.
// These supplement real audio captures; they are NOT evidence of ASR accuracy or live latency.
// Timing and error parameters are assumptions stated in each fixture.

import type { Verse } from '../shared/corpus-types';
import type { WireToken } from '../shared/transcript';

export type SynthTiming = {
  /** Base spoken duration of a word in ms, plus per-letter increment. */
  wordBaseMs: number;
  perLetterMs: number;
  /** Gap between words within an ayah and pause between ayahs. */
  wordGapMs: number;
  ayahPauseMs: number;
  /** When the provider first shows a word provisionally, and when it finalizes it (after word end). */
  provisionalLagMs: number;
  finalLagMs: number;
};

export const DEFAULT_TIMING: SynthTiming = {
  wordBaseMs: 260,
  perLetterMs: 55,
  wordGapMs: 60,
  ayahPauseMs: 900,
  provisionalLagMs: 150,
  finalLagMs: 700,
};

export type SynthErrors = { substitute: number; drop: number; insert: number; letterEdit: number };
export const NO_ERRORS: SynthErrors = { substitute: 0, drop: 0, insert: 0, letterEdit: 0 };

export type TruthWord = { text: string; startMs: number; endMs: number; verseKey: string | null };

export type ReplayEvent =
  | { t: number; type: 'result'; tokens: WireToken[] }
  | { t: number; type: 'control'; action: ControlAction };

export type ControlAction =
  | { kind: 'manual'; key: string }
  | { kind: 'hold'; on: boolean }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'start' }
  | { kind: 'mode'; mode: 'deterministic' | 'hybrid' | 'jev_required' };

/** Deterministic PRNG so fixtures are reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** ASR-style surface form: diacritics and Quranic marks removed, letters kept. */
export function asrSurface(word: string): string {
  return word.normalize('NFC').replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '');
}

export class Timeline {
  t = 0;
  truth: TruthWord[] = [];
  events: ReplayEvent[] = [];
  constructor(
    readonly timing: SynthTiming = DEFAULT_TIMING,
    readonly errors: SynthErrors = NO_ERRORS,
    readonly random: () => number = rng(7),
    readonly vocabulary: string[] = [],
  ) {}

  private duration(word: string) {
    return this.timing.wordBaseMs + this.timing.perLetterMs * word.length;
  }

  /** Speak words; each gets a provisional result then a final result. */
  speak(words: string[], verseKey: string | null) {
    for (const original of words) {
      const r = this.random();
      let spoken: string | null = original;
      if (verseKey && r < this.errors.drop) spoken = null;
      else if (verseKey && r < this.errors.drop + this.errors.substitute && this.vocabulary.length) {
        spoken = this.vocabulary[Math.floor(this.random() * this.vocabulary.length)];
      } else if (verseKey && r < this.errors.drop + this.errors.substitute + this.errors.letterEdit && original.length > 3) {
        const i = 1 + Math.floor(this.random() * (original.length - 2));
        spoken = original.slice(0, i) + original.slice(i + 1);
      }
      if (spoken !== null) this.emitWord(spoken, verseKey);
      if (verseKey && this.random() < this.errors.insert && this.vocabulary.length) {
        this.emitWord(this.vocabulary[Math.floor(this.random() * this.vocabulary.length)], null);
      }
    }
  }

  /** Recite a verse (or a word range of it); `omit` drops word positions (simulated ASR deletions). */
  reciteVerse(v: Verse, range?: [number, number], omit?: number[]) {
    const words = v.searchText.split(/\s+/).map(asrSurface).filter((w) => /[ء-ي]/.test(w));
    const kept = omit?.length ? words.filter((_, i) => !omit.includes(i)) : words;
    const slice = range ? kept.slice(range[0], range[1]) : kept;
    this.speak(slice, v.key);
    this.t += this.timing.ayahPauseMs - this.timing.wordGapMs;
  }

  pause(ms: number) {
    this.t += ms;
  }

  control(action: ControlAction) {
    this.events.push({ t: this.t, type: 'control', action });
  }

  private readonly spoken: Array<{ final: WireToken[]; prov: WireToken[]; partialT: number | null; provT: number; finalT: number }> = [];

  private emitWord(word: string, verseKey: string | null) {
    const start = this.t;
    const end = start + this.duration(word);
    this.truth.push({ text: word, startMs: start, endMs: end, verseKey });
    const cut = word.length > 4 ? Math.ceil(word.length / 2) : word.length;
    const pieces = [' ' + word.slice(0, cut), word.slice(cut)].filter((p) => p.trim());
    const tokens = (isFinal: boolean): WireToken[] =>
      pieces.map((p, i) => ({
        text: p,
        isFinal,
        startMs: i === 0 ? start : Math.round((start + end) / 2),
        endMs: i === pieces.length - 1 ? end : Math.round((start + end) / 2),
        confidence: 0.9,
      }));
    this.spoken.push({
      final: tokens(true),
      prov: tokens(false),
      // Like Soniox, a longer word first appears half-formed while it is still being spoken.
      partialT: pieces.length > 1 ? Math.round((start + end) / 2) + this.timing.provisionalLagMs : null,
      provT: end + this.timing.provisionalLagMs,
      finalT: end + this.timing.finalLagMs,
    });
    this.t = end + this.timing.wordGapMs;
  }

  /**
   * Provider results in Soniox's protocol: each result carries newly final tokens exactly once plus
   * the *whole* current provisional suffix (every word heard but not yet final), merged with control
   * events in time order (controls first on ties).
   */
  sorted(): ReplayEvent[] {
    const times = new Set<number>();
    for (const w of this.spoken) {
      if (w.partialT !== null) times.add(w.partialT);
      times.add(w.provT);
      times.add(w.finalT);
    }
    const results: ReplayEvent[] = [];
    for (const t of [...times].sort((a, b) => a - b)) {
      const tokens: WireToken[] = [];
      for (const w of this.spoken) if (w.finalT === t) tokens.push(...w.final);
      for (const w of this.spoken) {
        if (w.finalT <= t) continue;
        if (w.provT <= t) tokens.push(...w.prov);
        else if (w.partialT !== null && w.partialT <= t) tokens.push(w.prov[0]);
      }
      results.push({ t, type: 'result', tokens });
    }
    const controls = this.events.map((e, i) => ({ e, i }));
    return [...controls.map((x) => ({ e: x.e, k: 0, i: x.i })), ...results.map((e, i) => ({ e, k: 1, i }))]
      .sort((a, b) => a.e.t - b.e.t || a.k - b.k || a.i - b.i)
      .map((x) => x.e);
  }
}
