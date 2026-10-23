/**
 * UR38: Easy at phone widths. No horizontal scroll, the primary stays on
 * screen, and every visible control is at least 24 by 24.
 */
import { expect, test, type Page } from '@playwright/test';
import { clickPrimary, openEasyNew, primary } from './easy-helpers.ts';

const IDEA = 'A short film about a bakery window at dawn, warm and quiet.';
const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
] as const;

async function assertLayout(page: Page, step: string): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth, step).toBeLessThanOrEqual(metrics.innerWidth);

  const button = primary(page);
  const box = await button.boundingBox();
  expect(box, step).not.toBeNull();
  const viewport = page.viewportSize();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);

  const small = await page.locator('#easy-root').locator('button, a[href], input, select, textarea').evaluateAll((elements) => elements.flatMap((element) => {
    if (!(element instanceof HTMLElement)) return [];
    if (element.hidden || element.closest('[hidden]')) return [];
    if (element.closest('details:not([open])')) return [];
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return [];
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return [];
    if (rect.width >= 24 && rect.height >= 24) return [];
    const label = (element.getAttribute('aria-label') || element.textContent || element.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
    return [`${label} ${Math.round(rect.width)}x${Math.round(rect.height)}`];
  }));
  expect(small, `${step}: ${small.join(', ')}`).toEqual([]);
}

async function openStepperStep(page: Page, step: string): Promise<void> {
  const button = page.locator(`.stepper-step[data-step="${step}"]`);
  if (!(await button.isVisible())) {
    const compact = page.locator('.stepper-compact');
    await compact.click();
  }
  await button.click();
}

async function assertPlayer(page: Page): Promise<void> {
  const player = page.locator('[data-easy-player]').first();
  await expect(player).toBeVisible();
  const box = await player.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan((viewport?.width ?? 0) * 0.9);
  const ratio = box!.width / box!.height;
  expect(ratio).toBeGreaterThan(1.6);
  expect(ratio).toBeLessThan(1.9);
  const position = await player.evaluate((element) => getComputedStyle(element).position);
  expect(position).toBe('sticky');
}

async function walk(page: Page): Promise<void> {
  await openEasyNew(page);
  await assertLayout(page, 'idea');
  await page.locator('#easy-idea').fill(IDEA);
  await clickPrimary(page);
  const questions = page.getByRole('heading', { name: 'A couple of quick questions' });
  const characters = page.getByRole('heading', { name: "Who's in it?" });
  await expect(questions.or(characters)).toBeVisible();
  if (await questions.count()) {
    await assertLayout(page, 'questions');
    await clickPrimary(page);
  }
  await expect(page.locator('[data-easy-heading]')).toHaveText("Who's in it?");
  await assertLayout(page, 'characters');
  await clickPrimary(page);
  await expect(page.locator('[data-easy-heading]')).toHaveText('How many versions should we try?');
  await assertLayout(page, 'level');
  await clickPrimary(page);
  await expect(page.locator('[data-easy-heading]')).toHaveText('Your plan', { timeout: 60_000 });
  await assertLayout(page, 'plan');
  await assertPlayer(page);
  await expect(primary(page)).toHaveText('Generate');
  await clickPrimary(page);
  await expect(page.locator('[data-easy-heading]')).toHaveText('Review your video', { timeout: 60_000 });
  await assertLayout(page, 'review');
  await assertPlayer(page);
  const generate = page.locator('.stepper-step[data-step="generate"]');
  if (await generate.isEnabled()) {
    await openStepperStep(page, 'generate');
    await expect(page.locator('[data-easy-heading]')).toHaveText('Making your video');
    await assertLayout(page, 'generate');
    await assertPlayer(page);
    await openStepperStep(page, 'review');
  }
  await expect(primary(page)).toHaveText('Export video');
  await clickPrimary(page);
  await expect(page.locator('[data-easy-heading]')).toHaveText('Export');
  await assertLayout(page, 'export');
  await assertPlayer(page);
}

for (const viewport of VIEWPORTS) {
  test(`studio layout holds at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(viewport);
    await walk(page);
  });
}
