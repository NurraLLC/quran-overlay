// npm run benchmark -- --manifest fixtures/benchmark.json
// Replays identical provider event streams across tracker modes and writes
// artifacts/benchmark/results.json and docs/BENCHMARK.md. Decision latency in hybrid/jev_required is
// SIMULATED unless a live client is configured and --live is passed; it measures structure
// (calls, added delay), not JEV accuracy.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import type { TrackerMode } from '../src/server/tracker/follower';
import { buildIndex } from '../src/server/tracker/index';
import { loadFixture, pct, replay, type ReplayResult } from '../src/replay/run';

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const manifestPath = arg('manifest', 'fixtures/benchmark.json')!;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { fixtures: string[]; modes: TrackerMode[]; decisions: Record<string, string>; note?: string };

const corpus = new Corpus(loadCorpus());
const ix = buildIndex(corpus.verses);
const results: ReplayResult[] = [];
for (const fx of manifest.fixtures) {
  const loaded = loadFixture(fx, corpus);
  for (const mode of manifest.modes) {
    const spec = manifest.decisions[mode] ?? 'none';
    const decisions = spec.startsWith('simulated:') ? { kind: 'simulated' as const, latencyMs: Number(spec.split(':')[1]) } : { kind: 'none' as const };
    results.push(await replay(loaded, corpus, ix, mode, decisions));
  }
}

type Row = { mode: TrackerMode; decisions: string; runs: number; transitions: number; shown: number; wrong: number; clears: number; expectFail: number; onset: number[]; words: number[]; calls: number; compute: number[] };
const rows = new Map<TrackerMode, Row>();
for (const r of results) {
  const row = rows.get(r.mode) ?? { mode: r.mode, decisions: r.decisions, runs: 0, transitions: 0, shown: 0, wrong: 0, clears: 0, expectFail: 0, onset: [], words: [], calls: 0, compute: [] };
  row.runs++;
  row.transitions += r.metrics.transitions;
  row.shown += r.metrics.shownTransitions;
  row.wrong += r.metrics.wrongCommits;
  row.clears += r.metrics.clears;
  row.expectFail += r.metrics.expectationFailures.length ? 1 : 0;
  row.onset.push(...r.metrics.onsetToDisplayMs);
  row.words.push(...r.metrics.wordsHeardBeforeDisplay);
  row.calls += r.metrics.decisionCalls;
  row.compute.push(...r.metrics.trackerComputeMs);
  rows.set(r.mode, row);
}

mkdirSync('artifacts/benchmark', { recursive: true });
writeFileSync('artifacts/benchmark/results.json', JSON.stringify({ generatedAt: new Date().toISOString(), manifest: manifestPath, note: manifest.note, results }, null, 1));

const fmt = (n: number | null, d = 0) => (n === null ? '—' : n.toFixed(d));
const lines: string[] = [];
lines.push('# Tracker replay benchmark', '');
lines.push(`Generated ${new Date().toISOString()} by \`npm run benchmark -- --manifest ${manifestPath}\` on this machine.`, '');
lines.push('**What this is:** the three tracker modes replayed over identical provider event streams in virtual time.');
lines.push('**What this is not:** a live latency or accuracy result. All streams below are corpus-derived synthetic Soniox-like token streams with assumed timing (final tokens 700 ms after each word, provisional 150 ms) and, for the `noisy-*` fixtures, assumed ASR error rates. Decision calls in `hybrid` and `jev_required` use a simulated client with a fixed 350 ms latency that always picks the top-ranked local candidate — it is **not JEV** and says nothing about JEV accuracy on Arabic. No microphone, Soniox, JEV or OBS measurement is included.', '');
lines.push('| Mode | Decisions | Runs | Ayahs shown / recited | Wrong displays | Clears | Runs failing expectations | Onset→display p50 / p95 (ms, assumed timing) | Words heard before display p50 | Decision calls | Tracker compute p50 / p95 (ms, measured) |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows.values()) {
  lines.push(`| ${r.mode} | ${r.decisions} | ${r.runs} | ${r.shown} / ${r.transitions} | ${r.wrong} | ${r.clears} | ${r.expectFail} | ${fmt(pct(r.onset, 0.5))} / ${fmt(pct(r.onset, 0.95))} | ${fmt(pct(r.words, 0.5))} | ${r.calls} | ${fmt(pct(r.compute, 0.5), 2)} / ${fmt(pct(r.compute, 0.95), 2)} |`);
}
lines.push('', '## Per fixture', '', '| Fixture | Mode | Shown / recited | Wrong | Clears | Onset→display p50 (ms) | Calls | Expectations |', '|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const m = r.metrics;
  lines.push(`| ${r.fixture} | ${r.mode} | ${m.shownTransitions} / ${m.transitions} | ${m.wrongCommits} | ${m.clears} | ${fmt(pct(m.onsetToDisplayMs, 0.5))} | ${m.decisionCalls} | ${m.expectationFailures.length ? m.expectationFailures.join('; ') : 'pass'} |`);
}
lines.push('', 'Onset→display is measured from the end of the first word of each recited ayah to the moment that ayah is first shown, using the synthetic stream\'s assumed provider timing; it includes waiting for enough distinguishing words. "Wrong displays" counts commits of an ayah that was not among the last 12 recited words. Tracker compute is real wall-clock time on this machine per material update.');
mkdirSync('docs', { recursive: true });
writeFileSync('docs/BENCHMARK.md', lines.join('\n') + '\n');
console.log(lines.slice(0, 12).join('\n'));
