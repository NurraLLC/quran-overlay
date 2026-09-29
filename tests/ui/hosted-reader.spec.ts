// Hosted browser flow through the actual audio relay. All provider/payment endpoints are local
// stand-ins; the microphone is a tone, never generated Quran recitation or the owner's microphone.
import { test, expect } from '@playwright/test';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { SessionHub } from '../../src/server/billing/hub';
import { StripeBilling, signForTest } from '../../src/server/billing/stripe';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { fullCorpus } from '../helpers';

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }, viewport: { width: 390, height: 844 } });

test('shared lifetime totals, donation readback, and browser audio through the protected relay', async ({ page }) => {
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((r) => probe.on('listening', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => provider.on('listening', r));
  let bytes = 0;
  provider.on('connection', (s) => s.on('message', (d, binary) => { if (binary) bytes += (d as Buffer).length; }));
  const { corpus, ix } = fullCorpus();
  const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 1200, holdMinSeconds: 20, poolDailySecondsPerVisitor: 7200 });
  credits.grantPool(100 * 3600, 'fixture-funding');
  const past = Date.now() - 2 * 86_400_000;
  for (let i = 0; i < 75; i++) { credits.reserve(`fixture-${i}`, `fixture-ip-${i}`, past); credits.settle(`fixture-${i}`, past + 1200_000); }
  const resolver = new CommandResolver(corpus, null, null);
  const hub = new SessionHub(() => new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => `${base}/quran-reader/overlay#view=${v}` }));
  let checkout: URLSearchParams | null = null;
  const billing = new StripeBilling('test-only', 'webhook-test-only', (async (_u, init) => {
    checkout = new URLSearchParams(String(init?.body));
    return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/test-only' }));
  }) as typeof fetch);
  const { app } = await buildApp({ port, basePath: '/quran-reader', sonioxApiKey: 'test-only',
    speechEndpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`,
    fetchImpl: (async () => new Response(JSON.stringify({ api_key: 'provider-key-never-in-browser', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as typeof fetch,
    hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 9)), billing },
  });
  await app.listen({ host: '127.0.0.1', port });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.route('https://checkout.stripe.com/test-only', (r) => r.fulfill({ body: 'Test checkout only' }));
    await page.goto(`${base}/quran-reader/`);
    const panel = page.getByRole('region', { name: 'Sponsored recitation hours' });
    await expect(panel).toContainText('100 h');
    await expect(panel).toContainText('25 h');
    await expect(panel).toContainText('75 h');
    await expect(panel).not.toContainText(/month|goal|plan|bought/i);
    await page.screenshot({ path: 'test-results/support-entry-phone.png' });
    await panel.getByRole('button', { name: /Support Quran Reader/ }).click();
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: 'test-results/community-hours-fixture.png' });
    await page.locator('.r-support-nav').getByRole('button', { name: /Support Quran Reader/ }).click();
    const support = page.getByRole('dialog', { name: 'Support Quran Reader' });
    await expect(support).toContainText('not tax-deductible');
    await expect(support.getByRole('status')).toContainText('Test checkout — no real money');
    await page.route('**/api/billing/donate', (r) => r.fulfill({ status: 502, json: { error: 'The payment page could not be opened. Please try again.' } }), { times: 1 });
    await support.getByRole('button', { name: '$10 Add 76 shared hours' }).click();
    await expect(support.getByRole('alert')).toContainText('Please try again');
    await support.getByRole('button', { name: '$10 Add 76 shared hours' }).click();
    await expect(page).toHaveURL('https://checkout.stripe.com/test-only');
    expect(checkout!.get('line_items[0][price_data][unit_amount]')).toBe('1000');
    expect(checkout!.get('line_items[0][price_data][product_data][description]')).toContain('Nurra LLC');
    const event = JSON.stringify({ id: 'event-test-gift', type: 'checkout.session.completed', data: { object: { id: 'checkout-test-gift', payment_status: 'paid', metadata: { kind: 'donation', amount: '1000' }, amount_total: 1000, currency: 'usd' } } });
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/quran-reader/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signForTest(event, 'webhook-test-only') }, body: event });
      expect(response.ok).toBe(true);
    }
    await page.goto(`${base}/quran-reader/?donated=1`);
    await expect(panel).toContainText('176 h'); // webhook replay never adds it twice
    await expect(panel).toContainText('151 h');
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    await expect.poll(() => bytes).toBeGreaterThan(0); // real browser SDK -> app -> local provider
    await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
    await expect.poll(() => provider.clients.size).toBe(0);
    expect(credits.poolStats().used).toBeGreaterThan(25 * 3600);
    // Unconfigured payments must remain discoverable without pretending checkout is available.
    await page.route('**/api/me', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), billing: null } });
    });
    await page.reload();
    await page.locator('.r-support-nav').getByRole('button', { name: /Support Quran Reader/ }).click();
    await expect(support.getByRole('status')).toContainText('Online contributions aren’t open yet');
    await page.screenshot({ path: 'test-results/support-unavailable-phone.png' });
    await expect(support.getByRole('button', { name: /\$10/ })).toHaveCount(0);
    await support.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(support).toHaveCount(0);
    await page.goto(`${base}/quran-reader/about`);
    await page.screenshot({ path: 'test-results/about-community-phone.png', fullPage: true });
    await page.getByRole('link', { name: /Support Quran Reader/ }).click();
    await expect(page).toHaveURL(/about#support$/);
    await expect(page.getByRole('heading', { name: 'Support Quran Reader' })).toBeInViewport();
    await expect(page.getByRole('link', { name: /Open the overlay controls/ })).toHaveAttribute('href', '/quran-reader/control');
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await app.close();
    for (const s of provider.clients) s.terminate();
    await new Promise<void>((r) => provider.close(() => r()));
    credits.close();
  }
});
