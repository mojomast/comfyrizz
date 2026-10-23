// VX15: prompt-mode shots never dispatch before the character's voice audition
// is approved, and the plan warns at plan time instead of refusing.
//
// The gate is pure: it reads the package's FastH3 prompt voice, maps the plate
// to its speaking scene, and compares the approved audition hash with the
// character's current seed+description identity. Missing, stale and unknown all
// fail closed; clip and an absent voice never do.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  approvePromptVoiceAudition,
} from '../../src/characters/audition.mjs';
import { validateVoice } from '../../src/characters/voice.mjs';
import {
  createActionCoordinator,
} from '../../src/productions/actions.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import { createProductionCoordinator } from '../../src/productions/coordinator.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { promptVoiceGate } from '../../src/productions/voice-gate.mjs';

const AT = '2026-10-23T12:10:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_voice_gate' });
const CHARACTER_ID = 'chr_1111111111111111';
const CAST_ID = 'c_pip';
const ASSET_ID = 'a_plate';
const SHOT_ID = 'shot_1';
const DESCRIPTION = 'Warm, low narrator with an unhurried delivery.';
const OTHER_DESCRIPTION = 'Bright, quick narrator with a dry edge.';
const SEED = 314159;
const LINE = 'Morning! This is what I sound like.';

function promptVoice(overrides = {}) {
  return validateVoice({
    engine: 'kokoro',
    voice: 'af_heart',
    voiceDescription: DESCRIPTION,
    h3Mode: 'prompt',
    seed: SEED,
    ...overrides,
  });
}

function character(voice = promptVoice()) {
  return { id: CHARACTER_ID, name: 'Pip', voice };
}

function characters(record = character()) {
  return new Map([[CAST_ID, record]]);
}

function approvedVoice() {
  const voice = promptVoice();
  const approval = approvePromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice,
    line: LINE,
    approvedBy: 'user',
  });
  return { ...voice, audition: approval.audition };
}

function packageWith(voice, { speaker = CAST_ID } = {}) {
  const pkg = {
    id: 'pkg_voice_gate',
    revision: 1,
    scenes: [{ id: SHOT_ID, speaker, background: { asset: ASSET_ID } }],
    assets: {
      [ASSET_ID]: {
        kind: 'video',
        origin: 'generated',
        status: 'pending',
        gen: {
          generator: 'fasth3-omni',
          direction: { voice },
        },
      },
    },
  };
  if (speaker === undefined) delete pkg.scenes[0].speaker;
  return pkg;
}

function promptDirection(overrides = {}) {
  return { mode: 'prompt', description: DESCRIPTION, seed: SEED, ...overrides };
}

test('a prompt plate with no approved audition is blocked with the cast identity', () => {
  const gate = promptVoiceGate({
    pkg: packageWith(promptDirection()),
    characters: characters(),
  });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.blocked, [{
    assetId: ASSET_ID,
    castId: CAST_ID,
    characterId: CHARACTER_ID,
    code: 'VOICE_AUDITION_REQUIRED',
  }]);
});

test('an approved audition for the current seed and description passes', () => {
  const gate = promptVoiceGate({
    pkg: packageWith(promptDirection()),
    characters: characters(character(approvedVoice())),
  });
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.blocked, []);
});

test('a description or seed edit makes the approval stale', () => {
  const audition = approvedVoice().audition;
  for (const edited of [
    { ...promptVoice({ voiceDescription: OTHER_DESCRIPTION }), audition },
    { ...promptVoice({ seed: 7 }), audition },
  ]) {
    const gate = promptVoiceGate({
      pkg: packageWith(promptDirection()),
      characters: characters(character(edited)),
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.blocked.length, 1);
    assert.equal(gate.blocked[0].code, 'VOICE_AUDITION_STALE');
    assert.equal(gate.blocked[0].assetId, ASSET_ID);
    assert.equal(gate.blocked[0].castId, CAST_ID);
  }
});

test('an unknown speaker fails closed', () => {
  const gate = promptVoiceGate({
    pkg: packageWith(promptDirection()),
    characters: new Map(),
  });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.blocked, [{
    assetId: ASSET_ID,
    castId: CAST_ID,
    characterId: null,
    code: 'VOICE_AUDITION_REQUIRED',
  }]);
});

test('a prompt plate with no speaker fails closed', () => {
  const pkg = packageWith(promptDirection());
  delete pkg.scenes[0].speaker;
  const gate = promptVoiceGate({
    pkg,
    characters: characters(character(approvedVoice())),
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.blocked[0].code, 'VOICE_AUDITION_REQUIRED');
  assert.equal(gate.blocked[0].castId, null);
  assert.equal(gate.blocked[0].characterId, null);
});

test('clip, an absent voice and non-FastH3 assets are never blocked', () => {
  const clip = packageWith({ mode: 'clip' });
  assert.deepEqual(promptVoiceGate({ pkg: clip, characters: new Map() }), {
    blocked: [],
    ok: true,
  });

  const absent = packageWith(undefined);
  delete absent.assets[ASSET_ID].gen.direction.voice;
  assert.deepEqual(promptVoiceGate({ pkg: absent, characters: new Map() }), {
    blocked: [],
    ok: true,
  });

  const notH3 = packageWith(promptDirection());
  notH3.assets[ASSET_ID].gen.generator = 'ltx25';
  assert.deepEqual(promptVoiceGate({ pkg: notH3, characters: new Map() }), {
    blocked: [],
    ok: true,
  });
});

test('the gate is pure and reports one entry per blocked plate', () => {
  const pkg = packageWith(promptDirection());
  pkg.assets.a_second = structuredClone(pkg.assets[ASSET_ID]);
  pkg.scenes.push({ id: 'shot_2', speaker: 'c_nib', background: { asset: 'a_second' } });
  const before = structuredClone(pkg);
  const cast = characters();

  const gate = promptVoiceGate({ pkg, characters: cast });
  assert.deepEqual(pkg, before, 'the package is not mutated');
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.blocked.map((entry) => entry.assetId), [ASSET_ID, 'a_second']);
  assert.deepEqual(gate.blocked.map((entry) => entry.castId), [CAST_ID, 'c_nib']);
});

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-voice-gate-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function setup(t, { pkg, cast } = {}) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const ledgers = new Map();
  const ledgerFor = (production) => {
    let ledger = ledgers.get(production.budgetLedgerId);
    if (!ledger) {
      ledger = createBudgetLedger({
        runtimeDir,
        ledgerId: production.budgetLedgerId,
        clock: () => new Date(AT),
      });
      ledgers.set(production.budgetLedgerId, ledger);
    }
    return ledger;
  };
  const actions = createActionCoordinator({
    store,
    handler,
    ledgerFor,
    ...(pkg !== undefined ? { pkg } : {}),
    ...(cast !== undefined ? { characters: cast } : {}),
  });
  const created = handler.execute({
    commandId: 'cmd_create',
    idempotencyKey: 'key_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: {
      conversationId: 'conv_voice_gate',
      shotIds: [SHOT_ID],
      characterBindings: [{ characterId: CHARACTER_ID }],
    },
  }, USER);
  const productionId = created.productionId;
  handler.execute({
    commandId: 'cmd_iteration',
    idempotencyKey: 'key_iteration',
    kind: 'iteration.set',
    productionId,
    expected: { productionRevision: store.read(productionId).revision },
    payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
  }, USER);
  return { runtimeDir, store, handler, ledgerFor, actions, productionId };
}

function slot(overrides = {}) {
  return {
    id: 'act_1',
    kind: 'take',
    targetId: SHOT_ID,
    assetId: ASSET_ID,
    upperBound: 2,
    effectiveInputHash: 'hash_act_1',
    seed: 1,
    ...overrides,
  };
}

function planPayload(overrides = {}) {
  return {
    planId: 'plan_1',
    revision: 0,
    reservationCeiling: 5,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions: [slot()],
    ...overrides,
  };
}

function propose(ctx, payload = planPayload()) {
  const production = ctx.store.read(ctx.productionId);
  return ctx.actions.propose({
    productionId: ctx.productionId,
    body: {
      commandId: 'cmd_propose',
      idempotencyKey: 'key_propose',
      expected: { productionRevision: production.revision },
      payload,
    },
    context: USER,
  });
}

function approve(ctx, plan) {
  const production = ctx.store.read(ctx.productionId);
  return ctx.handler.execute({
    commandId: `cmd_approve_${plan.planHash.slice(0, 8)}`,
    idempotencyKey: `key_approve_${plan.planHash.slice(0, 8)}`,
    kind: 'plan.approve',
    productionId: ctx.productionId,
    expected: { productionRevision: production.revision },
    payload: { planId: plan.id, planHash: plan.planHash },
  }, USER);
}

test('plan.propose reports one warning per blocked plate without refusing', (t) => {
  const pkg = packageWith(promptDirection());
  const ctx = setup(t, { pkg, cast: characters() });
  const proposed = propose(ctx);

  assert.equal(proposed.planHash.length > 0, true);
  assert.deepEqual(proposed.warnings, [{
    code: 'VOICE_AUDITION_REQUIRED',
    assetId: ASSET_ID,
    castId: CAST_ID,
  }]);
  assert.equal(ctx.store.readEvents(ctx.productionId).filter((event) => event.type === 'plan.proposed').length, 1);

  const approved = setup(t, { pkg, cast: characters(character(approvedVoice())) });
  assert.deepEqual(propose(approved).warnings, []);
});

test('the coordinator refuses a blocked action before any dispatch, hold or reservation', (t) => {
  const pkg = packageWith(promptDirection());
  const ctx = setup(t, { pkg, cast: characters() });
  const proposed = propose(ctx);
  approve(ctx, proposed.plan);

  const coordinator = createProductionCoordinator({
    store: ctx.store,
    actions: ctx.actions,
    pkg,
    characters: characters(),
    clock: () => new Date(AT),
  });

  const before = ctx.ledgerFor(ctx.store.read(ctx.productionId)).status();
  const result = coordinator.continue(ctx.productionId, { force: true });

  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'VOICE_AUDITION_REQUIRED');
  assert.equal(result.admitted, false);
  assert.equal(result.executed, 0);
  assert.deepEqual(ctx.store.read(ctx.productionId).actionIds, []);
  assert.deepEqual(ctx.store.pending(ctx.productionId), []);
  const after = ctx.ledgerFor(ctx.store.read(ctx.productionId)).status();
  assert.deepEqual(after.openReservations, before.openReservations);
});

test('the same action dispatches once the audition is approved', (t) => {
  const pkg = packageWith(promptDirection());
  const ctx = setup(t, { pkg, cast: characters() });
  const proposed = propose(ctx);
  approve(ctx, proposed.plan);

  const coordinator = createProductionCoordinator({
    store: ctx.store,
    actions: ctx.actions,
    pkg,
    characters: characters(character(approvedVoice())),
    clock: () => new Date(AT),
  });

  const result = coordinator.continue(ctx.productionId, { force: true });
  assert.equal(result.status, 'wait');
  assert.equal(result.executed, 1);
  assert.deepEqual(ctx.store.read(ctx.productionId).actionIds, ['act_1']);
  assert.equal(
    ctx.ledgerFor(ctx.store.read(ctx.productionId)).status().openReservations.length,
    1,
  );
});
