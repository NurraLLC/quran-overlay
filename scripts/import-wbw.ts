// npm run wbw:import
// Word-by-word English glosses from the public Quran.com API (api.quran.com/api/v4), cached under
// data/raw/quran-com-wbw/<surah>.json, then written to data/processed/wbw-en.json keyed by ayah with
// one entry per display token: the gloss of that word, or null for a standalone pause mark (ۛ ۚ …).
// An ayah is kept only when its word count matches our display text exactly, so a gloss can never
// sit under the wrong word; mismatches are reported.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Corpus, loadCorpus } from '../src/server/corpus/load';

type ApiWord = { char_type_name: string; text_qpc_hafs?: string; translation?: { text?: string } };
type ApiVerse = { verse_key: string; words: ApiWord[] };

const rawDir = path.join('data', 'raw', 'quran-com-wbw');
mkdirSync(rawDir, { recursive: true });
const corpus = new Corpus(loadCorpus());

async function chapter(n: number): Promise<ApiVerse[]> {
  const file = path.join(rawDir, `${n}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ApiVerse[];
  const out: ApiVerse[] = [];
  for (let page = 1; ; page++) {
    const url = `https://api.quran.com/api/v4/verses/by_chapter/${n}?words=true&word_fields=text_qpc_hafs&per_page=50&page=${page}&language=en`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Quran.com API ${res.status} for surah ${n} page ${page}`);
    const j = (await res.json()) as { verses: ApiVerse[]; pagination: { next_page: number | null } };
    for (const v of j.verses) out.push({ verse_key: v.verse_key, words: v.words.map((w) => ({ char_type_name: w.char_type_name, text_qpc_hafs: w.text_qpc_hafs, translation: { text: w.translation?.text } })) });
    if (!j.pagination.next_page) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  writeFileSync(file, JSON.stringify(out));
  await new Promise((r) => setTimeout(r, 150));
  return out;
}

const verses: Record<string, Array<string | null>> = {};
const LETTER = /[ء-يٱ-ۓ]/;
const mismatched: string[] = [];
for (let n = 1; n <= 114; n++) {
  for (const v of await chapter(n)) {
    const glosses = v.words.filter((w) => w.char_type_name === 'word').map((w) => (w.translation?.text ?? '').trim());
    const tokens = corpus.verse(v.verse_key)?.arabicDisplay.split(/\s+/).filter(Boolean) ?? [];
    const words = tokens.filter((t) => LETTER.test(t)).length;
    if (glosses.length !== words || glosses.some((g) => !g)) mismatched.push(`${v.verse_key} (${glosses.length} glosses, ${words} words)`);
    else {
      let k = 0;
      verses[v.verse_key] = tokens.map((t) => (LETTER.test(t) ? glosses[k++] : null));
    }
  }
  process.stdout.write(`${n} `);
}
const out = path.join('data', 'processed', 'wbw-en.json');
writeFileSync(out, JSON.stringify({ source: 'Quran.com API v4 word-by-word English', attribution: 'Word by word: Quran.com', verses }));
console.log(`\nwrote ${out}: ${Object.keys(verses).length} ayahs aligned, ${mismatched.length} skipped${mismatched.length ? `: ${mismatched.slice(0, 12).join(', ')}${mismatched.length > 12 ? ' …' : ''}` : ''}`);
