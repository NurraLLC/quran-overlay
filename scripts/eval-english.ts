// npm run eval:english — English navigation/search evaluation (local routes only; no JEV call).
// Reports intent correctness, candidate recall before any reranking, and accidental execution.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { CommandResolver } from '../src/server/commands/reducer';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { SemanticRetriever } from '../src/server/search/semantic';

type Req = { text: string; current: string | null; split: 'dev' | 'test'; note?: string; expect: { kind: string; key?: string; anyOf?: string[] } };
const set = JSON.parse(readFileSync('fixtures/english-requests.json', 'utf8')) as { requests: Req[] };
const corpus = new Corpus(loadCorpus());
const semantic = new SemanticRetriever();
await semantic.init();
const resolver = new CommandResolver(corpus, semantic, null);

const rows: string[] = [];
const pctl = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))].toFixed(1) : '—');
const stats = { dev: { n: 0, ok: 0 }, test: { n: 0, ok: 0 } };
const recall = { lex5: 0, lex30: 0, sem30: 0, fused5: 0, fused24: 0, n: 0 };
const searchMs: number[] = [];
let accidental = 0;
for (const r of set.requests) {
  const current = r.current ? corpus.verse(r.current)!.index : null;
  const t0 = performance.now();
  const res = await resolver.resolve(r.text, current);
  const ms = performance.now() - t0;
  let ok = false;
  let detail = '';
  if (r.expect.kind === 'navigate') {
    ok = res.kind === 'navigate' && res.key === r.expect.key;
    detail = res.kind === 'navigate' ? res.key : res.kind;
  } else if (r.expect.kind === 'invalid_reference') {
    ok = res.kind === 'invalid_reference';
    detail = res.kind === 'invalid_reference' ? res.message : res.kind;
  } else if (r.expect.kind === 'not_navigate') {
    ok = res.kind !== 'navigate';
    if (!ok) accidental++;
    detail = res.kind;
  } else {
    const want = new Set(r.expect.anyOf);
    const tr = resolver.lastTrace!;
    const rank = (list: number[]) => {
      const i = list.findIndex((v) => want.has(corpus.at(v)!.key));
      return i < 0 ? null : i + 1;
    };
    const lexAll = resolver.bm25.search(r.text, 6236).map((h) => h.verseIndex);
    const lr = rank(lexAll);
    const sr = rank(tr.semantic);
    const fr = rank(tr.fused);
    recall.n++;
    if (lr !== null && lr <= 5) recall.lex5++;
    if (lr !== null && lr <= 30) recall.lex30++;
    if (sr !== null && sr <= 30) recall.sem30++;
    if (fr !== null) recall.fused24++;
    if (fr !== null && fr <= 5) recall.fused5++;
    searchMs.push(ms);
    ok = res.kind === 'candidates' && fr !== null;
    detail = `lexical rank ${lr ?? '>6236'}${tr.semantic.length ? `, semantic rank ${sr ?? '>30'}` : ''}; shown cards (top 5): ${fr !== null && fr <= 5 ? `yes (#${fr})` : 'no'}; JEV shortlist (top 24): ${fr ? 'yes' : 'no'}`;
  }
  stats[r.split].n++;
  if (ok) stats[r.split].ok++;
  rows.push(`| ${r.split} | ${r.text} | ${r.expect.kind}${r.expect.key ? ` ${r.expect.key}` : ''}${r.expect.anyOf ? ` (${r.expect.anyOf.join(', ')})` : ''} | ${ok ? 'pass' : '**fail**'} | ${detail}${r.note ? ` — ${r.note}` : ''} | ${ms.toFixed(1)} |`);
}
const out = [
  '# English navigation and search evaluation',
  '',
  `Generated ${new Date().toISOString()} by \`npm run eval:english\` over \`fixtures/english-requests.json\` (${set.requests.length} requests). Disclosure: the rule keeping each retriever's top hit in the fused list was added after a held-out query (5:32) exposed the problem, so the held-out split is not a clean measure of that rule. Local routes only: exact references, chapter aliases, numerals, next/previous, lexical${semantic.ready ? ' + semantic' : ''} retrieval. No JEV call was made (no key configured); "in JEV shortlist" means the expected ayah would be among the passages offered to JEV. Expected keys for meaning queries are illustrative, not exhaustive relevance labels.`,
  '',
  `- Dev split: ${stats.dev.ok}/${stats.dev.n} pass. Held-out test split: ${stats.test.ok}/${stats.test.n} pass.`,
  `- Meaning search candidate recall (${recall.n} queries): lexical top-5 ${recall.lex5}, lexical top-30 ${recall.lex30}, ${semantic.ready ? `semantic top-30 ${recall.sem30}, ` : 'semantic not set up, '}fused top-5 (cards shown without JEV) ${recall.fused5}, fused top-24 (JEV shortlist) ${recall.fused24}.`,
  `- Meaning-search time on this machine (local retrieval${semantic.ready ? ' incl. query embedding' : ''}): p50 ${pctl(searchMs, 0.5)} ms, p95 ${pctl(searchMs, 0.95)} ms${semantic.status.state === 'ready' ? `; model load + warm-up ${semantic.status.warmupMs} ms at startup` : ''}.`,
  `- Ordinary speech/commentary that caused navigation: ${accidental}.`,
  '',
  '| Split | Request | Expected | Result | Detail | Local ms |',
  '|---|---|---|---|---|---|',
  ...rows,
];
mkdirSync('docs', { recursive: true });
writeFileSync('docs/ENGLISH_EVAL.md', out.join('\n') + '\n');
console.log(out.slice(0, 8).join('\n'));
for (const r of rows.filter((x) => x.includes('**fail**'))) console.log(r);
