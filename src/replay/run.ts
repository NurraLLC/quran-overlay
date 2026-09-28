// Replay a provider event stream through the real follower in virtual time and score it.
// Inputs: a scenario (corpus-derived synthetic stream, labelled) or a capture (.jsonl of real
// provider results, when diagnostic capture is available). Outputs a timeline and metrics.

import { readFileSync } from 'node:fs';
import type { Corpus } from '../server/corpus/load';
import { SimulatedDecisionClient } from '../server/providers/decisions';
import type { DecisionClient } from '../server/providers/jev';
import { RecitationFollower, type FollowerEvent, type TrackerMode } from '../server/tracker/follower';
import type { CorpusIndex } from '../server/tracker/index';
import type { Clock } from '../server/tracker/scheduler';
import { TranscriptBuffer, type WireToken } from '../shared/transcript';
import { DEFAULT_TIMING, NO_ERRORS, rng, Timeline, type ReplayEvent, type SynthErrors, type SynthTiming, type TruthWord } from './synth';

export type ScenarioStep =
  | { recite: string; words?: [number, number] }
  | { pause: number }
  | { say: string; as?: string }
  | { control: { kind: 'manual'; key: string } | { kind: 'stop' } | { kind: 'hold'; on: boolean } | { kind: 'resume' } };

export type Scenario = {
  name: string;
  description: string;
  synthetic: true;
  seed?: number;
  timing?: Partial<SynthTiming>;
  errors?: Partial<SynthErrors>;
  script: ScenarioStep[];
  expect?: { finalDisplay?: string | null; mustShow?: string[]; mustNotShow?: string[]; maxClears?: number };
};

export type Loaded = { name: string; events: ReplayEvent[]; truth: TruthWord[] | null; scenario: Scenario | null; label: string };

class ReplayClock implements Clock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  async advanceTo(t: number) {
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > t) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    this.t = Math.max(this.t, t);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }
  wait(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const id = this.setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        this.clearTimeout(id);
        reject(Object.assign(new Error('aborted'), { code: 'CANCELLED' }));
      });
    });
  }
}

export function loadFixture(path: string, corpus: Corpus): Loaded {
  if (path.endsWith('.jsonl')) {
    const events = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ReplayEvent);
    return { name: path, events, truth: null, scenario: null, label: 'capture (provider events)' };
  }
  const sc = JSON.parse(readFileSync(path, 'utf8')) as Scenario;
  return { ...buildScenario(sc, corpus), name: sc.name };
}

export function buildScenario(sc: Scenario, corpus: Corpus): Omit<Loaded, 'name'> {
  const random = rng(sc.seed ?? 7);
  const vocab = [...new Set(corpus.verses.slice(0, 600).flatMap((v) => v.searchText.split(' ')))].map((w) => w.replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, ''));
  const tl = new Timeline({ ...DEFAULT_TIMING, ...sc.timing }, { ...NO_ERRORS, ...sc.errors }, random, vocab);
  for (const step of sc.script) {
    if ('recite' in step) {
      const [a, b] = step.recite.split('-');
      const from = corpus.verse(a);
      const to = corpus.verse(b ?? a);
      if (!from || !to) throw new Error(`Unknown reference in scenario ${sc.name}: ${step.recite}`);
      for (let i = from.index; i <= to.index; i++) tl.reciteVerse(corpus.at(i)!, i === from.index && i === to.index ? step.words : undefined);
    } else if ('pause' in step) tl.pause(step.pause);
    else if ('say' in step) tl.speak(step.say.split(/\s+/), step.as ?? null);
    else tl.control(step.control);
  }
  return { events: tl.sorted(), truth: tl.truth, scenario: sc, label: 'synthetic (corpus-derived; assumed provider timing and error rates)' };
}

export type ReplayResult = {
  fixture: string;
  label: string;
  mode: TrackerMode;
  decisions: string;
  timeline: Array<{ t: number; event: string; key: string | null; detail?: string }>;
  metrics: {
    commits: number;
    wrongCommits: number;
    wrong: Array<{ t: number; key: string }>;
    clears: number;
    transitions: number;
    shownTransitions: number;
    /** From the end of the first word of each recited ayah to its first display (assumed provider timing). */
    onsetToDisplayMs: number[];
    wordsHeardBeforeDisplay: number[];
    decisionCalls: number;
    decisionAccepted: number;
    trackerComputeMs: number[];
    expectationFailures: string[];
  };
};

export async function replay(
  loaded: Loaded,
  corpus: Corpus,
  ix: CorpusIndex,
  mode: TrackerMode,
  decisions: { kind: 'none' } | { kind: 'simulated'; latencyMs: number } | { kind: 'client'; client: DecisionClient },
): Promise<ReplayResult> {
  const clock = new ReplayClock();
  const client: DecisionClient | null =
    decisions.kind === 'none' ? null : decisions.kind === 'client' ? decisions.client : new SimulatedDecisionClient(decisions.latencyMs, (ms, s) => clock.wait(ms, s));
  const timeline: ReplayResult['timeline'] = [];
  let shown: number | null = null;
  const onEvent = (e: FollowerEvent) => {
    if (e.kind === 'commit') {
      shown = e.verseIndex;
      timeline.push({ t: clock.now(), event: 'commit', key: corpus.at(e.verseIndex)!.key, detail: `${e.reason} via ${e.via}` });
    } else if (e.kind === 'clear') {
      shown = null;
      timeline.push({ t: clock.now(), event: 'clear', key: null });
    } else if (e.kind === 'decision') {
      timeline.push({ t: clock.now(), event: 'decision', key: null, detail: `${e.record.reason}: ${e.record.outcome} (${Math.round(e.record.latencyMs)} ms)` });
    }
  };
  const f = new RecitationFollower(ix, corpus.id, 'replay', client, mode, onEvent, clock);
  let buf = new TranscriptBuffer();
  let epoch = 1;
  f.newCapture(epoch);
  let stopped = false;
  for (const ev of loaded.events) {
    await clock.advanceTo(ev.t);
    if (ev.type === 'control') {
      const a = ev.action;
      if (a.kind === 'manual') {
        const v = corpus.verse(a.key)!;
        f.seek(v.index);
        shown = v.index;
        timeline.push({ t: clock.now(), event: 'manual', key: a.key });
      } else if (a.kind === 'stop') {
        f.stop();
        stopped = true;
        timeline.push({ t: clock.now(), event: 'stop', key: null });
      } else if (a.kind === 'start') {
        epoch++;
        buf = new TranscriptBuffer();
        f.newCapture(epoch);
        stopped = false;
      }
      continue;
    }
    if (stopped) continue;
    const r = buf.apply(ev.tokens as WireToken[]);
    f.onTranscript(buf.evidence(), buf.heardText(1).provisional, r.evidenceChanged);
  }
  await clock.advanceTo(clock.now() + 3000);

  // ---------- scoring against truth (scenarios only) ----------
  const commits = timeline.filter((x) => x.event === 'commit');
  const truth = loaded.truth;
  const wrong: Array<{ t: number; key: string }> = [];
  const onset: number[] = [];
  const wordsBefore: number[] = [];
  let transitions = 0;
  let shownTransitions = 0;
  if (truth) {
    const manualKeys = new Set(timeline.filter((x) => x.event === 'manual').map((x) => x.key));
    for (const c of commits) {
      // A commit is correct if its verse was recited within the recent past (ends ≤ commit time,
      // last 12 words) — display naturally lags the voice.
      const recent = truth.filter((w) => w.verseKey && w.endMs <= c.t).slice(-12).map((w) => w.verseKey);
      if (!recent.includes(c.key!) && !manualKeys.has(c.key)) wrong.push({ t: c.t, key: c.key! });
    }
    const firsts = new Map<string, TruthWord[]>();
    for (const w of truth) if (w.verseKey) firsts.set(w.verseKey, [...(firsts.get(w.verseKey) ?? []), w]);
    let prev: string | null = null;
    for (const w of truth) {
      if (!w.verseKey || w.verseKey === prev) continue;
      prev = w.verseKey;
      transitions++;
      const words = firsts.get(w.verseKey)!;
      const next = truth.find((x) => x.startMs > words[words.length - 1].endMs && x.verseKey !== w.verseKey);
      const windowEnd = next ? next.endMs + 5000 : Infinity;
      const c = commits.find((x) => x.key === w.verseKey && x.t >= w.startMs && x.t <= windowEnd);
      if (!c) continue;
      shownTransitions++;
      onset.push(c.t - words[0].endMs);
      wordsBefore.push(words.filter((x) => x.endMs <= c.t).length);
    }
  }
  const failures: string[] = [];
  const ex = loaded.scenario?.expect;
  const shownKeys = commits.map((c) => c.key);
  if (ex) {
    const finalKey = shown === null ? null : corpus.at(shown)!.key;
    if (ex.finalDisplay !== undefined && ex.finalDisplay !== finalKey) failures.push(`final display ${finalKey} ≠ expected ${ex.finalDisplay}`);
    for (const k of ex.mustShow ?? []) if (!shownKeys.includes(k)) failures.push(`never showed ${k}`);
    for (const k of ex.mustNotShow ?? []) if (shownKeys.includes(k)) failures.push(`showed forbidden ${k}`);
    const clears = timeline.filter((x) => x.event === 'clear').length;
    if (ex.maxClears !== undefined && clears > ex.maxClears) failures.push(`${clears} clears > ${ex.maxClears}`);
  }
  if (wrong.length) failures.push(`${wrong.length} wrong commit(s): ${wrong.map((w) => w.key).join(', ')}`);

  return {
    fixture: loaded.name,
    label: loaded.label,
    mode,
    decisions: decisions.kind === 'simulated' ? `simulated (${decisions.latencyMs} ms; NOT JEV)` : decisions.kind === 'client' ? `live ${decisions.client.gateway}` : 'none',
    timeline,
    metrics: {
      commits: commits.length,
      wrongCommits: wrong.length,
      wrong,
      clears: timeline.filter((x) => x.event === 'clear').length,
      transitions,
      shownTransitions,
      onsetToDisplayMs: onset,
      wordsHeardBeforeDisplay: wordsBefore,
      decisionCalls: f.stats?.started ?? 0,
      decisionAccepted: f.decisions.filter((d) => d.outcome === 'accepted').length,
      trackerComputeMs: [...f.computeMs],
      expectationFailures: failures,
    },
  };
}

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
