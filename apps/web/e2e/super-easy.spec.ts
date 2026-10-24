/**
 * SE15: Super Easy browser smoke, one prompt to the final ready fixture.
 *
 * The page is a small harness served by Playwright from the Vite origin. It
 * mounts the real Super Easy home, progress view and Generate session against
 * a scripted fake backend. Nothing reaches the network: the fake API never
 * starts a paid run, never asks for a Google Colab status and never dispatches
 * an action. The run stays on This computer (CPU).
 */
import { expect, test, type Page } from '@playwright/test';

const PROMPT = 'A friendly robot who learns to bake bread';

const HARNESS = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Super Easy smoke</title>
<link rel="stylesheet" href="/src/ui/tokens.css">
<link rel="stylesheet" href="/src/easy/components.css">
<link rel="stylesheet" href="/src/easy/super-easy/home.css">
<link rel="stylesheet" href="/src/easy/super-easy/progress-view.css">
</head>
<body>
<div id="super-easy-root"></div>
<script type="module">
const root = document.getElementById('super-easy-root');
const { createEasyStore } = await import('/src/easy/store.ts');
const { mountSuperEasy } = await import('/src/easy/super-easy/mount.ts');
const { createSuperEasySession } = await import('/src/easy/super-easy/session.ts');

const PRODUCTION_ID = 'prod_super_easy_e2e_1';
const PACKAGE_ID = 'pkg_super_easy_e2e_1';
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=';
const VIDEO = 'data:video/mp4;base64,AAAA';
const calls = [];
const memory = new Map();
const storage = {
  getItem(key) { return memory.has(key) ? memory.get(key) : null; },
  setItem(key, value) { memory.set(key, value); },
  removeItem(key) { memory.delete(key); },
};
const store = createEasyStore({ storage, key: 'comfyrizz.easy.super-easy-e2e' });

function productionSnapshot() {
  return {
    production: {
      id: PRODUCTION_ID,
      revision: 2,
      briefVersionId: 'brief_1',
      scriptVersionId: 'script_1',
      shotIds: ['shot_1'],
      characterBindings: [{ characterId: 'char_mira', name: 'Mira' }],
      iteration: { policy: { level: 'draft' } },
    },
  };
}

const api = {
  async buildVideo(input) {
    calls.push({ method: 'buildVideo', input });
    return { package: { id: PACKAGE_ID, title: 'Super Easy smoke' } };
  },
  async createProduction(input) {
    calls.push({ method: 'createProduction', input });
    return { productionId: PRODUCTION_ID, revision: 1 };
  },
  async proposeEasyPlan(id, body) {
    calls.push({ method: 'proposeEasyPlan', id, body });
    return productionSnapshot();
  },
  async getProduction(id) {
    calls.push({ method: 'getProduction', id });
    return productionSnapshot();
  },
  async sendCommand(id, command) {
    calls.push({ method: 'sendCommand', id, command });
    return { revision: 3 };
  },
  async setSpendCap() {
    throw new Error('Super Easy on This computer must not set a Google Colab spend cap');
  },
  async dispatchAction() {
    throw new Error('Super Easy on This computer must not dispatch a paid action');
  },
  async startRun() {
    throw new Error('Super Easy on This computer must not start a paid run');
  },
  async colabStatus() {
    throw new Error('Super Easy on This computer must not ask Google Colab for status');
  },
};

const host = {
  adoptBuiltPackage() {},
  async aiSelection() { return { provider: 'none' }; },
  editorStore: {
    getState() {
      return { doc: { editSequence: 1 }, derived: { timeline: { scenes: [] }, compiledSequence: 1 } };
    },
  },
  async refreshClips() {},
  announce() {},
  rerender() {},
};

function partialSnapshot() {
  return {
    production: {
      id: PRODUCTION_ID,
      revision: 3,
      shotIds: ['shot_1', 'shot_2'],
      characterBindings: [
        { characterId: 'char_mira', name: 'Mira' },
        { characterId: 'char_bo', name: 'Bo' },
      ],
      iteration: { policy: { level: 'draft' } },
    },
    plan: { status: 'done' },
    characters: [
      { id: 'char_mira', name: 'Mira', status: 'ready', imageUrl: IMAGE },
      { id: 'char_bo', name: 'Bo', status: 'running' },
    ],
    shots: [
      { id: 'shot_1', status: 'approved', url: IMAGE },
      { id: 'shot_2', status: 'running' },
    ],
    voice: { status: 'starting' },
    render: { status: 'running', fraction: 0.4 },
  };
}

function finalSnapshot() {
  return {
    production: {
      id: PRODUCTION_ID,
      revision: 4,
      shotIds: ['shot_1', 'shot_2'],
      characterBindings: [
        { characterId: 'char_mira', name: 'Mira', artifactId: 'art_mira' },
        { characterId: 'char_bo', name: 'Bo', artifactId: 'art_bo' },
      ],
      latestDeliveryId: 'del_1',
      iteration: { policy: { level: 'draft' } },
    },
    plan: { status: 'done' },
    characters: [
      { id: 'char_mira', name: 'Mira', status: 'ready', imageUrl: IMAGE },
      { id: 'char_bo', name: 'Bo', status: 'ready', imageUrl: IMAGE },
    ],
    shots: [
      { id: 'shot_1', status: 'approved', url: IMAGE },
      { id: 'shot_2', status: 'approved', url: IMAGE },
    ],
    voice: { status: 'done' },
    render: { status: 'running', fraction: 0.7 },
    finalVideo: { ready: true, url: VIDEO },
    deliveries: [{ id: 'del_1', status: 'ready', url: VIDEO }],
  };
}

let watchOptions = null;
let snapshot = null;
let session;
const watch = (options) => {
  watchOptions = options;
  return () => {};
};

const mount = mountSuperEasy({
  root,
  state: () => store.get(),
  subscribe: (listener) => store.subscribe(listener),
  snapshot: () => snapshot,
  onGenerate: (input) => session.generate(input),
  onMoreControl() {},
  reducedMotion: true,
});

session = createSuperEasySession({
  api,
  host,
  store,
  go(step) { calls.push({ method: 'go', step }); },
  watch,
  onProgress(_html, next) {
    snapshot = next;
    mount.render();
  },
  onError(failure) {
    window.__superEasyHarness.error = failure;
  },
});

window.__superEasyHarness = {
  calls,
  session,
  error: null,
  watchReady() {
    return watchOptions !== null;
  },
  emitPartial() {
    watchOptions.onState(partialSnapshot());
  },
  emitFinal() {
    watchOptions.onState(finalSnapshot());
  },
};
</script>
</body>
</html>`;

async function openHarness(page: Page): Promise<string[]> {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\/api\/|google[ -]?colab/iu.test(url)) external.push(url);
  });
  await page.route('**/__super_easy_e2e__', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: HARNESS,
  }));
  await page.goto('/__super_easy_e2e__');
  await expect(page.locator('[data-super-easy-home]')).toBeVisible();
  return external;
}

test('one prompt shows progress, fills the gallery and ends on the final ready fixture', async ({ page }) => {
  const external = await openHarness(page);

  await expect(page.getByRole('heading', { name: 'Make a video' })).toBeVisible();
  await expect(page.locator('#super-easy-prompt')).toBeVisible();
  const generate = page.getByRole('button', { name: 'Generate', exact: true });
  await expect(generate).toBeVisible();
  await expect(page.locator('[data-super-easy-stage]')).toHaveCount(0);

  await page.locator('#super-easy-prompt').fill(PROMPT);
  await generate.click();

  await expect(page.locator('[data-super-easy-progress]')).toBeVisible();
  await expect(page.locator('[data-super-easy-overall-gauge] [role="progressbar"]')).toBeVisible();
  await expect(page.locator('[data-super-easy-stage]')).toHaveCount(5);
  await expect(page.locator('[data-super-easy-gallery]')).toBeVisible();

  const started = await page.evaluate(() => {
    const harness = (window as unknown as { __superEasyHarness: { session: { status(): string }; calls: Array<{ method: string; input?: { brief?: string; compute?: string } }> } }).__superEasyHarness;
    return { status: harness.session.status(), calls: harness.calls };
  });
  expect(started.status).toBe('running');
  expect(started.calls.some((call) => call.method === 'buildVideo')).toBe(true);
  const built = started.calls.find((call) => call.method === 'buildVideo');
  expect(built?.input?.brief).toContain(PROMPT);
  expect(started.calls.some((call) => call.method === 'startRun')).toBe(false);
  expect(started.calls.some((call) => call.method === 'dispatchAction')).toBe(false);
  expect(started.calls.some((call) => call.method === 'colabStatus')).toBe(false);

  await expect.poll(() => page.evaluate(() => {
    const harness = (window as unknown as { __superEasyHarness: { watchReady(): boolean } }).__superEasyHarness;
    return harness.watchReady();
  })).toBe(true);

  await page.evaluate(() => {
    (window as unknown as { __superEasyHarness: { emitPartial(): void } }).__superEasyHarness.emitPartial();
  });

  await expect(page.locator('[data-super-easy-gallery-item="character:char_mira"]')).toBeVisible();
  await expect(page.locator('[data-super-easy-gallery-item="shot:shot_1"]')).toBeVisible();
  await expect(page.locator('[data-super-easy-stage="characters"]')).toHaveAttribute('data-stage-status', 'running');

  await page.evaluate(() => {
    (window as unknown as { __superEasyHarness: { emitFinal(): void } }).__superEasyHarness.emitFinal();
  });

  await expect(page.locator('[data-super-easy-gallery-item="final"]')).toBeVisible();
  await expect(page.locator('[data-super-easy-gallery-item="final"] video')).toBeVisible();
  await expect(page.locator('[data-super-easy-overall-value]')).toHaveText('All done');
  await expect(page.locator('[data-super-easy-done-actions]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open in editor' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make another' })).toBeVisible();

  const finished = await page.evaluate(() => {
    const harness = (window as unknown as { __superEasyHarness: { session: { status(): string }; calls: Array<{ method: string }>; error: unknown } }).__superEasyHarness;
    return { status: harness.session.status(), calls: harness.calls, error: harness.error };
  });
  expect(finished.status).toBe('done');
  expect(finished.error).toBeNull();
  expect(finished.calls.some((call) => call.method === 'startRun')).toBe(false);
  expect(finished.calls.some((call) => call.method === 'dispatchAction')).toBe(false);
  expect(finished.calls.some((call) => call.method === 'colabStatus')).toBe(false);
  expect(external).toEqual([]);
});
