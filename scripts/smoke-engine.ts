// Developer smoke check: deterministic engine over a synthetic stream. Not a benchmark.
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { buildIndex } from '../src/server/tracker/index';
import { TrackerEngine } from '../src/server/tracker/reducer';
import { Timeline } from '../src/replay/synth';
import { TranscriptBuffer } from '../src/shared/transcript';

const corpus = new Corpus(loadCorpus());
let t0 = performance.now();
const ix = buildIndex(corpus.verses);
console.log(`index: ${ix.totalWords} words, ${ix.vocab.size} vocab, ${ix.bigrams.size} bigrams, built in ${(performance.now() - t0).toFixed(0)} ms`);

const ranges = (process.argv[2] ?? '55:10-55:20').split(',');
const tl = new Timeline();
for (const r of ranges) {
  const [a, b] = r.split('-');
  const ia = corpus.verse(a)!.index;
  const ib = corpus.verse(b ?? a)!.index;
  for (let i = ia; i <= ib; i++) tl.reciteVerse(corpus.at(i)!);
}
const buf = new TranscriptBuffer();
const eng = new TrackerEngine(ix);
let shown: string | null = null;
const times: number[] = [];
for (const ev of tl.sorted()) {
  if (ev.type !== 'result') continue;
  const r = buf.apply(ev.tokens);
  if (!r.evidenceChanged) continue;
  const out = eng.step(buf.evidence());
  times.push(out.computeMs);
  if (process.env.DEBUG_FROM && ev.t >= Number(process.env.DEBUG_FROM) && ev.t <= Number(process.env.DEBUG_TO ?? 1e9)) {
    const heard = buf.evidence().slice(-6).map((w) => w.text).join(' ');
    console.log(`  ${(ev.t / 1000).toFixed(2)}s phase=${out.phase} heard=[${heard}]`);
    for (const c of out.top.slice(0, 4)) console.log(`     ${corpus.at(c.verseIndex)!.key} ${c.relation} sc=${c.score.toFixed(2)} inV=${c.inVerse} w=${c.matchedWeight.toFixed(2)} run=${c.run} tr=${c.trailing} src=${c.source}`);
  }
  if (out.proposal) {
    eng.applyCommit(out.proposal);
    shown = corpus.at(out.proposal.verseIndex)!.key;
    const truth = [...tl.truth].reverse().find((w) => w.endMs <= ev.t)?.verseKey;
    console.log(`${(ev.t / 1000).toFixed(2)}s commit ${shown} (${out.proposal.reason}, margin ${out.proposal.margin.toFixed(2)}) truth-now=${truth}`);
  } else if (out.ask) {
    console.log(`${(ev.t / 1000).toFixed(2)}s ask ${out.ask.reason}: ${out.ask.shortlist.slice(0, 4).map((c) => corpus.at(c.verseIndex)!.key + ':' + c.score.toFixed(1)).join(' ')}`);
  }
  if (out.clear) console.log(`${(ev.t / 1000).toFixed(2)}s CLEAR`);
}
buf.flush();
times.sort((a, b) => a - b);
console.log(`steps=${times.length} p50=${times[Math.floor(times.length * 0.5)]?.toFixed(2)}ms p95=${times[Math.floor(times.length * 0.95)]?.toFixed(2)}ms final shown=${shown}`);
