// @ts-nocheck
// UR21: Easy Step 4 plan view.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { escapeHtml } from '../src/easy/components.ts';
import { defaultEasyState } from '../src/easy/store.ts';
import {
  planPrimary,
  renderPlan,
  step,
} from '../src/easy/steps/plan.ts';

const FACTS = {
  hasPackage: true,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);

const PACKAGE = {
  id: 'pkg_plan',
  scenes: [
    { id: 's1', copy: { headline: 'Crumb & Co' }, narration: 'Fresh bread at your door.' },
    { id: 's2', copy: { headline: 'Hands knead dough' }, narration: 'We bake at five.' },
  ],
};

function planEvent(actions, ceiling = 6, requiredDecisions = []) {
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
      reservationCeiling: ceiling,
      collectAndStopReserve: 0,
      requiredDecisions,
      actions,
    },
  };
}

function snapshot(overrides = {}, actions = [
  { id: 'act_s1', kind: 'shot.generate', targetId: 's1', upperBound: 3, versions: 2, reuse: false },
  { id: 'act_s2', kind: 'shot.generate', targetId: 's2', upperBound: 3, versions: 2, reuse: false },
], ceiling = 6, requiredDecisions = []) {
  return {
    productionId: PRODUCTION_ID,
    production: { id: PRODUCTION_ID, revision: 4 },
    revision: 4,
    events: [planEvent(actions, ceiling, requiredDecisions)],
    gap: false,
    stale: false,
    ...overrides,
  };
}

function readyState(overrides = {}) {
  return {
    ...defaultEasyState(),
    packageId: 'pkg_plan',
    productionId: PRODUCTION_ID,
    compute: 'colab',
    spendCap: 15,
    plan: { status: 'ready', error: null, errorAt: null, wordsChanged: false },
    ...overrides,
  };
}

test('a writing plan shows a busy skeleton and the live status', () => {
  const state = {
    ...readyState(),
    plan: { status: 'writing', error: null, errorAt: null, wordsChanged: false },
  };
  const html = renderPlan(state, FACTS, { snapshot: snapshot(), package: PACKAGE });
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /data-easy-plan-status/);
  assert.equal(html.includes(COPY.plan.writing), true);
});

test('an error shows an alert with the matching copy and a retry button', () => {
  const state = {
    ...readyState(),
    plan: { status: 'error', error: 'boom', errorAt: 'proposal', wordsChanged: false },
  };
  const html = renderPlan(state, FACTS, { snapshot: snapshot(), package: PACKAGE });
  assert.match(html, /role="alert"/);
  assert.equal(html.includes(escapeHtml(COPY.errors.plan.proposal)), true);
  assert.equal(html.includes(COPY.errors.tryAgain), true);
  assert.match(html, /data-easy-plan-retry/);
});

test('a ready Google Colab plan shows the server ceiling and the spend cap', () => {
  const html = renderPlan(readyState(), FACTS, { snapshot: snapshot(), package: PACKAGE });
  assert.equal(html.includes('Up to 6 Google Colab units (spend cap 15)'), true);
  assert.equal(html.includes(COPY.plan.shots), true);
  assert.equal(html.includes(COPY.plan.makes.replace('{n}', '2').replace('{where}', 'Google Colab')), true);
});

test('a plan over the cap disables the primary and shows both level links', () => {
  const state = readyState();
  const over = snapshot({}, undefined, 18);
  const html = renderPlan(state, FACTS, { snapshot: over, package: PACKAGE });
  assert.equal(html.includes(COPY.plan.overCap.replace('{n}', '18').replace('{cap}', '15')), true);
  assert.equal(html.includes(COPY.plan.changeLevel), true);
  assert.equal(html.includes(COPY.plan.raiseCap), true);
  assert.match(html, /data-easy-plan-level/);
  const primary = planPrimary(state, over);
  assert.equal(primary.disabled, true);
  assert.equal(primary.label, COPY.plan.approve);
});

test('This computer says it is free and labels the primary Generate', () => {
  const state = readyState({ compute: 'cpu', spendCap: null });
  const html = renderPlan(state, FACTS, { snapshot: snapshot(), package: PACKAGE });
  assert.equal(html.includes(COPY.plan.free), true);
  assert.equal(html.includes(COPY.plan.madeHere), true);
  assert.equal(planPrimary(state, snapshot()).label, COPY.plan.generate);
  assert.equal(step.primaryLabel(state), COPY.plan.generate);
});

test('shot rows have labelled headline and narration inputs', () => {
  const html = renderPlan(readyState(), FACTS, { snapshot: snapshot(), package: PACKAGE });
  assert.match(html, /<label[^>]*for="easy-plan-headline-s1"[^>]*>On screen<\/label>/);
  assert.match(html, /<input[^>]*id="easy-plan-headline-s1"/);
  assert.match(html, /<label[^>]*for="easy-plan-narration-s1"[^>]*>Narration<\/label>/);
  assert.match(html, /<textarea[^>]*id="easy-plan-narration-s1"/);
  assert.equal(html.includes('Shot 1'), true);
  assert.equal(html.includes('Shot 2'), true);
});

test('Google Colab with no user-set cap is blocked and asks for a cap', () => {
  const state = readyState({ spendCap: null });
  const primary = planPrimary(state, snapshot());
  assert.equal(primary.disabled, true);
  assert.equal(typeof primary.reason, 'string');
  assert.match(primary.reason, /spend cap/);
  const html = renderPlan(state, FACTS, { snapshot: snapshot(), package: PACKAGE });
  assert.equal(html.includes(primary.reason), true);
});

test('required decisions render as fieldsets with a checked default', () => {
  const decisions = [{
    id: 'music',
    prompt: 'Music?',
    options: ['Warm', 'None'],
  }];
  const html = renderPlan(readyState(), FACTS, {
    snapshot: snapshot({}, undefined, 6, decisions),
    package: PACKAGE,
  });
  assert.match(html, /<fieldset[^>]*data-easy-plan-decision="music"/);
  assert.equal(html.includes('Music?'), true);
  assert.match(html, /value="Warm"[^>]*checked/);
});

test('an empty player explains that the preview appears after generation', () => {
  const html = renderPlan(readyState(), FACTS, { snapshot: snapshot(), package: PACKAGE });
  assert.equal(html.includes('Preview appears after you generate.'), true);
  assert.match(html, /data-easy-player[^>]*>[\s\S]*data-easy-plan-preview-empty/);
  assert.match(html, /data-easy-plan-preview-empty[^>]*>Preview appears after you generate\.</);
});

test('a player with generated shots does not show the empty placeholder', () => {
  const state = readyState({ generate: { status: 'done' } });
  const html = renderPlan(state, FACTS, { snapshot: snapshot(), package: PACKAGE });
  assert.equal(html.includes('Preview appears after you generate.'), false);
  assert.equal(html.includes('data-easy-plan-preview-empty'), false);
});

test('the step module is registered as plan', () => {
  assert.equal(step.id, 'plan');
  assert.equal(step.heading, COPY.plan.heading);
});
