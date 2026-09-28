// Fixture proof for the QUL importers: tiny files in the exact shapes QUL's exporters write
// (work/qul/lib/exporter/*.rb). Real exports are validated by `npm run resources:import`.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detect,
  importDivision,
  importMutashabihatPhrases,
  importQpcAyah,
  importSimilar,
  importThemes,
  importTopics,
} from '../../src/server/resources/importers';
import { fullCorpus } from '../helpers';

const dir = mkdtempSync(path.join(tmpdir(), 'qo-res-'));
const file = (name: string, content: unknown) => {
  const f = path.join(dir, name);
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
};
function sqlite(name: string, table: string, columns: string[], rows: unknown[][]) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const f = path.join(dir, name);
  const db = new DatabaseSync(f);
  db.exec(`create table ${table} (${columns.join(', ')})`);
  const st = db.prepare(`insert into ${table} values (${columns.map(() => '?').join(',')})`);
  for (const r of rows) st.run(...(r as never[]));
  db.close();
  return f;
}
const idx = (k: string) => fullCorpus().corpus.verse(k)!.index;

describe('QUL importers', () => {
  it('similar ayah json: singleton and disjoint ranges kept, bad keys and ranges rejected', () => {
    const f = file('a.json', {
      '55:13': [{ matched_ayah_key: '55:16', matched_words_count: 4, coverage: 100, score: 100, match_words: [[1, 4]] }],
      '2:255': [
        { matched_ayah_key: '3:2', matched_words_count: 5, coverage: 20, score: 60, match_words: [[1, 3], [5], [7, 8]] },
        { matched_ayah_key: '2:999', matched_words_count: 1, coverage: 1, score: 1, match_words: [[1]] },
        { matched_ayah_key: '3:2', matched_words_count: 1, coverage: 1, score: 1, match_words: [[4, 2]] },
      ],
    });
    expect(detect(f)).toEqual({ kind: 'similar-ayah', format: 'json' });
    const r = importSimilar(f, 'json', fullCorpus().corpus);
    expect(r.data.edges).toHaveLength(2);
    expect(r.data.edges[1]).toMatchObject({ from: idx('2:255'), to: idx('3:2'), ranges: [[1, 3], [5, 5], [7, 8]] });
    expect(r.coverage.rejectedRows).toBe(2);
  });

  it('similar ayah sqlite: match_words_range is parsed from its serialized JSON', () => {
    const f = sqlite('b.db', 'similar_ayahs', ['verse_key TEXT', 'matched_ayah_key TEXT', 'matched_words_count INTEGER', 'coverage INTEGER', 'score INTEGER', 'match_words_range TEXT'], [['3:2', '2:255', 5, 50, 70, '[[1,5]]']]);
    expect(detect(f)).toEqual({ kind: 'similar-ayah', format: 'sqlite' });
    expect(importSimilar(f, 'sqlite', fullCorpus().corpus).data.edges[0]).toMatchObject({ from: idx('3:2'), to: idx('2:255'), score: 70 });
  });

  it('mutashabihat phrases: occurrences map to verse indices; single-occurrence phrases rejected', () => {
    const f = file('p.json', {
      '10': { surahs: 1, ayahs: 2, count: 2, source: { key: '55:13', from: 1, to: 4 }, ayah: { '55:13': [[1, 4]], '55:16': [[1, 4]] } },
      '11': { surahs: 1, ayahs: 1, count: 1, source: { key: '1:1', from: 1, to: 3 }, ayah: { '1:1': [[1, 3]] } },
    });
    expect(detect(f)?.kind).toBe('mutashabihat-phrases');
    const r = importMutashabihatPhrases(f, fullCorpus().corpus);
    expect(r.data.phrases.map((p) => p.id)).toEqual([10]);
    expect(r.coverage.rejectedRows).toBe(1);
  });

  it('topics sqlite: comma-separated fields become typed edges; dangling links and bad keys are counted, not kept', () => {
    const cols = ['topic_id INTEGER PRIMARY KEY', 'name TEXT', 'arabic_name TEXT', 'parent_id INTEGER', 'thematic_parent_id INTEGER', 'ontology_parent_id INTEGER', 'description TEXT', 'wiki_link TEXT', 'thematic INTEGER', 'ontology INTEGER', 'ayahs TEXT', 'related_topics TEXT'];
    const f = sqlite('t.db', 'topics', cols, [
      [1, 'Parents', 'الوالدين', null, null, null, 'Kindness to parents', '', 1, 0, '17:23, 17:24, 31:14, 99:99', '2,77'],
      [2, 'Family', 'الأسرة', null, null, null, '', '', 1, 0, '4:1', '1'],
    ]);
    expect(detect(f)?.kind).toBe('topics');
    const r = importTopics(f, fullCorpus().corpus);
    const t = r.data.topics.find((x) => x.id === 1)!;
    expect(t.verses).toEqual([idx('17:23'), idx('17:24'), idx('31:14')]);
    expect(t.related).toEqual([2]);
    expect(r.notes.join(' ')).toMatch(/1 parent\/related links/);
    expect(r.notes.join(' ')).toMatch(/1 ayah references/);
  });

  it('themes sqlite: ranges resolve to verse indices; impossible ranges rejected', () => {
    const f = sqlite('th.db', 'themes', ['theme TEXT', 'surah_number INTEGER', 'ayah_from INTEGER', 'ayah_to INTEGER', 'keywords TEXT', 'total_ayahs INTEGER'], [
      ['Opening prayer', 1, 1, 7, 'praise,guidance', 7],
      ['Bad', 1, 5, 9, '', 5],
    ]);
    const r = importThemes(f, fullCorpus().corpus);
    expect(r.data.themes).toHaveLength(1);
    expect(r.data.themes[0]).toMatchObject({ firstIndex: 0, lastIndex: 6, keywords: ['praise', 'guidance'] });
    expect(r.coverage.rejectedRows).toBe(1);
  });

  it('QPC ayah text: an incomplete file is flagged as unusable for display', () => {
    const f = file('q.json', { '1:1': { id: 1, verse_key: '1:1', surah: 1, ayah: 1, text: 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ ١' } });
    expect(detect(f)?.kind).toBe('qpc-ayah-text');
    const r = importQpcAyah(f, fullCorpus().corpus, 'qpc-ayah-text');
    expect(r.coverage.verseKeys).toBe(1);
    expect(r.notes[0]).toMatch(/not usable as the display source/);
  });

  it('divisions must tile the Quran without gaps', () => {
    const { corpus } = fullCorpus();
    const last = corpus.verses.at(-1)!.key;
    const ok = file('j.json', { '1': { juz_number: 1, verses_count: 148, first_verse_key: '1:1', last_verse_key: '2:141', verse_mapping: {} }, '2': { juz_number: 2, verses_count: 1, first_verse_key: '2:142', last_verse_key: last, verse_mapping: {} } });
    expect(detect(ok)?.kind).toBe('division');
    const r = importDivision(ok, 'json', corpus);
    expect(r.data.divisions.map((d) => d.type)).toEqual(['juz', 'juz']);
    expect(r.coverage.rejectedRows).toBe(0);
    const gap = file('j2.json', { '1': { juz_number: 1, verses_count: 1, first_verse_key: '1:1', last_verse_key: '2:100', verse_mapping: {} }, '2': { juz_number: 2, verses_count: 1, first_verse_key: '2:142', last_verse_key: last, verse_mapping: {} } });
    expect(importDivision(gap, 'json', corpus).coverage.rejectedRows).toBeGreaterThan(0);
  });

  it('unknown files are not guessed', () => {
    expect(detect(file('x.json', { hello: 'world' }))).toBeNull();
    expect(detect(file('y.txt', 'not json'))).toBeNull();
  });
});
