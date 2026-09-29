import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {loadCorpus} from '../src/server/corpus/load';
import {fontCodepoints} from '../src/server/corpus/font';
import {PROCESSED_DIR,PROCESSED_FONT_DIR} from '../src/server/corpus/manifest';
const {manifest}=loadCorpus();
const {codepoints}=fontCodepoints(path.join(PROCESSED_FONT_DIR,manifest.font.file));
writeFileSync(path.join(PROCESSED_DIR,'content-template.json'),JSON.stringify({manifest,codepoints:[...codepoints]}));
console.log('Content metadata and font coverage template created; no verse text included.');
