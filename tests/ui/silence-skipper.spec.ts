// The silence skipper end to end in a real browser, without Soniox: a fake microphone plays
// tone / long silence / tone, the provider key and WebSocket are stood in for, and the stream must
// close during the long silence and a new one open when the tone returns.
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OWNER = 'ui-test-owner-capability-0001';

/** 16 kHz mono WAV: 2 s voice-like tone, 11 s silence, 2 s tone, 11 s silence. */
function wav(): string {
  const rate = 16_000;
  const parts: Array<[number, boolean]> = [[2, true], [11, false], [2, true], [11, false]];
  const samples = parts.reduce((n, [s]) => n + s * rate, 0);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  let o = 44;
  let t = 0;
  for (const [sec, on] of parts) {
    for (let i = 0; i < sec * rate; i++, t++) {
      const v = on ? 0.3 * Math.sin((2 * Math.PI * 220 * t) / rate) + 0.1 * Math.sin((2 * Math.PI * 660 * t) / rate) : 0;
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  const file = path.join(tmpdir(), 'qo-silence-skipper.wav');
  writeFileSync(file, buf);
  return file;
}

test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav()}`, '--autoplay-policy=no-user-gesture-required'] },
  viewport: { width: 1440, height: 900 },
});

test('a long silence closes the provider stream and the voice reopens it', async ({ page }) => {
  test.setTimeout(60_000);
  // Stand-ins for the provider: a key, and a WebSocket that accepts audio and answers nothing.
  await page.route('**/api/soniox/temporary-key', (r) => r.fulfill({ json: { api_key: 'ui-test-temporary-key' } }));
  const streams: Array<{ opened: number; closed: number | null; bytes: number }> = [];
  const t0 = Date.now();
  await page.routeWebSocket(/stt-rt\.soniox\.com/, (ws) => {
    const s = { opened: Date.now() - t0, closed: null as number | null, bytes: 0 };
    streams.push(s);
    ws.onMessage((m) => {
      if (typeof m !== 'string') s.bytes += m.length;
    });
    ws.onClose(() => {
      s.closed = Date.now() - t0;
    });
  });

  await page.goto(`/control#owner=${OWNER}`);
  await page.waitForSelector('.topbar');
  await page.getByRole('button', { name: 'Start listening' }).click();
  await page.getByRole('dialog',{name:'Before you turn on the microphone'}).getByRole('checkbox').check();
  await page.getByRole('button',{name:'Agree and continue'}).click();
  try {
    await expect.poll(() => streams.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => streams[0].bytes, { timeout: 10_000 }).toBeGreaterThan(0);
    // Tone for 2 s, then silence: after 8 s of it the stream closes and listening stays on.
    await expect.poll(() => streams[0].closed, { timeout: 20_000 }).not.toBeNull();
    await expect(page.getByText('Waiting for you to recite').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
    // The tone returns: a new stream opens and receives audio.
    await expect.poll(() => streams.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => streams[1].bytes, { timeout: 10_000 }).toBeGreaterThan(0);
    const closedAt = streams[0].closed!;
    expect(closedAt - streams[0].opened).toBeGreaterThan(8_000);
  } finally {
    await page.getByRole('button', { name: 'Stop listening' }).click().catch(() => undefined);
  }
});
