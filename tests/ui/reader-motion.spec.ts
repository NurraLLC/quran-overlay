import { expect, test, type Page } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';

async function reading(page: Page) {
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  await page.getByRole('button', { name: 'Type instead' }).click();
  await page.getByLabel('Type a request').fill('112:1');
  await page.getByLabel('Type a request').press('Enter');
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:1');
  await page.getByRole('button', { name: 'Type instead' }).click();
  await page.getByRole('radio', { name: 'Both', exact: true }).click();
}

test('overlay frame changes keep the Quran at full size and publish one complete ayah', async ({ browser }, info) => {
  const context = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width: 1920, height: 1080 }, recordVideo: { dir: info.outputPath('overlay-video'), size: { width: 1920, height: 1080 } } });
  const control = await context.newPage();
  await control.goto(`/control#owner=${OWNER}`);
  const output = control.locator('.card', { has: control.getByRole('heading', { name: 'Stream output' }) });
  await output.getByRole('button', { name: /^Reading/ }).click();
  await output.getByText('Text size, colour and details', { exact: true }).click();
  await output.getByRole('checkbox', { name: 'Show short ayahs together (full frame)' }).uncheck();
  await control.getByLabel('Type a reference or what the ayah says').fill('112:1');
  await control.getByLabel('Type a reference or what the ayah says').press('Enter');
  await expect(control.locator('.preview .verse')).toHaveAttribute('aria-label', /112:1$/);
  const audience = await context.newPage();
  await audience.goto((await output.getByRole('link', { name: 'Open reading screen' }).getAttribute('href'))!);
  await expect(audience.locator('.next-ayah')).toBeVisible();
  await audience.waitForTimeout(650);
  const probe = audience.evaluate(() => new Promise<{ key: string | null; transform: string; opacity: string; english: string | null; animation: string }[]>((resolve) => {
    const samples: { key: string | null; transform: string; opacity: string; english: string | null; animation: string }[] = [];
    const frame = () => {
      const article = document.querySelector('.verse')!;
      const css = getComputedStyle(article);
      samples.push({ key: article.getAttribute('aria-label'), transform: css.transform, opacity: css.opacity, english: article.querySelector('.english')?.textContent || null, animation: css.animationName });
      if (samples.length < 45) requestAnimationFrame(frame); else resolve(samples);
    };
    requestAnimationFrame(frame);
  }));
  await control.getByRole('button', { name: 'Next ayah ›', exact: true }).click();
  const frames = await probe;
  await expect(audience.locator('.verse')).toHaveAttribute('aria-label', /112:2$/);
  const source = await (await control.request.get('/api/verse/112:2')).json();
  const { toQpcHafsEncoding } = await import('../../src/shared/display-encoding');
  expect((await audience.locator('.arabic .quran-word').allTextContents()).join(' ')).toBe(toQpcHafsEncoding(source.arabic));
  expect((await audience.locator('.english .line').allTextContents()).join(' ')).toBe(source.english);
  await info.attach('overlay-frames', { body: JSON.stringify(frames, null, 2), contentType: 'application/json' });
  await audience.waitForTimeout(650);
  await audience.screenshot({ path: info.outputPath('overlay-settled.png') });
  await control.getByRole('button', { name: 'Hide from stream', exact: true }).click();
  await expect(audience.locator('.panel')).toHaveAttribute('aria-hidden', 'true');
  await control.getByRole('button', { name: 'Unhide', exact: true }).click();
  await expect(audience.locator('.panel-on .verse')).toHaveAttribute('aria-label', /112:2$/);
  await audience.waitForTimeout(450);
  await context.close();
  const changed = frames.filter((f) => f.key?.endsWith('112:2'));
  expect(changed.length).toBeGreaterThan(3);
  expect(changed.every((f) => f.transform === 'none' && f.opacity === '1' && f.animation === 'none')).toBe(true);
  expect(changed.every((f) => f.english?.startsWith(source.english))).toBe(true);
});

async function appearance(page: Page) {
  await page.getByRole('button', { name: /^Menu/ }).click();
  await page.getByRole('button', { name: /^Reading appearance/ }).click();
  return page.getByRole('dialog', { name: 'Your reading page' });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test.describe(`reader controls at ${viewport.width}px`, () => {
    test.use({ viewport, reducedMotion: 'no-preference' });

    test('record the complete control journey at normal speed', async ({ page }, info) => {
      // Real browser recording; holds leave each choice readable. No speech or simulated following.
      await reading(page);
      await page.waitForTimeout(650);
      await page.getByRole('button', { name: /^Menu/ }).click();
      await page.waitForTimeout(650);
      await page.screenshot({ path: info.outputPath('menu.png') });
      await page.getByRole('button', { name: /^Reading appearance/ }).click();
      await page.waitForTimeout(650);
      await page.getByRole('radio', { name: /Paper/ }).click();
      await page.waitForTimeout(650);
      await page.screenshot({ path: info.outputPath('paper.png') });
      await page.getByRole('radio', { name: /Night/ }).click();
      await page.waitForTimeout(650);
      await page.getByRole('button', { name: 'Return to reading' }).click();
      await expect(page.getByRole('button', { name: /^Menu/ })).toBeFocused();
      await page.waitForTimeout(500);
      await page.getByRole('radio', { name: 'English', exact: true }).click();
      await page.waitForTimeout(650);
      await page.getByRole('radio', { name: 'Both', exact: true }).click();
      await page.waitForTimeout(650);
      await page.screenshot({ path: info.outputPath('reading.png') });
    });

    test('entrances remain cancellable, focus stays contained and reopening starts cleanly', async ({ page }) => {
      await reading(page);
      const opener = page.getByRole('button', { name: /^Menu/ });
      for (let i = 0; i < 4; i++) {
        await opener.focus();
        await opener.dispatchEvent('click'); // Interrupt before Playwright waits for animation stability.
        await expect(page.locator('.r-modal[open]')).toHaveCount(1);
        const entrance = await page.locator('.r-time').evaluate((el) => ({
          running: el.getAnimations().some((animation) => animation.playState === 'running'),
          modalScroll: el.closest('dialog')!.scrollHeight - el.closest('dialog')!.clientHeight,
        }));
        expect(entrance.running).toBe(true);
        expect(entrance.modalScroll).toBe(0);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(opener).toBeFocused();
      }
      await appearance(page);
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press(i % 3 ? 'Tab' : 'Shift+Tab');
        expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest('dialog[open]'))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(opener).toBeFocused();
      await appearance(page);
      // Native backdrop dismissal must remove the entire surface immediately.
      await page.locator('.r-reading-dialog').dispatchEvent('click');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(opener).toBeFocused();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(false);
    });

    test('rapid choices preserve the final state and leave scripture at its measured position', async ({ page }) => {
      await reading(page);
      const source = await (await page.request.get('/api/surah/112')).json();
      const arabic = await page.locator('.r-ar').allTextContents();
      const rects = await page.locator('.r-ayah').evaluateAll((els) => els.map((el) => ({ x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width })));
      await appearance(page);
      await page.getByRole('radio', { name: /Paper/ }).dispatchEvent('click');
      await page.getByRole('radio', { name: /Night/ }).dispatchEvent('click');
      await page.getByRole('radio', { name: /Paper/ }).dispatchEvent('click');
      await expect(page.getByRole('radio', { name: /Paper/ })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      for (const label of ['English', 'Both', 'عربي', 'Both']) {
        const choice = page.getByRole('radio', { name: label, exact: true });
        await choice.dispatchEvent('click');
        await expect(choice).toHaveAttribute('aria-checked', 'true');
      }
      await expect(page.locator('.r-en')).toHaveText(source.ayahs.map((a: { english: string }) => a.english));
      expect(await page.locator('.r-ar').allTextContents()).toEqual(arabic);
      expect(await page.locator('.r-ayah').evaluateAll((els) => els.map((el) => ({ x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width })))).toEqual(rects);
      expect(await page.locator('.r-ar, .r-en').evaluateAll((els) => els.every((el) => getComputedStyle(el).animationName === 'none' && getComputedStyle(el).transform === 'none'))).toBe(true);
      await page.reload();
      await expect(page.locator('.reader')).toHaveAttribute('data-theme', 'paper');
      await expect(page.getByRole('radio', { name: 'Both', exact: true })).toHaveAttribute('aria-checked', 'true');
    });

    test('reduced motion also cancels an entrance already in progress', async ({ page }) => {
      await reading(page);
      await page.getByRole('button', { name: /^Menu/ }).dispatchEvent('click');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(await page.locator('.r-time').evaluate((el) => el.getAnimations().length)).toBe(0);
      await page.getByRole('button', { name: /^Reading appearance/ }).click();
      expect(await page.locator('.r-reading-dialog').evaluate((el) => el.getAnimations().length)).toBe(0);
      await page.getByRole('radio', { name: /Paper/ }).click();
      expect(await page.getByRole('radio', { name: /Paper/ }).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: /^Menu/ })).toBeFocused();
      await page.getByRole('radio', { name: 'English', exact: true }).click();
      expect(await page.getByRole('radio', { name: 'English', exact: true }).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
      await expect(page.locator('.r-ar')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  });
}
