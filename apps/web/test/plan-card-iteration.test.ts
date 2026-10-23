// IL17: the plan card hides Approve until an iteration level is set, and a
// later level change is stale. Choosing a level is not spend approval.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvePlan,
  readPlanCard,
  renderPlanCard,
} from '../src/productions/cards/plan-card.ts';
import { iterationPresets } from '../src/productions/cards/iteration-card.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);

function paidPlan(sequence = 3) {
  return {
    id: 'evt_plan_1',
    sequence,
    productionId: PRODUCTION_ID,
    type: 'plan.proposed',
    data: {
      id: 'plan_1',
      productionId: PRODUCTION_ID,
      revision: 0,
      planHash: PLAN_HASH,
      reservationCeiling: 9,
      collectAndStopReserve: 2,
      requiredDecisions: [],
      actions: [
        { id: 'act_render', kind: 'render', targetId: 's1', upperBound: 6, backend: 'google-colab' },
      ],
    },
  };
}

function iterationSet(sequence, level = 'balanced') {
  return {
    id: 'evt_iteration_1',
    sequence,
    productionId: PRODUCTION_ID,
    type: 'iteration.set',
    data: { policy: iterationPresets()[level] },
  };
}

function state(overrides = {}) {
  return {
    productionId: PRODUCTION_ID,
    production: { id: PRODUCTION_ID, revision: 4, iteration: null },
    revision: 4,
    lastSequence: 3,
    targetSequence: 3,
    events: [paidPlan()],
    pendingEvents: [],
    pendingDecisions: [],
    pendingActions: [],
    gap: false,
    stale: false,
    ...overrides,
  };
}

function readFixture() {
  const preset = iterationPresets().balanced;
  return {
    policy: null,
    level: null,
    estimates: {
      draft: estimate(),
      balanced: estimate(),
      director: estimate(),
    },
    recommendation: { level: 'balanced', policy: preset, reasons: ['no history: balanced'] },
    prefill: null,
    lockedShotIds: [],
    revision: 4,
  };
}

function estimate() {
  return {
    gpuMinutes: { low: 1, expected: 2, high: 3 },
    units: { low: 0.2, expected: 0.4, high: 0.6 },
    wallMinutes: { low: 5, expected: 6, high: 8 },
    voiceSamples: 0,
    vsCap: { ceiling: null, fraction: null, status: 'no_cap' },
    labels: ['estimate; other sessions may be running'],
  };
}

test('Approve is hidden until a level is set and the picker is inline', () => {
  const card = readPlanCard(state());
  assert.equal(card.iterationRequired, true);
  assert.equal(card.canApprove, false);
  const html = renderPlanCard(card, { iterationRead: readFixture() });
  assert.equal(html.includes('data-plan-approve'), false);
  assert.match(html, /data-il-slot="iteration-level-picker"/);
  assert.match(html, /data-iteration-choice="draft"/);
  assert.match(html, /data-iteration-choice="balanced"/);
  assert.match(html, /data-iteration-choice="director"/);
  assert.match(html, /data-iteration-choice="recommended"/);
  assert.match(html, /Choosing a level is not spend approval/);
  assert.match(html, /Google Colab/);
  assert.equal(html.replace(/Google Colab/g, '').includes('Colab'), false);

  const approval = approvePlan(card);
  assert.equal(approval.ok, false);
  assert.equal(approval.code, 'ITERATION_LEVEL_REQUIRED');
  assert.equal('command' in approval, false);
});

test('a free plan still approves when no iteration level is set', () => {
  const card = readPlanCard(state({
    events: [paidPlan()],
    production: { id: PRODUCTION_ID, revision: 4, iteration: null },
  }));
  const free = readPlanCard(state({
    events: [{
      ...paidPlan(),
      data: {
        ...paidPlan().data,
        actions: [{ id: 'act_voice', kind: 'audition', engine: 'kokoro', upperBound: 0 }],
      },
    }],
  }));
  assert.equal(card.iterationRequired, true);
  assert.equal(free.iterationRequired, false);
  assert.equal(free.canApprove, true);
  assert.match(renderPlanCard(free), /data-plan-approve/);
});

test('a level set before the plan keeps Approve, and a later change is stale', () => {
  const ready = readPlanCard(state({
    production: {
      id: PRODUCTION_ID,
      revision: 5,
      iteration: { policy: iterationPresets().balanced, level: 'balanced' },
    },
    events: [iterationSet(2), paidPlan(4)],
    revision: 5,
  }));
  assert.equal(ready.iterationRequired, false);
  assert.equal(ready.iterationLevelChanged, false);
  assert.equal(ready.canApprove, true);
  const readyApproval = approvePlan(ready);
  assert.equal(readyApproval.ok, true);
  assert.equal(readyApproval.command.kind, 'plan.approve');

  const changed = readPlanCard(state({
    production: {
      id: PRODUCTION_ID,
      revision: 6,
      iteration: { policy: iterationPresets().director, level: 'director' },
    },
    events: [paidPlan(3), iterationSet(5, 'director')],
    revision: 6,
  }));
  assert.equal(changed.iterationLevelChanged, true);
  assert.equal(changed.canApprove, false);
  assert.equal(changed.status, 'stale');
  const html = renderPlanCard(changed);
  assert.match(html, /level changed — re-propose/);
  assert.equal(html.includes('data-plan-approve'), false);
  const approval = approvePlan(changed);
  assert.equal(approval.ok, false);
  assert.equal(approval.code, 'STALE_VIEW');
  assert.equal('command' in approval, false);
  assert.match(approval.error, /level changed — re-propose/);
});
