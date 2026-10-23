// AV22: thumbnails -> viewer -> element-scoped iterate -> approval gates -> compare.
//
// The browser runs the real Vite app, the real local server and the real viewer,
// iterate panel, plan card and compare modules. Thumbnails are produced by the
// server's local CPU ffmpeg step from a real video this test writes into the
// temporary runtime. The agent turn is scripted: the test captures the scoped
// chat request and proposes exactly one matching plan through the same
// action-plans HTTP boundary the agent uses. Nothing here calls a paid
// generation, a GPU or Google Colab; approval stays a user command and the
// server's level and ledger gates are exercised directly.
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTakeStore } from '../../server/src/takes/store.mjs';
import { ITERATION_PRESETS } from '../../server/src/productions/iteration.mjs';

interface Env {
  web: string;
  api: string;
  token: string;
  packageId: string;
  runtimeDir: string;
}

interface ApiResult {
  status: number;
  body: Record<string, any>;
  text: string;
}

interface TakeRecord {
  takeId: string;
  assetId: string;
  n: number;
}

interface CapturedTurn {
  message: string;
  iterationScope: Record<string, any>;
}

const ASSET_ID = 'a_plate';
const SHOT_ID = 's_body';
const CLIP_ID = 's_body:a_plate';
const PRODUCTION_CONVERSATION = 'conv_av22_scope';

const here = dirname(fileURLToPath(import.meta.url));

function systemChromium(): string | undefined {
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find((candidate) => existsSync(candidate));
}

const chromiumPath = systemChromium();
if (chromiumPath) {
  test.use({ launchOptions: { executablePath: chromiumPath, args: ['--no-sandbox'] } });
}

test.setTimeout(120_000);

function loadEnv(): Env {
  return JSON.parse(readFileSync(join(here, '.e2e-env.json'), 'utf8')) as Env;
}

function apiCall(env: Env, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.body === undefined ? {} : { 'content-type': 'application/json' });
  headers.set('x-comfyrizz-token', env.token);
  headers.set('origin', env.api);
  return fetch(`${env.api}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function call(env: Env, path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult> {
  const response = await apiCall(env, path, init);
  const text = await response.text();
  let body: Record<string, any> = {};
  try { body = text === '' ? {} : JSON.parse(text) as Record<string, any>; } catch { body = {}; }
  return { status: response.status, body, text };
}

async function productionState(env: Env, productionId: string): Promise<{ snapshot: Record<string, any>; state: Record<string, any> }> {
  const snapshot = await call(env, `/api/productions/${encodeURIComponent(productionId)}`);
  expect(snapshot.status, snapshot.text).toBe(200);
  const events = await call(env, `/api/productions/${encodeURIComponent(productionId)}/events?after=0`);
  expect(events.status, events.text).toBe(200);
  return {
    snapshot: snapshot.body,
    state: { ...snapshot.body, events: events.body?.events ?? [] },
  };
}

function resetFixture(env: Env): void {
  const seed = join(env.runtimeDir, 'seed');
  copyFileSync(join(seed, 'package.json'), join(env.runtimeDir, 'packages', `${env.packageId}.json`));
  copyFileSync(join(seed, 'editor.json'), join(env.runtimeDir, 'editor', `${env.packageId}.json`));
  copyFileSync(join(seed, 'durations.json'), join(env.runtimeDir, 'packages', 'audio', 'durations.json'));
  rmSync(join(env.runtimeDir, 'takes', `${env.packageId}.json`), { force: true });
}

function makeVideo(file: string, colour: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const result = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi',
    '-i', `color=c=${colour}:size=320x180:rate=24:duration=4`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    file,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg could not create the AV22 fixture: ${result.stderr || result.stdout}`);
  }
}

function makeGeneratedAsset(env: Env, pkg: Record<string, any>): void {
  const asset = pkg.assets?.[ASSET_ID];
  if (!asset) throw new Error(`the e2e fixture has no ${ASSET_ID} asset`);
  asset.gen = {
    generator: 'fake-cpu',
    workflow: 'workflows/av22.api.json',
    workflow_sha256: 'ab'.repeat(32),
    prompt: 'an empty night street with warm lamps',
    seed: 11,
    inputs: { seed: 11, prompt: 'an empty night street with warm lamps' },
  };
  writeFileSync(join(env.runtimeDir, 'packages', `${env.packageId}.json`), `${JSON.stringify(pkg, null, 2)}\n`);
  makeVideo(join(env.runtimeDir, 'packages', env.packageId, asset.file), '0x1b2440');
}

function addTake(env: Env, source: string, seed: number): TakeRecord {
  const store = createTakeStore({
    runtimeDir: env.runtimeDir,
    packageDir: join(env.runtimeDir, 'packages'),
  });
  return store.addTake(env.packageId, ASSET_ID, {
    srcPath: source,
    media: { durationInSeconds: 4, width: 320, height: 180, fps: 24, frames: 96 },
    gen: { generator: 'fake-cpu', prompt: 'an empty night street', seed },
  }) as TakeRecord;
}

async function createProduction(env: Env): Promise<string> {
  const created = await call(env, '/api/productions', {
    body: {
      commandId: 'cmd_av22_create',
      idempotencyKey: 'key_av22_create',
      kind: 'production.create',
      expected: { productionRevision: 0 },
      payload: {
        conversationId: PRODUCTION_CONVERSATION,
        packageId: env.packageId,
        shotIds: [SHOT_ID],
      },
    },
  });
  expect(created.status, created.text).toBe(201);
  expect(created.body.productionId).toMatch(/^prod_/);
  return created.body.productionId as string;
}

function scopedPlan(scope: Record<string, any>) {
  return {
    planId: 'plan_av22',
    revision: 0,
    reservationCeiling: 8,
    collectAndStopReserve: 1,
    requiredDecisions: [],
    scope,
    actions: [{
      id: 'av22_background_take',
      kind: 'take',
      targetId: CLIP_ID,
      upperBound: 4,
      reuse: false,
      effectiveInputHash: 'hash_av22_background',
      seed: 11,
      scope,
    }],
  };
}

async function propose(env: Env, productionId: string, revision: number, plan: ReturnType<typeof scopedPlan>, suffix: string): Promise<ApiResult> {
  return call(env, `/api/productions/${encodeURIComponent(productionId)}/action-plans`, {
    body: {
      commandId: `cmd_av22_plan_${suffix}`,
      idempotencyKey: `key_av22_plan_${suffix}`,
      expected: { productionRevision: revision },
      payload: plan,
    },
  });
}

async function setSpendCap(env: Env, productionId: string, revision: number, ceiling: number, suffix: string): Promise<ApiResult> {
  return call(env, `/api/productions/${encodeURIComponent(productionId)}/spend-cap`, {
    body: {
      commandId: `cmd_av22_cap_${suffix}`,
      idempotencyKey: `key_av22_cap_${suffix}`,
      ceiling,
      expected: { productionRevision: revision },
    },
  });
}

async function setLevel(env: Env, productionId: string, revision: number): Promise<ApiResult> {
  return call(env, `/api/productions/${encodeURIComponent(productionId)}/commands`, {
    body: {
      commandId: 'cmd_av22_level',
      idempotencyKey: 'key_av22_level',
      kind: 'iteration.set',
      productionId,
      expected: { productionRevision: revision },
      payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
    },
  });
}

async function approve(env: Env, productionId: string, revision: number, planId: string, planHash: string, suffix: string): Promise<ApiResult> {
  return call(env, `/api/productions/${encodeURIComponent(productionId)}/commands`, {
    body: {
      commandId: `cmd_av22_approve_${suffix}`,
      idempotencyKey: `key_av22_approve_${suffix}`,
      kind: 'plan.approve',
      productionId,
      expected: { productionRevision: revision },
      payload: { planId, planHash, proposalRevision: 0 },
    },
  });
}

async function dispatch(env: Env, productionId: string, revision: number, planId: string, actionId: string, suffix: string): Promise<ApiResult> {
  return call(env, `/api/productions/${encodeURIComponent(productionId)}/actions`, {
    body: {
      commandId: `cmd_av22_dispatch_${suffix}`,
      idempotencyKey: `key_av22_dispatch_${suffix}`,
      expected: { productionRevision: revision },
      payload: { planId, planRevision: 0, actionId },
    },
  });
}

async function renderPlanCard(
  page: Page,
  state: Record<string, any>,
  productionId: string,
  iterationRequired = false,
): Promise<{ canApprove: boolean; iterationRequired: boolean }> {
  return page.evaluate(async ({ cardState, id, required }) => {
    const mod = await import('/src/productions/cards/plan-card.ts');
    const card = mod.readPlanCard(cardState, { productionId: id, iterationRequired: required });
    let host = document.getElementById('av22-plan-card');
    if (!host) {
      host = document.createElement('section');
      host.id = 'av22-plan-card';
      document.body.appendChild(host);
    }
    host.innerHTML = mod.renderPlanCard(card);
    return { canApprove: card.canApprove === true, iterationRequired: card.iterationRequired === true };
  }, { cardState: state, id: productionId, required: iterationRequired });
}

async function approvalFromCard(
  page: Page,
  state: Record<string, any>,
  productionId: string,
  commandId: string,
): Promise<{ ok: boolean; code?: string; command?: Record<string, any> }> {
  return page.evaluate(async ({ cardState, id, command }) => {
    const mod = await import('/src/productions/cards/plan-card.ts');
    const card = mod.readPlanCard(cardState, { productionId: id });
    const result = mod.approvePlan(card, { commandId: command, idempotencyKey: command });
    return result.ok
      ? { ok: true, command: result.command }
      : { ok: false, code: result.code };
  }, { cardState: state, id: productionId, command: commandId });
}

async function openAdvancedAssets(page: Page): Promise<void> {
  const root = page.locator('html');
  if (await root.getAttribute('data-mode') !== 'advanced') {
    await page.keyboard.press('Control+Shift+A');
  }
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await page.locator('[data-rail-tab="assets"]').click();
  await expect(page.locator('#rail-panel-assets')).toBeVisible();
}

test('AV22: thumbnails, viewer region and range, scoped iterate, gated approval, then compare', async ({ page }) => {
  const env = loadEnv();
  resetFixture(env);

  const pkg = JSON.parse(readFileSync(join(env.runtimeDir, 'packages', `${env.packageId}.json`), 'utf8')) as Record<string, any>;
  makeGeneratedAsset(env, pkg);

  const takeScratch = join(env.runtimeDir, 'av22-takes');
  const baseTakeFile = join(takeScratch, 'base.mp4');
  const newTakeFile = join(takeScratch, 'new.mp4');
  makeVideo(baseTakeFile, '0x6d8cff');
  makeVideo(newTakeFile, '0xe6a15a');
  const baseTake = addTake(env, baseTakeFile, 11);
  expect(baseTake.takeId).toMatch(/^tk_[0-9a-f]{12}$/);

  const productionId = await createProduction(env);

  let captured: CapturedTurn | null = null;
  await page.route('**/api/agent/chat**', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no saved conversation' }) });
      return;
    }
    const body = request.postDataJSON() as {
      conversationId?: string;
      message?: string;
      iterationScope?: Record<string, any>;
    };
    if (!body.iterationScope) throw new Error('the viewer turn did not carry an iterationScope');
    captured = { message: String(body.message ?? ''), iterationScope: body.iterationScope };
    const conversationId = body.conversationId ?? 'chat_av22_scripted';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        conversation: {
          id: conversationId,
          revision: 1,
          messages: [
            { role: 'user', content: body.message ?? '' },
            { role: 'assistant', content: 'Proposed one scoped plan for the background only. Nothing has been approved or dispatched.' },
          ],
          plan: null,
          phase: 'chatting',
          projectId: env.packageId,
          projectRevision: 1,
        },
        reply: 'Proposed one scoped plan for the background only. Nothing has been approved or dispatched.',
        built: false,
      }),
    });
  });

  await page.addInitScript(() => {
    localStorage.setItem('comfyrizz.ui', JSON.stringify({ mode: 'advanced', density: 'compact' }));
    localStorage.removeItem('comfyrizz.project-chat');
  });

  await page.goto(`/?package=${encodeURIComponent(env.packageId)}&production=${encodeURIComponent(productionId)}#token=${encodeURIComponent(env.token)}`);
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(page).not.toHaveURL(/token=/);
  await openAdvancedAssets(page);

  const row = page.locator(`[data-asset-id="${ASSET_ID}"]`).first();
  await expect(row).toBeVisible();
  const thumb = row.locator('button[data-asset-open]');
  await expect(thumb).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(thumb).toHaveAttribute('data-thumb-state', 'ready', { timeout: 30_000 });
  const thumbImage = thumb.locator('img.thumb-img');
  await expect(thumbImage).toBeVisible();
  const imageUrl = await thumbImage.getAttribute('src');
  expect(imageUrl).toMatch(/^\/api\/media\/[A-Za-z0-9_-]+$/);
  expect(imageUrl).not.toContain(env.token);

  await thumb.click();
  const viewer = page.locator('dialog.asset-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('[data-viewer-live]')).toContainText('Asset');
  await expect(viewer.locator('[data-viewer-title]')).toHaveText(ASSET_ID);

  await page.keyboard.press('r');
  await expect(viewer.locator('[data-viewer-region-desc]')).toContainText('Region selected');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('r');
  await expect(viewer.locator('[data-viewer-region-desc]')).toContainText('Region:');

  await page.keyboard.press('i');
  await page.keyboard.press('l');
  await page.keyboard.press('o');

  await page.keyboard.press('e');
  const iterate = viewer.locator('[data-iterate-panel]');
  await expect(iterate).toBeVisible();
  await expect(iterate.locator('[data-iterate-level]')).not.toHaveText('Level: loading…');
  await iterate.locator('[data-iterate-element="background"]').click();
  await iterate.locator('[data-iterate-note]').fill('Give the background a warmer sunset glow.');
  const backgroundPreserve = iterate.locator('[data-iterate-preserve="background"]');
  await expect(backgroundPreserve).not.toBeChecked();
  await iterate.locator('[data-iterate-submit]').click();

  await expect.poll(() => captured).not.toBeNull();
  const turn = captured as CapturedTurn;
  expect(turn.message).toBe('Give the background a warmer sunset glow.');
  expect(turn.iterationScope).toMatchObject({
    target: {
      packageId: env.packageId,
      shotId: SHOT_ID,
      clipId: CLIP_ID,
      assetId: ASSET_ID,
    },
    element: 'background',
    note: 'Give the background a warmer sunset glow.',
  });
  expect(turn.iterationScope.region).toBeTruthy();
  expect(turn.iterationScope.region.x).toBeGreaterThan(0.25);
  expect(turn.iterationScope.region.w).toBeGreaterThan(0);
  expect(turn.iterationScope.region.h).toBeGreaterThan(0);
  expect(turn.iterationScope.time).toEqual({ in: 0, out: 4 });
  expect(turn.iterationScope.preserve).toContain('character');
  expect(turn.iterationScope.preserve).not.toContain('background');

  const scope = turn.iterationScope;
  let { snapshot, state } = await productionState(env, productionId);
  const firstPlan = await propose(env, productionId, snapshot.revision, scopedPlan(scope), 'a');
  expect(firstPlan.status, firstPlan.text).toBe(201);
  expect(firstPlan.body.plan.actions).toHaveLength(1);
  expect(firstPlan.body.plan.scope).toEqual(scope);

  ({ snapshot, state } = await productionState(env, productionId));
  const early = await approve(env, productionId, snapshot.revision, 'plan_av22', firstPlan.body.planHash as string, 'early');
  expect(early.status, early.text).toBe(409);
  expect(early.body.code).toBe('ITERATION_LEVEL_REQUIRED');

  // The refusal is the server's. The card renders the same gate from that
  // result, so the browser cannot offer an approval before a level exists.
  const cardBeforeLevel = await renderPlanCard(page, state, productionId, true);
  expect(cardBeforeLevel.iterationRequired).toBe(true);
  await expect(page.locator('#av22-plan-card [data-plan-card][data-iteration-required="true"]')).toBeVisible();
  await expect(page.locator('#av22-plan-card [data-plan-approve]')).toHaveCount(0);

  const level = await setLevel(env, productionId, snapshot.revision);
  expect(level.status, level.text).toBe(200);

  ({ snapshot, state } = await productionState(env, productionId));
  const secondPlan = await propose(env, productionId, snapshot.revision, scopedPlan(scope), 'b');
  expect(secondPlan.status, secondPlan.text).toBe(201);
  expect(secondPlan.body.plan.actions).toHaveLength(1);
  expect(secondPlan.body.plan.scope).toEqual(scope);

  ({ snapshot, state } = await productionState(env, productionId));
  const capped = await setSpendCap(env, productionId, snapshot.revision, 1, 'low');
  expect(capped.status, capped.text).toBe(200);
  expect(capped.body.ceiling).toBe(1);

  ({ snapshot, state } = await productionState(env, productionId));
  const card = await renderPlanCard(page, state, productionId);
  expect(card.canApprove).toBe(true);
  await expect(page.locator('#av22-plan-card [data-plan-approve]')).toBeVisible();
  await expect(page.locator('#av22-plan-card [data-plan-actions] [data-plan-action-id]')).toHaveCount(1);

  const cardApproval = await approvalFromCard(page, state, productionId, 'cmd_av22_card_approve');
  expect(cardApproval.ok).toBe(true);
  expect(cardApproval.command?.payload?.planHash).toBe(secondPlan.body.planHash);
  const approved = await call(env, `/api/productions/${encodeURIComponent(productionId)}/commands`, {
    body: cardApproval.command,
  });
  expect(approved.status, approved.text).toBe(200);
  expect(approved.body.events.some((event: { type?: string }) => event.type === 'plan.approved')).toBe(true);

  // Approval is gated by the level; the ledger cap is enforced when the
  // approved slot asks for a reservation. No backend is called here.
  ({ snapshot, state } = await productionState(env, productionId));
  const overCap = await dispatch(
    env,
    productionId,
    snapshot.revision,
    String(secondPlan.body.plan.id),
    'av22_background_take',
    'over_cap',
  );
  expect(overCap.status, overCap.text).toBe(409);
  expect(overCap.body.code).toBe('BUDGET_EXCEEDED');

  ({ snapshot, state } = await productionState(env, productionId));
  const raised = await setSpendCap(env, productionId, snapshot.revision, 100, 'high');
  expect(raised.status, raised.text).toBe(200);

  ({ snapshot, state } = await productionState(env, productionId));
  const admitted = await dispatch(
    env,
    productionId,
    snapshot.revision,
    String(secondPlan.body.plan.id),
    'av22_background_take',
    'final',
  );
  expect(admitted.status, admitted.text).toBe(202);
  expect(admitted.body.action.state).toBe('queued');
  ({ snapshot, state } = await productionState(env, productionId));
  expect(state.events.some((event: { type?: string }) => event.type === 'budget.reserved')).toBe(true);

  const newTake = addTake(env, newTakeFile, 29);
  expect(newTake.takeId).toMatch(/^tk_[0-9a-f]{12}$/);
  expect(newTake.takeId).not.toBe(baseTake.takeId);

  await page.reload();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await openAdvancedAssets(page);

  const chip = page.locator(`[data-clip-id="${CLIP_ID}"]`).first();
  await expect(chip).toBeVisible();
  await expect(chip.locator('.tl-clip-take')).toContainText('take 2 of 2', { timeout: 20_000 });
  await chip.dblclick();

  await expect(page.locator('dialog.asset-viewer')).toBeVisible();
  await page.keyboard.press('c');
  const compare = page.locator('[data-viewer-compare-host] [data-compare-view]');
  await expect(compare).toBeVisible();
  await expect(compare.locator('[data-compare-take]')).toHaveCount(2);
  await expect(compare.locator(`[data-compare-take="${newTake.takeId}"]`)).toBeVisible();
});
