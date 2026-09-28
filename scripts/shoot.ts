// Developer capture: render the real overlay at 1920×1080 in installed Edge and save full frames
// plus optional crops. Usage: tsx scripts/shoot.ts <overlayUrl> <outPrefix> [x,y,w,h ...]
import { chromium } from '@playwright/test';

const [url, out, ...crops] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(url);
await page.waitForSelector('.panel-on .verse, .overlay-denied', { timeout: 8000 }).catch(() => undefined);
await page.waitForTimeout(400);
console.log('text:', (await page.locator('body').innerText()).slice(0, 80).replace(/\s+/g, ' '));
await page.screenshot({ path: `${out}.png` });
for (const [i, c] of crops.entries()) {
  const [x, y, width, height] = c.split(',').map(Number);
  await page.screenshot({ path: `${out}-crop${i}.png`, clip: { x, y, width, height } });
}
await browser.close();
