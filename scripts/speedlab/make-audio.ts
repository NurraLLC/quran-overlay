// npm run speedlab:audio -- --name kahf --ranges 18:1-18:10 [--voice Adrian] [--speed 0.85] [--pause 700] [--basmala]
// --basmala opens with the isti'adha and basmala, and says the basmala before each later surah.
// Builds a recitation-like WAV from Soniox TTS (one request per ayah, cached) with pauses between
// ayahs, plus a truth file giving each ayah's start/end in the audio. TTS is not a human reciter:
// this measures the pipeline's speed and correctness on real audio, not recitation accuracy.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Corpus, loadCorpus } from '../../src/server/corpus/load';

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const name = arg('name', 'lab');
const ranges = arg('ranges', '93:1-93:11');
const voice = arg('voice', 'Adrian');
const speed = Number(arg('speed', '0.85'));
const pauseMs = Number(arg('pause', '700'));
const basmala = process.argv.includes('--basmala');
const ISTIADHA = 'أعوذ بالله من الشيطان الرجيم';
const BASMALA = 'بسم الله الرحمن الرحيم';
const leadMs = 1500;
const RATE = 16000;

for (const line of existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const key = process.env.SONIOX_API_KEY;
if (!key) throw new Error('SONIOX_API_KEY missing in .env');

const corpus = new Corpus(loadCorpus());
const cacheDir = path.join('data', 'speedlab', 'tts');
mkdirSync(cacheDir, { recursive: true });

/** PCM samples (16-bit mono) from a WAV file's data chunk. */
function pcmOf(wav: Buffer): Buffer {
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'data') return wav.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
function wavOf(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const silence = (ms: number) => Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
const msOf = (pcm: Buffer) => (pcm.length / 2 / RATE) * 1000;

async function tts(text: string): Promise<Buffer> {
  const id = createHash('sha256').update(`${voice}|${speed}|${text}`).digest('hex').slice(0, 16);
  const file = path.join(cacheDir, `${id}.wav`);
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch('https://tts-rt.soniox.com/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-rt-v2', language: 'ar', voice, audio_format: 'wav', sample_rate: RATE, speed, text }),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

const parts: Buffer[] = [silence(leadMs)];
let t = leadMs;
const segments: Array<{ key: string; startMs: number; endMs: number }> = [];
/** Speech that belongs to no ayah (not a truth segment). */
async function say(text: string) {
  const pcm = pcmOf(await tts(text));
  parts.push(pcm, silence(pauseMs));
  t += msOf(pcm) + pauseMs;
}
if (basmala) await say(ISTIADHA);
let lastSurah = 0;
for (const r of ranges.split(',')) {
  const [a, b] = r.split('-');
  const from = corpus.verse(a)!.index;
  const to = corpus.verse(b ?? a)!.index;
  for (let i = from; i <= to; i++) {
    const v = corpus.at(i)!;
    if (basmala && v.ayah === 1 && v.surah !== lastSurah && v.surah !== 1 && v.surah !== 9) await say(BASMALA);
    lastSurah = v.surah;
    const pcm = pcmOf(await tts(v.searchText));
    segments.push({ key: v.key, startMs: Math.round(t), endMs: Math.round(t + msOf(pcm)) });
    parts.push(pcm, silence(pauseMs));
    t += msOf(pcm) + pauseMs;
    process.stdout.write(`${v.key} `);
  }
}
parts.push(silence(3000));
const out = path.join('data', 'speedlab', `${name}.wav`);
writeFileSync(out, wavOf(Buffer.concat(parts)));
writeFileSync(path.join('data', 'speedlab', `${name}.json`), JSON.stringify({ name, ranges, voice, speed, pauseMs, leadMs, basmala, durationMs: Math.round(t + 3000), segments }, null, 1));
console.log(`\nwrote ${out} (${(t / 1000).toFixed(1)} s, ${segments.length} ayahs)`);
