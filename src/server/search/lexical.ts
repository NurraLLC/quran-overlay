// BM25 over sanitized English translation text. Source-aware: a verse may have several search
// documents (alternative translations can be added later); results are deduplicated by verse.

export type SearchDoc = { verseIndex: number; source: string; text: string };

const STOP = new Set(
  'a an and are as at be been but by did do does for from had has have he her him his i if in into is it its me my of on or our she so that the their them then there these they this those to us was we were what when which who whom will with would you your shall not no nor upon unto indeed thus then say said'.split(
    ' ',
  ),
);
// Negations are meaning-bearing in queries about ethics; keep them out of the stop list for query parsing.
STOP.delete('not');
STOP.delete('no');

/** Small reviewed synonym list for everyday English → translation vocabulary. Not semantic coverage. */
export const SYNONYMS: Record<string, string[]> = {
  mom: ['mother'],
  mum: ['mother'],
  mother: ['mother', 'parent'],
  dad: ['father'],
  father: ['father', 'parent'],
  parent: ['parent', 'mother', 'father'],
  kind: ['good', 'kindness'],
  nice: ['good', 'kindness'],
  god: ['allah', 'lord'],
  handle: ['bear', 'burden', 'capacity'],
  cope: ['bear', 'burden', 'capacity'],
  die: ['death', 'die', 'perish'],
  dies: ['death', 'die'],
  dying: ['death'],
  everybody: ['every', 'soul'],
  everyone: ['every', 'soul'],
  hard: ['hardship', 'difficulty'],
  difficult: ['hardship', 'difficulty'],
  easy: ['ease'],
  heaven: ['paradise', 'garden', 'heaven'],
  hell: ['fire', 'hell'],
  forgive: ['forgive', 'forgiving', 'forgiveness'],
  pray: ['prayer', 'pray'],
  prayer: ['prayer'],
  charity: ['charity', 'spend', 'zakah'],
  patient: ['patience', 'patient'],
  patience: ['patience', 'patient'],
  worry: ['grieve', 'fear'],
  sad: ['grieve', 'sorrow'],
  moses: ['moses'],
  musa: ['moses'],
  isa: ['jesus'],
  jesus: ['jesus'],
  ibrahim: ['abraham'],
  abraham: ['abraham'],
  yusuf: ['joseph'],
  nuh: ['noah'],
  maryam: ['mary'],
  mary: ['mary'],
  dawud: ['david'],
  sulayman: ['solomon'],
  yunus: ['jonah'],
  firawn: ['pharaoh'],
  pharaoh: ['pharaoh'],
};

export function stem(w: string): string {
  if (w.length <= 3) return w;
  let s = w;
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (s.endsWith('es') && /(ch|sh|x|ss)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) s = s.slice(0, -1);
  if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('ly') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('ness') && s.length > 5) s = s.slice(0, -4);
  return s;
}

export function englishTerms(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/'s\b/g, '')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

export type LexicalHit = { verseIndex: number; score: number };

export class Bm25Index {
  private postings = new Map<string, Array<[number, number]>>();
  private docLen: number[] = [];
  private docVerse: number[] = [];
  private avgLen = 0;
  constructor(docs: readonly SearchDoc[], private k1 = 1.2, private b = 0.75) {
    docs.forEach((d, i) => {
      const terms = englishTerms(d.text);
      this.docLen[i] = terms.length;
      this.docVerse[i] = d.verseIndex;
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, c] of tf) {
        let p = this.postings.get(t);
        if (!p) this.postings.set(t, (p = []));
        p.push([i, c]);
      }
    });
    this.avgLen = this.docLen.reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
  }

  expand(query: string): Map<string, number> {
    const q = new Map<string, number>();
    const raw = query.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of raw) {
      if (STOP.has(w)) continue;
      q.set(stem(w), Math.max(q.get(stem(w)) ?? 0, 1));
      for (const s of SYNONYMS[w] ?? []) if (!q.has(stem(s))) q.set(stem(s), 0.6);
    }
    return q;
  }

  search(query: string, k = 30): LexicalHit[] {
    const q = this.expand(query);
    const N = this.docLen.length;
    const scores = new Map<number, number>();
    for (const [term, qw] of q) {
      const p = this.postings.get(term);
      if (!p) continue;
      const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5));
      for (const [doc, tf] of p) {
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + (this.b * this.docLen[doc]) / this.avgLen));
        scores.set(doc, (scores.get(doc) ?? 0) + qw * idf * norm);
      }
    }
    const byVerse = new Map<number, number>();
    for (const [doc, s] of scores) {
      const v = this.docVerse[doc];
      if ((byVerse.get(v) ?? -1) < s) byVerse.set(v, s);
    }
    return [...byVerse.entries()]
      .map(([verseIndex, score]) => ({ verseIndex, score }))
      .sort((a, b) => b.score - a.score || a.verseIndex - b.verseIndex)
      .slice(0, k);
  }
}
