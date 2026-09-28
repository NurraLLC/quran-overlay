// npm run replay -- --fixture <path> --mode deterministic|hybrid|jev_required [--decisions none|simulated:350]
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { TRACKER_MODES, type TrackerMode } from '../src/server/tracker/follower';
import { buildIndex } from '../src/server/tracker/index';
import { loadFixture, pct, replay } from '../src/replay/run';

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const fixture = arg('fixture');
const mode = (arg('mode', 'deterministic') as TrackerMode) ?? 'deterministic';
if (!fixture || !TRACKER_MODES.includes(mode)) {
  console.error('Usage: npm run replay -- --fixture <path> --mode deterministic|hybrid|jev_required [--decisions none|simulated:<ms>]');
  process.exit(2);
}
const dec = arg('decisions', mode === 'deterministic' ? 'none' : 'simulated:350')!;
const decisions = dec.startsWith('simulated:') ? { kind: 'simulated' as const, latencyMs: Number(dec.split(':')[1]) } : { kind: 'none' as const };

const corpus = new Corpus(loadCorpus());
const ix = buildIndex(corpus.verses);
const loaded = loadFixture(fixture, corpus);
const r = await replay(loaded, corpus, ix, mode, decisions);
console.log(`${r.fixture} — ${r.label}\nmode ${r.mode}, decisions ${r.decisions}\n`);
for (const e of r.timeline) console.log(`${(e.t / 1000).toFixed(2).padStart(7)}s  ${e.event.padEnd(8)} ${e.key ?? ''} ${e.detail ?? ''}`);
const m = r.metrics;
console.log(`\ncommits ${m.commits}, wrong ${m.wrongCommits}, clears ${m.clears}, ayahs shown ${m.shownTransitions}/${m.transitions}`);
console.log(`onset→display p50 ${pct(m.onsetToDisplayMs, 0.5) ?? '—'} ms, p95 ${pct(m.onsetToDisplayMs, 0.95) ?? '—'} ms (assumed provider timing)`);
console.log(`words heard before display p50 ${pct(m.wordsHeardBeforeDisplay, 0.5) ?? '—'}; decision calls ${m.decisionCalls} (accepted ${m.decisionAccepted})`);
console.log(`tracker compute p50 ${pct(m.trackerComputeMs, 0.5)?.toFixed(2)} ms, p95 ${pct(m.trackerComputeMs, 0.95)?.toFixed(2)} ms (this machine)`);
if (m.expectationFailures.length) {
  console.log(`\nEXPECTATION FAILURES:\n  ${m.expectationFailures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nexpectations: pass');
