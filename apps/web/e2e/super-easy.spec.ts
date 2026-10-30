/**
 * SE15: Super Easy browser smoke, one prompt to the final ready fixture.
 *
 * The page is a small harness served by Playwright from the Vite origin. It
 * mounts the real Super Easy home, progress view and Generate session against
 * a scripted fake backend. Nothing reaches the network: the fake API never
 * starts a paid run, never asks for a Google Colab status and never dispatches
 * an action. The run stays on This computer (CPU).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import { assertNoPaidCalls, loadEnv, watchPaidCalls } from './easy-helpers.ts';

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

/**
 * The full app must boot as shipped. A bundled node:test file once threw on
 * the bare visit and left a half-drawn editor instead of Super Easy.
 */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('one prompt shows progress, fills the gallery and ends on the final ready fixture', async ({ page }) => {
  const external = await openHarness(page);

  await expect(page.getByRole('heading', { name: 'Imagine it. Make it.' })).toBeVisible();
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
  const download = page.getByRole('link', { name: 'Download', exact: true });
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute('download');
  await expect(download).toHaveAttribute('href', /^data:video\/mp4/);
  await expect(page.getByRole('link', { name: 'Open in Studio' })).toBeVisible();
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

const FULL_APP_PACKAGE = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/package.json', import.meta.url), 'utf8'));
const FULL_APP_TIMELINE = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/timeline.json', import.meta.url), 'utf8'));
const FULL_APP_PRODUCTION_ID = 'prod_super_easy_full_app_1';
const FULL_APP_PACKAGE_ID = 'pkg_super_easy_full_app_1';
const FULL_APP_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=';

function fullAppBackend() {
  const calls: string[] = [];
  let revision = 3;
  let iteration: Record<string, unknown> | null = null;
  let approved = false;
  const plans: Array<{ sequence: number; data: Record<string, unknown> }> = [];

  function snapshot() {
    const production: Record<string, unknown> = {
      id: FULL_APP_PRODUCTION_ID,
      revision,
      briefVersionId: 'brief_full_app',
      scriptVersionId: 'script_full_app',
      shotIds: ['shot_1', 'shot_2'],
      characterBindings: [
        { characterId: 'char_mira', name: 'Mira' },
        { characterId: 'char_bo', name: 'Bo' },
      ],
      iteration: iteration ?? undefined,
    };
    if (approved) {
      production.characters = [
        { id: 'char_mira', name: 'Mira', status: 'ready', imageUrl: FULL_APP_IMAGE },
        { id: 'char_bo', name: 'Bo', status: 'running' },
      ];
      production.shots = [
        { id: 'shot_1', status: 'approved', url: FULL_APP_IMAGE },
        { id: 'shot_2', status: 'running' },
      ];
      production.voice = { status: 'starting' };
      production.render = { status: 'running', fraction: 0.4 };
    }
    const events = [
      { productionId: FULL_APP_PRODUCTION_ID, type: 'production.created', data: {} },
      { productionId: FULL_APP_PRODUCTION_ID, type: 'brief.updated', data: {} },
      ...plans,
      ...(iteration === null
        ? []
        : [{
            productionId: FULL_APP_PRODUCTION_ID,
            type: 'iteration.set',
            data: { policy: iteration.policy },
          }]),
    ].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
      .map((event, index) => ({ ...event, id: `evt_full_app_${index + 1}`, sequence: index + 1 }));
    return {
      productionId: FULL_APP_PRODUCTION_ID,
      production,
      revision,
      lastSequence: events.at(-1)?.sequence ?? 0,
      events,
      gap: false,
      stale: false,
    };
  }

  async function handle(route: Route): Promise<void> {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const send = (body: unknown) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (path === '/api/agent' && method === 'POST') {
      calls.push('agent');
      return send({
        package: { ...FULL_APP_PACKAGE, id: FULL_APP_PACKAGE_ID },
        revision: FULL_APP_PACKAGE.revision,
        timeline: FULL_APP_TIMELINE,
        live: true,
        generatedAssets: {},
        svgAssets: [],
        pendingGpu: [],
      });
    }
    if (path === '/api/productions' && method === 'POST') {
      calls.push('production');
      return send({ productionId: FULL_APP_PRODUCTION_ID, production: { id: FULL_APP_PRODUCTION_ID, revision } });
    }
    if (/^\/api\/productions\/[^/]+\/easy-plan$/u.test(path) && method === 'POST') {
      calls.push('plan');
      revision += 1;
      plans.push({
        sequence: 3 + plans.length * 3,
        data: {
          id: `plan_full_app_${plans.length + 1}`,
          productionId: FULL_APP_PRODUCTION_ID,
          revision: 3 + plans.length * 3,
          planHash: 'c'.repeat(64),
          reservationCeiling: 0,
          collectAndStopReserve: 0,
          requiredDecisions: [],
          actions: [],
        },
      });
      return send({ revision });
    }
    if (/^\/api\/productions\/[^/]+$/u.test(path) && method === 'GET') {
      calls.push('snapshot');
      return send(snapshot());
    }
    if (/^\/api\/productions\/[^/]+\/events$/u.test(path) && method === 'GET') {
      calls.push('events');
      const body = snapshot();
      return send({ productionId: FULL_APP_PRODUCTION_ID, lastSequence: body.lastSequence, nextAfter: body.lastSequence, events: body.events, gap: false, truncated: false });
    }
    if (/^\/api\/productions\/[^/]+\/commands$/u.test(path) && method === 'POST') {
      const command = JSON.parse(request.postData() ?? '{}');
      calls.push(`command:${String(command.kind ?? '')}`);
      revision += 1;
      if (command.kind === 'iteration.set') {
        iteration = { policy: command.payload?.policy, level: 'draft', revision };
      }
      if (command.kind === 'plan.approve') approved = true;
      return send({ revision });
    }
    if (path === '/api/run') {
      calls.push('run');
      return send({});
    }
    if (path.endsWith('/spend-cap')) {
      calls.push('spend-cap');
      return send({ revision });
    }
    if (path.endsWith('/actions')) {
      calls.push('dispatch');
      return send({ revision });
    }
    calls.push(`other:${path}`);
    return send({});
  }

  return { handle, calls };
}

test('the full app starts at the bare visit and fills the progress view from the fake backend', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors = collectPageErrors(page);
  const backend = fullAppBackend();
  await page.route('**/api/**', (route) => backend.handle(route));
  await page.goto(`/#token=${loadEnv().token}`, { waitUntil: 'domcontentloaded' });

  await expect(page.locator('[data-super-easy-home]')).toBeVisible();
  expect(pageErrors).toEqual([]);
  await page.locator('#super-easy-prompt').fill(PROMPT);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('[data-super-easy-proposal]')).toBeVisible();
  await page.getByRole('button', { name: 'Make this film' }).click();

  await expect(page.locator('[data-super-easy-progress]')).toBeVisible();
  await expect(page.locator('[data-super-easy-overall-gauge] [role="progressbar"]')).toBeVisible();
  await expect(page.locator('[data-super-easy-stage]')).toHaveCount(5);
  await expect(page.locator('[data-super-easy-gallery-item="character:char_mira"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-super-easy-gallery-item="shot:shot_1"]')).toBeVisible();

  expect(backend.calls.some((call) => call === 'agent')).toBe(true);
  expect(backend.calls.some((call) => call === 'plan')).toBe(true);
  expect(backend.calls).toContain('command:iteration.set');
  expect(backend.calls.some((call) => call === 'run' || call === 'dispatch' || call === 'spend-cap')).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('the home coaches a first-time visitor and an idea chip is enough to Generate', async ({ page }) => {
  await openHarness(page);

  await expect(page.locator('#super-easy-prompt-hint')).toContainText('no Google Colab');
  await expect(page.locator('[data-super-easy-prompt-error]')).toBeHidden();

  await page.locator('#super-easy-prompt').fill('robot');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('[data-super-easy-prompt-error]')).toBeVisible();
  await expect(page.locator('#super-easy-prompt')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('[data-super-easy-home]')).toBeVisible();

  await page.getByRole('button', { name: 'How a coffee bean becomes your morning cup' }).click();
  await expect(page.locator('#super-easy-prompt')).toHaveValue('How a coffee bean becomes your morning cup');
  await expect(page.locator('[data-super-easy-prompt-error]')).toBeHidden();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.locator('[data-super-easy-progress]')).toBeVisible();
});

test('the preview card leads with Download preview MP4 above the gauges', async ({ page }) => {
  await page.route('**/__super_easy_preview_e2e__', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview card</title>
<link rel="stylesheet" href="/src/ui/tokens.css">
<link rel="stylesheet" href="/src/easy/components.css">
<link rel="stylesheet" href="/src/easy/super-easy/progress-view.css">
</head><body><div id="root"></div><script type="module">
const { renderSuperEasyProgress } = await import('/src/easy/super-easy/progress-view.ts');
document.getElementById('root').innerHTML = renderSuperEasyProgress({ plan: { status: 'done' }, render: { status: 'running', fraction: 0.5 } }, { previewReady: true });
</script></body></html>`,
  }));
  await page.goto('/__super_easy_preview_e2e__');

  const download = page.getByRole('button', { name: 'Download preview MP4' });
  await expect(download).toBeVisible();
  await expect(page.getByRole('button', { name: 'Watch and review' })).toBeVisible();
  const card = await page.locator('[data-super-easy-preview-ready]').boundingBox();
  const gauges = await page.locator('[data-super-easy-stages]').boundingBox();
  const column = await page.locator('[data-super-easy-progress]').boundingBox();
  expect(card && gauges && column).toBeTruthy();
  expect(card!.y).toBeLessThan(gauges!.y);
  expect(card!.x).toBeGreaterThanOrEqual(column!.x);
  expect(card!.x + card!.width).toBeLessThanOrEqual(column!.x + column!.width + 1);
});

test('the Studio escape for a ready package lands past Idea', async ({ page }) => {
  test.setTimeout(90_000);
  const env = loadEnv();
  watchPaidCalls(page);
  await page.addInitScript((pkg: string) => {
    const state = {
      version: 1,
      packageId: pkg,
      chatId: null,
      productionId: 'prod_ex14_ready_0000000000000000',
      offline: false,
      idea: {
        text: 'A short film about a bakery window at dawn, warm and quiet.',
        lengthS: 30,
        aspect: '16:9',
        look: 'clay',
        sound: true,
      },
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
      exported: { revision: null, at: null },
    };
    localStorage.setItem('comfyrizz.super-easy', JSON.stringify({ preferStudio: false, seenSuperEasy: true }));
    localStorage.setItem('comfyrizz.easy.new', JSON.stringify(state));
    localStorage.setItem(`comfyrizz.easy.${pkg}`, JSON.stringify(state));
  }, env.packageId);

  await page.goto(`/#token=${encodeURIComponent(env.token)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#easy-root')).toBeVisible({ timeout: 30_000 });

  // The more-control link uses this shared escape builder once the package is
  // ready. It must target the step the package reached, never a fresh Idea.
  const target = await page.evaluate(async (pkg: string) => {
    const { escapeToStudio } = await import('/src/easy/super-easy/escape.ts');
    const { defaultEasyState } = await import('/src/easy/store.ts');
    const state = {
      ...defaultEasyState(),
      packageId: pkg,
      productionId: 'prod_ex14_ready_0000000000000000',
      idea: {
        ...defaultEasyState().idea,
        text: 'A short film about a bakery window at dawn, warm and quiet.',
      },
      plan: { ...defaultEasyState().plan, status: 'ready' as const },
      generate: { status: 'done' as const },
    };
    return escapeToStudio('', pkg, state);
  }, env.packageId);

  expect(target).toContain('step=review');
  expect(target).not.toContain('step=idea');

  await page.goto(`/${target}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-easy-heading]')).toHaveText('Review your video', { timeout: 30_000 });
  assertNoPaidCalls();
});

test('one-time setup reveals the credit cap when Google Colab is selected', async ({ page }) => {
  await page.route('**/api/colab/status', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ installed: true, signedIn: true, tokenPresent: true, tokenChecked: true, tokenReady: true }),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Set up AI & Google Colab' }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.getByRole('heading', { name: 'Set up your video maker' })).toBeVisible();
  await expect(dialog.locator('input[name="easy-cap"]')).toHaveCount(0);
  await dialog.locator('input[name="easy-compute"][value="colab"]').check();
  await expect(dialog.locator('input[name="easy-cap"]')).toBeVisible();
  await dialog.locator('input[name="easy-cap"]').fill('10');
  await expect(dialog.locator('input[name="easy-cap"]')).toHaveValue('10');
});
