// UX04: recovery actions exposed by the production watcher.
//
// The watcher is driven by an injected fetch and clock. The failure path is a
// scripted non-OK response; no network or Google Colab access is involved.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProductionState,
  applySnapshotToState,
} from '../productions/client.ts';
import {
  RECOVERY_ACTION_LABELS,
  recoveryActions,
  watchProduction,
} from './events.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';

function snapshot(recoveryIds = [], extra = {}) {
  return {
    production: {
      schema: 'comfyrizz.production/v1',
      id: PRODUCTION_ID,
      revision: 3,
      lastSequence: 5,
      pendingDecisionIds: [],
      actionIds: ['act_1'],
    },
    revision: 3,
    lastSequence: 5,
    epoch: 'epoch-1',
    plan: null,
    actions: [{ id: 'act_1', state: 'submission_unknown', runId: 'run_1' }],
    decisions: [],
    errors: [],
    execution: {
      status: 'reconcile',
      evidence: 'journal',
      activeActionIds: [],
      reconcileActionIds: ['act_1'],
      failedActionIds: [],
      terminalActionIds: [],
      reconcileRequired: true,
    },
    recovery: {
      actions: recoveryIds.map((id) => ({ id, reason: `${id} is required` })),
    },
    ...extra,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function queueFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next;
  };
  return { fetchImpl, calls };
}

function createTimers() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      jobs.set(id, { at: now + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    clearTimeout(id) {
      jobs.delete(id);
    },
    tick(ms) {
      const target = now + Math.max(0, Number(ms) || 0);
      while (true) {
        let chosen = null;
        for (const [id, job] of jobs) {
          if (job.at > target) continue;
          if (chosen === null || job.at < chosen.job.at || (job.at === chosen.job.at && id < chosen.id)) {
            chosen = { id, job };
          }
        }
        if (chosen === null) break;
        now = chosen.job.at;
        jobs.delete(chosen.id);
        chosen.job.callback();
      }
      now = target;
    },
  };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('server-declared recovery actions are exposed with plain labels', () => {
  const state = applySnapshotToState(
    createProductionState(PRODUCTION_ID),
    snapshot(['reconcile_shutdown', 'retry_download']),
  );
  const actions = recoveryActions(state);
  assert.deepEqual(actions.map((action) => action.id), ['reconcile_shutdown', 'retry_download']);
  assert.equal(actions[0].label, RECOVERY_ACTION_LABELS.reconcile_shutdown);
  assert.equal(actions[1].label, RECOVERY_ACTION_LABELS.retry_download);
  assert.match(actions[0].reason, /required/);
  assert.deepEqual(Object.keys(RECOVERY_ACTION_LABELS).sort(), [
    'new_generation',
    'reconcile_shutdown',
    'reconnect',
    'retry_download',
  ]);
});

test('a transport error adds reconnect without dropping state recovery actions', () => {
  const state = applySnapshotToState(
    createProductionState(PRODUCTION_ID),
    snapshot(['reconcile_shutdown']),
  );
  const actions = recoveryActions(state, { error: { code: 'NETWORK_ERROR' } });
  assert.deepEqual(actions.map((action) => action.id), ['reconcile_shutdown', 'reconnect']);
  assert.equal(actions[1].label, RECOVERY_ACTION_LABELS.reconnect);
});

test('a stale cursor exposes reconnect and leaves the actionable state intact', () => {
  const state = applySnapshotToState(
    createProductionState(PRODUCTION_ID),
    snapshot(['new_generation']),
  );
  const stale = { ...state, stale: true, gap: true, epochChanged: true, replayExpired: true };
  const actions = recoveryActions(stale);
  assert.ok(actions.some((action) => action.id === 'new_generation'));
  assert.ok(actions.some((action) => action.id === 'reconnect'));
});

test('the watcher keeps recovery actions while reporting a failed poll', async () => {
  const api = queueFetch([
    json(snapshot(['reconcile_shutdown'])),
    json({ error: 'events are unavailable', code: 'UNAVAILABLE' }, 503),
  ]);
  const timers = createTimers();
  const states = [];
  const stop = watchProduction({
    productionId: PRODUCTION_ID,
    fetchImpl: api.fetchImpl,
    onState: (state) => states.push(state),
    intervalMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  await settle();
  assert.equal(states.at(-1).error, null);
  const loaded = recoveryActions(states.at(-1));
  assert.deepEqual(loaded.map((action) => action.id), ['reconcile_shutdown']);

  timers.tick(2000);
  await settle();
  const failed = states.at(-1);
  assert.equal(failed.error.code, 'UNAVAILABLE');
  const recovered = recoveryActions(failed);
  assert.deepEqual(recovered.map((action) => action.id), ['reconcile_shutdown', 'reconnect']);
  assert.equal(failed.execution.status, 'reconcile');

  stop();
});
