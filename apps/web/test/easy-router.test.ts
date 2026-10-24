// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultEasyState } from '../src/easy/store.ts';
import { initialRoute } from '../src/easy/router.ts';

class FakeLocalStorage {
  map = new Map();
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

function withStorage(storage, run) {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (own) Object.defineProperty(globalThis, 'localStorage', own);
    else delete globalThis.localStorage;
  }
}

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

test('Super Easy remains the default when the stored flags are empty', () => {
  const storage = new FakeLocalStorage();
  const route = withStorage(storage, () => initialRoute('', null, fresh));
  assert.equal(route.home, true);
  assert.equal(route.view, 'superEasy');
  assert.equal(storage.getItem('comfyrizz.super-easy'), null);
});

test('a sticky prefer-Studio choice sends a bare visit to Easy home', () => {
  const storage = new FakeLocalStorage();
  storage.setItem('comfyrizz.super-easy', JSON.stringify({ preferStudio: true, seenSuperEasy: true }));
  const route = withStorage(storage, () => initialRoute('', null, fresh));
  assert.equal(route.home, true);
  assert.equal(route.view, 'easy');
});

test('the prefer-Studio choice can be passed explicitly instead of read from storage', () => {
  const route = initialRoute('', null, fresh, { preferStudio: true });
  assert.equal(route.home, true);
  assert.equal(route.view, 'easy');
  assert.equal(initialRoute('', null, fresh, { preferStudio: false }).view, 'superEasy');
});

test('prefer Studio does not hijack a step, package or editor link', () => {
  const storage = new FakeLocalStorage();
  storage.setItem('comfyrizz.super-easy', JSON.stringify({ preferStudio: true }));
  withStorage(storage, () => {
    const idea = initialRoute('?step=idea', null, fresh);
    assert.equal(idea.view, 'easy');
    assert.equal(idea.home, false);
    assert.equal(idea.step, 'idea');

    const saved = initialRoute('?package=pkg_newer', defaultEasyState(), fresh);
    assert.equal(saved.view, 'easy');
    assert.equal(saved.home, false);

    const editor = initialRoute('?view=editor', null, fresh);
    assert.equal(editor.view, 'editor');
    assert.equal(editor.home, false);
  });
});

test('seenSuperEasy alone does not opt out of the Super Easy landing', () => {
  const storage = new FakeLocalStorage();
  storage.setItem('comfyrizz.super-easy', JSON.stringify({ seenSuperEasy: true }));
  const route = withStorage(storage, () => initialRoute('', null, fresh));
  assert.equal(route.view, 'superEasy');
  assert.equal(route.home, true);
});

test('a broken Super Easy record does not break the landing', () => {
  const storage = new FakeLocalStorage();
  storage.setItem('comfyrizz.super-easy', '{not json');
  const route = withStorage(storage, () => initialRoute('', null, fresh));
  assert.equal(route.view, 'superEasy');
  assert.equal(route.home, true);
});

test('the global Mode stays easy or advanced; Super Easy is only a view', async () => {
  const ui = await import('../src/ui/prefs.ts');
  assert.deepEqual([...ui.MODES_LIST], ['easy', 'advanced']);
  assert.equal(ui.DEFAULT_MODE, 'easy');
  assert.deepEqual(Object.keys(ui.defaultPrefs()).sort(), ['density', 'mode', 'panels']);
});
