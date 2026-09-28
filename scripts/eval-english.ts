// npm run eval:english — English navigation/search evaluation (local routes only; no JEV call).
// Reports intent correctness, candidate recall before any reranking, and accidental execution.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { CommandResolver } from '../src/server/commands/reducer';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { SemanticRetriever } from '../src/server/search/semantic';
import { JevClient } from '../src/server/providers/jev';
import { existsSync } from 'node:fs';

type Req = { text: string; current?: string | null; split?: 'dev' | 'test'; note?: string; expect: { kind: string; key?: string; anyOf?: string[]; notTop?: string[] } };
const argv = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const setPath = argv('set', 'fixtures/english-requests.json');
const outPath = argv('out', 'docs/ENGLISH_EVAL.md');
const set = JSON.parse(readFileSync(setPath, 'utf8')) as { requests: Req[] };
const corpus = new Corpus(loadCorpus());
const semantic = new SemanticRetriever();
await semantic.init();
const useJev = process.argv.includes('--jev');
for (const line of existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const client = useJev && process.env.OPENROUTER_API_KEY ? new JevClient('openrouter', process.env.OPENROUTER_API_KEY) : null;
if (useJev && !client) throw new Error('--jev needs OPENROUTER_API_KEY in .env');
const resolver = new CommandResolver(corpus, semantic, client);

const rows: string[] = [];
const pctl = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))].toFixed(1) : '—');
const stats: Record<string, { n: number; ok: number }> = { dev: { n: 0, ok: 0 }, test: { n: 0, ok: 0 }, all: { n: 0, ok: 0 } };
let top1 = 0;
let wrongTop = 0;
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
    const topKey = res.kind === 'candidates' ? res.cards[0]?.key : null;
    if (topKey && want.has(topKey)) top1++;
    const badTop = !!topKey && (r.expect.notTop ?? []).includes(topKey);
    if (badTop) wrongTop++;
    ok = res.kind === 'candidates' && fr !== null && !badTop;
    detail = (badTop ? `**wrong-context first card ${topKey}**; ` : '') + `lexical rank ${lr ?? '>6236'}${tr.semantic.length ? `, semantic rank ${sr ?? '>30'}` : ''}; shown cards (top 5): ${fr !== null && fr <= 5 ? `yes (#${fr})` : 'no'}; JEV shortlist (top 24): ${fr ? 'yes' : 'no'}`;
  }
  const split = r.split ?? 'all';
  stats[split].n++;
  if (ok) stats[split].ok++;
  rows.push(`| ${split} | ${r.text} | ${r.expect.kind}${r.expect.key ? ` ${r.expect.key}` : ''}${r.expect.anyOf ? ` (${r.expect.anyOf.join(', ')})` : ''} | ${ok ? 'pass' : '**fail**'} | ${detail}${r.note ? ` — ${r.note}` : ''} | ${ms.toFixed(1)} |`);
}
const out = [
  '# English navigation and search evaluation',
  '',
  `Generated ${new Date().toISOString()} by \`npm run eval:english -- --set ${setPath}\` (${set.requests.length} requests). ${setPath.endsWith('english-requests.json') ? "Disclosure: the rule keeping each retriever's top hit in the fused list was added after a held-out query (5:32) exposed the problem, so the held-out split is not a clean measure of that rule. " : ''}Local routes only: exact references, chapter aliases, numerals, next/previous, translation-wording${semantic.ready ? ' + meaning' : ''} retrieval${resolver ? '' : ''}. ${client ? 'JEV (live, OpenRouter Decisions) selected among the retrieved passages; the first card reflects its choice when it made one; ' : 'No JEV call was made (local retrieval is measured before any JEV reranking); '} "in JEV shortlist" means the expected ayah would be among the passages offered to JEV. Expected keys for meaning queries are illustrative, not exhaustive relevance labels.`,
  '',
  stats.all.n ? `- ${stats.all.ok}/${stats.all.n} pass.` : `- Dev split: ${stats.dev.ok}/${stats.dev.n} pass. Held-out test split: ${stats.test.ok}/${stats.test.n} pass.`,
  `- First card is an expected passage: ${top1}/${recall.n}. First card is a listed wrong-context passage: ${wrongTop}.`,
  `- Meaning search candidate recall (${recall.n} queries): lexical top-5 ${recall.lex5}, lexical top-30 ${recall.lex30}, ${semantic.ready ? `semantic top-30 ${recall.sem30}, ` : 'semantic not set up, '}fused top-5 (cards shown without JEV) ${recall.fused5}, fused top-24 (JEV shortlist) ${recall.fused24}.`,
  `- Meaning-search time on this machine (local retrieval${semantic.ready ? ' incl. query embedding' : ''}): p50 ${pctl(searchMs, 0.5)} ms, p95 ${pctl(searchMs, 0.95)} ms${semantic.status.state === 'ready' ? `; model load + warm-up ${semantic.status.warmupMs} ms at startup` : ''}.`,
  `- Ordinary speech/commentary that caused navigation: ${accidental}.`,
  '',
  '| Split | Request | Expected | Result | Detail | Local ms |',
  '|---|---|---|---|---|---|',
  ...rows,
];
mkdirSync('docs', { recursive: true });
writeFileSync(outPath, out.join('\n') + '\n');
console.log(out.slice(0, 8).join('\n'));
for (const r of rows.filter((x) => x.includes('**fail**'))) console.log(r);
