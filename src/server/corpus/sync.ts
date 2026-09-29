import { createHash } from 'node:crypto';
import type { Chapter, CorpusManifest, ProcessedCorpus, VerseKey } from '../../shared/corpus-types';
import { validateCorpus } from './validate';

export type Snapshot = { resource_group: string; resource_id: number; schema_version: number; records: Record<string, any>[] };
export const SYNC_RESOURCES = ['quran_core:1', 'mushafs:1', 'translations:20', 'word_by_word_translations:59', 'word_by_word_transliterations:60'];
export const contentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LETTER = /[ء-يٱ-ۓ]/;

/** Complete source snapshots are validated before a generation can become active. */
export function convertSnapshots(snapshots: Snapshot[], imlaei: { verses: { verse_key: string; text_imlaei: string }[] }, template: { manifest: CorpusManifest; codepoints: number[]; minimumGlosses?: number }) {
  const source = (group: string, id: number) => {
    const found = snapshots.filter(s => s.resource_group === group && s.resource_id === id && s.schema_version === 1);
    if (found.length !== 1 || !Array.isArray(found[0].records)) throw new Error(`Missing or duplicate snapshot ${group}:${id}`);
    return found[0].records;
  };
  const unique = (rows: Record<string, any>[], key: string) => {
    const map = new Map<any, Record<string, any>>();
    for (const row of rows) {
      if (row[key] === undefined || map.has(row[key])) throw new Error(`Missing or duplicate ${key}`);
      map.set(row[key], row);
    }
    return map;
  };
  const core = source('quran_core', 1);
  const chapters: Chapter[] = core.filter(r=>r.record_type==='chapter').map(r=>({ number:r.chapter_number, nameArabic:r.name_arabic, nameSimple:r.name_simple, nameComplex:r.name_complex, verseCount:r.verses_count, bismillahPre:r.bismillah_pre })).sort((a,b)=>a.number-b.number);
  const arabic = unique(core.filter(r=>r.record_type==='verse'),'verse_key');
  const search = unique(imlaei.verses,'verse_key');
  const english = unique(source('translations',20),'verse_key');
  if (arabic.size!==6236 || search.size!==6236 || english.size!==6236) throw new Error('Every source must contain exactly 6,236 ayahs');
  const verses = [...arabic.values()].sort((a,b)=>a.chapter_id-b.chapter_id || a.verse_number-b.verse_number).map((r,index)=>{
    const e=english.get(r.verse_key),s=search.get(r.verse_key);
    if(!e||!s||typeof e.text!=='string'||typeof s.text_imlaei!=='string'||typeof r.text_uthmani!=='string')throw new Error('Missing source-owned verse text');
    const footnote=/<sup foot_note=(\d+)>\d+<\/sup>/g;
    return {index,key:r.verse_key as VerseKey,surah:r.chapter_id,ayah:r.verse_number,arabicDisplay:r.text_uthmani.trim(),searchText:s.text_imlaei.trim(),english:e.text.replace(footnote,'').replace(/[ \t]{2,}/g,' ').trim(),footnoteIds:[...e.text.matchAll(footnote)].map(m=>Number(m[1]))};
  });
  const wordTranslations=unique(source('word_by_word_translations',59),'word_id');
  const wordSounds=unique(source('word_by_word_transliterations',60),'word_id');
  const byVerse=new Map<number,Record<string,any>[]>();
  for(const row of source('mushafs',1).filter(r=>r.record_type==='mushaf_word'&&r.char_type_name==='word')) {
    const rows=byVerse.get(row.verse_id)??[]; rows.push(row); byVerse.set(row.verse_id,rows);
  }
  const glosses:Record<string,(string|null)[]>={}, sounds:Record<string,string[]>={};
  for(const verse of verses) {
    const rows=(byVerse.get(arabic.get(verse.key)!.id)??[]).sort((a,b)=>a.position_in_verse-b.position_in_verse);
    const words=unique(rows,'position_in_verse');
    if(!rows.length||rows.some((r,i)=>r.position_in_verse!==i+1))throw new Error(`Incomplete word mapping at ${verse.key}`);
    const tokens=verse.arabicDisplay.split(/\s+/).filter(Boolean);
    const translations=rows.map(r=>wordTranslations.get(r.word_id)?.text);
    const transliterations=rows.map(r=>wordSounds.get(r.word_id)?.text);
    if([...translations,...transliterations].some(t=>typeof t!=='string'||!t.trim()||/[<>]/.test(t)))throw new Error(`Missing or unsafe word text at ${verse.key}`);
    sounds[verse.key]=transliterations.map(t=>t.trim());
    // Some Uthmani compounds use a different word split from the Mushaf. As in the
    // original importer, omit their glosses rather than put a meaning under a wrong word.
    if(words.size!==tokens.filter(t=>LETTER.test(t)).length)continue;
    let i=0;glosses[verse.key]=tokens.map(t=>LETTER.test(t)?translations[i++].trim():null);
  }
  if(Object.keys(glosses).length<(template.minimumGlosses??6232))throw new Error('Word gloss coverage fell below the validated baseline');
  const id='hafs-sync-'+contentHash({chapters,verses,glosses,sounds}).slice(0,24);
  const now=new Date().toISOString();
  const manifest:CorpusManifest={...template.manifest,id,builtAt:now,sourceFiles:template.manifest.sourceFiles.map(s=>{
    if(s.role==='font')return s;
    const raw=s.role==='english'?source('translations',20):s.role==='arabicSearch'?imlaei:core;
    return {...s,path:'runtime-content-sync',sourceUrl:s.role==='arabicSearch'?'https://apis.quran.foundation/content/api/v4/quran/verses/imlaei':`https://apis.quran.foundation/content/api/v4/resources/snapshots/${s.role==='english'?'translations/20':'quran_core/1'}`,sha256:contentHash(raw),bytes:Buffer.byteLength(JSON.stringify(raw)),downloadedAt:now,licenseStatus:'End-user display under Quran Foundation Developer Terms; refreshed from authenticated production APIs',attribution:s.attribution.replace('Quran.com API v4','Quran Foundation Content API')};
  })};
  const corpus:ProcessedCorpus={manifest,chapters,verses};
  const failed=validateCorpus(corpus,new Set(template.codepoints)).filter(c=>!c.ok);
  if(failed.length)throw new Error('Refused content update: '+failed.map(c=>c.name).join('; '));
  return {corpus,glosses:{source:'Quran Foundation Content Sync resource 59',attribution:'Word by word: Quran Foundation',verses:glosses},transliteration:{source:'Quran Foundation Content Sync resource 60',attribution:'Transliteration: Quran Foundation',verses:sounds}};
}
