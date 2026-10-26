// UX08: the Easy Studio header reads the real UX05 save state instead of a
// hard-coded "Saved". These tests use an in-memory save source only.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from './copy.ts';
import { mountShellSave, saveStatusText } from './shell-save.ts';

function state(overrides = {}) {
  return {
    status: 'saved',
    editSequence: 2,
    acknowledgedSequence: 2,
    acknowledgedRevision: 4,
    currentRevision: null,
    error: null,
    ...overrides,
  };
}

function fakeSource(initial) {
  let current = initial;
  let listener = null;
  let unsubscribed = false;
  return {
    get state() { return current; },
    get unsubscribed() { return unsubscribed; },
    source: {
      saveState: () => current,
      subscribeSaveState(next) {
        listener = next;
        return () => { unsubscribed = true; };
      },
    },
    emit(next) {
      current = next;
      listener?.(next);
    },
  };
}

function fakeElement() {
  return {
    textContent: '',
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}

test('save state maps every UX05 status to truthful header copy', () => {
  assert.equal(saveStatusText(state({ status: 'saved' })), COPY.shell.saved);
  assert.equal(saveStatusText(state({ status: 'pending', acknowledgedSequence: 1 })), COPY.shell.saving);
  assert.equal(saveStatusText(state({ status: 'offline', acknowledgedRevision: null })), COPY.shell.offline);
  assert.equal(saveStatusText(state({ status: 'conflict', currentRevision: 5 })), COPY.shell.conflict);
  assert.equal(
    saveStatusText(state({ status: 'rejected', error: 'invalid package' })),
    'Save failed: invalid package',
  );
});

test('the Studio header starts from the actual save state, not a fixed Saved label', () => {
  const element = fakeElement();
  const source = fakeSource(state({ status: 'pending', acknowledgedSequence: 1 }));
  const controller = mountShellSave(element, source.source);

  assert.equal(element.textContent, COPY.shell.saving);
  assert.equal(element.getAttribute('data-status'), 'pending');

  controller.destroy();
  assert.equal(source.unsubscribed, true);
});

test('pending, failed and recovered saves update the Studio header live', () => {
  const element = fakeElement();
  const source = fakeSource(state());
  mountShellSave(element, source.source);

  source.emit(state({ status: 'pending', editSequence: 3, acknowledgedSequence: 2 }));
  assert.equal(element.textContent, COPY.shell.saving);
  assert.equal(element.getAttribute('data-status'), 'pending');

  source.emit(state({ status: 'offline', editSequence: 3, acknowledgedSequence: 2, acknowledgedRevision: null }));
  assert.equal(element.textContent, COPY.shell.offline);
  assert.equal(element.getAttribute('data-status'), 'offline');

  source.emit(state({ status: 'conflict', editSequence: 3, acknowledgedSequence: 2, currentRevision: 9 }));
  assert.equal(element.textContent, COPY.shell.conflict);
  assert.equal(element.getAttribute('data-status'), 'conflict');

  source.emit(state({ status: 'rejected', editSequence: 3, acknowledgedSequence: 2, error: 'bad scene' }));
  assert.match(element.textContent, /bad scene/);
  assert.equal(element.getAttribute('data-status'), 'rejected');

  source.emit(state({ status: 'saved', editSequence: 4, acknowledgedSequence: 4, acknowledgedRevision: 10 }));
  assert.equal(element.textContent, COPY.shell.saved);
  assert.equal(element.getAttribute('data-status'), 'saved');
});

test('a missing save source shows the offline state instead of claiming Saved', () => {
  const element = fakeElement();
  const controller = mountShellSave(element, null);
  assert.equal(element.textContent, COPY.shell.offline);
  assert.equal(element.getAttribute('data-status'), 'offline');
  controller.destroy();
});
