// IP29: the shot-plan and cost/impact card.
//
// The plan is read from exactly one source: the IP20 `plan.proposed` event
// data carried by an IP28 production client state. There is no second plan
// field, no client estimate and no network in this module. Approval cites the
// server's plan id, hash and proposal revision, and a stale card never builds
// an approval command.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_COMMAND_KIND,
  approvePlan,
  emptyPlanCard,
  errorPlanCard,
  loadingPlanCard,
  planCostLabel,
  readPlanCard,
  renderPlanCard,
  sendPlanApproval,
} from '../src/productions/cards/plan-card.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);

function planEvent(dataOverrides = {}) {
  return {
    id: 'evt_plan_1',
    sequence: 3,
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
        { id: 'act_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 3, reuse: false },
        { id: 'act_2', kind: 'shot.reuse', targetId: 'shot_2', upperBound: 2, reuse: true },
        { id: 'act_3', kind: 'shot.generate', targetId: 'shot_3', upperBound: 2 },
      ],
      ...dataOverrides,
    },
  };
}

function approvalEvent(type, dataOverrides = {}) {
  return {
    id: `evt_${type}`,
    sequence: 4,
    productionId: PRODUCTION_ID,
    type,
    data: {
      planId: 'plan_1',
      planHash: PLAN_HASH,
      proposalRevision: 0,
      ...dataOverrides,
    },
  };
}

function state(overrides = {}) {
  return {
    productionId: PRODUCTION_ID,
    production: { id: PRODUCTION_ID, revision: 4 },
    revision: 4,
    lastSequence: 3,
    targetSequence: 3,
    events: [planEvent()],
    pendingEvents: [],
    pendingDecisions: [],
    pendingActions: [],
    gap: false,
    stale: false,
    ...overrides,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('readPlanCard reads only the plan.proposed event data', () => {
  const card = readPlanCard(state({
    production: {
      id: PRODUCTION_ID,
      revision: 4,
      plan: {
        id: 'decoy_production_plan',
        planHash: 'd'.repeat(64),
        revision: 99,
        reservationCeiling: 1,
      },
      cards: {
        plan: {
          id: 'decoy_cards_plan',
          planHash: 'e'.repeat(64),
          revision: 98,
          reservationCeiling: 2,
        },
      },
      planCard: {
        id: 'decoy_plan_card',
        planHash: 'f'.repeat(64),
        revision: 97,
        reservationCeiling: 3,
      },
    },
    events: [
      { id: 'evt_created', sequence: 1, type: 'production.created', data: { productionId: PRODUCTION_ID } },
      planEvent(),
    ],
  }));

  assert.equal(card.status, 'ready');
  assert.equal(card.state, 'ready');
  assert.equal(card.stale, false);
  assert.equal(card.productionId, PRODUCTION_ID);
  assert.equal(card.revision, 4);
  assert.equal(card.planId, 'plan_1');
  assert.equal(card.planHash, PLAN_HASH);
  assert.equal(card.proposalRevision, 0);
  assert.equal(card.reservationCeiling, 9);
  assert.equal(card.collectAndStopReserve, 2);
  assert.deepEqual(card.requiredDecisions, []);
  assert.deepEqual(card.actions.map((action) => action.id), ['act_1', 'act_2', 'act_3']);
  assert.deepEqual(card.actions.map((action) => action.upperBound), [3, 2, 2]);
  assert.equal(card.actions[1].reuse, true);
});

test('the latest plan.proposed event is the plan the card shows', () => {
  const card = readPlanCard(state({
    events: [
      planEvent({ id: 'plan_1', revision: 0, planHash: 'a'.repeat(64) }),
      { ...planEvent({ id: 'plan_1', revision: 1, planHash: 'b'.repeat(64), reservationCeiling: 12 }), sequence: 4 },
    ],
  }));

  assert.equal(card.planHash, 'b'.repeat(64));
  assert.equal(card.proposalRevision, 1);
  assert.equal(card.reservationCeiling, 12);
});

test('a plan without an id, hash or revision is an error, never a derived value', () => {
  for (const field of ['id', 'planHash', 'revision']) {
    const card = readPlanCard(state({
      events: [planEvent({ [field]: undefined })],
      production: {
        id: PRODUCTION_ID,
        revision: 4,
        plan: { id: 'decoy', planHash: 'd'.repeat(64), revision: 9, reservationCeiling: 1 },
      },
    }));

    assert.equal(card.status, 'error', `missing ${field}`);
    assert.equal(card.state, 'error');
    assert.equal(card.planId, null);
    assert.equal(card.planHash, null);
    assert.equal(card.proposalRevision, null);
    assert.ok(card.error);
  }
});

test('a plan without a server reservation ceiling or action list is an error', () => {
  const noCeiling = readPlanCard(state({ events: [planEvent({ reservationCeiling: undefined })] }));
  assert.equal(noCeiling.status, 'error');
  assert.equal(noCeiling.reservationCeiling, null);

  const noActions = readPlanCard(state({ events: [planEvent({ actions: undefined })] }));
  assert.equal(noActions.status, 'error');
  assert.deepEqual(noActions.actions, []);
});

test('approval matches planId, planHash and proposal revision together', () => {
  const approved = readPlanCard(state({ events: [planEvent(), approvalEvent('plan.approved')] }));
  assert.equal(approved.approval, 'approved');
  assert.equal(approved.approved, true);
  assert.equal(approved.rejected, false);

  const mismatches = [
    approvalEvent('plan.approved', { planId: 'plan_other' }),
    approvalEvent('plan.approved', { planHash: 'd'.repeat(64) }),
    approvalEvent('plan.approved', { proposalRevision: 1 }),
    approvalEvent('plan.approved', { proposalRevision: undefined }),
  ];
  for (const event of mismatches) {
    const card = readPlanCard(state({ events: [planEvent(), event] }));
    assert.equal(card.approval, 'pending', JSON.stringify(event.data));
    assert.equal(card.approved, false);
  }

  const rejected = readPlanCard(state({
    events: [
      planEvent(),
      approvalEvent('plan.approved'),
      approvalEvent('plan.rejected'),
    ],
  }));
  assert.equal(rejected.approval, 'rejected');
  assert.equal(rejected.approved, false);
  assert.equal(rejected.rejected, true);
});

test('the cost is the reservation ceiling shown as an upper bound', () => {
  const card = readPlanCard(state({
    events: [planEvent({
      reservationCeiling: 9,
      collectAndStopReserve: 2,
      gpuMinutes: 99,
      estimate: { gpuMinutes: 999 },
    })],
  }));

  assert.equal(card.reservationCeiling, 9);
  assert.equal(planCostLabel(card), 'Estimated upper bound: 9 units');
  const html = renderPlanCard(card);
  assert.match(html, /Estimated upper bound: 9 units/);
  assert.doesNotMatch(html, /gpuMinutes|999/);
  assert.doesNotMatch(html, />99</);
});

test('the card counts reuse, new work and unclassified action slots from the plan', () => {
  const card = readPlanCard(state());

  assert.deepEqual(card.impact, {
    actions: 3,
    reused: 1,
    generated: 1,
    unknown: 1,
    actionUpperBound: 7,
    collectAndStopReserve: 2,
  });
  const html = renderPlanCard(card);
  assert.match(html, /data-plan-impact-actions="3"/);
  assert.match(html, /data-plan-impact-reused="1"/);
  assert.match(html, /data-plan-impact-generated="1"/);
  assert.match(html, /data-plan-impact-unknown="1"/);
  assert.match(html, /data-plan-collect-and-stop-reserve="2"/);
});

test('loading, empty, error and stale states are explicit', () => {
  assert.equal(readPlanCard(null).status, 'loading');
  assert.equal(readPlanCard(undefined).status, 'loading');
  assert.equal(readPlanCard({ productionId: PRODUCTION_ID }).status, 'loading');
  assert.equal(loadingPlanCard(PRODUCTION_ID).status, 'loading');
  assert.equal(errorPlanCard('snapshot failed', PRODUCTION_ID).status, 'error');
  assert.equal(errorPlanCard('snapshot failed', PRODUCTION_ID).error, 'snapshot failed');

  const empty = readPlanCard(state({
    events: [{ id: 'evt_created', sequence: 1, type: 'production.created', data: {} }],
  }));
  assert.equal(empty.status, 'empty');
  assert.equal(empty.planId, null);
  assert.deepEqual(empty.actions, []);

  const emptyCard = emptyPlanCard(PRODUCTION_ID);
  assert.equal(emptyCard.status, 'empty');
  assert.equal(emptyCard.productionId, PRODUCTION_ID);

  const stale = readPlanCard(state({ stale: true }));
  assert.equal(stale.status, 'stale');
  assert.equal(stale.state, 'stale');
  assert.equal(stale.stale, true);
  assert.equal(stale.planId, 'plan_1', 'a stale card still shows the last durable plan');
  assert.equal(stale.canApprove, false);

  const gapped = readPlanCard(state({ gap: true }));
  assert.equal(gapped.status, 'stale');
  assert.equal(gapped.stale, true);
});

test('approvePlan sends the exact plan identity and proposal revision', () => {
  const card = readPlanCard(state());
  const frozen = plain(card);
  const result = approvePlan(card, {
    commandId: 'cmd_approve_plan',
    idempotencyKey: 'key_approve_plan',
    baseRevision: 4,
    userEventId: 'ue_user_approve',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(card, frozen, 'the card is not mutated in place');
  assert.equal(result.command.kind, PLAN_COMMAND_KIND);
  assert.equal(result.command.kind, 'plan.approve');
  assert.equal(result.command.productionId, PRODUCTION_ID);
  assert.equal(result.command.expected.productionRevision, 4);
  assert.equal(result.command.commandId, 'cmd_approve_plan');
  assert.equal(result.command.idempotencyKey, 'key_approve_plan');
  assert.deepEqual(result.command.payload, {
    planId: 'plan_1',
    planHash: PLAN_HASH,
    proposalRevision: 0,
  });
  assert.equal('userEventId' in result.command, false, 'the server owns attribution');
  assert.equal('actor' in result.command, false, 'the server owns attribution');
  assert.equal(result.citation, 'ue_user_approve');
});

test('a command retry is deterministic and a different plan is not', () => {
  const card = readPlanCard(state());
  const first = approvePlan(card);
  const retry = approvePlan(card);
  const other = approvePlan(readPlanCard(state({
    events: [planEvent({ planHash: 'd'.repeat(64) })],
  })));

  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(first.command.commandId, retry.command.commandId);
  assert.equal(first.command.idempotencyKey, retry.command.idempotencyKey);
  assert.notEqual(first.command.commandId, other.command.commandId);
});

test('a stale, loading or planless card never builds an approval command', () => {
  const stale = approvePlan(readPlanCard(state({ stale: true })));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_VIEW');
  assert.equal('command' in stale, false);

  for (const card of [
    loadingPlanCard(PRODUCTION_ID),
    emptyPlanCard(PRODUCTION_ID),
    errorPlanCard('snapshot failed', PRODUCTION_ID),
  ]) {
    const result = approvePlan(card);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_READY');
    assert.equal('command' in result, false);
  }
});

test('a base revision that does not match the card is refused', () => {
  const result = approvePlan(readPlanCard(state()), { baseRevision: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVISION_MISMATCH');
  assert.equal('command' in result, false);
});

test('renderPlanCard renders safe durable data with the stable hooks', () => {
  const card = readPlanCard(state({
    events: [planEvent({
      id: 'plan_<1>',
      actions: [{ id: 'act_<1>', kind: 'shot.generate', upperBound: 1, reuse: false }],
    })],
  }));
  const html = renderPlanCard(card);

  assert.match(html, /data-plan-card/);
  assert.match(html, /data-production-card="plan"/);
  assert.match(html, /data-card-status="ready"/);
  assert.match(html, /data-card-state="ready"/);
  assert.match(html, /data-plan-id="plan_&lt;1&gt;"/);
  assert.match(html, new RegExp(`data-plan-hash="${PLAN_HASH}"`));
  assert.match(html, /data-plan-revision="0"/);
  assert.match(html, /data-reservation-ceiling="9"/);
  assert.match(html, /data-plan-approve/);
  assert.match(html, /data-plan-action-id="act_&lt;1&gt;"/);
  assert.equal(html.includes('<1>'), false, 'plan data is escaped, never injected as HTML');
});

test('renderPlanCard defines loading, empty, error and stale states', () => {
  const loading = renderPlanCard(loadingPlanCard(PRODUCTION_ID));
  assert.match(loading, /data-card-status="loading"/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Loading the plan/);

  const empty = renderPlanCard(emptyPlanCard(PRODUCTION_ID));
  assert.match(empty, /data-card-status="empty"/);
  assert.match(empty, /No plan has been proposed/);

  const error = renderPlanCard(errorPlanCard('snapshot failed', PRODUCTION_ID));
  assert.match(error, /data-card-status="error"/);
  assert.match(error, /role="alert"/);
  assert.match(error, /snapshot failed/);

  const stale = renderPlanCard(readPlanCard(state({ stale: true })));
  assert.match(stale, /data-card-status="stale"/);
  assert.match(stale, /data-card-stale="true"/);
  assert.match(stale, /behind the event journal/);
  assert.match(stale, /data-plan-approve[^>]*disabled/);
});

test('an approved plan is shown as approved and does not look approvable', () => {
  const card = readPlanCard(state({
    events: [planEvent(), approvalEvent('plan.approved')],
  }));
  const html = renderPlanCard(card);

  assert.equal(card.canApprove, false);
  assert.match(html, /data-plan-approval="approved"/);
  assert.match(html, /data-plan-approve[^>]*disabled/);
});

test('sendPlanApproval sends the built command through the one command client', async () => {
  const sent = [];
  const result = approvePlan(readPlanCard(state()), {
    commandId: 'cmd_approve_plan',
    idempotencyKey: 'key_approve_plan',
    baseRevision: 4,
  });
  const response = await sendPlanApproval({
    async sendCommand(envelope) {
      sent.push(envelope);
      return { ok: true };
    },
  }, result);

  assert.deepEqual(response, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'plan.approve');
  assert.equal(sent[0].payload.planHash, PLAN_HASH);

  await assert.rejects(
    () => sendPlanApproval({ async sendCommand() { throw new Error('must not be called'); } }, approvePlan(readPlanCard(state({ stale: true })))),
    /STALE_VIEW/,
  );
});
