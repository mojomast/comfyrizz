// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProductionTab } from '../src/editor/inspector/production.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);

function planEvent() {
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
      ],
    },
  };
}

function snapshot(overrides = {}) {
  return {
    productionId: PRODUCTION_ID,
    production: {
      id: PRODUCTION_ID,
      revision: 4,
      shots: [
        { shotId: 'shot_1', status: 'approved' },
        { shotId: 'shot_2', status: 'review' },
      ],
    },
    revision: 4,
    lastSequence: 3,
    targetSequence: 3,
    events: [planEvent()],
    pendingEvents: [],
    pendingDecisions: [],
    pendingActions: [],
    gap: false,
    stale: false,
    error: null,
    ...overrides,
  };
}

function clip() {
  return {
    clipId: 'ep2_video_a01',
    sceneId: 's1',
    assetId: 'a_1',
    slot: 'presenter',
    kind: 'presenter',
    from: 0,
    durationInFrames: 90,
    state: 'review',
    selected: 'tk_111111111111',
    selectedN: 1,
    takeCount: 2,
    newTakes: 0,
    lastJob: null,
    queued: false,
  };
}

test('production tab renders the plan, script, progress cards and review list from a snapshot', () => {
  const html = renderProductionTab(snapshot(), {
    productionId: PRODUCTION_ID,
    clips: [clip()],
    activeClipId: 'ep2_video_a01',
  });

  assert.match(html, /data-production-tab/);
  assert.match(html, /data-plan-card/);
  assert.match(html, /data-plan-id="plan_1"/);
  assert.match(html, /data-script-card/);
  assert.match(html, /data-production-card="progress"/);
  assert.match(html, /data-review-clip="ep2_video_a01"/);
});

test('production tab fails closed with the watch error on every card', () => {
  const html = renderProductionTab(snapshot({
    error: new Error('The production could not be read.'),
  }), { productionId: PRODUCTION_ID, clips: [] });

  assert.match(html, /data-production-error[^>]*role="alert"/);
  assert.match(html, /The production could not be read\./);
  assert.match(html, /data-plan-card[^>]*data-card-status="error"/);
  assert.match(html, /data-script-card[^>]*data-card-status="error"/);
  assert.match(html, /data-progress-error/);
});
