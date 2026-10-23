/**
 * DN09: density modes and the Easy/Advanced shell switch.
 *
 * The app has one data model. Easy mounts the studio at #easy-root and hides
 * the Advanced #app; switching back never unmounts it. The choice and the
 * density live in `localStorage['comfyrizz.ui']`, and the approval drawer keeps
 * the render-gate hooks the rest of the suite relies on.
 *
 * Chromium, loopback, no GPU. MIT, same as the repo.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

interface Env {
  web: string;
  api: string;
  token: string;
  packageId: string;
  runtimeDir: string;
}

type UiMode = 'easy' | 'advanced';
type UiDensity = 'compact' | 'comfortable';

interface StoredPrefs {
  mode: UiMode;
  density: UiDensity;
  panels: { left: boolean; right: boolean; timeline: boolean };
}

const PREFS_KEY = 'comfyrizz.ui';
const LAYOUT_KEY = 'comfyrizz.ui.layout';
const DEFAULT_PANELS = { left: true, right: true, timeline: true };
const CLIP_IDS = ['s_open:a_plate', 's_body:a_plate', 's_close:a_plate'] as const;

function loadEnv(): Env {
  return JSON.parse(readFileSync(new URL('./.e2e-env.json', import.meta.url), 'utf8')) as Env;
}

function resetProject(env: Env): void {
  const seed = join(env.runtimeDir, 'seed');
  copyFileSync(join(seed, 'package.json'), join(env.runtimeDir, 'packages', `${env.packageId}.json`));
  copyFileSync(join(seed, 'editor.json'), join(env.runtimeDir, 'editor', `${env.packageId}.json`));
  copyFileSync(join(seed, 'durations.json'), join(env.runtimeDir, 'packages', 'audio', 'durations.json'));
}

function editorUrl(env: Env): string {
  return `/?package=${encodeURIComponent(env.packageId)}#token=${encodeURIComponent(env.token)}`;
}

async function openEditor(page: Page, env: Env): Promise<void> {
  await page.goto(editorUrl(env));
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page).not.toHaveURL(/token=/);
}

async function storedPrefs(page: Page): Promise<StoredPrefs | null> {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw) as StoredPrefs;
  }, PREFS_KEY);
}

async function writePrefs(page: Page, prefs: StoredPrefs): Promise<void> {
  await page.evaluate(([key, value]) => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [PREFS_KEY, prefs] as const);
}

async function densityVariable(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--d').trim());
}

async function useAdvancedPrefs(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('comfyrizz.ui', JSON.stringify({ mode: 'advanced', density: 'compact' })));
}

async function expectEasyShell(page: Page): Promise<void> {
  await expect(page.locator('#easy-root')).toBeVisible();
  await expect(page.locator('#app')).toHaveAttribute('hidden', '');
}

async function expectAdvancedShell(page: Page): Promise<void> {
  await expect(page.locator('#easy-root')).toBeHidden();
  await expect(page.locator('#app')).not.toHaveAttribute('hidden', '');
  await expect(page.getByTestId('inspector-tabs')).toBeVisible();
}

/**
 * Supply the editor with reviewable clips without touching the committed
 * fixture (which only has an upload). The drawer, clip store, render bar and
 * verdict calls are the real app code; only the clip list/verdict transport is
 * a deterministic test double, because the fixture has no generated media.
 */
async function mockReviewClips(
  page: Page,
  env: Env,
  approvedClipIds: readonly string[] = [],
): Promise<{ approved: Set<string> }> {
  const approved = new Set<string>(approvedClipIds);
  const clipFor = (clipId: string) => {
    const index = CLIP_IDS.indexOf(clipId as (typeof CLIP_IDS)[number]);
    return {
      clipId,
      sceneId: clipId.split(':')[0]!,
      assetId: `asset_${clipId.split(':')[0]}`,
      slot: 'background',
      kind: 'plate',
      from: Math.max(0, index) * 30,
      durationInFrames: 30,
      state: approved.has(clipId) ? 'approved' : 'review',
      selected: null,
      selectedN: 1,
      takeCount: 1,
      newTakes: 0,
      lastJob: null,
      queued: false,
    };
  };
  await page.route('**/api/package/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/clips')) {
      await route.fulfill({
        json: {
          packageId: env.packageId,
          revision: 1,
          clips: CLIP_IDS.map(clipId => clipFor(clipId)),
        },
      });
      return;
    }
    if (request.method() === 'GET' && /\/clips\/[^/]+\/takes$/.test(url.pathname)) {
      const clipId = decodeURIComponent(url.pathname.split('/clips/')[1]!.split('/takes')[0]!);
      await route.fulfill({
        json: {
          packageId: env.packageId,
          revision: 1,
          clip: clipFor(clipId),
          assetId: `asset_${clipId.split(':')[0]}`,
          selected: null,
          takes: [],
          history: [],
          lastJob: null,
          queued: null,
        },
      });
      return;
    }
    if (request.method() === 'POST' && /\/clips\/[^/]+\/verdict$/.test(url.pathname)) {
      const clipId = decodeURIComponent(url.pathname.split('/clips/')[1]!.split('/verdict')[0]!);
      approved.add(clipId);
      await route.fulfill({ json: { kind: 'verdict', packageId: env.packageId, clipId, verdict: 'approved' } });
      return;
    }
    await route.continue();
  });
  return { approved };
}

async function useAdvanced(page: Page): Promise<void> {
  const root = page.locator('html');
  if (await root.getAttribute('data-mode') !== 'advanced') {
    await page.keyboard.press('Control+Shift+A');
  }
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await expectAdvancedShell(page);
}

const reviewPill = (page: Page) => page.locator('#render-bar-host [data-review-open]');
const reviewDrawer = (page: Page) => page.locator('#review-drawer');

test.beforeEach(() => {
  resetProject(loadEnv());
});

test('new users start in Easy; the toggle persists mode and its default density', async ({ page }) => {
  const env = loadEnv();
  await openEditor(page, env);

  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-mode', 'easy');
  await expect(root).toHaveAttribute('data-density', 'comfortable');
  await expect(page.locator('#ui-mode-easy')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#ui-mode-advanced')).toHaveAttribute('aria-pressed', 'false');
  await expectEasyShell(page);
  expect(await storedPrefs(page)).toBeNull();

  await page.keyboard.press('Control+Shift+A');
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await expect(root).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('#ui-mode-live')).toHaveText('Advanced view. All controls are visible.');
  await expect(page.locator('#easy-root')).toBeHidden();
  await expectAdvancedShell(page);
  expect(await storedPrefs(page)).toMatchObject({ mode: 'advanced', density: 'compact' });

  // Mode still chooses its default until a density is picked explicitly.
  await page.locator('#ui-mode-easy').click();
  await expect(root).toHaveAttribute('data-mode', 'easy');
  await expect(root).toHaveAttribute('data-density', 'comfortable');
  await expect(page.locator('#ui-mode-live')).toHaveText('Easy view. Advanced controls are hidden.');
  await expectEasyShell(page);
  expect(await storedPrefs(page)).toMatchObject({ mode: 'easy', density: 'comfortable' });

  await page.keyboard.press('Control+Shift+A');
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await expect(root).toHaveAttribute('data-density', 'compact');
  await expectAdvancedShell(page);

  await page.reload();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await expect(root).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('#ui-mode-advanced')).toHaveAttribute('aria-pressed', 'true');
  await expectAdvancedShell(page);
});

test('an explicit density sticks across mode switches and reloads', async ({ page }) => {
  const env = loadEnv();
  await openEditor(page, env);
  const root = page.locator('html');

  await writePrefs(page, { mode: 'easy', density: 'compact', panels: DEFAULT_PANELS });
  await page.reload();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(root).toHaveAttribute('data-density', 'compact');
  await expectEasyShell(page);
  expect(await densityVariable(page)).toBe('0');

  await useAdvanced(page);
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await expect(root).toHaveAttribute('data-density', 'compact');
  expect(await densityVariable(page)).toBe('0');

  await writePrefs(page, { mode: 'advanced', density: 'comfortable', panels: DEFAULT_PANELS });
  await page.reload();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await expect(root).toHaveAttribute('data-density', 'comfortable');
  await expectAdvancedShell(page);
  expect(await densityVariable(page)).toBe('1');

  await page.locator('#ui-mode-easy').click();
  await expect(root).toHaveAttribute('data-mode', 'easy');
  await expect(root).toHaveAttribute('data-density', 'comfortable');
  await expectEasyShell(page);
  expect(await densityVariable(page)).toBe('1');
});

test('an Advanced edit survives the Easy filter and comes back unchanged', async ({ page }) => {
  const env = loadEnv();
  await useAdvancedPrefs(page);
  await openEditor(page, env);
  await useAdvanced(page);
  const root = page.locator('html');

  await page.getByTestId('scene-select').selectOption('s_body');
  await expect(page.getByLabel('Transition type')).toHaveValue('slide');
  await page.getByLabel('Transition type').selectOption('fade');
  const frames = page.getByLabel('Transition frames');
  await frames.fill('9');
  await frames.press('Enter');
  await expect(page.locator('.tl-inspector')).toContainText('out 9');

  const narration = page.getByTestId('narration');
  await narration.fill('Typed in Advanced, still here in Easy.');
  await page.getByTestId('apply-narration').click();
  await expect(page.locator('[data-action]')).toHaveText('Edit applied.');

  await page.locator('#ui-mode-easy').click();
  await expect(root).toHaveAttribute('data-mode', 'easy');
  await expect(page.getByTestId('inspector-tabs')).toBeHidden();
  await expectEasyShell(page);
  await expect(page.locator('#easy-root [data-easy-primary]')).toBeVisible();

  // Hidden, not unmounted: the same inputs keep their state while Easy is on.
  await expect(narration).toBeHidden();
  await expect(narration).toBeAttached();
  await expect(narration).toHaveValue('Typed in Advanced, still here in Easy.');
  await expect(frames).toBeHidden();
  await expect(frames).toHaveValue('9');
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(page.getByTestId('caption').first()).toHaveText('one two three four.');

  await useAdvanced(page);
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await expect(narration).toBeVisible();
  await expect(narration).toHaveValue('Typed in Advanced, still here in Easy.');
  await expect(page.getByLabel('Transition type')).toHaveValue('fade');
  await expect(page.getByLabel('Transition frames')).toHaveValue('9');
});

test('the drawer opens from R, moves with J, approves with A, advances and closes with Esc', async ({ page }) => {
  const env = loadEnv();
  await useAdvancedPrefs(page);
  const { approved } = await mockReviewClips(page, env, ['s_close:a_plate']);
  await openEditor(page, env);

  const pill = reviewPill(page);
  const drawer = reviewDrawer(page);
  await expect(pill).toHaveText(/1\/3 (?:clips )?approved/);
  await expect(pill).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer).toBeHidden();

  await page.keyboard.press('r');
  await expect(drawer).toBeVisible();
  await expect(pill).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.locator('[role="option"]').first()).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('j');
  await expect(drawer.locator('[role="option"][aria-selected="true"]')).toHaveAttribute('data-review-clip', 's_body:a_plate');

  await page.keyboard.press('a');
  await expect(drawer.locator('[data-review-live]')).toHaveText('Approved 2/3');
  expect(approved.has('s_body:a_plate')).toBe(true);
  // Approval moves the active row to the next clip that still needs review.
  await expect(drawer.locator('[role="option"][aria-selected="true"]')).toHaveAttribute('data-review-clip', 's_open:a_plate');

  // The approved clip leaves the Needs review filter but keeps its verdict.
  await drawer.locator('[data-review-filter="approved"]').click();
  await expect(drawer.locator('[data-review-clip="s_body:a_plate"]')).toHaveAttribute('data-review-status', 'approved');
  await expect(drawer.locator('[data-review-clip="s_body:a_plate"]')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(pill).toHaveAttribute('aria-expanded', 'false');

  // A single-letter shortcut is inert while the caret is in a text field.
  await page.locator('#prompt').click();
  await page.keyboard.press('r');
  await expect(drawer).toBeHidden();
});

test('splitter arrow keys move the column and the width survives a reload', async ({ page }) => {
  const env = loadEnv();
  await useAdvancedPrefs(page);
  await openEditor(page, env);

  const splitter = page.locator('.shell-splitter[data-split="left"]');
  await expect(splitter).toBeVisible();
  const initial = Number(await splitter.getAttribute('aria-valuenow'));
  expect(initial).toBeGreaterThanOrEqual(240);

  await splitter.focus();
  await page.keyboard.press('ArrowRight');
  const moved = Number(await splitter.getAttribute('aria-valuenow'));
  expect(moved).toBe(initial + 16);
  await expect(splitter).toHaveAttribute('aria-valuetext', `${moved} pixels`);
  const layout = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), LAYOUT_KEY) as {
    md?: { left?: number };
  };
  expect(layout.md?.left).toBe(moved);

  await page.reload();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  const restored = page.locator('.shell-splitter[data-split="left"]');
  await expect(restored).toHaveAttribute('aria-valuenow', String(moved));

  await restored.dblclick();
  await expect(restored).toHaveAttribute('aria-valuenow', String(initial));
});

test('the render gate hooks stay inside the drawer and flip when every clip is approved', async ({ page }) => {
  const env = loadEnv();
  await useAdvancedPrefs(page);
  await mockReviewClips(page, env);
  await openEditor(page, env);

  const bar = page.locator('#render-bar-host [data-render-bar]');
  const pill = reviewPill(page);
  const drawer = reviewDrawer(page);
  await expect(bar).toHaveAttribute('data-gate-ok', 'false');
  await expect(pill).toHaveText(/0\/3 (?:clips )?approved/);

  await pill.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-render-blocker]')).toHaveCount(3);
  await expect(drawer.locator('[data-render-open-override]')).toBeVisible();
  await expect(drawer.locator('[data-render-run]')).toHaveCount(0);

  page.once('dialog', dialog => { void dialog.accept(); });
  await page.keyboard.press('Shift+A');
  await expect(bar).toHaveAttribute('data-gate-ok', 'true');
  await expect(drawer.locator('[data-render-blocker]')).toHaveCount(0);
  await expect(drawer.locator('[data-render-open-override]')).toHaveCount(0);
  await expect(drawer.locator('[data-render-run]')).toBeVisible();
  await expect(pill).toHaveText(/3\/3 (?:clips )?approved/);

  await drawer.locator('[data-review-close]').click();
  await expect(drawer).toBeHidden();
  await expect(pill).toHaveAttribute('aria-expanded', 'false');
  await expect(pill).toHaveText(/3\/3 (?:clips )?approved/);
});

for (const mode of ['easy', 'advanced'] as const) {
  for (const density of ['compact', 'comfortable'] as const) {
    test(`no serious or critical axe violations in ${mode} at ${density} density`, async ({ page }) => {
      const env = loadEnv();
      await page.addInitScript(([key, value]) => {
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch {
          // A storage-disabled context still renders; the test then sees Easy.
        }
      }, [PREFS_KEY, { mode, density, panels: DEFAULT_PANELS }] as const);

      await openEditor(page, env);
      const root = page.locator('html');
      await expect(root).toHaveAttribute('data-mode', mode);
      await expect(root).toHaveAttribute('data-density', density);

      const results = await new AxeBuilder({ page }).analyze();
      const blocking = results.violations.filter(item => item.impact === 'serious' || item.impact === 'critical');
      expect(blocking.map(item => ({
        id: item.id,
        impact: item.impact,
        nodes: item.nodes.slice(0, 3).map(node => node.target),
      }))).toEqual([]);
    });
  }
}

test('Easy opens the studio and hides the Advanced app without destroying it', async ({ page }) => {
  const env = loadEnv();
  await useAdvancedPrefs(page);
  await openEditor(page, env);
  await useAdvanced(page);

  const root = page.locator('html');
  const advNode = page.getByLabel('Transition frames');
  await expect(advNode).toBeVisible();
  await page.locator('#ui-mode-easy').click();
  await expect(root).toHaveAttribute('data-mode', 'easy');
  await expectEasyShell(page);
  await expect(advNode).toBeAttached();
  await expect(advNode).toBeHidden();

  await page.keyboard.press('Control+Shift+A');
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await expectAdvancedShell(page);
  await expect(advNode).toBeVisible();
});
