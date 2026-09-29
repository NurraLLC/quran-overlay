// Daily authenticated full refresh. Publish the checkpoint only after every source validates.
import {copyFileSync,existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {convertSnapshots,SYNC_RESOURCES,type Snapshot} from '../src/server/corpus/sync';
const ROOT=path.resolve(import.meta.dirname,'..');
const id=process.env.QF_CLIENT_ID?.trim(),secret=process.env.QF_CLIENT_SECRET?.trim();
if(!id||!secret)throw new Error('Quran Foundation production credentials required');
const auth=await fetch('https://oauth2.quran.foundation/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(id+':'+secret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials&scope=content',redirect:'error',signal:AbortSignal.timeout(15000)});
if(!auth.ok)throw new Error(`QF authentication unavailable (${auth.status})`);
const access=(await auth.json() as {access_token:string}).access_token;
async function get(relative:string):Promise<any>{
  if(!relative.startsWith('/api/v4/')||relative.includes('://')||relative.includes('\\'))throw new Error('Invalid QF API path');
  const r=await fetch('https://apis.quran.foundation/content'+relative,{headers:{'x-client-id':id!,'x-auth-token':access},redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!r.ok)throw new Error(`QF content unavailable (${r.status})`);
  const body=await r.text();if(Buffer.byteLength(body)>80*1024*1024)throw new Error('Content response too large');
  return JSON.parse(body);
}
const snapshots:Snapshot[]=[];
let url='/api/v4/resources/sync?bootstrap=true&per_page=100&resources='+encodeURIComponent(SYNC_RESOURCES.join(';'));
let token:string|undefined;
for(let page=0;page<20;page++){
  const batch=(await get(url)).sync;
  if(!batch||typeof batch.has_more!=='boolean')throw new Error('Invalid sync envelope');
  // Full snapshots make recovery independent of local partial updates and old cursor expiry.
  if(!batch.has_more){token=batch.next_sync_token;break;}
  if(typeof batch.next_page_url!=='string'||!batch.next_page_url.startsWith('/api/v4/resources/sync?'))throw new Error('Invalid sync pagination');
  url=batch.next_page_url;
}
if(!token)throw new Error('Content sync did not complete');
for(const resource of SYNC_RESOURCES)snapshots.push(await get('/api/v4/resources/snapshots/'+resource.replace(':','/')));
const imlaei=await get('/api/v4/quran/verses/imlaei');
const template=JSON.parse(readFileSync(path.join(ROOT,'data/processed/content-template.json'),'utf8'));
const result=convertSnapshots(snapshots,imlaei,template);
const store=path.resolve(process.env.QO_CONTENT_STORE||path.join(ROOT,'data/live'));
mkdirSync(store,{recursive:true});
const activeFile=path.join(store,'active.json');
const previous=existsSync(activeFile)?JSON.parse(readFileSync(activeFile,'utf8')):null;
const reusable=previous && /^generation-[a-f0-9-]{36}$/.test(previous.directory) && ['corpus.json','wbw-en.json','translit-en.json',path.join('fonts',template.manifest.font.file)].every(name=>existsSync(path.join(store,previous.directory,name)));
const changed=!reusable||previous.id!==result.corpus.manifest.id;
const directory=changed?'generation-'+randomUUID():previous.directory;
if(changed){
 const target=path.join(store,directory);mkdirSync(path.join(target,'fonts'),{recursive:true});
 for(const [name,data]of [['corpus.json',result.corpus],['wbw-en.json',result.glosses],['translit-en.json',result.transliteration]] as const)writeFileSync(path.join(target,name),JSON.stringify(data));
 copyFileSync(path.join(ROOT,'data/processed/fonts',template.manifest.font.file),path.join(target,'fonts',template.manifest.font.file));
}
const temporary=path.join(store,'.active-'+randomUUID()+'.json');
writeFileSync(temporary,JSON.stringify({id:result.corpus.manifest.id,directory,checkedAt:Date.now(),syncToken:token,resources:SYNC_RESOURCES}),{mode:0o600});
renameSync(temporary,activeFile);
// Keep a one-day handover window for a running reader; never traverse links or
// remove anything outside this dedicated content store.
for(const name of readdirSync(store)) {
 if(name===directory||!/^generation-[a-f0-9-]{36}$/.test(name))continue;
 const target=path.resolve(store,name);
 if(path.dirname(target)!==store)throw new Error('Invalid cache cleanup target');
 const stat=lstatSync(target);
 if(stat.isDirectory()&&!stat.isSymbolicLink()&&Date.now()-stat.mtimeMs>86400000)rmSync(target,{recursive:true});
}
console.log(JSON.stringify({changed,id:result.corpus.manifest.id,verses:result.corpus.verses.length,glosses:Object.keys(result.glosses.verses).length}));
