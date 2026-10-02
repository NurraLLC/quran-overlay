import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OWNER = 'ui-test-owner-capability-0001';
const evidence = process.env.QO_USABILITY_EVIDENCE || 'test-results/reader-usability';
test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
test.beforeAll(() => mkdirSync(evidence, { recursive: true }));

async function home(page: Page) {
  await page.getByRole('button', { name: /^Menu/ }).click();
  await page.getByRole('button', { name: /^Home/ }).click();
}

test('the surah picker shows a failed load and retries in place', async ({ page }) => {
  await page.route('**/api/chapters', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  // A shared session may already be reading; Home always exposes the index.
  await home(page);
  await page.locator('.r-brand').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/surahs-failed.png` });
  const index = page.getByRole('region', { name: 'All surahs' });
  await expect(index.getByText("Couldn't load the surahs.")).toBeVisible();
  await page.unroute('**/api/chapters');
  await index.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByLabel('Find a surah')).toBeVisible();
  await page.getByLabel('Find a surah').fill('112');
  await page.getByRole('button', { name: '112. Al-Ikhlas, 4 ayahs' }).click();
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:1');
});

test('requesting the current surah from Home returns to the reading page', async ({ page }) => {
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  const request = async () => {
    await page.getByRole('button', { name: 'Type instead' }).click();
    await page.getByLabel('Type a request').fill('112:1');
    await page.getByLabel('Type a request').press('Enter');
  };
  await request();
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:1');
  await home(page);
  await request();
  await expect(page.getByText('Opened 112:1.', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/reopen-current.png` });
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:1');
  await expect(page.locator('.r-welcome')).toHaveCount(0);
});

test('a private spoken search keeps Home open and leaves the displayed ayah unchanged', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).endsWith('/ws/control')) Object.assign(window, { readerTestSocket: this });
      }
    };
  });
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  await page.getByRole('button', { name: 'Type instead' }).click();
  await page.getByLabel('Type a request').fill('112:1');
  await page.getByLabel('Type a request').press('Enter');
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:1');
  await home(page);
  const card = await (await page.request.get('/api/verse/2:153')).json();
  // Replay server messages for a source-owned candidate without opening a microphone/provider.
  await page.evaluate((candidate) => {
    const socket = (window as unknown as { readerTestSocket: WebSocket }).readerTestSocket;
    const frame = (data: unknown) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
    frame({ type: 'command_pending', requestId: 'listen:private-preview' });
    frame({ type: 'command_result', requestId: 'listen:private-preview', result: { kind: 'candidates', cards: [candidate], confirmedKey: candidate.key, status: 'Preview', refining: false } });
  }, card);
  await expect(page.locator('.r-results')).toContainText('2:153');
  await expect(page.locator('.r-welcome')).toBeVisible();
  await page.getByRole('button', { name: 'Continue at Al-Ikhlas 112:1' }).click();
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:1');
});

test('Menu contains keyboard focus, closes with Escape and returns focus', async ({ page }) => {
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  const opener = page.getByRole('button', { name: /^Menu/ });
  await opener.click();
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
  await expect(menu).toBeVisible();
  await page.screenshot({ path: `${evidence}/menu.png` });
  // Browser-native focus cycling can briefly focus the dialog/document; it must never reach
  // the reader's language, typing or microphone controls behind the menu.
  const escaped: string[] = [];
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Tab');
    const leak = await page.evaluate(() => {
      const active = document.activeElement;
      return active && active !== document.body && !active.closest('[aria-label="Menu"]')
        ? active.getAttribute('aria-label') || active.textContent?.trim() || active.tagName : null;
    });
    if (leak) escaped.push(leak);
  }
  expect(escaped).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('moving from Menu to Listening returns focus to the persistent menu button', async ({ page }) => {
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), mode: 'hosted', credits: { available: 3600, freePerMonth: 0, pool: 3600, limitedBy: null } } });
  });
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  const opener = page.getByRole('button', { name: /^Menu/ });
  await opener.click();
  await page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('button', { name: /^Listening/ }).click();
  await expect(page.getByRole('dialog', { name: 'Listening', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('About never guesses a direct audio route while hosted mode is pending or unavailable', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/me', async (route) => {
    await delayed;
    await route.fulfill({ json: { mode: 'hosted', owner: true } });
  });
  try {
    await page.goto('/about', { waitUntil: 'domcontentloaded' });
    const how = page.locator('section', { has: page.getByRole('heading', { name: 'How it works' }) });
    await expect(how).toContainText('Audio is sent to Soniox for recognition.');
    await expect(how).not.toContainText('directly');
    release();
    await expect(how).toContainText('passes through Nurra');
    await expect(how).not.toContainText('directly');
    await expect(how).toContainText('does not save audio or transcripts to disk');
    await expect(how).toContainText('OpenRouter or TypeSafe');
    await page.screenshot({ path: `${evidence}/privacy-about.png`, fullPage: true });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await page.route('**/api/me', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.reload();
  await expect(page.getByText('Audio is sent to Soniox for recognition.', { exact: false })).toBeVisible();
  await expect(page.locator('.about-page')).not.toContainText('directly');
});

test('a typed request exposes a compact privacy cue and Help is separate from support', async ({ page }) => {
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  await page.getByRole('button', { name: 'Type instead' }).click();
  const cue = page.locator('#reader-request-privacy');
  await expect(cue).toContainText('OpenRouter or TypeSafe');
  await expect(page.getByLabel('Type a request')).toHaveAttribute('aria-describedby', 'reader-request-privacy');
  await expect(cue.getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute('href', '/privacy.html');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/typed-request.png` });
  await page.getByRole('button', { name: /^Menu/ }).click();
  await expect(page.getByRole('link', { name: 'Help or report a problem' })).toHaveAttribute('href', 'https://github.com/NurraLLC/quran-reader/issues');
});
