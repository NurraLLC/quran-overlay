// The charity stream scene end to end in Edge: the control page's Charity stream card sets it up, the
// scene shows the reader in its panel with the project, the total and a QR code, donations added on
// the control page are announced on stream one at a time, the arch leaves a see-through window for
// the camera, and a long ayah pages inside the panel. Screenshots: test-results/stream-*.png.
import { expect, test, type Page } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';

/** The alpha of the scene's pixel at (x, y): 0 where OBS shows the source underneath. */
async function alphaAt(page: Page, x: number, y: number) {
  const png = await page.screenshot({ clip: { x, y, width: 2, height: 2 }, omitBackground: true });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, 1, 1).data[3];
  }, png.toString('base64'));
}

test('charity stream: set up on the control page, live on the stream scene', async ({ browser }) => {
  test.setTimeout(90_000);
  const c = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  await c.goto(`/control#owner=${OWNER}`);
  await c.waitForSelector('.topbar');
  const card = c.locator('.charity-card');
  await expect(card).toBeVisible();
  await card.getByLabel('Partner (who receives the donations)').fill('Water for All');
  await card.getByLabel('Project', { exact: true }).fill('Clean water wells');
  await card.getByLabel('Where', { exact: true }).fill('Niger');
  await card.getByLabel('What a donation provides (one line)').fill('A well gives a village clean water for years');
  await card.getByLabel('Donation link (their page, https://…)').fill('http://example.org/give');
  await expect(card.getByText('The donation link must start with https://')).toBeVisible();
  await card.getByLabel('Donation link (their page, https://…)').fill('https://example.org/give');
  await card.getByLabel('Goal', { exact: true }).fill('5000');
  await card.getByLabel('Reciter’s name (under the camera)').fill('The reciter');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByRole('button', { name: 'Saved' })).toBeVisible();
  await card.getByRole('button', { name: 'Start the clock' }).click();
  await expect(card.getByText(/Clock started/)).toBeVisible();

  const find = c.getByLabel('Type a reference or what the ayah says');
  await find.fill('76:8');
  await find.press('Enter');

  const streamUrl = (await card.getByRole('link', { name: 'Open the stream scene' }).getAttribute('href'))!;
  expect(streamUrl).toContain('/stream#view=');
  const s = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  s.on('pageerror', (e) => errors.push(e.message));
  await s.goto(streamUrl.replace(/^http:\/\/[^/]+/, ''));
  await expect(s.locator('.cs-reader .verse')).toHaveAttribute('aria-label', /76:8/, { timeout: 15_000 });
  await expect(s.locator('.cs-title-for')).toHaveText('for Water for All');
  await expect(s.locator('.cs-project-title')).toHaveText('Clean water wells in Niger');
  await expect(s.locator('.cs-hour')).toHaveText('Hour 1 of 24');
  await expect(s.locator('.cs-nameplate')).toHaveText('The reciter');
  await expect(s.locator('.cs-qr')).toBeVisible();
  await expect(s.locator('.cs-give-link')).toHaveText('example.org/give');
  await expect(s.locator('.cs-slot-empty')).toContainText('Be the first to give');
  await s.waitForTimeout(500);
  await s.screenshot({ path: 'test-results/stream-ready.png' });

  // The arch's window is see-through (the camera under the page in OBS shows there); the ground is not.
  expect(await alphaAt(s, 272, 330)).toBe(0);
  expect(await alphaAt(s, 60, 600)).toBe(255);
  expect(await alphaAt(s, 900, 500)).toBe(255);

  // A donation on the control page is announced on stream.
  await card.getByLabel('Donor’s name').fill('Aisha');
  await card.getByLabel('Amount', { exact: true }).fill('50');
  await card.getByRole('button', { name: 'Announce on stream' }).click();
  await expect(s.locator('.cs-slot-new')).toContainText('Aisha’s donation');
  await expect(s.locator('.cs-total-amount')).toHaveText('$50');
  await expect(s.locator('.cs-total-note')).toHaveText('of the $5,000 goal · 1 donor');
  await s.waitForTimeout(900);
  await s.screenshot({ path: 'test-results/stream-announcing.png' });

  // A second, anonymous, with the donor's words: it waits its turn, then is announced.
  await card.getByLabel('The donor’s words').fill('For my late father');
  await card.getByLabel('Amount', { exact: true }).fill('20');
  await card.getByRole('button', { name: 'Announce on stream' }).click();
  await expect(s.locator('.cs-slot-new')).toContainText('Aisha’s donation');
  await expect(s.locator('.cs-slot-new')).toContainText('this donation', { timeout: 15_000 });
  await expect(s.locator('.cs-slot-new')).toContainText('“For my late father”');
  await expect(s.locator('.cs-recent-name')).toHaveText(['Aisha']);
  await expect(s.locator('.cs-total-amount')).toHaveText('$70');
  await s.waitForTimeout(900);
  await s.screenshot({ path: 'test-results/stream-anonymous.png' });
  // Then it settles (navy, with how long ago).
  await expect(s.locator('.cs-slot')).not.toHaveClass(/cs-slot-new/, { timeout: 12_000 });
  await expect(s.locator('.cs-slot-when')).toHaveText(/just now|1 min/);

  // A long ayah pages inside the panel, with its continuation marked.
  await find.fill('2:282');
  await find.press('Enter');
  await expect(s.locator('.cs-reader .verse')).toHaveAttribute('aria-label', /2:282/, { timeout: 15_000 });
  await expect(s.locator('.cs-reader .cont').first()).toBeVisible();
  await s.waitForTimeout(500);
  await s.screenshot({ path: 'test-results/stream-long-ayah.png' });

  // The streamer can take a mistaken donation back.
  await card.getByRole('button', { name: 'Remove Aisha donation' }).click();
  await expect(s.locator('.cs-total-amount')).toHaveText('$20');
  expect(errors).toEqual([]);
});
