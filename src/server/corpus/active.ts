import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
export const CONTENT_MAX_AGE_MS=6*24*60*60*1000;
export function activeContent(store:string,now=Date.now()) {
  const record=JSON.parse(readFileSync(path.join(store,'active.json'),'utf8')) as {id:string;directory:string;checkedAt:number};
  if(!/^generation-[a-f0-9-]{36}$/.test(record.directory)||typeof record.id!=='string'||!record.id||!Number.isFinite(record.checkedAt)||record.checkedAt>now+300000||now-record.checkedAt>CONTENT_MAX_AGE_MS)throw new Error('Quran content needs a successful refresh before serving');
  const directory=path.resolve(store,record.directory);
  if(!existsSync(path.join(directory,'corpus.json')))throw new Error('Active Quran content is missing');
  return {...record,path:directory};
}
