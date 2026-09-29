import {afterAll,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fullCorpus} from '../helpers';
import {activeContent,CONTENT_MAX_AGE_MS} from '../../src/server/corpus/active';
import {convertSnapshots,type Snapshot} from '../../src/server/corpus/sync';
const data=fullCorpus().corpus.data;
function fixture(){
 const core:any[]=data.chapters.map(c=>({record_type:'chapter',id:c.number,chapter_number:c.number,name_arabic:c.nameArabic,name_simple:c.nameSimple,name_complex:c.nameComplex,verses_count:c.verseCount,bismillah_pre:c.bismillahPre}));
 const english:any[]=[],search:any[]=[],words:any[]=[],glosses:any[]=[],sounds:any[]=[];
 let id=0;
 for(const v of data.verses){
  core.push({record_type:'verse',id:v.index+1,verse_key:v.key,chapter_id:v.surah,verse_number:v.ayah,text_uthmani:v.arabicDisplay});
  english.push({verse_key:v.key,text:v.english});search.push({verse_key:v.key,text_imlaei:v.searchText});
  let position=0;
  for(const token of v.arabicDisplay.split(/\s+/).filter(t=>/[ء-يٱ-ۓ]/.test(t))){
   id++;position++;words.push({record_type:'mushaf_word',word_id:id,verse_id:v.index+1,char_type_name:'word',position_in_verse:position});
   glosses.push({word_id:id,text:'fixture'});sounds.push({word_id:id,text:'fixture'});
  }
 }
 const snapshot=(resource_group:string,resource_id:number,records:any[]):Snapshot=>({resource_group,resource_id,schema_version:1,records});
 return {snapshots:[snapshot('quran_core',1,core),snapshot('translations',20,english),snapshot('mushafs',1,words),snapshot('word_by_word_translations',59,glosses),snapshot('word_by_word_transliterations',60,sounds)],imlaei:{verses:search},template:{manifest:data.manifest,codepoints:[...new Set([...data.verses.map(v=>v.arabicDisplay).join('')].map(c=>c.codePointAt(0)!))]}};
}
describe('authenticated content generations',()=>{
 it('preserves every source-owned ayah and refuses missing or duplicate scripture',()=>{
  const f=fixture(),result=convertSnapshots(f.snapshots,f.imlaei,f.template);
  expect(result.corpus.verses).toHaveLength(6236);
  expect(result.corpus.verses.map(v=>v.arabicDisplay)).toEqual(data.verses.map(v=>v.arabicDisplay));
  expect(Object.keys(result.glosses.verses)).toHaveLength(6236);
  f.snapshots[1].records.pop();
  expect(()=>convertSnapshots(f.snapshots,f.imlaei,f.template)).toThrow('6,236');
  f.snapshots[1].records.push(f.snapshots[1].records[0]);
  expect(()=>convertSnapshots(f.snapshots,f.imlaei,f.template)).toThrow('duplicate');
 });
 it('rejects missing words and incomplete display-font coverage',()=>{
  const f=fixture();
  expect(()=>convertSnapshots(f.snapshots,f.imlaei,{...f.template,codepoints:[]})).toThrow('display font');
  f.snapshots[2].records=f.snapshots[2].records.filter(r=>r.verse_id!==1);
  expect(()=>convertSnapshots(f.snapshots,f.imlaei,f.template)).toThrow('Incomplete word mapping');
 });
});
const store=mkdtempSync(path.join(os.tmpdir(),'quran-content-test-'));
afterAll(()=>rmSync(store,{recursive:true,force:true}));
it('rejects stale, missing and escaping cache pointers',()=>{
 const directory='generation-11111111-1111-1111-1111-111111111111';
 mkdirSync(path.join(store,directory));writeFileSync(path.join(store,directory,'corpus.json'),'{}');
 const now=Date.now();
 const save=(over:Record<string,unknown>)=>writeFileSync(path.join(store,'active.json'),JSON.stringify({id:'fixture',directory,checkedAt:now,...over}));
 save({});expect(activeContent(store,now).path).toBe(path.join(store,directory));
 for(const bad of [{directory:'../outside'},{checkedAt:now-CONTENT_MAX_AGE_MS-1},{checkedAt:now+600000},{directory:'generation-22222222-2222-2222-2222-222222222222'}]){save(bad);expect(()=>activeContent(store,now)).toThrow();}
});
