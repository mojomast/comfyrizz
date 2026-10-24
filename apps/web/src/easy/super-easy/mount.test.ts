// SE07: first paint and in-place navigation for Super Easy.
//
// The mount is tested against a tiny fake root: no browser, no network and no
// player. The Easy delegation is checked from its source because that module
// imports CSS, which node:test cannot load. node:test imports are runtime-only.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defaultEasyState } from '../store.ts';
import { SUPER_EASY_EXAMPLE_PROMPT, mountSuperEasy, superEasyScreen } from './mount.ts';

const EASY_MOUNT = fileURLToPath(new URL('../mount.ts', import.meta.url));
const SUPER_EASY_MOUNT = fileURLToPath(new URL('./mount.ts', import.meta.url));

function state(patch = {}) {
  return { ...defaultEasyState(), ...patch };
}

function fakeRoot() {
  const listeners = new Map();
  const prompt = {
    value: '',
    focused: false,
    focus() {
      this.focused = true;
    },
  };
  const root = {
    innerHTML: '',
    dataset: {},
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    querySelector(selector) {
      return selector === '#super-easy-prompt' ? prompt : null;
    },
    fire(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
  return { root, prompt };
}

function clickTarget(selector) {
  return {
    closest(candidate) {
      return candidate === selector ? { selector } : null;
    },
  };
}

function submitTarget() {
  return clickTarget('[data-super-easy-form]');
}

test('a fresh video opens the Super Easy home and an existing run opens progress', () => {
  assert.equal(superEasyScreen(state()), 'home');
  assert.equal(superEasyScreen(state({ generate: { status: 'running' } })), 'progress');
  assert.equal(superEasyScreen(state({ productionId: 'prod_0123456789abcdef01234567' })), 'progress');
});

test('first paint is the Super Easy home, never the Easy studio or its player slot', () => {
  const { root } = fakeRoot();
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
  });

  assert.equal(root.dataset.superEasyView, 'home');
  assert.match(root.innerHTML, /data-super-easy-home/u);
  assert.match(root.innerHTML, /data-super-easy-form/u);
  assert.doesNotMatch(root.innerHTML, /data-super-easy-progress/u);
  assert.doesNotMatch(root.innerHTML, /data-easy-shell/u);
  assert.doesNotMatch(root.innerHTML, /data-easy-player/u);

  handle.destroy();
});

test('I want more control hands off to the studio instead of navigating the page', () => {
  const { root } = fakeRoot();
  let handedOff = 0;
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {
      handedOff += 1;
    },
  });

  let prevented = false;
  root.fire('click', {
    target: clickTarget('[data-super-easy-more-control]'),
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(handedOff, 1);
  handle.destroy();
});

test('Try an example fills the one prompt and keeps the happy path local', () => {
  const { root, prompt } = fakeRoot();
  let handedOff = 0;
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {
      handedOff += 1;
    },
  });

  root.fire('click', {
    target: clickTarget('[data-super-easy-example]'),
    preventDefault() {},
  });

  assert.equal(prompt.value, SUPER_EASY_EXAMPLE_PROMPT);
  assert.equal(prompt.focused, true);
  assert.equal(handedOff, 0);
  handle.destroy();
});

test('Generate sends the trimmed prompt to This computer and never to Google Colab', () => {
  const { root, prompt } = fakeRoot();
  const calls = [];
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
    onGenerate: (input) => {
      calls.push(input);
    },
  });

  prompt.value = '  A friendly robot who learns to bake bread  ';
  let prevented = false;
  root.fire('submit', {
    target: submitTarget(),
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, [{ prompt: 'A friendly robot who learns to bake bread', compute: 'cpu' }]);
  handle.destroy();
});

test('a too-short prompt stays on the home screen', () => {
  const { root, prompt } = fakeRoot();
  const calls = [];
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
    onGenerate: (input) => {
      calls.push(input);
    },
  });

  prompt.value = 'robot';
  root.fire('submit', {
    target: submitTarget(),
    preventDefault() {},
  });

  assert.deepEqual(calls, []);
  assert.equal(prompt.focused, true);
  handle.destroy();
});

test('a run opens the progress view with gauges and no player adoption', () => {
  const { root } = fakeRoot();
  const snapshot = {
    plan: { status: 'done' },
    characters: { done: 1, total: 2 },
    shots: [{ status: 'approved' }, { status: 'review' }],
    voice: { status: 'starting' },
    render: { status: 'running', fraction: 0.4 },
  };
  const handle = mountSuperEasy({
    root,
    state: () => state({ productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } }),
    snapshot: () => snapshot,
    onMoreControl: () => {},
  });

  assert.equal(root.dataset.superEasyView, 'progress');
  assert.match(root.innerHTML, /data-super-easy-progress/u);
  assert.match(root.innerHTML, /data-super-easy-overall-gauge/u);
  assert.match(root.innerHTML, /data-super-easy-stage-gauge/u);
  assert.doesNotMatch(root.innerHTML, /data-super-easy-home/u);
  assert.doesNotMatch(root.innerHTML, /data-easy-player/u);

  handle.destroy();
});

test('the store moves the same mount from home to progress without remounting', () => {
  const { root } = fakeRoot();
  let current = state();
  let notify = () => {};
  const handle = mountSuperEasy({
    root,
    state: () => current,
    subscribe: (listener) => {
      notify = listener;
      return () => {
        notify = () => {};
      };
    },
    snapshot: () => ({ plan: { status: 'done' } }),
    onMoreControl: () => {},
  });

  assert.match(root.innerHTML, /data-super-easy-home/u);

  current = state({ productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } });
  notify();

  assert.equal(root.dataset.superEasyView, 'progress');
  assert.match(root.innerHTML, /data-super-easy-progress/u);
  handle.destroy();
});

test('destroy unbinds the handoff, the form and the store subscription', () => {
  const { root } = fakeRoot();
  let handedOff = 0;
  let unsubscribed = 0;
  let notify = () => {};
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    subscribe: (listener) => {
      notify = listener;
      return () => {
        unsubscribed += 1;
      };
    },
    onMoreControl: () => {
      handedOff += 1;
    },
  });

  handle.destroy();
  notify();
  root.fire('click', {
    target: clickTarget('[data-super-easy-more-control]'),
    preventDefault() {},
  });

  assert.equal(handedOff, 0);
  assert.equal(unsubscribed, 1);
  assert.equal(root.innerHTML, '');
  assert.equal(root.dataset.superEasyView, undefined);
});

test('Easy delegates first paint to Super Easy and releases the player first', () => {
  const easy = readFileSync(EASY_MOUNT, 'utf8');
  const superEasy = readFileSync(SUPER_EASY_MOUNT, 'utf8');

  assert.match(easy, /import \{[^}]*mountSuperEasy[^}]*\} from '\.\/super-easy\/mount\.ts'/u);
  assert.ok((easy.match(/route\.view === 'superEasy'/gu) ?? []).length >= 2, 'both boot and route changes check Super Easy');
  assert.match(easy, /boot\.view === 'superEasy'/u);
  assert.match(easy, /setPreferStudio\(true\)/u);
  assert.match(easy, /onMoreControl:/u);

  const start = easy.indexOf('function showSuperEasy');
  const end = easy.indexOf('\n  function ', start + 1);
  assert.ok(start >= 0 && end > start);
  const body = easy.slice(start, end);
  const release = body.indexOf('releasePlayer()');
  const mount = body.indexOf('mountSuperEasy(');
  assert.ok(release >= 0, 'the borrowed player is returned before Super Easy paints');
  assert.ok(mount > release, 'Super Easy mounts only after the player is released');

  const openStart = easy.indexOf('function openStudioFromSuperEasy');
  const openEnd = easy.indexOf('\n  function ', openStart + 1);
  assert.ok(openStart >= 0 && openEnd > openStart);
  const open = easy.slice(openStart, openEnd);
  const destroy = open.indexOf('destroySuperEasy()');
  const studio = open.indexOf('ensureShell()');
  assert.ok(destroy >= 0 && studio > destroy, 'more control closes Super Easy before the studio mounts');

  assert.doesNotMatch(superEasy, /preview-slot|adoptPlayer|releasePlayer/u);
  assert.doesNotMatch(superEasy, /data-easy-player|playerElement/u);
  assert.doesNotMatch(superEasy, /Google Colab/u);
});
