// @ts-nocheck
/**
 * IP34: the iterative production spine, end to end.
 *
 * One brief becomes a shot list, an approved scoped plan, a Google Colab G4
 * run (a local fake that implements the same runPackage contract, never a
 * session or a network call), a reviewed take, and an export bundle. The
 * browser renders the real plan, script, progress, controls and review modules
 * against the durable production journal; the server is the real app with only
 * its paid backend and final renderer replaced by fakes.
 *
 * No Google Colab session, network model call or secret is used.
 */
import { expect, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApp } from '../../server/src/app.mjs';

const TOKEN = `ip34-${randomBytes(16).toString('hex')}`;
const PACKAGE_ID = 'pkg_ip34_production_spine';
const CLIP_ID = `s1:a_plate1`;
const OUTPUT_BYTES = Buffer.from('fake Google Colab G4 plate for the IP34 spine\n');
const OUTPUT_SHA = createHash('sha256').update(OUTPUT_BYTES).digest('hex');

function systemChromium(): string | undefined {
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find(candidate => existsSync(candidate));
}

const chromiumPath = systemChromium();
if (chromiumPath) test.use({ launchOptions: { executablePath: chromiumPath } });

test.setTimeout(90_000);

function fixturePackage() {
  const path = new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.id = PACKAGE_ID;
  pkg.revision = 1;
  pkg.title = 'IP34 production spine';
  pkg.createdAt = '2026-10-23T09:00:00-04:00';
  // The fixture has one scene; a transition out of the last scene does not compile.
  for (const scene of pkg.scenes ?? []) delete scene.transitionOut;
  return pkg;
}

/** Give every declared asset a real file and a matching digest. */
function seedPackage(app, pkg) {
  const dir = dirname(app.store.path(pkg.id));
  for (const [assetId, asset] of Object.entries(pkg.assets ?? {})) {
    for (const file of [asset?.file, ...Object.values(asset?.variants ?? {}).map(variant => variant?.file)]) {
      if (typeof file !== 'string' || file === '') continue;
      const target = join(dir, file);
      mkdirSync(dirname(target), { recursive: true });
      const bytes = Buffer.from(`IP34 fixture ${assetId} ${file}\n`);
      writeFileSync(target, bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (file === asset.file) {
        asset.sha256 = sha256;
        asset.bytes = bytes.byteLength;
      }
      const variant = Object.values(asset?.variants ?? {}).find(item => item?.file === file);
      if (variant) {
        variant.sha256 = sha256;
        variant.bytes = bytes.byteLength;
      }
    }
  }
  app.store.seed(pkg);
  return dir;
}

/**
 * A local backend that speaks the same contract as the Google Colab adapter.
 * It records the run, writes one plate, and stops; nothing leaves the process.
 */
function createFakeGoogleColab() {
  const state = {
    backendIds: [] as string[],
    dryRuns: 0,
    realCalls: 0,
    startedAt: null as string | null,
    teardown: null as null | Record<string, unknown>,
    outputs: [] as string[],
  };
  const jobsDoc = {
    version: 1,
    jobs: [{
      id: 'a_plate1.1',
      asset: 'a_plate1',
      kind: 'plate',
      generator: 'ltx25',
      model: 'ltx-2.5',
      backend: 'colab:G4',
      dims: { width: 1024, height: 576 },
      fps: 24,
      frames: 97,
    }],
  };
  const estimate = { gpuMinutes: 1, overheadMinutes: 1, ratePerHour: 8.9 };

  const instance = (backendId: string) => ({
    id: backendId,
    async describe() {
      return {
        label: 'Google Colab G4 (local fake)',
        costVisibility: 'account-estimate',
        gpu: 'G4',
      };
    },
    async estimate() {
      return estimate;
    },
    async runPackage(pkg, run = {}) {
      if (run.dryRun) {
        state.dryRuns += 1;
        return { jobsDoc, estimate, teardown: null };
      }
      state.realCalls += 1;
      state.startedAt = new Date().toISOString();
      const output = join(run.outDir, 'assets/a_plate1.mp4');
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, OUTPUT_BYTES);
      state.outputs.push('assets/a_plate1.mp4');
      const teardown = { state: 'stopped', evidence: 'fake Google Colab teardown confirmed' };
      state.teardown = teardown;
      return {
        ok: true,
        package: pkg,
        jobsDoc,
        estimate,
        manifest: {
          complete: true,
          updatedAt: new Date().toISOString(),
          jobs: [{
            job: 'a_plate1.1',
            job_id: 'fake_job_1',
            attempt_id: 'fake_attempt_1',
            status: 'succeeded',
            outputs: [{
              relative: 'assets/a_plate1.mp4',
              sha256: OUTPUT_SHA,
              bytes: OUTPUT_BYTES.byteLength,
              measured: { width: 1024, height: 576, fps: 24, frames: 97 },
            }],
          }],
        },
        counts: { succeeded: 1, failed: 0, pending: 0 },
        applied: [],
        teardown,
        spend: { units: 2 },
        usage: { balance: 70, ratePerHour: 0 },
      };
    },
    async teardown() {
      const teardown = { state: 'stopped', evidence: 'fake Google Colab teardown confirmed' };
      state.teardown = teardown;
      return teardown;
    },
    async usage() {
      return { balance: 70, ratePerHour: 0 };
    },
  });

  return {
    state,
    factory: async (backendId: string) => {
      state.backendIds.push(backendId);
      return instance(backendId);
    },
  };
}

function fakeRender() {
  return async (_packagePath: string, output: string) => {
    writeFileSync(output, Buffer.from('IP34 final export render\n'));
    return { output, bytes: 25, frames: 30, hash: 'ip34-export-hash' };
  };
}

async function startApp() {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ip34-'));
  const colab = createFakeGoogleColab();
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    backendFactory: colab.factory,
    render: fakeRender(),
  });
  const pkg = fixturePackage();
  seedPackage(app, pkg);
  const server = createServer(app.handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function call(path: string, options: { method?: string; body?: unknown } = {}) {
    const response = await fetch(base + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        origin: base,
        'x-comfyrizz-token': TOKEN,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let json = null;
    try { json = text === '' ? null : JSON.parse(text); } catch { json = null; }
    return { status: response.status, body: json, text };
  }

  return {
    runtimeDir,
    colab,
    app,
    pkg,
    base,
    call,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      app.close();
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

async function productionState(ctx, productionId: string) {
  const snapshot = await ctx.call(`/api/productions/${encodeURIComponent(productionId)}`);
  expect(snapshot.status, snapshot.text).toBe(200);
  const events = await ctx.call(`/api/productions/${encodeURIComponent(productionId)}/events?after=0`);
  expect(events.status, events.text).toBe(200);
  const journal = events.body?.events ?? [];
  return {
    snapshot: snapshot.body,
    state: {
      ...snapshot.body,
      events: journal,
      artifacts: journal
        .filter(event => event.type === 'artifact.attached' && event.data?.artifact)
        .map(event => event.data.artifact),
    },
  };
}

async function renderInPage(page, kind: string, payload: unknown) {
  const html = await page.evaluate(async ({ kind, payload }) => {
    if (kind === 'script') {
      const mod = await import('/src/productions/cards/script-card.ts');
      const card = mod.readScriptCard(payload.state, {});
      return mod.renderScriptCard(card);
    }
    if (kind === 'plan') {
      const mod = await import('/src/productions/cards/plan-card.ts');
      const card = mod.readPlanCard(payload.state, {});
      return mod.renderPlanCard(card);
    }
    if (kind === 'progress') {
      const mod = await import('/src/productions/cards/progress.ts');
      return `${mod.renderProgressCard(payload.shots, { state: 'ready' })}
        ${mod.renderProgressControls(mod.readProgressControls(payload.controls, { teardown: payload.teardown }))}`;
    }
    if (kind === 'review') {
      const mod = await import('/src/takes/review-drawer.ts');
      return mod.renderReviewDrawer(payload.clips, { open: true, filter: payload.filter ?? 'needs' });
    }
    throw new Error(`unknown card ${kind}`);
  }, { kind, payload });
  await page.evaluate(markup => {
    document.body.innerHTML = `<main id="ip34-harness">${markup}</main>`;
  }, html);
  return html;
}

test('IP34: brief to shots to a fake Google Colab run to review to export', async ({ page }) => {
  const ctx = await startApp();
  const colab = ctx.colab;
  try {
    // 1. The brief creates a stable production identity before a package exists.
    const created = await ctx.call('/api/productions', {
      body: {
        commandId: 'cmd_ip34_create',
        idempotencyKey: 'key_ip34_create',
        kind: 'production.create',
        expected: { productionRevision: 0 },
        payload: { conversationId: 'conv_ip34', packageId: PACKAGE_ID },
      },
    });
    expect(created.status, created.text).toBe(201);
    const productionId = created.body.productionId;
    expect(productionId).toMatch(/^prod_/);
    expect(created.body.production.packageId).toBe(PACKAGE_ID);

    await page.goto('/ui-kit.html');
    let { state } = await productionState(ctx, productionId);

    // 2. A brief becomes a treatment and a shot list through the real script card.
    await renderInPage(page, 'script', { state });
    await expect(page.locator('[data-script-card]')).toHaveAttribute('data-card-status', 'empty');
    await expect(page.locator('[data-script-card]')).toContainText('No treatment or script yet');

    const treatment = await page.evaluate(async state => {
      const mod = await import('/src/productions/cards/script-card.ts');
      const card = mod.readScriptCard(state, {});
      return mod.editTreatment(card, 'A calm product brief about a night-shift automation agent.', {
        commandId: 'cmd_ip34_treatment',
        idempotencyKey: 'key_ip34_treatment',
      });
    }, state);
    expect(treatment.ok, JSON.stringify(treatment)).toBe(true);
    const treatmentSent = await ctx.call(`/api/productions/${productionId}/commands`, { body: treatment.command });
    expect(treatmentSent.status, treatmentSent.text).toBe(200);

    for (const [index, shot] of [
      { title: 'Open on the night city', description: 'A slow push through wet streets.', dialogue: 'Every night, the work begins.' },
      { title: 'The agent wakes', description: 'A calm interface unfolds across the desk.', dialogue: 'It already knows the plan.' },
    ].entries()) {
      ({ state } = await productionState(ctx, productionId));
      const ordinal = index + 1;
      const built = await page.evaluate(async ({ state, shot, ordinal }) => {
        const mod = await import('/src/productions/cards/script-card.ts');
        const card = mod.readScriptCard(state, {});
        return mod.addShot(card, shot, {
          commandId: `cmd_ip34_shot_${ordinal}`,
          idempotencyKey: `key_ip34_shot_${ordinal}`,
        });
      }, { state, shot, ordinal });
      expect(built.ok, JSON.stringify(built)).toBe(true);
      const sent = await ctx.call(`/api/productions/${productionId}/commands`, { body: built.command });
      expect(sent.status, sent.text).toBe(200);
      expect(sent.body.events[0].type).toBe('artifact.attached');
    }

    ({ state } = await productionState(ctx, productionId));
    await renderInPage(page, 'script', { state });
    await expect(page.locator('[data-script-shots] > li[data-shot-id]')).toHaveCount(2);
    await expect(page.locator('input[data-shot-field="title"]').nth(0)).toHaveValue('Open on the night city');
    await expect(page.locator('input[data-shot-field="title"]').nth(1)).toHaveValue('The agent wakes');
    await expect(page.locator('[data-script-card]')).toContainText('A slow push through wet streets.');

    // 3. Propose a scoped plan and approve it through the real plan card.
    const proposed = await ctx.call(`/api/productions/${productionId}/action-plans`, {
      body: {
        commandId: 'cmd_ip34_plan',
        idempotencyKey: 'key_ip34_plan',
        expected: { productionRevision: state.revision },
        payload: {
          planId: 'plan_ip34',
          revision: 0,
          reservationCeiling: 12,
          collectAndStopReserve: 2,
          requiredDecisions: [],
          actions: [
            { id: 'act_shot_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 5, reuse: false, effectiveInputHash: 'hash_shot_1', seed: 11 },
            { id: 'act_shot_2', kind: 'shot.generate', targetId: 'shot_2', upperBound: 5, reuse: false, effectiveInputHash: 'hash_shot_2', seed: 12 },
          ],
        },
      },
    });
    expect(proposed.status, proposed.text).toBe(201);
    const planHash = proposed.body.planHash;
    expect(planHash).toMatch(/^[0-9a-f]{64}$/);

    ({ state } = await productionState(ctx, productionId));
    await renderInPage(page, 'plan', { state });
    await expect(page.locator('[data-plan-card]')).toHaveAttribute('data-plan-approval', 'pending');
    await expect(page.locator('[data-plan-card]')).toContainText('Estimated upper bound: 12 units');
    await expect(page.locator('[data-plan-card]')).toContainText('2 actions, 2 new');

    const approval = await page.evaluate(async state => {
      const mod = await import('/src/productions/cards/plan-card.ts');
      const card = mod.readPlanCard(state, {});
      return mod.approvePlan(card, {
        commandId: 'cmd_ip34_plan_approve',
        idempotencyKey: 'key_ip34_plan_approve',
      });
    }, state);
    expect(approval.ok, JSON.stringify(approval)).toBe(true);
    expect(approval.command.payload.planHash).toBe(planHash);
    const approved = await ctx.call(`/api/productions/${productionId}/commands`, { body: approval.command });
    expect(approved.status, approved.text).toBe(200);

    ({ state } = await productionState(ctx, productionId));
    await renderInPage(page, 'plan', { state });
    await expect(page.locator('[data-plan-card]')).toHaveAttribute('data-plan-approval', 'approved');
    expect(state.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'production.created',
      'artifact.attached',
      'plan.proposed',
      'plan.approved',
    ]));

    // 4. Dispatch the approved slot and run it on the fake Google Colab backend.
    const dispatched = await ctx.call(`/api/productions/${productionId}/actions`, {
      body: {
        commandId: 'cmd_ip34_dispatch_1',
        idempotencyKey: 'key_ip34_dispatch_1',
        expected: { productionRevision: state.revision },
        payload: { planId: 'plan_ip34', planRevision: 0, actionId: 'act_shot_1' },
      },
    });
    expect(dispatched.status, dispatched.text).toBe(202);
    expect(dispatched.body.action.state).toBe('queued');

    const run = await ctx.call('/api/run', {
      body: {
        packageId: PACKAGE_ID,
        backendId: 'colab:G4',
        budgetUnits: 1000,
        mode: 'take',
        authority: {
          productionId,
          planId: 'plan_ip34',
          planHash,
          actionId: 'act_shot_1',
        },
        expected: { productionRevision: dispatched.body.revision },
      },
    });
    expect(run.status, run.text).toBe(200);
    const runId = run.body.runId;
    expect(runId).toMatch(/^run_/);

    let finished = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const loaded = await ctx.call(`/api/run/${runId}`);
      expect(loaded.status, loaded.text).toBe(200);
      const record = loaded.body.run;
      if (record.status === 'done' || record.status === 'failed' || record.status === 'stop_unconfirmed') {
        finished = record;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(finished, 'the Google Colab run did not finish').not.toBeNull();
    expect(finished.status, JSON.stringify({ error: finished.error, events: finished.events?.slice(-4), applied: finished.applied })).toBe('done');
    expect(finished.backendId).toBe('colab:G4');
    expect(finished.teardown.state).toBe('stopped');
    expect(colab.state.realCalls).toBe(1);
    expect(colab.state.dryRuns).toBe(1);
    expect(colab.state.teardown).toMatchObject({ state: 'stopped' });
    expect(colab.state.outputs).toEqual(['assets/a_plate1.mp4']);

    const colabRecord = {
      runId,
      backendId: finished.backendId,
      backendLabel: 'Google Colab G4 (local fake)',
      status: finished.status,
      teardown: finished.teardown,
      startedAt: colab.state.startedAt,
      dryRuns: colab.state.dryRuns,
      realCalls: colab.state.realCalls,
      outputs: colab.state.outputs,
      simulated: true,
    };
    await test.info().attach('google-colab-run.json', {
      body: JSON.stringify(colabRecord, null, 2),
      contentType: 'application/json',
    });

    // 5. Review the landed take with the real review drawer, then record the verdict.
    const clipsBefore = await ctx.call(`/api/package/${PACKAGE_ID}/clips`);
    expect(clipsBefore.status, clipsBefore.text).toBe(200);
    const clip = clipsBefore.body.clips.find(entry => entry.clipId === CLIP_ID);
    expect(clip, JSON.stringify(clipsBefore.body)).toBeTruthy();
    expect(clip.state).toBe('review');
    await renderInPage(page, 'review', { clips: clipsBefore.body.clips });
    await expect(page.locator('[data-review-drawer]')).toBeVisible();
    await expect(page.locator(`[data-review-clip="${CLIP_ID}"]`)).toHaveAttribute('data-review-status', 'needs');
    await expect(page.locator(`[data-review-clip="${CLIP_ID}"]`)).toContainText('Needs review');

    const takes = await ctx.call(`/api/package/${PACKAGE_ID}/clips/${encodeURIComponent(CLIP_ID)}/takes`);
    expect(takes.status, takes.text).toBe(200);
    const takeId = takes.body.selected;
    expect(takeId).toMatch(/^tk_/);

    const verdict = await ctx.call(`/api/package/${PACKAGE_ID}/clips/${encodeURIComponent(CLIP_ID)}/verdict`, {
      body: { verdict: 'approved', takeId, note: 'Reviewed in the IP34 spine' },
    });
    expect(verdict.status, verdict.text).toBe(200);
    const finalProduction = await productionState(ctx, productionId);
    const reviewCommand = await ctx.call(`/api/productions/${productionId}/commands`, {
      body: {
        commandId: 'cmd_ip34_clip_approve',
        idempotencyKey: 'key_ip34_clip_approve',
        kind: 'clip.approve',
        expected: { productionRevision: finalProduction.snapshot.revision },
        payload: { clipId: CLIP_ID, assetId: 'a_plate1', takeId, verdict: 'approved' },
      },
    });
    expect(reviewCommand.status, reviewCommand.text).toBe(200);
    expect(reviewCommand.body.events[0].type).toBe('clip.reviewed');

    const clipsAfter = await ctx.call(`/api/package/${PACKAGE_ID}/clips`);
    expect(clipsAfter.status, clipsAfter.text).toBe(200);
    const approvedClip = clipsAfter.body.clips.find(entry => entry.clipId === CLIP_ID);
    expect(approvedClip.state).toBe('approved');
    await renderInPage(page, 'review', { clips: clipsAfter.body.clips, filter: 'approved' });
    await expect(page.locator(`[data-review-clip="${CLIP_ID}"]`)).toHaveAttribute('data-review-status', 'approved');
    await expect(page.locator('[data-render-run]')).toContainText('Render');

    // 6. Progress and controls read from the durable record, including teardown.
    const reviewed = await productionState(ctx, productionId);
    await renderInPage(page, 'progress', {
      shots: [{ shotId: 'shot_1', label: 'Open on the night city', status: 'approved' }],
      controls: {
        production: reviewed.snapshot.production,
        revision: reviewed.snapshot.revision,
        lastSequence: reviewed.snapshot.lastSequence,
        events: reviewed.state.events,
        pendingActions: [],
      },
      teardown: finished.teardown,
    });
    await expect(page.locator('[data-shot-progress-strip]')).toContainText('Open on the night city');
    await expect(page.locator('[data-shot-status]')).toHaveText('Approved');
    await expect(page.locator('[data-progress-intent]')).toHaveAttribute('data-progress-intent', 'active');
    await expect(page.locator('[data-progress-teardown]')).toHaveAttribute('data-progress-teardown', 'stopped');
    await expect(page.locator('[data-progress-teardown-text]')).toContainText('Compute teardown confirmed.');

    // 7. The approved review gate admits the final export.
    const stored = await ctx.call(`/api/package/${PACKAGE_ID}`);
    expect(stored.status, stored.text).toBe(200);
    const exported = await ctx.call('/api/export', {
      body: { packageId: PACKAGE_ID, baseRevision: stored.body.revision, force: true },
    });
    expect(exported.status, exported.text).toBe(200);
    const names = exported.body.files.map(file => file.name);
    expect(names).toEqual(expect.arrayContaining(['video.mp4', 'captions.srt', 'captions.vtt', 'CREDITS.md', 'package.zip']));
    expect(exported.body.revision).toBe(stored.body.revision);
    expect(exported.body.frames).toBeGreaterThan(0);
    expect(existsSync(join(ctx.runtimeDir, 'out', 'export', PACKAGE_ID, 'video.mp4'))).toBe(true);

    const finalJournal = await ctx.call(`/api/productions/${productionId}/events?after=0`);
    expect(finalJournal.status, finalJournal.text).toBe(200);
    expect(finalJournal.body.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'production.created',
      'artifact.attached',
      'plan.proposed',
      'plan.approved',
      'action.state_changed',
      'budget.reserved',
      'clip.reviewed',
    ]));
  } finally {
    await ctx.close();
  }
});
