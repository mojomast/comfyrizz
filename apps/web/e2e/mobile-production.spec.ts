/**
 * IP59: mobile tabs and sheets.
 *
 * The shell has one DOM at every width. Easy stays Easy: the right rail and the
 * run-settings anchor are never forced open. Advanced below 1100px turns the
 * right rail into a reachable bottom sheet with full-width tabs, and a
 * collapsed rail stays collapsed until its toggle brings it back.
 *
 * Chromium, loopback, CPU only. No Google Colab or network backends are used.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

interface Env {
  web: string;
  api: string;
  token: string;
  packageId: string;
  runtimeDir: string;
}

type UiMode = 'easy' | 'advanced';

const PREFS_KEY = 'comfyrizz.ui';
const RAIL_TABS = ['run', 'activity', 'assets', 'gpu'] as const;

function loadEnv(): Env {
  return JSON.parse(readFileSync(new URL('./.e2e-env.json', import.meta.url), 'utf8')) as Env;
}

function resetProject(env: Env): void {
  const seed = join(env.runtimeDir, 'seed');
  copyFileSync(join(seed, 'package.json'), join(env.runtimeDir, 'packages', `${env.packageId}.json`));
  copyFileSync(join(seed, 'editor.json'), join(env.runtimeDir, 'editor', `${env.packageId}.json`));
  copyFileSync(join(seed, 'durations.json'), join(env.runtimeDir, 'packages', 'audio', 'durations.json'));
}

async function openEditor(page: Page, mode: UiMode, panels = { left: true, right: true, timeline: true }): Promise<Env> {
  const env = loadEnv();
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    [PREFS_KEY, { mode, density: 'compact', panels }] as const,
  );
  await page.goto(`/?package=${encodeURIComponent(env.packageId)}#token=${encodeURIComponent(env.token)}`);
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
  return env;
}

/**
 * A control is reachable when it can be scrolled into view, fits the viewport,
 * and the topmost element at its centre is the control (or a descendant).
 * This catches both clipping and overlays without relying on visibility alone.
 */
async function expectReachable(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector).first();
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const hit = await target.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
      hit: top === node || node.contains(top),
    };
  });
  expect(hit.left).toBeGreaterThanOrEqual(-1);
  expect(hit.right).toBeLessThanOrEqual(hit.width + 1);
  expect(hit.top).toBeGreaterThanOrEqual(-1);
  expect(hit.bottom).toBeLessThanOrEqual(hit.height + 1);
  expect(hit.hit).toBe(true);
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function expectRailTabs(page: Page): Promise<void> {
  for (const tab of RAIL_TABS) {
    const button = page.locator(`#rail-tab-${tab}`);
    await expectReachable(page, `#rail-tab-${tab}`);
    await button.click();
    await expect(button).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`#rail-panel-${tab}`)).toBeVisible();
  }
}

test.beforeEach(() => {
  resetProject(loadEnv());
});

test('Easy at 390 stays Easy, keeps the rail hidden, and its actions are reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEditor(page, 'easy');

  await expect(page.locator('#activity-pane')).toBeHidden();
  await expect(page.locator('#easy-actions')).toBeVisible();
  await expect(page.locator('#topbar .run-settings-anchor')).toBeHidden();

  await expectReachable(page, '#easy-generate');
  await expectReachable(page, '#easy-preview');
  await expectReachable(page, '#easy-advanced');
  await noHorizontalOverflow(page);

  await page.locator('#easy-advanced').click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'advanced');
  await expect(page.locator('#easy-actions')).toBeHidden();
  await expect(page.locator('#activity-pane')).toBeVisible();

  await expectRailTabs(page);
  await expectReachable(page, '#run-backend');
  await expectReachable(page, '#render');
  await expectReachable(page, '#export-menu-toggle');
  await expectReachable(page, '#run-settings-toggle');
});

for (const width of [760, 1099] as const) {
  test(`Easy at ${width}px keeps the Advanced rail out of the layout`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openEditor(page, 'easy');

    await expect(page.locator('#activity-pane')).toBeHidden();
    await expect(page.locator('.shell-splitter[data-split="right"]')).toBeHidden();
    await expect(page.locator('#topbar .run-settings-anchor')).toBeHidden();
    await expect(page.locator('#easy-actions')).toBeVisible();
    await expectReachable(page, '#easy-advanced');
    await noHorizontalOverflow(page);

    await page.locator('#easy-advanced').click();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'advanced');
    await expect(page.locator('#activity-pane')).toBeVisible();
  });
}

for (const width of [390, 760, 1099] as const) {
  test(`Advanced at ${width}px exposes the rail sheet and its operations`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openEditor(page, 'advanced');

    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-shell-right', 'on');
    await expect(page.locator('#activity-pane')).toBeVisible();

    const rail = await page.locator('#activity-pane').boundingBox();
    expect(rail).not.toBeNull();
    expect(rail!.width).toBeGreaterThanOrEqual(width - 2);
    expect(rail!.x).toBeLessThanOrEqual(1);

    await expectRailTabs(page);
    await expectReachable(page, '#run-backend');
    await expectReachable(page, '#render');
    await expectReachable(page, '#export-menu-toggle');
    await expectReachable(page, '#run-settings-toggle');
    if (width === 390) await noHorizontalOverflow(page);
  });
}

test('Advanced keeps a collapsed rail hidden and its toggle brings it back', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 844 });
  await openEditor(page, 'advanced', { left: true, right: false, timeline: true });

  const app = page.locator('#app');
  await expect(app).toHaveAttribute('data-shell-right', 'off');
  await expect(page.locator('#activity-pane')).toBeHidden();
  await expect(page.locator('.shell-splitter[data-split="right"]')).toBeHidden();

  await page.keyboard.press('Control+Alt+B');
  await expect(app).toHaveAttribute('data-shell-right', 'on');
  await expect(page.locator('#activity-pane')).toBeVisible();
  await expectRailTabs(page);
});
