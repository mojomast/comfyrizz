// IL03: iteration.set through the one production command path.
//
// The iteration level is the user's creative-iteration budget. Only a user may
// set it; the command is compare-and-swap, idempotent, and journaled as one
// `iteration.set` event. The production snapshot keeps the effective policy
// under `production.iteration` so it survives a restart.
//
// D6: a mid-production change may not touch a shot whose render or take action
// is queued through completed. Those shots are refused per shot with
// ITERATION_SHOT_LOCKED, listed in the result, and left unchanged; the other
// requested shots take the new policy through shotOverrides.
//
// These tests use the real on-disk store in a temporary directory. There are
// no network or backend calls.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ITERATION_SHOT_LOCKED } from '../../src/productions/contract.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import {
  CommandError,
  createCommandHandler,
} from '../../src/productions/commands.mjs';
import {
  ITERATION_PRESETS,
  effectivePolicyForShot,
} from '../../src/productions/iteration.mjs';

const AT = '2026-10-23T10:35:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_iteration' });

function clone(value) {
  return structuredClone(value);
}

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-iteration-command-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeHandler(t, runtimeDir) {
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  t.after(() => store.close?.());
  return { store, handler };
}

function policy(level) {
  return clone(ITERATION_PRESETS[level]);
}

function createProduction(handler, overrides = {}) {
  return handler.execute({
    commandId: 'cmd_create',
    idempotencyKey: 'key_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: {
      conversationId: 'conv_iteration',
      shotIds: ['shot_1', 'shot_2', 'shot_3'],
      ...overrides,
    },
  }, USER);
}

function setEnvelope(productionId, revision, overrides = {}) {
  return {
    commandId: 'cmd_iteration',
    idempotencyKey: 'key_iteration',
    kind: 'iteration.set',
    productionId,
    expected: { productionRevision: revision },
    payload: { policy: policy('balanced') },
    ...overrides,
  };
}

function assertCommandError(fn, code, status) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CommandError, `expected CommandError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

function commitStateEvent(store, productionId, data, type = 'action.state_changed') {
  const production = store.read(productionId);
  return store.commit(productionId, {
    commandId: `cmd_event_${production.revision}`,
    idempotencyKey: `key_event_${production.revision}`,
    baseRevision: production.revision,
    production,
    events: [{ type, data }],
  });
}

test('a user sets the whole-production policy and the projection survives a restart', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  const result = handler.execute(setEnvelope(created.productionId, created.revision), USER);

  assert.equal(result.duplicate, false);
  assert.equal(result.committed, true);
  assert.equal(result.revision, 2);
  assert.deepEqual(result.production.iteration, {
    policy: policy('balanced'),
    level: 'balanced',
    setAt: AT,
    revision: 2,
  });

  const events = store.readEvents(created.productionId);
  assert.equal(events.at(-1).type, 'iteration.set');
  assert.equal(events.at(-1).userEventId, 'ue_iteration');
  assert.deepEqual(events.at(-1).data.policy.stages, policy('balanced').stages);

  const reopened = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  t.after(() => reopened.close?.());
  assert.deepEqual(reopened.read(created.productionId).iteration, result.production.iteration);
});

test('only a user may set the iteration policy', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  const envelope = setEnvelope(created.productionId, created.revision);

  for (const context of [
    { actor: 'agent', userEventId: 'ue_agent' },
    { actor: 'system' },
  ]) {
    assertCommandError(
      () => handler.execute(envelope, context),
      'ITERATION_USER_ONLY',
      403,
    );
  }

  assert.equal(store.read(created.productionId).revision, 1);
  assert.equal(store.read(created.productionId).iteration, undefined);
  assert.equal(store.readEvents(created.productionId).length, 1);
});

test('a replay is a duplicate and a changed replay is IDEMPOTENCY_CONFLICT', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  const envelope = setEnvelope(created.productionId, created.revision);
  const first = handler.execute(envelope, USER);

  const replay = handler.execute(envelope, { actor: 'user', userEventId: 'ue_replay' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, first.revision);
  assert.deepEqual(replay.production.iteration, first.production.iteration);
  assert.equal(store.readEvents(created.productionId).filter((event) => event.type === 'iteration.set').length, 1);

  assertCommandError(
    () => handler.execute(
      { ...envelope, payload: { policy: policy('draft') } },
      USER,
    ),
    'IDEMPOTENCY_CONFLICT',
    409,
  );
  assert.equal(store.read(created.productionId).revision, first.revision);
});

test('a scoped change applies the new policy through shotOverrides only', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  handler.execute(setEnvelope(created.productionId, created.revision), USER);
  const scoped = handler.execute(setEnvelope(created.productionId, 2, {
    commandId: 'cmd_iteration_scoped',
    idempotencyKey: 'key_iteration_scoped',
    payload: {
      policy: policy('director'),
      scope: { shotIds: ['shot_1'] },
    },
  }), USER);

  const iteration = scoped.production.iteration;
  assert.equal(iteration.level, 'custom');
  assert.deepEqual(iteration.policy.stages, policy('balanced').stages);
  assert.deepEqual(iteration.policy.shotOverrides, {
    shot_1: { stages: policy('director').stages },
  });
  assert.deepEqual(effectivePolicyForShot(iteration.policy, 'shot_1').stages, policy('director').stages);
  assert.deepEqual(effectivePolicyForShot(iteration.policy, 'shot_2').stages, policy('balanced').stages);

  const reopened = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  t.after(() => reopened.close?.());
  assert.deepEqual(reopened.read(created.productionId).iteration, iteration);
});

test('a locked shot is listed and unchanged while the other scoped shots change', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  handler.execute(setEnvelope(created.productionId, created.revision), USER);

  commitStateEvent(store, created.productionId, {
    id: 'act_render_1',
    state: 'running',
    shotId: 'shot_1',
  });

  const scoped = handler.execute(setEnvelope(created.productionId, store.read(created.productionId).revision, {
    commandId: 'cmd_iteration_locked',
    idempotencyKey: 'key_iteration_locked',
    payload: {
      policy: policy('director'),
      scope: { shotIds: ['shot_1', 'shot_2'] },
    },
  }), USER);

  assert.deepEqual(scoped.lockedShotIds, ['shot_1']);
  const iteration = scoped.production.iteration;
  assert.deepEqual(effectivePolicyForShot(iteration.policy, 'shot_1').stages, policy('balanced').stages);
  assert.deepEqual(effectivePolicyForShot(iteration.policy, 'shot_2').stages, policy('director').stages);
  assert.equal(Object.hasOwn(iteration.policy.shotOverrides, 'shot_1'), false);
  assert.equal(iteration.policy.shotOverrides.shot_2.stages.video.takes, policy('director').stages.video.takes);
});

test('take requests also lock their shot', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  handler.execute(setEnvelope(created.productionId, created.revision), USER);

  commitStateEvent(store, created.productionId, {
    shotId: 'shot_2',
    stage: 'video',
  }, 'take.requested');

  const scoped = handler.execute(setEnvelope(created.productionId, store.read(created.productionId).revision, {
    commandId: 'cmd_iteration_take_locked',
    idempotencyKey: 'key_iteration_take_locked',
    payload: {
      policy: policy('draft'),
      scope: { shotIds: ['shot_2', 'shot_3'] },
    },
  }), USER);

  assert.deepEqual(scoped.lockedShotIds, ['shot_2']);
  assert.deepEqual(effectivePolicyForShot(scoped.production.iteration.policy, 'shot_2').stages, policy('balanced').stages);
  assert.deepEqual(effectivePolicyForShot(scoped.production.iteration.policy, 'shot_3').stages, policy('draft').stages);
});

test('a change with every requested shot locked is refused and commits nothing', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  handler.execute(setEnvelope(created.productionId, created.revision), USER);

  commitStateEvent(store, created.productionId, {
    id: 'act_render_1',
    state: 'completed',
    shotId: 'shot_1',
  });
  const before = store.read(created.productionId);

  assert.throws(
    () => handler.execute(setEnvelope(created.productionId, before.revision, {
      commandId: 'cmd_iteration_all_locked',
      idempotencyKey: 'key_iteration_all_locked',
      payload: {
        policy: policy('director'),
        scope: { shotIds: ['shot_1'] },
      },
    }), USER),
    (error) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.code, ITERATION_SHOT_LOCKED);
      assert.equal(error.status, 409);
      assert.deepEqual(error.lockedShotIds, ['shot_1']);
      return true;
    },
  );

  assert.deepEqual(store.read(created.productionId), before);
  assert.equal(store.readEvents(created.productionId).some((event) => event.type === 'iteration.set' && event.commandId === 'cmd_iteration_all_locked'), false);
});

test('a whole-production change after the first set leaves locked shots on their old policy', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);
  handler.execute(setEnvelope(created.productionId, created.revision), USER);

  commitStateEvent(store, created.productionId, {
    id: 'act_take_1',
    state: 'queued',
    targetId: 'shot_1',
  });

  const whole = handler.execute(setEnvelope(created.productionId, store.read(created.productionId).revision, {
    commandId: 'cmd_iteration_whole',
    idempotencyKey: 'key_iteration_whole',
    payload: { policy: policy('director') },
  }), USER);

  assert.deepEqual(whole.lockedShotIds, ['shot_1']);
  const iteration = whole.production.iteration;
  assert.deepEqual(iteration.policy.stages, policy('director').stages);
  assert.deepEqual(effectivePolicyForShot(iteration.policy, 'shot_1').stages, policy('balanced').stages);
  assert.deepEqual(effectivePolicyForShot(iteration.policy, 'shot_2').stages, policy('director').stages);
  assert.equal(iteration.level, 'custom');
});

test('a stale production revision is a conflict and writes nothing', (t) => {
  const runtimeDir = tempRuntime(t);
  const { store, handler } = makeHandler(t, runtimeDir);
  const created = createProduction(handler);

  assertCommandError(
    () => handler.execute(setEnvelope(created.productionId, 0), USER),
    'REVISION_CONFLICT',
    409,
  );
  assert.equal(store.read(created.productionId).revision, 1);
  assert.equal(store.read(created.productionId).iteration, undefined);
});
