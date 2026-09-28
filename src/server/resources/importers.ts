// Importers for selected QUL exports, written against the exporter source in work/qul/lib/exporter
// (export_matching_ayah.rb, export_mutashabihat.rb, export_topics.rb, export_ayah_theme.rb,
// export_quran_ayah_script.rb, export_quran_word_script.rb, export_quran_meta_data.rb).
// Files are identified by content, never by filename. Every row is validated against the complete
// corpus; invalid keys, impossible ranges and dangling joins are rejected and counted, never
// silently dropped or repaired. Original bytes are kept unchanged by the import script.

import { readFileSync } from 'node:fs';
import type { Corpus } from '../corpus/load';

export type ImportKind =
  | 'similar-ayah'
  | 'mutashabihat-phrases'
  | 'mutashabihat-ayah-phrases'
  | 'topics'
  | 'themes'
  | 'qpc-ayah-text'
  | 'qpc-word-text'
  | 'ayah-metadata'
  | 'division';

export type Rejection = { row: string; reason: string };

export type Imported<T> = {
  kind: ImportKind;
  resourceId: string;
  category: string;
  title: string;
  data: T;
  coverage: { rows: number; verseKeys: number; rejectedRows: number };
  rejections: Rejection[];
  notes: string[];
};

const MAX_REJECTIONS_KEPT = 200;

class Rejects {
  list: Rejection[] = [];
  count = 0;
  add(row: string, reason: string) {
    this.count++;
    if (this.list.length < MAX_REJECTIONS_KEPT) this.list.push({ row, reason });
  }
}

function validKey(corpus: Corpus, key: unknown): number | null {
  if (typeof key !== 'string') return null;
  const v = corpus.verse(key.trim());
  return v ? v.index : null;
}

function validRanges(raw: unknown, maxWord: number | null): Array<[number, number]> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<[number, number]> = [];
  for (const r of raw) {
    // Singleton ranges are exported as [position]; ranges as [from, to].
    if (!Array.isArray(r) || r.length < 1 || r.length > 2) return null;
    const from = Number(r[0]);
    const to = Number(r.length === 2 ? r[1] : r[0]);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return null;
    if (maxWord !== null && to > maxWord) return null;
    out.push([from, to]);
  }
  return out;
}

// ---------- detection ----------

export function detect(file: string): { kind: ImportKind; format: 'json' | 'sqlite' } | null {
  const head = readFileSync(file).subarray(0, 16).toString('latin1');
  if (head.startsWith('SQLite format 3')) {
    const tables = sqliteTables(file);
    if (tables.includes('similar_ayahs')) return { kind: 'similar-ayah', format: 'sqlite' };
    if (tables.includes('topics')) return { kind: 'topics', format: 'sqlite' };
    if (tables.includes('themes')) return { kind: 'themes', format: 'sqlite' };
    if (tables.includes('words')) return { kind: 'qpc-word-text', format: 'sqlite' };
    for (const t of ['juz', 'hizb', 'rub', 'manzil']) if (tables.includes(t)) return { kind: 'division', format: 'sqlite' };
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const entries = Object.entries(json as Record<string, unknown>);
  if (!entries.length) return null;
  const [k, v] = entries[0];
  if (Array.isArray(v) && /^\d+:\d+$/.test(k)) {
    if (v.length === 0 || (typeof v[0] === 'object' && v[0] && 'matched_ayah_key' in v[0])) return { kind: 'similar-ayah', format: 'json' };
    if (typeof v[0] === 'number') return { kind: 'mutashabihat-ayah-phrases', format: 'json' };
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ('source' in o && 'ayah' in o) return { kind: 'mutashabihat-phrases', format: 'json' };
    if ('location' in o && 'word' in o && 'text' in o) return { kind: 'qpc-word-text', format: 'json' };
    if ('verse_key' in o && 'words_count' in o && 'surah_number' in o) return { kind: 'ayah-metadata', format: 'json' };
    if ('verse_key' in o && 'text' in o && 'ayah' in o) return { kind: 'qpc-ayah-text', format: 'json' };
    if ('first_verse_key' in o && 'last_verse_key' in o) return { kind: 'division', format: 'json' };
  }
  return null;
}

type SqliteRow = Record<string, unknown>;
function sqliteDb(file: string) {
  // node:sqlite is built into Node 22.5+ (experimental flag-free in 24); loaded lazily.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}
function sqliteTables(file: string): string[] {
  const db = sqliteDb(file);
  try {
    return (db.prepare("select name from sqlite_master where type='table'").all() as SqliteRow[]).map((r) => String(r.name));
  } finally {
    db.close();
  }
}
function sqliteAll(file: string, table: string): SqliteRow[] {
  const db = sqliteDb(file);
  try {
    return db.prepare(`select * from "${table}"`).all() as SqliteRow[];
  } finally {
    db.close();
  }
}

// ---------- similar ayah (qul:similar-ayah:74) ----------

export type SimilarEdge = { from: number; to: number; matchedWords: number; coverage: number; score: number; ranges: Array<[number, number]> };

export function importSimilar(file: string, format: 'json' | 'sqlite', corpus: Corpus): Imported<{ edges: SimilarEdge[] }> {
  const rej = new Rejects();
  const rows: Array<{ from: unknown; to: unknown; count: unknown; coverage: unknown; score: unknown; ranges: unknown }> = [];
  if (format === 'json') {
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Array<Record<string, unknown>>>;
    for (const [key, list] of Object.entries(json)) {
      if (!Array.isArray(list)) {
        rej.add(key, 'entries not an array');
        continue;
      }
      for (const e of list) rows.push({ from: key, to: e.matched_ayah_key, count: e.matched_words_count, coverage: e.coverage, score: e.score, ranges: e.match_words });
    }
  } else {
    for (const r of sqliteAll(file, 'similar_ayahs')) {
      let ranges: unknown = null;
      try {
        ranges = JSON.parse(String(r.match_words_range));
      } catch {
        ranges = null;
      }
      rows.push({ from: r.verse_key, to: r.matched_ayah_key, count: r.matched_words_count, coverage: r.coverage, score: r.score, ranges });
    }
  }
  const edges: SimilarEdge[] = [];
  const keys = new Set<number>();
  for (const r of rows) {
    const id = `${r.from}->${r.to}`;
    const from = validKey(corpus, r.from);
    const to = validKey(corpus, r.to);
    if (from === null || to === null) {
      rej.add(id, 'unknown verse key');
      continue;
    }
    if (from === to) {
      rej.add(id, 'self edge');
      continue;
    }
    const score = Number(r.score);
    const coverage = Number(r.coverage);
    const matchedWords = Number(r.count);
    if (![score, coverage, matchedWords].every(Number.isFinite)) {
      rej.add(id, 'non-numeric score/coverage/count');
      continue;
    }
    const ranges = validRanges(r.ranges, null);
    if (!ranges) {
      rej.add(id, 'malformed match_words ranges');
      continue;
    }
    edges.push({ from, to, matchedWords, coverage, score, ranges });
    keys.add(from);
    keys.add(to);
  }
  return {
    kind: 'similar-ayah',
    resourceId: 'qul:similar-ayah:74',
    category: 'similar-ayah',
    title: 'Similar Ayah',
    data: { edges },
    coverage: { rows: rows.length, verseKeys: keys.size, rejectedRows: rej.count },
    rejections: rej.list,
    notes: ['match_words ranges are QUL word positions (QPC word coordinates), not Imlaei search-token positions.'],
  };
}

// ---------- mutashabihat (qul:mutashabihat:73) ----------

export type Phrase = { id: number; sourceVerse: number; sourceRange: [number, number]; occurrences: Array<{ verse: number; ranges: Array<[number, number]> }>; count: number };

export function importMutashabihatPhrases(file: string, corpus: Corpus): Imported<{ phrases: Phrase[] }> {
  const rej = new Rejects();
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
  const phrases: Phrase[] = [];
  const keys = new Set<number>();
  let rows = 0;
  for (const [pid, p] of Object.entries(json)) {
    rows++;
    const id = Number(pid);
    const src = p.source as Record<string, unknown> | undefined;
    const sourceVerse = validKey(corpus, src?.key);
    const from = Number(src?.from);
    const to = Number(src?.to);
    if (!Number.isInteger(id) || sourceVerse === null || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      rej.add(pid, 'invalid id or source');
      continue;
    }
    const ayah = p.ayah as Record<string, unknown> | undefined;
    if (!ayah || typeof ayah !== 'object') {
      rej.add(pid, 'missing ayah map');
      continue;
    }
    const occurrences: Phrase['occurrences'] = [];
    let bad = false;
    for (const [key, ranges] of Object.entries(ayah)) {
      const verse = validKey(corpus, key);
      const r = validRanges(ranges, null);
      if (verse === null || !r) {
        bad = true;
        break;
      }
      occurrences.push({ verse, ranges: r });
      keys.add(verse);
    }
    if (bad || occurrences.length < 2) {
      rej.add(pid, bad ? 'invalid occurrence key/range' : 'fewer than two occurrences');
      continue;
    }
    phrases.push({ id, sourceVerse, sourceRange: [from, to], occurrences, count: Number(p.count) || occurrences.length });
  }
  return {
    kind: 'mutashabihat-phrases',
    resourceId: 'qul:mutashabihat:73',
    category: 'mutashabihat',
    title: 'Mutashabihat ul Quran (phrases)',
    data: { phrases },
    coverage: { rows, verseKeys: keys.size, rejectedRows: rej.count },
    rejections: rej.list,
    notes: ['Published export (already filtered by QUL: approved, ≥3 words, ≥2 verses/occurrences, parent de-duplication). Word ranges are QPC word coordinates.'],
  };
}

// ---------- topics (qul:ayah-topics:45) ----------

export type Topic = {
  id: number;
  name: string;
  arabicName: string;
  description: string;
  parent: number | null;
  thematicParent: number | null;
  ontologyParent: number | null;
  thematic: boolean;
  ontology: boolean;
  verses: number[];
  related: number[];
};

const splitList = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const optId = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

export function importTopics(file: string, corpus: Corpus): Imported<{ topics: Topic[] }> {
  const rej = new Rejects();
  const raw = sqliteAll(file, 'topics');
  const ids = new Set(raw.map((r) => Number(r.topic_id)));
  const topics: Topic[] = [];
  const keys = new Set<number>();
  let danglingEdges = 0;
  let badVerseRefs = 0;
  for (const r of raw) {
    const id = Number(r.topic_id);
    if (!Number.isInteger(id) || !r.name) {
      rej.add(String(r.topic_id), 'missing id or name');
      continue;
    }
    const verses: number[] = [];
    for (const k of splitList(r.ayahs)) {
      const v = validKey(corpus, k);
      if (v === null) badVerseRefs++;
      else {
        verses.push(v);
        keys.add(v);
      }
    }
    const edge = (x: number | null) => {
      if (x === null || Number.isNaN(x)) return null;
      if (!ids.has(x)) {
        danglingEdges++;
        return null;
      }
      return x;
    };
    const related = splitList(r.related_topics)
      .map(Number)
      .filter((x) => {
        if (ids.has(x)) return true;
        danglingEdges++;
        return false;
      });
    topics.push({
      id,
      name: String(r.name),
      arabicName: String(r.arabic_name ?? ''),
      description: String(r.description ?? ''),
      parent: edge(optId(r.parent_id)),
      thematicParent: edge(optId(r.thematic_parent_id)),
      ontologyParent: edge(optId(r.ontology_parent_id)),
      thematic: Number(r.thematic) === 1,
      ontology: Number(r.ontology) === 1,
      verses,
      related,
    });
  }
  const notes = [`${danglingEdges} parent/related links pointed at topic ids absent from the export and were dropped from the edge list.`];
  if (badVerseRefs) notes.push(`${badVerseRefs} ayah references were not valid verse keys and were dropped.`);
  return {
    kind: 'topics',
    resourceId: 'qul:ayah-topics:45',
    category: 'ayah-topics',
    title: 'Topics',
    data: { topics },
    coverage: { rows: raw.length, verseKeys: keys.size, rejectedRows: rej.count },
    rejections: rej.list,
    notes,
  };
}

// ---------- themes (qul:ayah-theme:62) ----------

export type Theme = { theme: string; surah: number; from: number; to: number; keywords: string[]; firstIndex: number; lastIndex: number };

export function importThemes(file: string, corpus: Corpus): Imported<{ themes: Theme[] }> {
  const rej = new Rejects();
  const raw = sqliteAll(file, 'themes');
  const themes: Theme[] = [];
  const keys = new Set<number>();
  for (const r of raw) {
    const surah = Number(r.surah_number);
    const from = Number(r.ayah_from);
    const to = Number(r.ayah_to);
    const a = corpus.indexOf(surah, from);
    const b = corpus.indexOf(surah, to);
    const id = `${surah}:${from}-${to}`;
    if (a === null || b === null || b < a || !r.theme) {
      rej.add(id, 'invalid range or empty theme');
      continue;
    }
    for (let i = a; i <= b; i++) keys.add(i);
    themes.push({ theme: String(r.theme), surah, from, to, keywords: splitList(r.keywords), firstIndex: a, lastIndex: b });
  }
  return {
    kind: 'themes',
    resourceId: 'qul:ayah-theme:62',
    category: 'ayah-theme',
    title: 'Ayah theme',
    data: { themes },
    coverage: { rows: raw.length, verseKeys: keys.size, rejectedRows: rej.count },
    rejections: rej.list,
    notes: ['A theme belongs to its whole ayah range, not to a single ayah.'],
  };
}

// ---------- QPC-Hafs ayah text (qul:quran-script:86) and ayah metadata (69) ----------

export function importQpcAyah(file: string, corpus: Corpus, kind: 'qpc-ayah-text' | 'ayah-metadata'): Imported<{ text: Array<string | null>; wordsCount: Array<number | null> }> {
  const rej = new Rejects();
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
  const text: Array<string | null> = new Array(corpus.verses.length).fill(null);
  const wordsCount: Array<number | null> = new Array(corpus.verses.length).fill(null);
  let rows = 0;
  for (const [k, r] of Object.entries(json)) {
    rows++;
    const v = validKey(corpus, r.verse_key);
    if (v === null || typeof r.text !== 'string' || !r.text.trim()) {
      rej.add(k, 'unknown verse_key or empty text');
      continue;
    }
    if (text[v] !== null) {
      rej.add(k, 'duplicate verse_key');
      continue;
    }
    text[v] = r.text;
    if (r.words_count !== undefined) wordsCount[v] = Number(r.words_count);
  }
  const have = text.filter((t) => t !== null).length;
  return {
    kind,
    resourceId: kind === 'qpc-ayah-text' ? 'qul:quran-script:86' : 'qul:quran-metadata:69',
    category: kind === 'qpc-ayah-text' ? 'quran-script' : 'quran-metadata',
    title: kind === 'qpc-ayah-text' ? 'QPC Hafs script – ayah by ayah' : 'Ayah metadata',
    data: { text, wordsCount },
    coverage: { rows, verseKeys: have, rejectedRows: rej.count },
    rejections: rej.list,
    notes: have === corpus.verses.length ? ['All 6,236 verse keys present.'] : [`Only ${have} of ${corpus.verses.length} verse keys present: not usable as the display source.`],
  };
}

// ---------- QPC word text (qul:quran-script:312) ----------

export function importQpcWords(file: string, format: 'json' | 'sqlite', corpus: Corpus): Imported<{ words: Array<string[] | null> }> {
  const rej = new Rejects();
  const rows: SqliteRow[] =
    format === 'json' ? Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>) : sqliteAll(file, 'words');
  const byVerse: Array<Map<number, string> | null> = new Array(corpus.verses.length).fill(null);
  for (const r of rows) {
    const m = /^(\d+):(\d+):(\d+)$/.exec(String(r.location ?? ''));
    const v = m ? corpus.indexOf(Number(m[1]), Number(m[2])) : null;
    if (!m || v === null || typeof r.text !== 'string') {
      rej.add(String(r.location), 'invalid location or text');
      continue;
    }
    const map = (byVerse[v] ??= new Map());
    const w = Number(m[3]);
    if (map.has(w)) rej.add(String(r.location), 'duplicate word location');
    else map.set(w, r.text);
  }
  const words = byVerse.map((m) => {
    if (!m) return null;
    const n = Math.max(...m.keys());
    const arr: string[] = [];
    for (let i = 1; i <= n; i++) {
      const t = m.get(i);
      if (t === undefined) return null; // gap in word positions
      arr.push(t);
    }
    return arr;
  });
  const complete = words.filter(Boolean).length;
  return {
    kind: 'qpc-word-text',
    resourceId: 'qul:quran-script:312',
    category: 'quran-script',
    title: 'KFGQPC Hafs script – word by word',
    data: { words },
    coverage: { rows: rows.length, verseKeys: complete, rejectedRows: rej.count },
    rejections: rej.list,
    notes: ['Word text includes the end-of-ayah number glyph as its final "word" in QPC exports; it is kept but marked non-spoken downstream.'],
  };
}

// ---------- juz / hizb / rub / manzil (qul:quran-metadata:68/67/63/66) ----------

export type Division = { type: 'juz' | 'hizb' | 'rub' | 'manzil'; number: number; firstIndex: number; lastIndex: number };

export function importDivision(file: string, format: 'json' | 'sqlite', corpus: Corpus): Imported<{ divisions: Division[] }> {
  const rej = new Rejects();
  let type: Division['type'] = 'juz';
  let rows: SqliteRow[];
  if (format === 'sqlite') {
    const t = sqliteTables(file).find((x) => ['juz', 'hizb', 'rub', 'manzil'].includes(x))!;
    type = t as Division['type'];
    rows = sqliteAll(file, t);
  } else {
    rows = Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, SqliteRow>);
    const numKey = Object.keys(rows[0] ?? {}).find((k) => k.endsWith('_number')) ?? 'juz_number';
    type = numKey.replace('_number', '') as Division['type'];
  }
  const divisions: Division[] = [];
  for (const r of rows) {
    const number = Number(r[`${type}_number`]);
    const a = validKey(corpus, r.first_verse_key);
    const b = validKey(corpus, r.last_verse_key);
    if (!Number.isInteger(number) || a === null || b === null || b < a) {
      rej.add(String(number), 'invalid number or verse range');
      continue;
    }
    divisions.push({ type, number, firstIndex: a, lastIndex: b });
  }
  divisions.sort((x, y) => x.number - y.number);
  // Divisions must tile the Quran in order without gaps or overlaps.
  let gaps = 0;
  divisions.forEach((d, i) => {
    const expected = i === 0 ? 0 : divisions[i - 1].lastIndex + 1;
    if (d.firstIndex !== expected) gaps++;
  });
  if (divisions.length && divisions.at(-1)!.lastIndex !== corpus.verses.length - 1) gaps++;
  const ids: Record<Division['type'], string> = { juz: '68', hizb: '67', rub: '63', manzil: '66' };
  return {
    kind: 'division',
    resourceId: `qul:quran-metadata:${ids[type]}`,
    category: 'quran-metadata',
    title: `${type[0].toUpperCase()}${type.slice(1)} boundaries`,
    data: { divisions },
    coverage: { rows: rows.length, verseKeys: divisions.reduce((n, d) => n + d.lastIndex - d.firstIndex + 1, 0), rejectedRows: rej.count + gaps },
    rejections: gaps ? [...rej.list, { row: type, reason: `${gaps} gap(s)/overlap(s) in the division sequence` }] : rej.list,
    notes: [],
  };
}
