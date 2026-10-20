/**
 * Browser tests for the animation & storytelling inspector against the real
 * Vite app and local server. Chromium, loopback, no GPU. MIT, same as the repo.
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

interface StoredProject {
  package: {
    revision: number;
    voice?: Record<string, unknown>;
    scenes: Array<{
      id: string;
      locked?: boolean;
      narration_style?: string;
      motion?: { recipe?: string; focus?: { x?: number }; [key: string]: unknown } | null;
      transitionOut?: { type?: string; frames?: number } | null;
    }>;
    [key: string]: unknown;
  };
  editor?: unknown;
  revision: number;
}

function loadEnv(): Env {
  return JSON.parse(readFileSync(new URL('./.e2e-env.json', import.meta.url), 'utf8')) as Env;
}

function resetProject(env: Env): void {
  const seed = join(env.runtimeDir, 'seed');
  copyFileSync(join(seed, 'package.json'), join(env.runtimeDir, 'packages', `${env.packageId}.json`));
  copyFileSync(join(seed, 'editor.json'), join(env.runtimeDir, 'editor', `${env.packageId}.json`));
  copyFileSync(join(seed, 'durations.json'), join(env.runtimeDir, 'packages', 'audio', 'durations.json'));
}

async function api(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-comfyrizz-token', env.token);
  headers.set('origin', env.api);
  return fetch(`${env.api}${path}`, { ...init, headers });
}

async function storedProject(env: Env): Promise<StoredProject> {
  const response = await api(env, `/api/package/${env.packageId}`);
  expect(response.status).toBe(200);
  return await response.json() as StoredProject;
}

/** Seed package data the UI cannot create yet (compatibility and locked-scene cases). */
async function patchPackage(env: Env, change: (stored: StoredProject) => void): Promise<void> {
  const stored = await storedProject(env);
  change(stored);
  const response = await api(env, `/api/package/${env.packageId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseRevision: stored.package.revision,
      package: stored.package,
      ...(stored.editor ? { editor: stored.editor } : {}),
      editSequence: 0,
    }),
  });
  expect(response.status).toBe(200);
}

async function openEditor(page: Page, env: Env): Promise<void> {
  await page.goto(`/?package=${encodeURIComponent(env.packageId)}#token=${encodeURIComponent(env.token)}`);
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(page.getByTestId('animation-panel')).toBeVisible();
  await expect(page.locator('#voice-panel')).toBeVisible();
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page).not.toHaveURL(/token=/);
}

const animation = (page: Page) => page.locator('[data-animation-section]');
const animationStatus = (page: Page) => page.locator('[data-anim-status]');
const voice = (page: Page) => page.locator('#voice-panel').locator('[aria-label="Voice and narration"]');

test.beforeEach(() => {
  resetProject(loadEnv());
});

test('animation edits use autosave and survive reload', async ({ page }) => {
  const env = loadEnv();
  await openEditor(page, env);

  const first = animation(page);
  await first.getByLabel('Recipe').selectOption('kinetic');
  await first.getByLabel(/Seed/).fill('4242');
  await first.getByLabel(/Phrase cues/).fill('one two\nthree four');
  await first.getByRole('combobox', { name: 'Transition', exact: true }).selectOption('paper-reveal');
  await expect(page.getByRole('combobox', { name: 'Transition type', exact: true })).toHaveValue('paper-reveal');
  await first.getByLabel('Duration (frames)').fill('18');
  await expect(first.locator('[data-animation-timing]')).toContainText(/measured for this scene/i);

  await first.getByRole('button', { name: 'Save animation' }).click();
  await expect(animationStatus(page)).toContainText('Saved');
  await expect(page.locator('#save-status')).toHaveText('Saved');

  const stored = await storedProject(env);
  const scene = stored.package.scenes.find(item => item.id === 's_open');
  expect(scene?.motion?.recipe).toBe('kinetic');
  expect(scene?.motion?.seed).toBe(4242);
  expect(scene?.motion?.cue_phrases).toEqual(['one two', 'three four']);
  expect(scene?.transitionOut).toEqual({ type: 'paper-reveal', frames: 18 });

  await page.reload();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(page.locator('#save-status')).toHaveText('Saved');

  const reloaded = animation(page);
  await expect(reloaded.getByLabel('Recipe')).toHaveValue('kinetic');
  await expect(reloaded.getByLabel(/Seed/)).toHaveValue('4242');
  await expect(reloaded.getByLabel(/Phrase cues/)).toHaveValue('one two\nthree four');
  await expect(reloaded.getByRole('combobox', { name: 'Transition', exact: true })).toHaveValue('paper-reveal');
  await page.getByRole('combobox', { name: 'Transition type', exact: true }).selectOption('shape-reveal');
  await expect(reloaded.getByRole('combobox', { name: 'Transition', exact: true })).toHaveValue('shape-reveal');
  await expect(reloaded.getByLabel('Duration (frames)')).toHaveValue('18');
});

test('animation edits undo and redo from the timeline keyboard', async ({ page }) => {
  await openEditor(page, loadEnv());
  const section = animation(page);
  await section.getByLabel('Recipe').selectOption('sketch');
  await expect(section.getByLabel('Recipe')).toHaveValue('sketch');
  await expect(page.locator('#save-status')).toHaveText('Saved');

  await page.getByTestId('timeline').focus();
  await page.keyboard.press('Control+z');
  await expect(animation(page).getByLabel('Recipe')).toHaveValue('');
  await page.keyboard.press('Control+Shift+z');
  await expect(animation(page).getByLabel('Recipe')).toHaveValue('sketch');
});

test('voice presets undo, save and reload with their blend', async ({ page }) => {
  const env = loadEnv();
  await openEditor(page, env);

  await voice(page).getByLabel('Quick voice preset').selectOption('michael-fenrir');
  await expect(voice(page).getByLabel('Voice engine')).toHaveValue('kokoro');
  await expect(voice(page).getByLabel('Speaker')).toHaveValue('am_michael');
  await expect(voice(page).getByLabel('Blend a second voice')).toBeChecked();
  await expect(voice(page).getByRole('combobox', { name: 'Second voice', exact: true })).toHaveValue('am_fenrir');
  await expect(voice(page).getByLabel('Second voice share (%)')).toHaveValue('30');

  const toolbar = page.getByRole('toolbar', { name: 'Timeline' });
  await toolbar.getByRole('button', { name: 'Undo' }).click();
  await expect(voice(page).getByLabel('Voice engine')).toHaveValue('design');
  await toolbar.getByRole('button', { name: 'Redo' }).click();
  await expect(voice(page).getByLabel('Voice engine')).toHaveValue('kokoro');
  // The compact editor must not erase the blend/chunking chosen in production controls.
  await page.getByTestId('script-audio').getByLabel('Speed', { exact: true }).fill('1.1');
  await page.getByTestId('script-audio').getByRole('button', { name: 'Set voice', exact: true }).click();

  await voice(page).getByRole('button', { name: 'Save voice settings' }).click();
  await expect(page.locator('#save-status')).toHaveText('Saved');
  const stored = await storedProject(env);
  expect(stored.package.voice).toMatchObject({
    enabled: true,
    engine: 'kokoro',
    voice: 'am_michael',
    speed: 1.1,
    chunking: 'paragraph',
    blend: [{ voice: 'am_michael', weight: 0.7 }, { voice: 'am_fenrir', weight: 0.3 }],
  });

  await page.reload();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(voice(page).getByLabel('Voice engine')).toHaveValue('kokoro');
  await expect(voice(page).getByLabel('Speaker')).toHaveValue('am_michael');
  await expect(voice(page).getByLabel('Blend a second voice')).toBeChecked();
  await expect(voice(page).getByRole('combobox', { name: 'Second voice', exact: true })).toHaveValue('am_fenrir');
  await expect(voice(page).getByLabel('Second voice share (%)')).toHaveValue('30');
});

test('per-scene delivery is undoable and locked scenes stay read only', async ({ page }) => {
  const env = loadEnv();
  await openEditor(page, env);
  await voice(page).getByLabel('Voice engine').selectOption('custom');
  const delivery = voice(page).getByLabel('Scene delivery direction');
  await delivery.fill('Warm and curious, with a pause before the result.');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect.poll(async () => {
    const stored = await storedProject(env);
    return stored.package.scenes.find(item => item.id === 's_open')?.narration_style;
  }).toBe('Warm and curious, with a pause before the result.');

  await page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Undo' }).click();
  await expect(voice(page).getByLabel('Scene delivery direction')).toHaveValue('');
  await page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Redo' }).click();
  await expect(voice(page).getByLabel('Scene delivery direction')).toHaveValue('Warm and curious, with a pause before the result.');
});

test('per-scene delivery is read only on a locked scene', async ({ page }) => {
  const env = loadEnv();
  await patchPackage(env, stored => {
    const scene = stored.package.scenes.find(item => item.id === 's_open');
    if (scene) {
      scene.locked = true;
      scene.narration_style = 'Keep this saved direction.';
    }
    const pkgVoice = stored.package.voice;
    if (pkgVoice) {
      pkgVoice.engine = 'qwen3-tts';
      pkgVoice.qwen_mode = 'custom';
      pkgVoice.voice = 'Ryan';
    }
  });
  await openEditor(page, env);
  await expect(voice(page).getByLabel('Scene delivery direction')).toBeDisabled();
  await expect(voice(page).getByLabel('Scene delivery direction')).toHaveValue('Keep this saved direction.');
  await expect(voice(page).locator('.voice-delivery')).toContainText('locked');
});

test('the generation plan uses the saved revision without starting a run', async ({ page }) => {
  const env = loadEnv();
  let planBody: Record<string, unknown> | null = null;
  let startCalls = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/pipeline') startCalls += 1;
  });
  await page.route(/\/api\/pipeline\/plan$/, async route => {
    planBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, requiresApproval: false, planHash: 'plan_e2e_voice', issues: [] }),
    });
  });
  await openEditor(page, env);
  await voice(page).getByLabel('Voice engine').selectOption('custom');
  await voice(page).getByRole('button', { name: 'Check generation plan' }).click();

  await expect(voice(page).locator('[data-voice-status]')).toContainText('Ready to generate');
  expect(planBody).not.toBeNull();
  expect(planBody!.packageId).toBe(env.packageId);
  expect(typeof planBody!.baseRevision).toBe('number');
  expect(planBody!.narrationRuntime).toBe('colab');
  expect(planBody).not.toHaveProperty('status');
  expect(startCalls).toBe(0);
  await expect(voice(page).getByRole('button', { name: 'Generate video' })).toBeVisible();
  await page.getByTestId('scene-select').selectOption('s_body');
  await expect(voice(page).getByRole('button', { name: 'Generate video' })).toBeVisible();
});

test('a rejected voice save names the failure and keeps the edit', async ({ page }) => {
  await page.route('**/api/package/**', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid package', details: [{ path: '/voice/speed', message: 'speed is out of range' }] }),
    });
  });
  await openEditor(page, loadEnv());
  await voice(page).getByLabel('Quick voice preset').selectOption('heart');
  await voice(page).getByLabel('Speaking speed').fill('1.1');
  await voice(page).getByRole('button', { name: 'Save voice settings' }).click();
  await expect(voice(page).locator('[data-voice-status]')).toContainText('Save rejected: invalid package: /voice/speed speed is out of range');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'rejected');
  await expect(voice(page).getByLabel('Speaking speed')).toHaveValue('1.1');
});

test('a saved recipe the layout does not offer is shown but not selectable', async ({ page }) => {
  const env = loadEnv();
  await patchPackage(env, stored => {
    const scene = stored.package.scenes.find(item => item.id === 's_close');
    if (scene) scene.motion = { recipe: 'technical-flow' };
  });
  await openEditor(page, env);
  await page.getByTestId('scene-select').selectOption('s_close');

  const section = animation(page);
  await expect(section.getByLabel('Recipe')).toHaveValue('technical-flow');
  await expect(section.locator('option[value="technical-flow"]')).toHaveAttribute('disabled', '');
  await expect(section.locator('.animation-recipe-description')).toContainText('not offered for the title layout');
  await expect(section.locator('[data-animation-transition="final"]')).toBeVisible();
});

test('an invalid focus rectangle is reported and never saved', async ({ page }) => {
  const env = loadEnv();
  await openEditor(page, env);
  await page.getByTestId('scene-select').selectOption('s_body');
  const section = animation(page);
  await section.getByLabel('Recipe').selectOption('focus');
  await expect(page.locator('#save-status')).toHaveText('Saved');

  const x = section.locator('[data-anim-field="focus.x"]');
  await x.fill('0.6');
  await expect.poll(() => x.evaluate(input => (input as HTMLInputElement).validationMessage)).toContain('fit inside the frame');
  await section.getByRole('button', { name: 'Save animation' }).click();
  await expect(animationStatus(page)).not.toContainText('Saved');

  const rejected = await storedProject(env);
  expect(rejected.package.scenes.find(item => item.id === 's_body')?.motion?.focus?.x).toBe(0.2);

  await x.fill('0.4');
  await expect.poll(() => x.evaluate(input => (input as HTMLInputElement).validationMessage)).toBe('');
  await expect.poll(async () => {
    const stored = await storedProject(env);
    return stored.package.scenes.find(item => item.id === 's_body')?.motion?.focus?.x;
  }).toBe(0.4);
});

test('a locked scene disables animation editing and saving', async ({ page }) => {
  const env = loadEnv();
  await patchPackage(env, stored => {
    const scene = stored.package.scenes.find(item => item.id === 's_open');
    if (scene) {
      scene.locked = true;
      scene.motion = { recipe: 'kinetic', seed: 12, intensity: 0.5 };
    }
  });
  await openEditor(page, env);

  const section = animation(page);
  await expect(section.locator('.animation-lock')).toHaveText('locked');
  await expect(section.getByLabel('Recipe')).toBeDisabled();
  await expect(section.locator('[data-anim-field="seed"]')).toBeDisabled();
  await expect(section.locator('[data-anim-field="cue_phrases"]')).toBeDisabled();
  await expect(section.getByRole('combobox', { name: 'Transition', exact: true })).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Save animation' })).toBeDisabled();
});

test('a rejected animation save keeps the edit and shows the reason', async ({ page }) => {
  await page.route('**/api/package/**', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'invalid package',
        details: [{ path: '/scenes/0/motion/recipe', message: 'recipe is not available for this layout' }],
      }),
    });
  });
  await openEditor(page, loadEnv());
  const section = animation(page);
  await section.getByLabel('Recipe').selectOption('kinetic');
  await section.getByRole('button', { name: 'Save animation' }).click();

  await expect(page.locator('#save-status')).toHaveText('Save rejected: invalid package: /scenes/0/motion/recipe recipe is not available for this layout');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'rejected');
  await expect(animationStatus(page)).toContainText('Save rejected');
  await expect(section.getByLabel('Recipe')).toHaveValue('kinetic');
});

test('the QA contact sheet uses a token-free blob URL', async ({ page }) => {
  const env = loadEnv();
  await page.addInitScript(() => {
    const Original = window.EventSource;
    const streams: EventSource[] = [];
    (window as unknown as { __qaStreams: EventSource[] }).__qaStreams = streams;
    window.EventSource = class extends Original {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        streams.push(this);
      }
    };
  });
  const sheetRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/qa/sheet')) sheetRequests.push(request.url());
  });
  await page.route(/\/api\/qa\?renderId=/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ findings: [], sheet: 'render_e2e_qa.png' }),
  }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  await page.route(/\/api\/qa\/sheet\?renderId=/, route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: png,
  }));

  await openEditor(page, env);
  await page.evaluate(() => {
    const streams = (window as unknown as { __qaStreams: EventSource[] }).__qaStreams;
    streams.at(-1)?.dispatchEvent(new MessageEvent('qa.result', {
      data: JSON.stringify({ renderId: 'render_e2e_qa', ok: true, findings: 0, sheet: 'render_e2e_qa.png' }),
    }));
  });

  const sheet = page.locator('.qa-sheet');
  await expect(sheet).toHaveAttribute('src', /^blob:/);
  const src = await sheet.getAttribute('src');
  expect(src).not.toContain(env.token);
  expect(src).not.toContain('token=');
  expect(sheetRequests).toHaveLength(1);
  expect(sheetRequests[0]).not.toContain(env.token);
  expect(sheetRequests[0]).not.toContain('token=');
});

test('a failed scene re-render releases the card instead of staying stuck', async ({ page }) => {
  await page.route('**/api/scene/render', async route => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'render exploded' }),
    });
  });
  await openEditor(page, loadEnv());

  const card = page.locator('[data-scene-id="s_open"]');
  await card.getByRole('button', { name: 'Re-render scene' }).click();
  await expect(page.locator('#activity')).toContainText('Scene re-render failed: render exploded');
  const released = page.locator('[data-scene-id="s_open"]').getByRole('button', { name: 'Re-render scene' });
  await expect(released).toBeEnabled();
  await expect(released).toHaveText('Re-render scene');
});
