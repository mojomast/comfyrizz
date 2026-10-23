// VX15 wiring: the prompt-voice gate must run on the app's real dispatch path.
//
// The app constructs the production coordinator with the production's package
// (read from the package store) and the character store, so an unapproved
// prompt-mode plate is refused before the action coordinator reserves budget.
// Clip mode and an absent voice stay ungated.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../../src/app.mjs';
import { createCharacterStore } from '../../src/characters/store.mjs';
import { validateVoice } from '../../src/characters/voice.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';

const TOKEN = 'vx15-wiring-token-0123456789';
const CHARACTER_ID = 'chr_1111111111111111';
const CAST_ID = 'c_pip';
const PLATE_ID = 'a_plate';
const SHOT_ID = 's_plate';
const DESCRIPTION = 'Warm, low narrator with an unhurried delivery.';
const SEED = 314159;
const AT = '2026-10-23T12:10:00.000Z';

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-voice-wiring-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function promptVoice() {
  return validateVoice({
    engine: 'kokoro',
    voice: 'af_heart',
    voiceDescription: DESCRIPTION,
    h3Mode: 'prompt',
    seed: SEED,
  });
}

function packageWith(voice) {
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: voice === undefined ? 'pkg_wire_absent' : voice.mode === 'clip' ? 'pkg_wire_clip' : 'pkg_wire_prompt',
    title: 'Wire plate',
    createdAt: AT,
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#0d0f14'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    scenes: [
      {
        id: SHOT_ID,
        layout: 'hero',
        variant: 'full-bleed',
        preferredFrames: 150,
        copy: { headline: 'Prompt plate' },
        speaker: CAST_ID,
        background: { asset: PLATE_ID },
      },
    ],
    assets: {
      [PLATE_ID]: {
        kind: 'video',
        origin: 'generated',
        status: 'pending',
        gen: {
          generator: 'fasth3-omni',
          ...(voice === undefined ? {} : { direction: { voice } }),
        },
      },
    },
  };
}

function seedPackage(runtimeDir, pkg) {
  const dir = join(runtimeDir, 'packages');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pkg.id}.json`), `${JSON.stringify(pkg, null, 2)}\n`);
}

// The gate reads the character's prompt identity from the stored voice. The
// CC03 create() path validates the legacy voice shape, so the prompt fields are
// written onto the stored record the same way a character editor persists them.
function seedCharacter(runtimeDir) {
  const store = createCharacterStore({ rootDir: runtimeDir });
  const created = store.create({ name: 'Pip', handle: 'pip' });
  const file = join(runtimeDir, 'characters', created.id, 'character.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.voice = promptVoice();
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return created;
}

async function startApp(t, runtimeDir) {
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    render: async () => ({ bytes: 0, frames: 0, hash: '0' }),
  });
  t.after(() => app.close());
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  return {
    app,
    call(options = {}) {
      return new Promise((resolve, reject) => {
        const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
        const request = httpRequest({
          hostname: '127.0.0.1',
          port,
          method: options.method ?? 'GET',
          path: options.url,
          headers: {
            host: `127.0.0.1:${port}`,
            origin: `http://127.0.0.1:${port}`,
            'x-comfyrizz-token': TOKEN,
            ...(payload ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            } : {}),
          },
        }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body;
            try { body = JSON.parse(text); } catch { body = undefined; }
            resolve({ status: response.statusCode, headers: response.headers, body, raw: text });
          });
        });
        request.on('error', reject);
        request.end(payload);
      });
    },
  };
}

async function createProduction(ctx, store, packageId, suffix) {
  const created = await ctx.call({
    method: 'POST',
    url: '/api/productions',
    body: {
      commandId: `cmd_create_${suffix}`,
      idempotencyKey: `key_create_${suffix}`,
      kind: 'production.create',
      payload: {
        conversationId: `conv_${suffix}`,
        packageId,
        shotIds: [SHOT_ID],
        characterBindings: [{ characterId: CHARACTER_ID }],
      },
    },
  });
  assert.equal(created.status, 201, created.raw);
  const id = created.body.productionId;
  const iteration = await ctx.call({
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: {
      commandId: `cmd_iteration_${suffix}`,
      idempotencyKey: `key_iteration_${suffix}`,
      kind: 'iteration.set',
      expected: { productionRevision: store.read(id).revision },
      payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
    },
  });
  assert.equal(iteration.status, 200, iteration.raw);
  return id;
}

async function proposeAndApprove(ctx, store, id, suffix) {
  const proposed = await ctx.call({
    method: 'POST',
    url: `/api/productions/${id}/action-plans`,
    body: {
      commandId: `cmd_plan_${suffix}`,
      idempotencyKey: `key_plan_${suffix}`,
      expected: { productionRevision: store.read(id).revision },
      payload: {
        planId: `plan_${suffix}`,
        revision: 0,
        reservationCeiling: 5,
        collectAndStopReserve: 0,
        requiredDecisions: [],
        actions: [{
          id: `act_${suffix}`,
          kind: 'take',
          targetId: SHOT_ID,
          assetId: PLATE_ID,
          upperBound: 2,
          effectiveInputHash: `hash_${suffix}`,
          seed: 1,
        }],
      },
    },
  });
  assert.equal(proposed.status, 201, proposed.raw);
  const approved = await ctx.call({
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: {
      commandId: `cmd_approve_${suffix}`,
      idempotencyKey: `key_approve_${suffix}`,
      kind: 'plan.approve',
      expected: { productionRevision: store.read(id).revision },
      payload: { planId: proposed.body.plan.id, planHash: proposed.body.planHash },
    },
  });
  assert.equal(approved.status, 200, approved.raw);
  return proposed.body.plan;
}

function dispatch(ctx, store, id, suffix, actionId) {
  return ctx.call({
    method: 'POST',
    url: `/api/productions/${id}/actions`,
    body: {
      commandId: `cmd_dispatch_${suffix}`,
      idempotencyKey: `key_dispatch_${suffix}`,
      expected: { productionRevision: store.read(id).revision },
      payload: { planId: `plan_${suffix}`, planRevision: 0, actionId },
    },
  });
}

test('app dispatch blocks an unapproved prompt voice before reserving budget', async (t) => {
  const runtimeDir = tempRuntime(t);
  const ctx = await startApp(t, runtimeDir);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });

  seedPackage(runtimeDir, packageWith({ mode: 'prompt', description: DESCRIPTION, seed: SEED }));
  seedCharacter(runtimeDir);

  const id = await createProduction(ctx, store, 'pkg_wire_prompt', 'prompt');
  await proposeAndApprove(ctx, store, id, 'prompt');

  const production = store.read(id);
  const ledger = createBudgetLedger({ runtimeDir, ledgerId: production.budgetLedgerId });
  assert.deepEqual(ledger.status().openReservations, []);

  const blocked = await dispatch(ctx, store, id, 'prompt', 'act_prompt');
  assert.equal(blocked.status, 202, blocked.raw);
  assert.equal(blocked.body.status, 'blocked');
  assert.equal(blocked.body.admitted, false);
  assert.equal(blocked.body.code, 'VOICE_AUDITION_REQUIRED');
  assert.equal(blocked.body.blocked.assetId, PLATE_ID);

  assert.deepEqual(store.read(id).actionIds, []);
  assert.deepEqual(ledger.status().openReservations, []);
  assert.equal(ledger.status().spent, 0);
});

async function assertUngated(t, { voice, packageId, suffix }) {
  const runtimeDir = tempRuntime(t);
  const ctx = await startApp(t, runtimeDir);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });

  seedPackage(runtimeDir, packageWith(voice));
  seedCharacter(runtimeDir);

  const id = await createProduction(ctx, store, packageId, suffix);
  await proposeAndApprove(ctx, store, id, suffix);

  const dispatched = await dispatch(ctx, store, id, suffix, `act_${suffix}`);
  assert.equal(dispatched.status, 202, dispatched.raw);
  assert.equal(dispatched.body.action.state, 'queued');
  assert.deepEqual(store.read(id).actionIds, [`act_${suffix}`]);

  const production = store.read(id);
  const ledger = createBudgetLedger({ runtimeDir, ledgerId: production.budgetLedgerId });
  assert.equal(ledger.status().openReservations.length, 1);
}

test('app dispatch leaves clip mode ungated', async (t) => {
  await assertUngated(t, { voice: { mode: 'clip' }, packageId: 'pkg_wire_clip', suffix: 'clip' });
});

test('app dispatch leaves an absent voice ungated', async (t) => {
  await assertUngated(t, { voice: undefined, packageId: 'pkg_wire_absent', suffix: 'absent' });
});
