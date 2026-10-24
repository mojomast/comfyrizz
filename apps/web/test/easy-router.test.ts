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
  assert.equal(route.view, 'easy');
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

test('view=editor stays the editor without a package or step', () => {
  const route = initialRoute('?view=editor', null, {
    hasPackage: false,
    planApproved: false,
    actionsActive: false,
    allShotsKept: false,
    exportCurrent: false,
  });
  assert.equal(route.view, 'editor');
  assert.equal(route.home, false);
});

const fresh = {
  hasPackage: false,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

test('a bare visit opens Super Easy, not a step', () => {
  const route = initialRoute('', null, fresh);
  assert.equal(route.home, true);
  assert.equal(route.view, 'superEasy');
});

test('a studio step link opens the Easy studio', () => {
  const idea = initialRoute('?step=idea', null, fresh);
  assert.equal(idea.home, false);
  assert.equal(idea.view, 'easy');
  assert.equal(idea.step, 'idea');
  const review = initialRoute('?package=p&step=review', defaultEasyState(), blocked);
  assert.equal(review.view, 'easy');
  const saved = initialRoute('?package=pkg_newer', defaultEasyState(), fresh);
  assert.equal(saved.home, false);
  assert.equal(saved.view, 'easy');
});
