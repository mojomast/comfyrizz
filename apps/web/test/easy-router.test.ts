// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultEasyState } from '../src/easy/store.ts';
import { initialRoute } from '../src/easy/router.ts';

const blocked = {
  hasPackage: true,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

test('a review link before the plan is approved opens the plan step', () => {
  const state = defaultEasyState();
  state.idea.text = 'A 30-second video for the bakery subscription.';
  state.packageId = 'p';
  const route = initialRoute('?package=p&step=review', state, blocked);
  assert.equal(route.step, 'plan');
});

test('view=editor opens the editor', () => {
  const route = initialRoute('?view=editor', defaultEasyState(), {
    hasPackage: false,
    planApproved: false,
    actionsActive: false,
    allShotsKept: false,
    exportCurrent: false,
  });
  assert.deepEqual({ view: route.view }, { view: 'editor' });
});

const fresh = {
  hasPackage: false,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

test('a bare visit opens the home screen, not a step', () => {
  const route = initialRoute('', null, fresh);
  assert.equal(route.home, true);
  assert.equal(route.view, 'easy');
});

test('New video and a saved video leave home', () => {
  const idea = initialRoute('?step=idea', null, fresh);
  assert.equal(idea.home, false);
  assert.equal(idea.step, 'idea');
  const saved = initialRoute('?package=pkg_newer', defaultEasyState(), fresh);
  assert.equal(saved.home, false);
});
