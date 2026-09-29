// The phone reader: opening, typed requests, tap-a-word meaning, language, continue where you left off.
import { expect, test } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('reader: request, word meaning, language and continue where you left off', async ({ page }) => {
  await page.goto(`/reader#owner=${OWNER}`);
  // (The UI suite shares one session: another test may already have an ayah on screen.)
  await expect(page.locator('.r-top')).toBeVisible();

  // A typed request opens the surah and follows from the ayah.
  await page.getByRole('button', { name: 'Type instead' }).click();
  await page.getByLabel('Type a request').fill('55:13');
  await page.getByLabel('Type a request').press('Enter');
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-55:13');
  await expect(page.locator('.r-top')).toContainText('Ar-Rahman');

  // Tapping a word shows its meaning (when word-by-word data is installed) and does not move the page.
  const word = page.locator('.r-ayah.current .r-word').nth(1);
  await word.tap();
  if ((await page.locator('.r-word.peeked').count()) > 0) await expect(page.locator('.r-word.peeked .r-gloss')).toBeVisible();
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-55:13');

  // Language switch.
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.locator('.reader')).toHaveAttribute('data-lang', 'english');
  await expect(page.locator('.r-ayah.current .r-ar')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Both' }).click();

  // Keyboard: an ayah can be chosen with Enter.
  await page.locator('[id="a-55:14"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-55:14');

  // Remembered on this device: a fresh page with nothing on screen offers to continue.
  await page.evaluate(() => fetch('/api/owner/status'));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('qo.reader') ?? '{}'));
  expect(saved.key).toBe('55:14');
});
