// npm run replay:session -- [capture.jsonl | scenario.json | folder ...]
// Replays captures or scenarios through the actual app session (confirmed follower + live cursor +
// display state) in virtual time and measures what the audience screen showed:
//   - "first word ended -> ayah on screen": from the end of each shown ayah's first recognised word
//     (provider audio clock) to the display change (capture clock; audio starts slightly later, so
//     values from real captures are upper bounds),
//   - wrong displays (scenarios only: an ayah not among the last 12 recited words' ayahs),
//   - flip-backs (screen returning to an ayah it already left; real repeats also count),
//   - blanks, and highlight gaps (word highlight vanishing while the same ayah stays up).
// Compares the live cursor's two-word and one-word advance on identical input.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { CommandResolver } from '../src/server/commands/reducer';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { Session } from '../src/server/sessions';
import type { Clock } from '../src/server/tracker/scheduler';
import { buildIndex } from '../src/server/tracker/index';
import { tokenize } from '../src/server/tracker/normalize';
import { loadFixture } from '../src/replay/run';
import { TranscriptBuffer, type WireToken } from '../src/shared/transcript';

class VClock implements Clock {
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
  advanceTo(t: number) {
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const n = this.timers[0];
      if (!n || n.at > t) break;
      this.timers.shift();
      this.t = n.at;
      n.fn();
    }
    this.t = Math.max(this.t, t);
  }
}

const corpus = new Corpus(loadCorpus());
const ix = buildIndex(corpus.verses);
const resolver = new CommandResolver(corpus, null, null);
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const onlyAdv = process.argv.includes('--one') ? [1 as const] : process.argv.includes('--two') ? [2 as const] : ([2, 1] as const);
const expand = (p: string) =>
  p.endsWith('.json') || p.endsWith('.jsonl')
    ? [p]
    : readdirSync(p)
        .filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'))
        .map((f) => path.join(p, f));
const files = args.length ? args.flatMap(expand) : expand('data/captures');
const quiet = files.length > 8;

type Result = { lat: number[]; flips: number; blanks: number; shown: string[]; wrong: string[]; gaps: number };

export async function run(file: string, advanceWords: 1 | 2): Promise<Result> {
  const clock = new VClock();
  const session = new Session({
    corpus,
    ix,
    resolver,
    decisionClient: null,
    mode: 'deterministic',
    setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' },
    overlayUrl: (v) => v,
    clock,
  });
  (session as unknown as { liveCursor: { advanceWords: 1 | 2 } }).liveCursor.advanceWords = advanceWords;
  const changes: Array<{ t: number; key: string | null }> = [];
  let last: string | null = null;
  let hadCursor = false;
  let gaps = 0;
  session.onDisplay((s) => {
    const key = s.visible ? (s.verse?.key ?? null) : null;
    const cursor = (s as unknown as { cursor: unknown }).cursor;
    if (key === last && key !== null && hadCursor && !cursor) gaps++;
    hadCursor = !!cursor;
    if (key !== last) {
      changes.push({ t: clock.now(), key });
      last = key;
    }
  });
  const fx = loadFixture(file, corpus);
  session.handle({ type: 'capture', captureEpoch: 1, event: 'starting' });
  session.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
  let seq = 0;
  for (const e of fx.events) {
    clock.advanceTo(e.t);
    if (e.type === 'result') session.handle({ type: 'transcript', captureEpoch: 1, seq: seq++, tokens: e.tokens as WireToken[], receivedAt: e.t });
    else if (e.action.kind === 'manual') session.handle({ type: 'goto', key: e.action.key });
  }
  clock.advanceTo(clock.now() + 4000);

  // First recognised word of each shown ayah, from the final transcript.
  const buf = new TranscriptBuffer();
  for (const e of fx.events) if (e.type === 'result') buf.apply(e.tokens as WireToken[]);
  buf.flush();
  const fw = buf.finals.map((w) => ({ key: tokenize(w.text)[0]?.key ?? '', end: w.endMs ?? 0 }));
  const lat: number[] = [];
  let cursor = 0;
  let flips = 0;
  let blanks = 0;
  const seen: string[] = [];
  for (const ch of changes) {
    if (ch.key === null) {
      blanks++;
      continue;
    }
    const v = corpus.verse(ch.key)!;
    if (seen.length && seen.includes(ch.key) && seen.at(-1) !== ch.key) flips++;
    seen.push(ch.key);
    const first = ix.words[ix.verseStart[v.index]];
    const second = ix.words[ix.verseStart[v.index] + 1];
    for (let i = cursor; i < fw.length; i++) {
      if (fw[i].key === first && (ix.verseLen[v.index] < 2 || fw[i + 1]?.key === second)) {
        lat.push(ch.t - fw[i].end);
        cursor = i + 1;
        break;
      }
    }
  }
  const wrong: string[] = [];
  if (fx.truth) {
    const manual = new Set(fx.events.flatMap((e) => (e.type === 'control' && e.action.kind === 'manual' ? [e.action.key] : [])));
    for (const ch of changes) {
      if (!ch.key || manual.has(ch.key)) continue;
      const recent = fx.truth.filter((w) => w.verseKey && w.startMs <= ch.t).slice(-12).map((w) => w.verseKey);
      if (!recent.includes(ch.key)) wrong.push(`${ch.key}@${(ch.t / 1000).toFixed(1)}s`);
    }
  }
  return { lat, flips, blanks, shown: seen, wrong, gaps };
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(s.length * p))] / 1000).toFixed(2) : '—';
};
for (const adv of onlyAdv) {
  const all: number[] = [];
  let flips = 0;
  let blanks = 0;
  let gaps = 0;
  const wrong: string[] = [];
  console.log(`\nlive cursor advance on ${adv} word${adv > 1 ? 's' : ''}:`);
  for (const f of files) {
    const r = await run(f, adv);
    all.push(...r.lat);
    flips += r.flips;
    blanks += r.blanks;
    gaps += r.gaps;
    wrong.push(...r.wrong.map((w) => `${path.basename(f)} ${w}`));
    if (!quiet || r.wrong.length || (process.argv.includes("--flips") && r.flips) || (process.argv.includes("--gaps") && r.gaps)) {
      console.log(`  ${path.basename(f)}: ${r.shown.join(' ')}${r.flips ? ` | flip-backs ${r.flips}` : ''}${r.blanks ? ` | blanks ${r.blanks}` : ''}${r.gaps ? ` | gaps ${r.gaps}` : ""}${r.wrong.length ? ` | WRONG ${r.wrong.join(', ')}` : ''}`);
    }
  }
  console.log(
    `  => ${files.length} files, ${all.length} ayahs: first word ended -> on screen p50 ${q(all, 0.5)} s, p90 ${q(all, 0.9)} s, best ${q(all, 0)} s; wrong ${wrong.length}; flip-backs ${flips}; blanks ${blanks}; highlight gaps ${gaps}`,
  );
}
