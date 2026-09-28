// npm run fixtures:derived — resource-derived tracking scenarios (seeded, reproducible), written to
// fixtures/scenarios-derived/. Cases come from the complete exact-phrase collision index rather than
// hand-picking: twin openings (unknown start and anchored), near-identical ayahs differing by one
// word, ASR deleting that distinguishing word, and self-correction. Synthetic text streams only.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { buildIndex } from '../src/server/tracker/index';
import { buildPhraseIndex } from '../src/server/resources/phrases';
import { rng } from '../src/replay/synth';
import type { Scenario } from '../src/replay/run';

const OUT = 'fixtures/scenarios-derived';
const corpus = new Corpus(loadCorpus());
const ix = buildIndex(corpus.verses);
const phrases = buildPhraseIndex(ix);
const random = rng(20260928);
const key = (i: number) => corpus.at(i)!.key;
const words = (i: number) => ix.words.slice(ix.verseStart[i], ix.verseStart[i] + ix.verseLen[i]);
const sameSurah = (a: number, b: number) => corpus.at(a)!.surah === corpus.at(b)!.surah;
const pick = <T>(xs: T[], n: number) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};

// Twin openings: A and B start with the same 4 words; A has a following ayah in the same surah.
const twinOpen: Array<[number, number]> = [];
for (const [a, ns] of phrases.neighbours) {
  if (a + 1 >= corpus.verses.length || !sameSurah(a, a + 1) || a === 0 || !sameSurah(a - 1, a)) continue;
  const wa = words(a);
  if (wa.length < 6) continue;
  for (const b of ns.keys()) {
    const wb = words(b);
    if (wb.slice(0, 4).join(' ') === wa.slice(0, 4).join(' ') && wb.join(' ') !== wa.join(' ')) {
      twinOpen.push([a, b]);
      break;
    }
  }
}
// Near-identical: same length, exactly one differing word (not the last), both with a predecessor.
const oneWord: Array<[number, number, number]> = [];
for (const [a, ns] of phrases.neighbours) {
  const wa = words(a);
  if (wa.length < 5 || a === 0 || !sameSurah(a - 1, a)) continue;
  for (const b of ns.keys()) {
    if (b < a) continue;
    const wb = words(b);
    if (wb.length !== wa.length) continue;
    const diff = wa.map((w, i) => (w === wb[i] ? -1 : i)).filter((i) => i >= 0);
    if (diff.length === 1 && diff[0] < wa.length - 1) oneWord.push([a, b, diff[0]]);
  }
}

const scenarios: Scenario[] = [];
const add = (name: string, description: string, script: Scenario['script'], expect: Scenario['expect']) =>
  scenarios.push({ name, description, synthetic: true, seed: 7, script, expect });

for (const [a, b] of pick(twinOpen, 8)) {
  add(`twin-open-unknown-${key(a).replace(':', '-')}`, `Unknown start on ${key(a)}, whose first four words also open ${key(b)}; continues into ${key(a + 1)}.`, [{ recite: `${key(a)}-${key(a + 1)}` }], { mustShow: [key(a + 1)], mustNotShow: [key(b)] });
  add(`twin-open-anchored-${key(a).replace(':', '-')}`, `${key(a - 1)} then ${key(a)} (shares its opening with ${key(b)}) then ${key(a + 1)}.`, [{ recite: `${key(a - 1)}-${key(a + 1)}` }], { mustShow: [key(a), key(a + 1)], mustNotShow: [key(b)] });
}
for (const [a, b, d] of pick(oneWord, 6)) {
  add(`one-word-${key(a).replace(':', '-')}`, `${key(a)} and ${key(b)} differ only at word ${d + 1}; recited after ${key(a - 1)}.`, [{ recite: `${key(a - 1)}-${key(a)}` }], { mustShow: [key(a)], mustNotShow: [key(b)] });
  add(`one-word-dropped-${key(a).replace(':', '-')}`, `Unknown start on ${key(a)} with ASR deleting its only distinguishing word (word ${d + 1}) versus ${key(b)}: the evidence cannot separate them.`, [{ recite: key(a), omit: [d] }], { mustNotShow: [key(b)] });
}
// The recited pair must occur only once: from an unknown start an identical pair elsewhere (e.g. the
// 26:8–9 refrain repeated eight times in Ash-Shu'ara) can only be answered by abstaining.
const pairText = (v: number) => [...words(v), '|', ...words(v + 1)].join(' ');
const pairCounts = new Map<string, number>();
for (let v = 0; v + 1 < corpus.verses.length; v++) pairCounts.set(pairText(v), (pairCounts.get(pairText(v)) ?? 0) + 1);
for (const a of pick([...phrases.neighbours.keys()].filter((v) => ix.verseLen[v] >= 8 && v + 1 < corpus.verses.length && sameSurah(v, v + 1) && pairCounts.get(pairText(v)) === 1), 4)) {
  add(`self-correction-${key(a).replace(':', '-')}`, `Starts ${key(a)}, stops after 4 words, restarts it from the beginning, continues to ${key(a + 1)}.`, [{ recite: key(a), words: [0, 4] }, { pause: 800 }, { recite: `${key(a)}-${key(a + 1)}` }], { mustShow: [key(a + 1)] });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const s of scenarios) writeFileSync(`${OUT}/${s.name}.json`, JSON.stringify(s, null, 2) + '\n');
console.log(`twin openings available ${twinOpen.length}, one-word pairs ${oneWord.length}; wrote ${scenarios.length} scenarios to ${OUT}`);
