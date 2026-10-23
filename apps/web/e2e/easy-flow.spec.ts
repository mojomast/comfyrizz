/**
 * UR36: Easy end-to-end on This computer.
 * Eight clicks from a new idea to the MP4, keyboard only, back keeps work,
 * and a reload on Review stays on Review. No paid run is allowed.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  assertNoPaidCalls,
  assertPrimaryWithinFiveTabs,
  clickCount,
  clickPrimary,
  openEasyNew,
  primary,
  watchPaidCalls,
} from './easy-helpers.ts';

const IDEA = 'A short film about a bakery window at dawn, warm and quiet.';

async function continueThroughQuestions(page: Page): Promise<void> {
  await clickPrimary(page);
  const questions = page.getByRole('heading', { name: 'A couple of quick questions' });
  const characters = page.getByRole('heading', { name: "Who's in it?" });
  await expect(questions.or(characters)).toBeVisible();
  if (await questions.count()) {
    await clickPrimary(page);
  }
  await expect(characters).toBeVisible();
}

async function reachReview(page: Page): Promise<void> {
  await page.locator('#easy-idea').fill(IDEA);
  await continueThroughQuestions(page);
  await clickPrimary(page);
  await expect(page.locator('[data-easy-heading]')).toHaveText('How many versions should we try?');
  await clickPrimary(page);
  await expect(page.locator('[data-easy-heading]')).toHaveText('Your plan', { timeout: 60_000 });
  await expect(primary(page)).toHaveText('Generate');
  await clickPrimary(page);
  await expect(page.locator('[data-easy-heading]')).toHaveText('Review your video', { timeout: 60_000 });
}

async function exportAndDownload(page: Page): Promise<void> {
  await expect(primary(page)).toHaveText('Export video');
  await clickPrimary(page);
  const link = page.getByRole('link', { name: 'Download MP4' });
  await expect(link).toBeVisible({ timeout: 180_000 });
  const download = page.waitForEvent('download');
  await link.click();
  expect((await download).suggestedFilename()).toMatch(/\.mp4$/);
}

test.beforeEach(async ({ page }) => {
  watchPaidCalls(page);
});

test('a new video reaches Download MP4 in at most 8 clicks', async ({ page }) => {
  test.setTimeout(240_000);
  await openEasyNew(page);
  await reachReview(page);
  await exportAndDownload(page);
  expect(await clickCount(page)).toBeLessThanOrEqual(8);
  assertNoPaidCalls();
});

test('the keyboard path keeps the primary within five tabs of the heading', async ({ page }) => {
  test.setTimeout(240_000);
  await openEasyNew(page);

  await assertPrimaryWithinFiveTabs(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('#easy-idea')).not.toHaveValue('');

  const questions = page.getByRole('heading', { name: 'A couple of quick questions' });
  const characters = page.getByRole('heading', { name: "Who's in it?" });
  await assertPrimaryWithinFiveTabs(page);
  await page.keyboard.press('Enter');
  await expect(questions.or(characters)).toBeVisible();
  if (await questions.count()) {
    await assertPrimaryWithinFiveTabs(page);
    await page.keyboard.press('Enter');
  }
  await expect(characters).toBeVisible();

  for (const heading of ['How many versions should we try?', 'Your plan', 'Review your video']) {
    await expect(primary(page)).toBeEnabled();
    await assertPrimaryWithinFiveTabs(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-easy-heading]')).toHaveText(heading, { timeout: 60_000 });
  }

  await expect(primary(page)).toBeEnabled();
  await assertPrimaryWithinFiveTabs(page);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'Download MP4' })).toBeVisible({ timeout: 180_000 });
  assertNoPaidCalls();
});

test('going back keeps the plan marked and the shots listed', async ({ page }) => {
  test.setTimeout(180_000);
  await openEasyNew(page);
  await reachReview(page);
  const shots = page.getByRole('listbox', { name: 'Shots' });
  const before = await shots.getByRole('option').count();
  expect(before).toBeGreaterThan(0);

  await page.locator('.stepper-step[data-step="idea"]').click();
  await expect(page.locator('[data-easy-heading]')).toHaveText("What's your video about?");
  await page.locator('#easy-idea').fill(`${IDEA} Add a morning greeting.`);
  await expect(page.locator('.stepper-step[data-step="plan"]')).toContainText('Needs update');

  await page.locator('.stepper-step[data-step="review"]').click();
  await expect(page.locator('[data-easy-heading]')).toHaveText('Review your video');
  await expect(shots.getByRole('option')).toHaveCount(before);
  assertNoPaidCalls();
});

test('a reload on Review lands on Review', async ({ page }) => {
  test.setTimeout(180_000);
  await openEasyNew(page);
  await reachReview(page);
  await page.reload();
  await expect(page.locator('[data-easy-heading]')).toHaveText('Review your video');
  assertNoPaidCalls();
});
