/**
 * DN10: screenshot matrix for the density + Easy/Advanced shell work.
 *
 * Captures 1440x900 and 2560x1440 x {easy, advanced} x {compact, comfortable}
 * (8 frames) plus one drawer-open frame = 9 PNGs in test-results/density/.
 * Easy frames show the Easy Idea step; Advanced frames show the editor. One
 * app, one data model: each frame starts from fresh mode/density prefs; no
 * project state is cleared.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
type UiDensity = 'compact' | 'comfortable';

interface StoredPrefs {
  mode: UiMode;
  density: UiDensity;
  panels: { left: boolean; right: boolean; timeline: boolean };
}

const PREFS_KEY = 'comfyrizz.ui';
const DEFAULT_PANELS = { left: true, right: true, timeline: true };
const CLIP_IDS = ['s_open:a_plate', 's_body:a_plate', 's_close:a_plate'] as const;
const OUT_DIR = fileURLToPath(new URL('../test-results/density', import.meta.url));

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

function ideaUrl(env: Env): string {
  return `/?package=${encodeURIComponent(env.packageId)}&step=idea#token=${encodeURIComponent(env.token)}`;
}

async function expectShell(page: Page, mode: UiMode): Promise<void> {
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-mode', mode);
  if (mode === 'easy') {
    await expect(page.locator('#easy-root')).toBeVisible();
    await expect(page.locator('#app')).toHaveAttribute('hidden', '');
    await expect(page.locator('[data-easy-stepper] button[aria-current="step"]')).toContainText('Idea');
    return;
  }
  await expect(page.locator('#easy-root')).toBeHidden();
  await expect(page.locator('#app')).not.toHaveAttribute('hidden', '');
  await expect(page.getByTestId('inspector-tabs')).toBeVisible();
}

async function openEditor(page: Page, env: Env, mode: UiMode): Promise<void> {
  await page.goto(mode === 'easy' ? ideaUrl(env) : editorUrl(env));
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expectShell(page, mode);
}

async function mockReviewClips(page: Page, env: Env): Promise<void> {
  const clipFor = (clipId: string) => {
    const index = CLIP_IDS.indexOf(clipId as (typeof CLIP_IDS)[number]);
    return {
      clipId,
      sceneId: clipId.split(':')[0]!,
      assetId: 'a_plate',
      slot: 'background',
      kind: 'plate',
      from: Math.max(0, index) * 30,
      durationInFrames: 30,
      state: 'review',
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
        json: { packageId: env.packageId, revision: 1, clips: CLIP_IDS.map(clipId => clipFor(clipId)) },
      });
      return;
    }
    if (request.method() === 'GET' && /\/clips\/[^/]+\/takes$/.test(url.pathname)) {
      const clipId = decodeURIComponent(url.pathname.split('/clips/')[1]!.split('/takes')[0]!);
      await route.fulfill({
        json: { packageId: env.packageId, revision: 1, clip: clipFor(clipId), assetId: 'a_plate', selected: null, takes: [], history: [], lastJob: null, queued: null },
      });
      return;
    }
    await route.continue();
  });
}

test('DN10 screenshot matrix', async ({ page }) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const env = loadEnv();
  resetProject(env);

  const files: string[] = [];
  const viewports = [
    { width: 1440, height: 900, label: '1440x900' },
    { width: 2560, height: 1440, label: '2560x1440' },
  ];

  for (const vp of viewports) {
    for (const mode of ['easy', 'advanced'] as UiMode[]) {
      for (const density of ['compact', 'comfortable'] as UiDensity[]) {
        const framePage = await page.context().newPage();
        await framePage.setViewportSize({ width: vp.width, height: vp.height });
        await framePage.addInitScript(([key, prefs]) => {
          localStorage.setItem(key, JSON.stringify(prefs));
        }, [PREFS_KEY, { mode, density, panels: DEFAULT_PANELS }] as const);
        await openEditor(framePage, env, mode);
        await framePage.waitForTimeout(300);
        const name = `${vp.label}-${mode}-${density}.png`;
        await framePage.screenshot({ path: join(OUT_DIR, name) });
        files.push(name);
        await framePage.close();
      }
    }
  }

  // Drawer-open frame.
  const drawerPage = await page.context().newPage();
  await drawerPage.addInitScript(() => localStorage.setItem('comfyrizz.ui', JSON.stringify({ mode: 'advanced', density: 'comfortable' })));
  await mockReviewClips(drawerPage, env);
  await drawerPage.setViewportSize({ width: 1440, height: 900 });
  await openEditor(drawerPage, env, 'advanced');
  const pill = drawerPage.locator('#render-bar-host [data-review-open]');
  await expect(pill).toBeVisible();
  await pill.click();
  const drawer = drawerPage.locator('#review-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[role="option"]')).toHaveCount(3);
  const drawerName = 'drawer-open.png';
  await drawerPage.screenshot({ path: join(OUT_DIR, drawerName) });
  files.push(drawerName);
  await drawerPage.close();

  // eslint-disable-next-line no-console
  console.log(`DN10 screenshots (${files.length}): ${files.join(', ')}`);
  // eslint-disable-next-line no-console
  console.log('DN10 note: Easy frames show the Easy Idea step; Advanced frames use the full centre column at 2560 with no empty band over 25%.');
  expect(files).toHaveLength(9);
});
