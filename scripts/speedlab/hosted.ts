// npm run speedlab:hosted
// Hosted mode end to end with real Soniox: a fresh credit ledger with a one-minute allowance, the
// phone reader at "/", Ad-Duha + Ash-Sharh (TTS, see make-audio.ts) as the microphone. Expect the
// recitation to be followed, the provider to cut the stream at one minute, a clean "used up" stop
// that keeps the page, and exactly one 60 s charge in the ledger. Needs SONIOX_API_KEY in .env.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
const S = path.join('data', 'speedlab', 'hosted');
const state = path.join(S, 'state');
rmSync(state, { recursive: true, force: true });
mkdirSync(path.join(S, 'shots'), { recursive: true });
const port = 4420;
const server = spawn('npx', ['tsx', 'src/server/main.ts'], { shell: true, env: { ...process.env, PORT: String(port), QO_HOSTED: '1', QO_STATE_DIR: state, QO_FREE_HOURS_PER_MONTH: String(60 / 3600) }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => (log += d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100 && !log.includes('Hosted mode'); i++) await new Promise((r) => setTimeout(r, 200));
console.log(log.split('\n').filter((l) => l.startsWith('Hosted') || l.startsWith('Open')).join('\n'));
const wav = path.resolve('data', 'speedlab', 'duha-sharh.wav');
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`] });
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(`${base}/`);
  await p.waitForSelector('.r-top');
  await p.waitForTimeout(800);
  console.log('before:', await p.locator('.r-status').innerText());
  await p.getByRole('button', { name: 'Start listening' }).click();
  const t0 = Date.now();
  for (const at of [25, 50, 80]) {
    await p.waitForTimeout(at * 1000 - (Date.now() - t0));
    await p.screenshot({ path: `${S}/shots/hosted-${at}s.png` });
    console.log(`${at}s:`, (await p.locator('.r-top').innerText()).replace(/\s+/g, ' '), '|', (await p.locator('.r-status').innerText()).replace(/\s+/g, ' '));
  }
} finally {
  await browser.close();
  if (server.pid) spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f']);
}
await new Promise((r) => setTimeout(r, 500));
const db = new DatabaseSync(path.join(state, 'credits.db'));
console.log('holds:', JSON.stringify(db.prepare('SELECT max_seconds, settled_at IS NOT NULL AS settled, free_seconds, paid_seconds FROM holds').all()));
process.exit(0);
