/**
 * UR37: Easy accessibility. Axe on every step and dialog, focus returns,
 * and each step keeps a small set of visible controls.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { clickPrimary, openEasyNew, primary } from './easy-helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const IDEA = 'A short film about a bakery window at dawn, warm and quiet.';

async function axe(page: Page, include: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include(include).withTags(TAGS).analyze();
  const blocking = results.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical');
  expect(blocking.map((item) => ({
    id: item.id,
    impact: item.impact,
    nodes: item.nodes.slice(0, 3).map((node) => node.target),
  }))).toEqual([]);
}

async function visibleControlLabels(page: Page): Promise<string[]> {
  return page.locator('#easy-root').locator('button, a[href], input, select, textarea').evaluateAll((elements) => elements.filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.hidden || element.closest('[hidden]')) return false;
    if (element.closest('details:not([open])')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }).map((element) => (element.getAttribute('aria-label') || element.textContent || element.tagName).replace(/\s+/g, ' ').trim().slice(0, 60)));
}

async function expectBudget(page: Page, limit: number): Promise<void> {
  const labels = await visibleControlLabels(page);
  expect(labels, labels.join(' | ')).toHaveLength(Math.min(labels.length, limit));
  expect(labels.length, labels.join(' | ')).toBeLessThanOrEqual(limit);
}

async function expectStep(page: Page, heading: string): Promise<void> {
  const title = page.locator('[data-easy-heading]');
  await expect(title).toHaveText(heading, { timeout: 60_000 });
  await expect(title).toBeFocused();
}

test('studio steps and dialogs meet the accessibility bar', async ({ page }) => {
  test.setTimeout(240_000);
  await openEasyNew(page);
  await expectStep(page, "What's your video about?");
  await axe(page, '#easy-root');
  await expectBudget(page, 15);

  const help = page.locator('[data-easy-help]');
  await help.click();
  const helpDialog = page.getByRole('dialog', { name: 'How it works' });
  await expect(helpDialog).toBeVisible();
  await axe(page, 'dialog[open]');
  await page.keyboard.press('Escape');
  await expect(helpDialog).toBeHidden();
  await expect(help).toBeFocused();

  await page.locator('#easy-idea').fill(IDEA);
  await clickPrimary(page);
  const questions = page.getByRole('heading', { name: 'A couple of quick questions' });
  const characters = page.getByRole('heading', { name: "Who's in it?" });
  await expect(questions.or(characters)).toBeVisible();
  if (await questions.count()) {
    await expect(questions).toBeFocused();
    await axe(page, '#easy-root');
    await expectBudget(page, 15);
    await clickPrimary(page);
  }

  await expectStep(page, "Who's in it?");
  await axe(page, '#easy-root');
  await expectBudget(page, 15);

  const libraryOpen = page.getByRole('button', { name: 'Add from your characters' });
  await libraryOpen.click();
  const libraryDialog = page.getByRole('dialog', { name: 'Your characters' });
  await expect(libraryDialog).toBeVisible();
  await axe(page, 'dialog[open]');
  await page.keyboard.press('Escape');
  await expect(libraryDialog).toBeHidden();
  await expect(libraryOpen).toBeFocused();

  const createOpen = page.getByRole('button', { name: 'Create a character' });
  await createOpen.click();
  const quick = page.getByRole('dialog', { name: 'Create a character' });
  await expect(quick).toBeVisible();
  await axe(page, 'dialog[open]');
  await page.keyboard.press('Escape');
  await expect(quick).toBeHidden();
  await expect(createOpen).toBeFocused();

  const compareVoices = page.getByRole('button', { name: 'Compare two' });
  if (await compareVoices.count()) {
    await compareVoices.first().click();
    const compareDialog = page.getByRole('dialog', { name: 'Compare two voices' });
    await expect(compareDialog).toBeVisible();
    await axe(page, 'dialog[open]');
    await page.keyboard.press('Escape');
    await expect(compareDialog).toBeHidden();
    await expect(compareVoices.first()).toBeFocused();
  }

  await clickPrimary(page);
  await expectStep(page, 'How many versions should we try?');
  await axe(page, '#easy-root');
  await expectBudget(page, 15);

  await clickPrimary(page);
  await expectStep(page, 'Your plan');
  await axe(page, '#easy-root');
  await expectBudget(page, 15);

  await expect(primary(page)).toHaveText('Generate');
  await clickPrimary(page);
  await expect(page.locator('[data-easy-heading]')).toHaveText('Review your video', { timeout: 120_000 });

  const generateStep = page.locator('.stepper-step[data-step="generate"]');
  if (await generateStep.isEnabled()) {
    await generateStep.click();
    await expectStep(page, 'Making your video');
    await axe(page, '#easy-root');
    await expectBudget(page, 15);
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await stop.click();
    const stopDialog = page.getByRole('dialog', { name: 'Stop making shots?' });
    await expect(stopDialog).toBeVisible();
    await axe(page, 'dialog[open]');
    await page.keyboard.press('Escape');
    await expect(stopDialog).toBeHidden();
    await expect(stop).toBeFocused();
    await page.locator('.stepper-step[data-step="review"]').click();
  }

  await expectStep(page, 'Review your video');
  await axe(page, '#easy-root');
  await expectBudget(page, 25);

  const keepAll = page.getByRole('button', { name: 'Keep all' });
  if (await keepAll.count()) {
    await keepAll.click();
    const keepDialog = page.getByRole('dialog');
    await expect(keepDialog).toBeVisible();
    await axe(page, 'dialog[open]');
    await page.keyboard.press('Escape');
    await expect(keepDialog).toBeHidden();
    await expect(keepAll).toBeFocused();
  }

  const compareShots = page.getByRole('button', { name: 'Compare versions' });
  if (await compareShots.count()) {
    await compareShots.first().click();
    const shotDialog = page.getByRole('dialog');
    await expect(shotDialog).toBeVisible();
    await axe(page, 'dialog[open]');
    await page.keyboard.press('Escape');
    await expect(shotDialog).toBeHidden();
  }

  const ask = page.getByRole('button', { name: 'Ask for changes' });
  await ask.click();
  const askDialog = page.getByRole('dialog', { name: 'Ask for changes' });
  await expect(askDialog).toBeVisible();
  await axe(page, 'dialog[open]');
  await page.keyboard.press('Escape');
  await expect(askDialog).toBeHidden();
  await expect(ask).toBeFocused();

  await expect(primary(page)).toHaveText('Export video');
  await clickPrimary(page);
  await expectStep(page, 'Export');
  await axe(page, '#easy-root');
  await expectBudget(page, 15);
});
