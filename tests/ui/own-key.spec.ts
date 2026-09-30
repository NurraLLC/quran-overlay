// A streamer's own Soniox key on the control page, in a real browser through the hosted server and
// its relay (the recogniser is a local stand-in; the microphone is a tone): saving the key shows it
// is in use, a key Soniox refuses does not stop listening (it carries on with the shared hours and
// says why), and the key can be removed.
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { fullCorpus } from '../helpers';

const OWN = 'streamer-own-key-0123456789abcdef';

/** 16 kHz mono WAV: a steady voice-like tone (the fake microphone). */
function tone(): string {
  const rate = 16_000;
  const samples = 30 * rate;
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
  for (let t = 0; t < samples; t++) buf.writeInt16LE(Math.round(0.3 * Math.sin((2 * Math.PI * 220 * t) / rate) * 32767), 44 + t * 2);
  const file = path.join(tmpdir(), 'qo-own-key.wav');
  writeFileSync(file, buf);
  return file;
}

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${tone()}`, '--autoplay-policy=no-user-gesture-required'] }, viewport: { width: 1440, height: 900 } });

test('own Soniox key: shown in use, a refused key falls back to the shared hours, and it can be removed', async ({ page }) => {
  test.setTimeout(60_000);
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((r) => probe.on('listening', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => provider.on('listening', r));
  provider.on('connection', (s) => s.once('message', () => {
    let ms = 0;
    const t = setInterval(() => (s.readyState === s.OPEN ? s.send(JSON.stringify({ tokens: [], final_audio_proc_ms: ms, total_audio_proc_ms: (ms += 500) })) : clearInterval(t)), 500);
  }));
  const { corpus, ix } = fullCorpus();
  const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 1200, holdMinSeconds: 20, poolDailySecondsPerVisitor: 7200 });
  credits.grantPool(100 * 3600, 'fixture-funding');
  const resolver = new CommandResolver(corpus, null, null);
  const hub = new SessionHub(() => new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => `${base}/overlay#view=${v}` }));
  // Soniox's key service stand-in: the streamer's key is refused, the service's own key works.
  const accounts: string[] = [];
  const { app } = await buildApp({ port, sonioxApiKey: 'service-key-not-real', speechEndpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`,
    fetchImpl: (async (_u: string, init: RequestInit) => {
      const account = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
      accounts.push(account);
      if (account === OWN) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ api_key: 'provider-key-never-in-browser', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
    }) as unknown as typeof fetch,
    hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 8)) },
  });
  await app.listen({ host: '127.0.0.1', port });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/control`);
    await page.waitForSelector('.topbar');
    const section = page.locator('details.own-key');
    await section.locator('summary').click();
    await expect(section.getByRole('button', { name: 'Use it' })).toBeDisabled();
    await section.getByLabel('Your Soniox API key').fill(OWN);
    await section.getByRole('button', { name: 'Use it' }).click();
    await expect(section.locator('summary')).toHaveText('Using your own Soniox key');
    await expect(section.getByText('Key ending …cdef')).toBeVisible();
    await expect(page.getByText('Your own Soniox key · no time limit')).toBeVisible();
    await expect(section.getByLabel('Your Soniox API key')).toHaveCount(0); // the key is not shown again
    await page.screenshot({ path: 'test-results/own-key-saved.png' });

    await page.getByRole('button', { name: 'Start listening' }).click();
    await page.getByRole('dialog', { name: 'Before you turn on the microphone' }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    // Soniox refuses the key: listening carries on with the shared hours, and says why.
    const hint = page.locator('.voice-card .hint').first();
    await expect(hint).toContainText('Soniox did not accept your own key', { timeout: 15_000 });
    await expect(hint).toContainText('Listening continues on the shared hours.');
    await expect(section.locator('summary')).toHaveText('Your own Soniox key isn’t working');
    await expect(section.getByText('Listening uses the shared hours meanwhile.')).toBeVisible();
    await expect(page.getByText('Your own Soniox key · no time limit')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
    await expect.poll(() => accounts).toEqual([OWN, 'service-key-not-real']);
    await page.screenshot({ path: 'test-results/own-key-refused.png' });

    await section.getByRole('button', { name: 'Remove' }).click();
    await expect(section.locator('summary')).toHaveText('Your own Soniox key (optional)');
    expect(await page.evaluate(() => localStorage.getItem('qo.ownSonioxKey'))).toBeNull();
    await page.getByRole('button', { name: 'Stop listening' }).click();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await new Promise<void>((r) => provider.close(() => r()));
    credits.close();
  }
});
