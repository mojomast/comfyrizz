// @ts-nocheck
/**
 * IL23: picker, then the paid-plan gate, then compare keep.
 *
 * The browser uses the real iteration picker, plan card, and compare view.
 * The server is the real app. The Google Colab backend is a local fake that
 * refuses runPackage. This test never calls /api/run and never starts a
 * Google Colab session.
 *
 * Choosing a level sends iteration.set only. It is not spend approval.
 */
import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/src/app.mjs';

const TOKEN = `il23-${randomBytes(16).toString('hex')}`;

function systemChromium(): string | undefined {
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find((candidate) => existsSync(candidate));
}

const chromiumPath = systemChromium();
if (chromiumPath) test.use({ launchOptions: { executablePath: chromiumPath } });

test.setTimeout(90_000);

function createFakeGoogleColab() {
  const state = { realCalls: 0, runPackageCalls: 0 };
  return {
    state,
    factory: async (backendId: string) => ({
      id: backendId,
      async describe() {
        return {
          label: 'Google Colab G4 (local fake)',
          costVisibility: 'account-estimate',
          gpu: 'G4',
        };
      },
      async estimate() {
        return { gpuMinutes: 0, overheadMinutes: 0, ratePerHour: 0 };
      },
      async runPackage() {
        state.runPackageCalls += 1;
        state.realCalls += 1;
        throw new Error('a paid generation is out of scope for this test');
      },
      async teardown() {
        return { state: 'stopped', evidence: 'no Google Colab session was started' };
      },
      async usage() {
        return { balance: 0, ratePerHour: 0 };
      },
    }),
  };
}

async function startApp() {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-il23-'));
  const colab = createFakeGoogleColab();
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    backendFactory: colab.factory,
    render: async () => {
      throw new Error('a final render is out of scope for this test');
    },
  });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
    colab,
    base,
    call,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.close();
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

function paidPlan(planId: string) {
  return {
    planId,
    revision: 0,
    reservationCeiling: 8,
    collectAndStopReserve: 1,
    requiredDecisions: [],
    actions: [{
      id: `${planId}_render`,
      kind: 'render',
      targetId: 'shot_1',
      upperBound: 4,
      reuse: false,
      effectiveInputHash: `hash_${planId}`,
      seed: 1,
    }],
  };
}

async function productionState(ctx, productionId: string) {
  const snapshot = await ctx.call(`/api/productions/${encodeURIComponent(productionId)}`);
  expect(snapshot.status, snapshot.text).toBe(200);
  const events = await ctx.call(`/api/productions/${encodeURIComponent(productionId)}/events?after=0`);
  expect(events.status, events.text).toBe(200);
  return {
    snapshot: snapshot.body,
    state: {
      ...snapshot.body,
      events: events.body?.events ?? [],
    },
  };
}

test('IL23: choose a level, then the plan gate, then keep a take', async ({ page }) => {
  const ctx = await startApp();
  try {
    const created = await ctx.call('/api/productions', {
      body: {
        commandId: 'cmd_il23_create',
        idempotencyKey: 'key_il23_create',
        kind: 'production.create',
        expected: { productionRevision: 0 },
        payload: { conversationId: 'conv_il23', shotIds: ['shot_1'] },
      },
    });
    expect(created.status, created.text).toBe(201);
    const productionId = created.body.productionId;
    expect(productionId).toMatch(/^prod_/);

    let { snapshot, state } = await productionState(ctx, productionId);
    const proposed = await ctx.call(`/api/productions/${productionId}/action-plans`, {
      body: {
        commandId: 'cmd_il23_plan_a',
        idempotencyKey: 'key_il23_plan_a',
        expected: { productionRevision: snapshot.revision },
        payload: paidPlan('plan_il23_a'),
      },
    });
    expect(proposed.status, proposed.text).toBe(201);
    const firstHash = proposed.body.planHash;
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/);

    ({ snapshot, state } = await productionState(ctx, productionId));
    const iteration = await ctx.call(`/api/productions/${encodeURIComponent(productionId)}/iteration`);
    expect(iteration.status, iteration.text).toBe(200);
    expect(iteration.body.level).toBeNull();

    const refused = await ctx.call(`/api/productions/${productionId}/commands`, {
      body: {
        commandId: 'cmd_il23_approve_early',
        idempotencyKey: 'key_il23_approve_early',
        kind: 'plan.approve',
        productionId,
        expected: { productionRevision: snapshot.revision },
        payload: { planId: 'plan_il23_a', planHash: firstHash, proposalRevision: 0 },
      },
    });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.code).toBe('ITERATION_LEVEL_REQUIRED');

    await page.goto('/ui-kit.html');
    await page.evaluate(async ({ read, productionId: id }) => {
      const mod = await import('/src/productions/cards/iteration-advanced.ts');
      const host = document.createElement('section');
      host.id = 'il23-level';
      document.body.appendChild(host);
      window.__il23Level = { sent: null };
      const mount = mod.mountIterationLevel({
        host,
        getMode: () => 'easy',
        getProductionId: () => id,
        read: async () => read,
        set: async (_productionId, input) => {
          window.__il23Level.sent = input;
          return { revision: read.revision };
        },
      });
      await mount.refresh();
    }, { read: iteration.body, productionId });

    await expect(page.locator('#il23-level [data-iteration-choice]')).toHaveCount(4);
    await expect(page.locator('#il23-level [aria-checked="true"]')).toHaveCount(0);
    await expect(page.locator('#il23-level')).toContainText('How many versions should we try?');
    await expect(page.locator('#il23-level')).toContainText('Google Colab');

    await page.evaluate(async ({ state: planState, read }) => {
      const mod = await import('/src/productions/cards/plan-card.ts');
      const card = mod.readPlanCard(planState, { iterationRequired: true });
      const host = document.createElement('div');
      host.id = 'il23-plan';
      host.innerHTML = mod.renderPlanCard(card, { iterationRead: read });
      document.body.appendChild(host);
      window.__il23Approval = mod.approvePlan(card, {
        commandId: 'cmd_il23_card_early',
        idempotencyKey: 'key_il23_card_early',
      });
    }, { state, read: iteration.body });

    await expect(page.locator('#il23-plan [data-plan-approve]')).toHaveCount(0);
    await expect(page.locator('#il23-plan [data-il-slot="iteration-level-picker"]')).toBeVisible();
    const earlyApproval = await page.evaluate(() => window.__il23Approval);
    expect(earlyApproval.ok).toBe(false);
    expect(earlyApproval.code).toBe('ITERATION_LEVEL_REQUIRED');
    expect(earlyApproval.command).toBeUndefined();

    await page.locator('#il23-level [data-iteration-choice="draft"]').click();
    await expect(page.locator('#il23-level [data-surface="change"]')).toContainText('Level: draft');
    await expect(page.locator('#il23-level [data-surface="change"]')).toContainText('You still approve each spend');
    const chosen = await page.evaluate(() => window.__il23Level.sent);
    expect(chosen.policy.level).toBe('draft');
    expect(chosen.actor).toBeUndefined();
    expect(JSON.stringify(chosen)).not.toContain('plan.approve');

    const iterationCommand = {
      commandId: 'cmd_il23_iteration_set',
      idempotencyKey: 'key_il23_iteration_set',
      kind: 'iteration.set',
      productionId,
      expected: { productionRevision: snapshot.revision },
      payload: { policy: chosen.policy },
    };
    expect(iterationCommand.actor).toBeUndefined();
    expect(JSON.stringify(iterationCommand)).not.toContain('plan.approve');
    const saved = await ctx.call(`/api/productions/${productionId}/commands`, { body: iterationCommand });
    expect(saved.status, saved.text).toBe(200);

    ({ snapshot, state } = await productionState(ctx, productionId));
    const levelEvents = state.events.filter((event) => event.type === 'iteration.set');
    expect(levelEvents).toHaveLength(1);
    expect(state.events.some((event) => event.type === 'plan.approved')).toBe(false);

    await page.evaluate(async (planState) => {
      const mod = await import('/src/productions/cards/plan-card.ts');
      const card = mod.readPlanCard(planState, {});
      const host = document.getElementById('il23-plan');
      host.innerHTML = mod.renderPlanCard(card);
      window.__il23Approval = mod.approvePlan(card, {
        commandId: 'cmd_il23_card_stale',
        idempotencyKey: 'key_il23_card_stale',
      });
    }, state);
    await expect(page.locator('#il23-plan [data-iteration-stale]')).toHaveText('level changed — re-propose');
    await expect(page.locator('#il23-plan [data-plan-approve]')).toHaveCount(0);
    const staleApproval = await page.evaluate(() => window.__il23Approval);
    expect(staleApproval.ok).toBe(false);
    expect(staleApproval.code).toBe('STALE_VIEW');
    expect(staleApproval.command).toBeUndefined();

    const reproposed = await ctx.call(`/api/productions/${productionId}/action-plans`, {
      body: {
        commandId: 'cmd_il23_plan_b',
        idempotencyKey: 'key_il23_plan_b',
        expected: { productionRevision: snapshot.revision },
        payload: paidPlan('plan_il23_b'),
      },
    });
    expect(reproposed.status, reproposed.text).toBe(201);

    ({ state } = await productionState(ctx, productionId));
    await page.evaluate(async (planState) => {
      const mod = await import('/src/productions/cards/plan-card.ts');
      const card = mod.readPlanCard(planState, {});
      const host = document.getElementById('il23-plan');
      host.innerHTML = mod.renderPlanCard(card);
      window.__il23Approval = mod.approvePlan(card, {
        commandId: 'cmd_il23_card_approve',
        idempotencyKey: 'key_il23_card_approve',
      });
    }, state);
    await expect(page.locator('#il23-plan [data-plan-approve]')).toBeVisible();
    const approval = await page.evaluate(() => window.__il23Approval);
    expect(approval.ok).toBe(true);
    expect(approval.command.kind).toBe('plan.approve');
    expect(approval.command.payload.planId).toBe('plan_il23_b');
    expect(approval.command.actor).toBeUndefined();
    const approved = await ctx.call(`/api/productions/${productionId}/commands`, { body: approval.command });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.events.some((event) => event.type === 'plan.approved')).toBe(true);

    await page.evaluate(async () => {
      const mod = await import('/src/takes/compare.ts');
      const host = document.createElement('div');
      host.id = 'il23-compare';
      document.body.appendChild(host);
      window.__il23Select = [];
      const take = (takeId, n) => ({
        takeId,
        assetId: 'a_plate',
        n,
        sha256: 'ab'.repeat(32),
        bytes: 16,
        media: { durationInSeconds: 1 },
        gen: { generator: 'fake' },
        createdAt: '2026-10-23T12:00:00.000Z',
        verdict: 'unreviewed',
      });
      mod.mountCompare(host, {
        api: {
          select: async (_packageId, _clipId, takeId) => {
            window.__il23Select.push(takeId);
            return { takeId };
          },
        },
        packageId: 'pkg_il23',
        clipId: 's1:a_plate',
        shotId: 's1',
        takes: [take('tk_il23_1', 1), take('tk_il23_2', 2)],
      });
    });
    await expect(page.locator('#il23-compare [data-compare-keep]')).toBeEnabled();
    await page.locator('#il23-compare [data-compare-keep]').click();
    await expect(page.locator('#il23-compare [data-compare-live]')).toContainText('Kept Take 1 of 2, shot s1.');
    await expect.poll(async () => page.evaluate(() => window.__il23Select)).toEqual(['tk_il23_1']);

    expect(ctx.colab.state.realCalls).toBe(0);
    expect(ctx.colab.state.runPackageCalls).toBe(0);
  } finally {
    await ctx.close();
  }
});
