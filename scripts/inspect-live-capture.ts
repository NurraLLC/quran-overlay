// Replay private provider events locally. No provider requests; report references/times, not speech.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { buildIndex } from '../src/server/tracker/index';
import { Session } from '../src/server/sessions';
import { CommandResolver } from '../src/server/commands/reducer';
import { mapDisplayWords } from '../src/server/corpus/word-map';
import type { WireToken } from '../src/shared/transcript';
import type { Clock } from '../src/server/tracker/scheduler';

const file = process.argv[2];
if (!file) throw new Error('Usage: tsx scripts/inspect-live-capture.ts <capture.jsonl> [report.json]');
const bytes = readFileSync(file);
const records = bytes.toString('utf8').trim().split(/\r?\n/).map(l => JSON.parse(l) as { t: number; tokens: WireToken[] });
const corpus = new Corpus(loadCorpus()), ix = buildIndex(corpus.verses);
function run(partials: boolean) {
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = { now: () => now, setTimeout: (fn, ms) => { const k = ++id; timers.set(k, { at: now + ms, fn }); return k; }, clearTimeout: h => { timers.delete(h as number); } };
  const session = new Session({ corpus, ix, resolver: new CommandResolver(corpus, null, null), decisionClient: null, mode: 'hybrid', clock, setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: () => '' });
  session.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
  const verses: Array<{ t: number; key: string | null }> = [];
  let cursorChanges = 0, beforeFinalCursorChanges = 0, lastCursor = '', lastKey: string | null = null, firstCursorMs: number | null = null;
  records.forEach((r, seq) => {
    now = r.t;
    for (const [k, timer] of [...timers]) if (timer.at <= now) { timers.delete(k); timer.fn(); }
    session.handle({ type: 'transcript', captureEpoch: 1, seq, tokens: partials ? r.tokens : r.tokens.filter(t => t.isFinal), receivedAt: now });
    const d = session.display, key = d.verse?.key ?? null;
    if (key !== lastKey) { verses.push({ t: now, key }); lastKey = key; }
    const cursor = d.cursor ? `${key}:${d.cursor.from}:${d.cursor.to}` : '';
    if (cursor && cursor !== lastCursor) {
      cursorChanges++; firstCursorMs ??= now;
      if (!r.tokens.some(t => t.isFinal)) beforeFinalCursorChanges++;
    }
    lastCursor = cursor;
  });
  return { firstCursorMs, cursorChanges, updatesWithoutAnyFinalToken: beforeFinalCursorChanges, displayedVerseTimeline: verses };
}
let mapped = 0, total = 0, fullyMappedVerses = 0;
for (const v of process.argv.includes('--skip-word-map') ? [] : corpus.verses) {
  const m = mapDisplayWords(v.searchText, v.arabicDisplay);
  total += m.length; mapped += m.filter(Boolean).length;
  if (m.every(Boolean)) fullyMappedVerses++;
}
const report = { kind: 'Real saved provider-event replay; no new microphone run, no live provider, no audio-to-paint latency or accuracy ground truth', captureSha256: createHash('sha256').update(bytes).digest('hex'), records: records.length, finalizedOnly: run(false), currentHypothesis: run(true), wordMapping: total ? { mapped, total, fullyMappedVerses, totalVerses: corpus.verses.length, method: 'Exact normalized monotone token groups; unmapped words do not receive a fabricated highlight' } : null };
const destination = process.argv[3];
if (destination) { mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
