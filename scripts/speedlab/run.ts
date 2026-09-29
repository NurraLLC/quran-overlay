// npm run speedlab -- --name duha [--port 4398] [--mode hybrid]
// End-to-end speed and correctness through the real pipeline: WAV (see make-audio.ts) as Edge's
// microphone -> Soniox (live) -> server -> screen. Records every screen change against the audio
// clock and reports, per ayah, "ayah starts in the audio -> on screen", plus wrong and missed ayahs.
// Real network, real Soniox, TTS voice (not a human reciter). Needs SONIOX_API_KEY in .env.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const name = arg('name', 'duha');
const port = Number(arg('port', '4398'));
const mode = arg('mode', 'hybrid');
const owner = 'speedlab-owner-capability-7f3a';
const wav = path.resolve('data', 'speedlab', `${name}.wav`);
const truth = JSON.parse(readFileSync(path.join('data', 'speedlab', `${name}.json`), 'utf8')) as {
  durationMs: number;
  segments: Array<{ key: string; startMs: number; endMs: number }>;
};

// A server left on the port (e.g. from an interrupted run) would silently serve stale code.
const inUse = await fetch(`http://127.0.0.1:${port}/api/owner/status`).then(() => true, () => false);
if (inUse) throw new Error(`port ${port} is already serving; stop that process first`);

const server = spawn('npx', ['tsx', 'src/server/main.ts', '--capture'], {
  shell: true,
  env: { ...process.env, PORT: String(port), QO_OWNER_TOKEN: owner, TRACKER_MODE: mode },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => undefined);
server.stderr.on('data', (d) => process.stderr.write(d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/owner/status`)).ok) break;
  } catch {
    /* starting */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/control#owner=${owner}`);
  await page.waitForSelector('.topbar');
  // Record every change of the previewed ayah at frame resolution.
  await page.evaluate(`(() => {
    window.__qoLog = [];
    let last;
    const tick = () => {
      const el = document.querySelector('.panel-on .verse');
      const label = el ? el.getAttribute('aria-label') : null;
      const key = label ? label.split(' ').pop() : null;
      if (key !== last) { window.__qoLog.push({ t: performance.now(), key }); last = key; }
      requestAnimationFrame(tick);
    };
    tick();
  })()`);
  await page.getByRole('button', { name: 'Start listening' }).click();
  await page.waitForFunction(() => (window as unknown as { __qoAudioOrigin?: () => number | null }).__qoAudioOrigin?.() != null, undefined, { timeout: 20000 });
  await page.waitForTimeout(truth.durationMs + 2500);
  const origin = await page.evaluate(() => (window as unknown as { __qoAudioOrigin: () => number }).__qoAudioOrigin());
  const log = await page.evaluate(() => (window as unknown as { __qoLog: Array<{ t: number; key: string | null }> }).__qoLog);
  const meter = await page.locator('.speed').innerText().catch(() => '');
  await page.getByRole('button', { name: 'Stop listening' }).click().catch(() => undefined);

  // Audio time of each screen change.
  const changes = log.map((l) => ({ audio: l.t - origin, key: l.key })).filter((c) => c.audio > -2000);
  const rows: string[] = [];
  const lat: number[] = [];
  let wrong = 0;
  for (const c of changes) {
    if (!c.key) continue;
    const seg = truth.segments.find((s) => s.key === c.key);
    const current = truth.segments.filter((s) => s.startMs <= c.audio).at(-1);
    const ok = !!seg && seg.startMs <= c.audio + 50 && (current?.key === c.key || truth.segments.indexOf(current!) - truth.segments.indexOf(seg) <= 1);
    if (!ok) wrong++;
    if (seg) lat.push(c.audio - seg.startMs);
    rows.push(`  ${c.key.padEnd(7)} on screen ${(c.audio / 1000).toFixed(2).padStart(6)} s audio | ayah began ${seg ? (seg.startMs / 1000).toFixed(2) : '—'} s | ${seg ? `+${((c.audio - seg.startMs) / 1000).toFixed(2)} s after ayah start` : ''}${ok ? '' : '  WRONG'}`);
  }
  const shown = new Set(changes.map((c) => c.key));
  const missed = truth.segments.filter((s) => !shown.has(s.key)).map((s) => s.key);
  const s = [...lat].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? (s[Math.min(s.length - 1, Math.floor(s.length * p))] / 1000).toFixed(2) : '—');
  console.log(rows.join('\n'));
  console.log(`\n${name} (${mode}): ${truth.segments.length} ayahs, shown ${truth.segments.length - missed.length}, missed ${missed.length}${missed.length ? ` (${missed.join(' ')})` : ''}, wrong ${wrong}`);
  console.log(`ayah starts in audio -> on screen: p50 ${q(0.5)} s, p90 ${q(0.9)} s, best ${q(0)} s`);
  console.log(`control-page meter: ${meter}`);
} finally {
  await browser.close();
  if (process.platform === 'win32' && server.pid) spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f']);
  else server.kill();
  process.exit(0);
}
