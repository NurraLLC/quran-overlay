// Evidence for the display re-encoding (src/shared/display-encoding.ts): compare our Quran.com
// Uthmani text, re-encoded for the KFGQPC Hafs font, against QUL's own QPC-Hafs text for every
// verse present in the QUL development dump sample (data/raw/qul-dev-dump-qpc-hafs-sample.tsv,
// extracted from mini_quran_dev.sql.zip columns verse_key, text_uthmani, text_qpc_hafs).
import { existsSync, readFileSync } from 'node:fs';
import { loadCorpus } from '../src/server/corpus/load';
import { toQpcHafsEncoding } from '../src/shared/display-encoding';

const file = process.argv[2] ?? 'data/raw/qul-dev-dump-qpc-hafs-sample.tsv';
if (!existsSync(file)) {
  console.error(`Missing ${file}`);
  process.exit(1);
}
const corpus = loadCorpus();
const byKey = new Map<string, (typeof corpus.verses)[number]>(corpus.verses.map((v) => [v.key, v]));
const stripNumber = (s: string) => s.replace(/\s*[٠-٩]+\s*$/, '').trim();
const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0'));

let n = 0;
let exact = 0;
let exactIgnoringTatweel = 0;
let sourceSame = 0;
const residual = new Map<string, number>();
const examples: string[] = [];
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const [key, dumpUthmani, qpc] = line.split('\t');
  if (!key || !qpc) continue;
  const v = byKey.get(key);
  if (!v) continue;
  n++;
  if (dumpUthmani.trim() === v.arabicDisplay) sourceSame++;
  const ours = toQpcHafsEncoding(v.arabicDisplay);
  const target = stripNumber(qpc);
  if (ours === target) {
    exact++;
    exactIgnoringTatweel++;
    continue;
  }
  const a = ours.replace(/ـ/g, '');
  const b = target.replace(/ـ/g, '');
  if (a === b) {
    exactIgnoringTatweel++;
    continue;
  }
  // Characterize residual differences by multiset of codepoints.
  const count = (s: string) => cps(s).reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>());
  const ca = count(a);
  const cb = count(b);
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    const d = (cb.get(k) ?? 0) - (ca.get(k) ?? 0);
    if (d) residual.set(`${d > 0 ? 'qpc+' : 'ours+'}${k}`, (residual.get(`${d > 0 ? 'qpc+' : 'ours+'}${k}`) ?? 0) + Math.abs(d));
  }
  if (examples.length < 6) examples.push(key);
}
console.log(`verses compared: ${n} (dump Uthmani identical to our display source: ${sourceSame})`);
console.log(`re-encoded == QPC-Hafs exactly: ${exact} (${((exact / n) * 100).toFixed(2)}%)`);
console.log(`equal ignoring tatweel: ${exactIgnoringTatweel} (${((exactIgnoringTatweel / n) * 100).toFixed(2)}%)`);
console.log('residual codepoint differences:', Object.fromEntries([...residual.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)));
console.log('examples:', examples.join(' '));
