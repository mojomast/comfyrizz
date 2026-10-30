import { expect, test, type Page } from '@playwright/test';
import { loadEnv } from './easy-helpers.ts';

function watchGeneration(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/(run|agent|pipelines|self-repairs)/.test(request.url())) calls.push(request.url());
  });
  return calls;
}

test('landing never paints the editor while JavaScript loads, even after an editor visit', async ({ page }) => {
  const env = loadEnv();
  const calls = watchGeneration(page);
  await page.addInitScript(() => {
    localStorage.setItem('comfyrizz.ui', JSON.stringify({ mode: 'advanced' }));
  });
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/src/main.ts', async route => { await ready; await route.continue(); });
  await page.goto(`/#token=${env.token}`, { waitUntil: 'commit' });
  try {
    await expect(page.locator('.app-launch')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    await expect(page.locator('#easy-root')).toBeHidden();
  } finally { release(); }
  await expect(page.locator('[data-super-easy-home]')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('.app-launch')).toBeHidden();
  await expect(page).not.toHaveURL(/token=/);
  await page.screenshot({ path: test.info().outputPath('landing-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('landing-mobile.png'), fullPage: true });
  expect(calls).toEqual([]);
});

test('video types are collapsed, keyboard operable, and preserve the draft when selected', async ({ page }) => {
  const env = loadEnv();
  const calls = watchGeneration(page);
  await page.goto(`/#token=${env.token}`);
  const types = page.locator('[data-super-easy-type-disclosure]');
  await expect(types).toBeVisible();
  await expect(types).not.toHaveAttribute('open', '');
  const prompt = page.locator('#super-easy-prompt');
  await prompt.fill('Keep my exact idea about a tiny robot making tea.');
  await types.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(types).toHaveAttribute('open', '');
  await page.locator('[data-super-easy-video-type][value="music-video"]').check();
  await expect(page.locator('[data-super-easy-type-summary]')).toHaveText('Music video');
  await expect(prompt).toHaveValue('Keep my exact idea about a tiny robot making tea.');
  await expect(page.locator('[data-super-easy-song-trim]')).toBeVisible();
  await types.locator('summary').click();
  await expect(types).not.toHaveAttribute('open', '');
  await expect(page.locator('[data-super-easy-type-summary]')).toHaveText('Music video');
  await expect(page.locator('[data-super-easy-video-types]')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(calls).toEqual([]);
});

test('an explicit editor link still opens the editor', async ({ page }) => {
  const env = loadEnv();
  await page.goto(`/?view=editor&package=${env.packageId}#token=${env.token}`);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#easy-root')).toBeHidden();
  await expect(page.locator('.app-launch')).toBeHidden();
});
