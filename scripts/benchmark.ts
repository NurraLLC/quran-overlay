// npm run benchmark -- --manifest fixtures/benchmark.json
// Replays identical provider event streams across a matrix of tracker mode × decision provider ×
// resource enrichment, over hand-authored and resource-derived fixtures. Writes
// artifacts/benchmark/results.json and docs/BENCHMARK.md. "live" decision runs make real JEV calls
// (OPENROUTER_API_KEY or TYPESAFE_API_KEY from .env) inside virtual time; they are skipped, with a
// note, when no key is configured.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { JevClient, type DecisionClient } from '../src/server/providers/jev';
import { ResourceCatalog } from '../src/server/resources/catalog';
import type { TrackerMode } from '../src/server/tracker/follower';
import { buildIndex } from '../src/server/tracker/index';
import { loadFixture, pct, replay, type ReplayResult } from '../src/replay/run';

type Run = { mode: TrackerMode; decisions: string; enrichment: boolean };
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const manifestPath = arg('manifest', 'fixtures/benchmark.json')!;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { fixtures: string[]; runs: Run[]; note?: string };

for (const line of existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
let live: DecisionClient | null = null;
try {
  if (process.env.OPENROUTER_API_KEY) live = new JevClient('openrouter', process.env.OPENROUTER_API_KEY);
  else if (process.env.TYPESAFE_API_KEY) live = new JevClient('typesafe', process.env.TYPESAFE_API_KEY);
} catch {
  live = null;
}

const corpus = new Corpus(loadCorpus());
const ix = buildIndex(corpus.verses);
const catalog = new ResourceCatalog(corpus, ix);
const files = manifest.fixtures.flatMap((f) =>
  statSync(f).isDirectory()
    ? readdirSync(f)
        .filter((x) => x.endsWith('.json') || x.endsWith('.jsonl'))
        .map((x) => path.join(f, x))
    : [f],
);
const setOf = (fx: string) => (fx.includes('scenarios-derived') ? 'resource-derived' : fx.endsWith('.jsonl') ? 'capture' : 'hand-authored');
const label = (r: Run) =>
  `${r.mode} · ${r.decisions === 'live' ? 'live JEV' : r.decisions === 'none' ? 'no decisions' : `simulated ${r.decisions.split(':')[1]} ms (not JEV)`} · enrichment ${r.enrichment ? 'on' : 'off'}`;

type Row = ReplayResult & { run: string; set: string };
const results: Row[] = [];
const skipped: string[] = [];
for (const run of manifest.runs) {
  if (run.decisions === 'live' && !live) {
    skipped.push(`${label(run)}: no JEV key configured`);
    continue;
  }
  const t0 = performance.now();
  for (const fx of files) {
    const loaded = loadFixture(fx, corpus);
    const decisions =
      run.decisions === 'none'
        ? { kind: 'none' as const }
        : run.decisions === 'live'
          ? { kind: 'client' as const, client: live! }
          : { kind: 'simulated' as const, latencyMs: Number(run.decisions.split(':')[1]) };
    const r = await replay(loaded, corpus, ix, run.mode, decisions, run.enrichment ? catalog : null);
    results.push({ ...r, run: label(run), set: setOf(fx) });
  }
  console.log(`${label(run)}: ${files.length} fixtures in ${Math.round((performance.now() - t0) / 1000)} s`);
}

mkdirSync('artifacts/benchmark', { recursive: true });
writeFileSync('artifacts/benchmark/results.json', JSON.stringify({ generatedAt: new Date().toISOString(), manifest: manifestPath, results }, null, 1));

const fmt = (n: number | null, d = 0) => (n === null ? '—' : n.toFixed(d));
function table(rows: Row[]) {
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.run, [...(by.get(r.run) ?? []), r]);
  const out = [
    '| Configuration | Runs | Ayahs shown / recited | Wrong displays | Clears | Runs failing expectations | Onset→display p50 / p95 ms | Words before display p50 | Decision calls | Outcomes | JEV p50 / p95 ms | Cost USD | Tracker p95 ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [run, rs] of by) {
    const sum = (f: (r: Row) => number) => rs.reduce((n, r) => n + f(r), 0);
    const all = (f: (r: Row) => number[]) => rs.flatMap(f);
    const outcomes = new Map<string, number>();
    for (const r of rs) for (const [k, v] of Object.entries(r.metrics.decisionOutcomes)) outcomes.set(k, (outcomes.get(k) ?? 0) + v);
    out.push(
      [
        run,
        rs.length,
        `${sum((r) => r.metrics.shownTransitions)} / ${sum((r) => r.metrics.transitions)}`,
        sum((r) => r.metrics.wrongCommits),
        sum((r) => r.metrics.clears),
        rs.filter((r) => r.metrics.expectationFailures.length).length,
        `${fmt(pct(all((r) => r.metrics.onsetToDisplayMs), 0.5))} / ${fmt(pct(all((r) => r.metrics.onsetToDisplayMs), 0.95))}`,
        fmt(pct(all((r) => r.metrics.wordsHeardBeforeDisplay), 0.5)),
        sum((r) => r.metrics.decisionCalls),
        [...outcomes].map(([k, v]) => `${k} ${v}`).join(', ') || '—',
        `${fmt(pct(all((r) => r.metrics.decisionLatencyMs), 0.5))} / ${fmt(pct(all((r) => r.metrics.decisionLatencyMs), 0.95))}`,
        sum((r) => r.metrics.decisionCostUsd).toFixed(4),
        fmt(pct(all((r) => r.metrics.trackerComputeMs), 0.95), 2),
      ]
        .map(String)
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |'),
    );
  }
  return out;
}

const lines = [
  '# Tracker replay benchmark',
  '',
  `Generated ${new Date().toISOString()} by \`npm run benchmark -- --manifest ${manifestPath}\` on this machine.`,
  '',
  '**What this measures:** identical provider event streams replayed through the real follower in virtual time, across tracker mode × decision provider × resource enrichment. **Live JEV** rows made real OpenRouter Decisions calls; each answer was delivered at start + measured wall-clock latency in virtual time.',
  '',
  '**What it does not measure:** microphone audio, Soniox recognition, or real reciters. Every stream is a corpus-derived synthetic Soniox-like token stream (final tokens 700 ms after each word, provisional 150 ms; `noisy-*` fixtures add assumed ASR error rates). JEV here judges clean or synthetically corrupted text, which is not yet evidence about real ASR output of recitation. Onset→display uses the assumed timing.',
  '',
  ...(skipped.length ? ['Skipped: ' + skipped.join('; ') + '.', ''] : []),
  '## All fixtures',
  '',
  ...table(results),
  '',
  '## Hand-authored scenarios',
  '',
  ...table(results.filter((r) => r.set === 'hand-authored')),
  '',
  '## Resource-derived scenarios',
  '',
  'Generated by `npm run fixtures:derived` from the complete exact-phrase collision index: twin openings (unknown start / anchored), near-identical ayahs differing by one word, ASR deleting that word, self-correction.',
  '',
  ...table(results.filter((r) => r.set === 'resource-derived')),
  '',
  '## Failing expectations',
  '',
  ...results.filter((r) => r.metrics.expectationFailures.length).map((r) => `- ${r.run} — ${path.basename(r.fixture)}: ${r.metrics.expectationFailures.join('; ')}`),
  '',
  '"Wrong displays" counts commits of an ayah that was not among the last 12 recited words. Zero wrong displays with more missed ayahs is a tradeoff, not an automatic improvement.',
];
mkdirSync('docs', { recursive: true });
writeFileSync('docs/BENCHMARK.md', lines.join('\n') + '\n');
console.log(lines.slice(10, 22).join('\n'));
