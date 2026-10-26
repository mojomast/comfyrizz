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
  loadEnv,
  primary,
  watchPaidCalls,
} from './easy-helpers.ts';

const IDEA = 'A short film about a bakery window at dawn, warm and quiet.';

const EXPORT_RELOAD_HARNESS = String.raw`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Export reload smoke</title></head>
<body>
<h1 data-easy-heading></h1>
<div id="export-root"></div>
<script type="module">
const { createEasyStore } = await import('/src/easy/store.ts');
const { step } = await import('/src/easy/steps/export.ts');

const KEY = 'comfyrizz.easy.export-reload-e2e';
const PACKAGE_ID = 'pkg_export_reload_e2e';
const REVISION = 5;
const state = {
  version: 1,
  packageId: PACKAGE_ID,
  chatId: null,
  productionId: null,
  offline: false,
  idea: { text: 'A short film about a bakery window at dawn, warm and quiet.', lengthS: 30, aspect: '16:9', look: 'clay', sound: true },
  questions: [],
  questionsAsked: true,
  answers: {},
  cast: [],
  narration: { on: true, voiceId: null },
  level: 'draft',
  levelTouched: true,
  compute: 'cpu',
  spendCap: 15,
  planHash: null,
  plan: { status: 'ready', error: null, errorAt: null, wordsChanged: false },
  generate: { status: 'done' },
  review: { shotId: null },
  exported: { revision: REVISION, at: '2026-10-26T12:00:00.000Z' },
};
if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(state));

const store = createEasyStore({ storage: localStorage, key: KEY });
const pkg = { id: PACKAGE_ID, title: 'Export reload smoke', revision: REVISION, durationSeconds: 30 };
let renders = 0;
let primary = '';
const ctx = {
  state: store.get(),
  store,
  api: { qa: async () => ({ passed: true, notes: 0 }) },
  host: {
    getPackage: () => pkg,
    renderMp4: async () => {
      renders += 1;
      return { blob: new Blob(['fake-mp4'], { type: 'video/mp4' }), revision: REVISION };
    },
    openEditor() {},
    playerElement: () => null,
  },
  shell: {
    setPrimary(options) { primary = options.label; },
    setStatus() {},
    alert() {},
    setBanner() {},
  },
  go() {},
  rerender() {},
  dialogs: {},
};

step.bind(document.getElementById('export-root'), ctx);
window.__exportReloadHarness = { renders: () => renders, primary: () => primary };
</script>
</body>
</html>`;

async function openExportReloadHarness(page: Page): Promise<void> {
  await page.route('**/__easy_export_reload__', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: EXPORT_RELOAD_HARNESS,
  }));
  await page.goto('/__easy_export_reload__');
  await expect(page.locator('[data-easy-export-done]')).toBeVisible();
}

/**
 * The Easy studio is the second door on purpose: a bare visit lands on Super
 * Easy, and More control is the way in. The studio's eager step import also
 * picks up colocated node:test modules on this base, so stub those modules
 * only; every real step stays in place.
 */
async function openStudioNew(page: Page): Promise<void> {
  const env = loadEnv();
  await page.route(/\/src\/easy\/steps\/[^/]+\.test\.ts(?:\?.*)?$/u, (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: 'export {};',
  }));
  await page.addInitScript(() => {
    // A reload must keep the studio. Clear storage once per tab, not on every document.
    if (!sessionStorage.getItem('easy-e2e-booted')) {
      localStorage.clear();
      sessionStorage.setItem('easy-e2e-booted', '1');
    }
    const raw = localStorage.getItem('comfyrizz.ui');
    let prefs: Record<string, unknown> = {};
    try {
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object') prefs = parsed as Record<string, unknown>;
    } catch {
      prefs = {};
    }
    prefs.mode = 'easy';
    localStorage.setItem('comfyrizz.ui', JSON.stringify(prefs));
    const record = window as Window & { __easyClicks?: number };
    record.__easyClicks = 0;
    document.addEventListener('click', () => {
      record.__easyClicks = (record.__easyClicks ?? 0) + 1;
    }, true);
  });
  await page.goto(`/#token=${encodeURIComponent(env.token)}`);
  await expect(page.locator('#easy-root')).toBeVisible({ timeout: 30_000 });
  const moreControl = page.locator('[data-super-easy-more-control]');
  if (await moreControl.isVisible().catch(() => false)) {
    await moreControl.click();
  }
  await expect(page.locator('[data-easy-heading]')).toHaveText("What's your video about?");
  await expect(page).not.toHaveURL(/token=/);
}

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
  await openStudioNew(page);
  await reachReview(page);
  await exportAndDownload(page);
  expect(await clickCount(page)).toBeLessThanOrEqual(8);
  assertNoPaidCalls();
});

test('the keyboard path keeps the primary within five tabs of the heading', async ({ page }) => {
  test.setTimeout(240_000);
  await openStudioNew(page);

  await assertPrimaryWithinFiveTabs(page);
  await page.locator('#easy-idea').focus();
  await page.keyboard.type(IDEA);
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
  await openStudioNew(page);
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
  await openStudioNew(page);
  await reachReview(page);
  await page.reload();
  await expect(page.locator('[data-easy-heading]')).toHaveText('Review your video');
  assertNoPaidCalls();
});

test('a reload after export offers Export again, never a dead Download', async ({ page }) => {
  test.setTimeout(120_000);
  await openExportReloadHarness(page);

  const again = page.locator('[data-easy-export-again]');
  const download = page.locator('[data-easy-export-download]');
  await expect(again).toBeVisible();
  await expect(download).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const harness = (window as unknown as { __exportReloadHarness: { primary(): string; renders(): number } }).__exportReloadHarness;
    return { primary: harness.primary(), renders: harness.renders() };
  })).toEqual({ primary: 'Export again', renders: 0 });

  await again.click();
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute('href', /^blob:/);
  await expect.poll(() => page.evaluate(() => {
    const harness = (window as unknown as { __exportReloadHarness: { primary(): string; renders(): number } }).__exportReloadHarness;
    return { primary: harness.primary(), renders: harness.renders() };
  })).toEqual({ primary: 'Download MP4', renders: 1 });

  await page.reload();
  await expect(page.locator('[data-easy-export-done]')).toBeVisible();
  await expect(again).toBeVisible();
  await expect(download).toHaveCount(0);
  await again.click();
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute('href', /^blob:/);
  assertNoPaidCalls();
});
