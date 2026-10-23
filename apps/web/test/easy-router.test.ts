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

test('a new user with no state starts on idea', () => {
  const route = initialRoute('', null, {
    hasPackage: false,
    planApproved: false,
    actionsActive: false,
    allShotsKept: false,
    exportCurrent: false,
  });
  assert.equal(route.step, 'idea');
  assert.equal(route.view, 'easy');
});
