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
  assert.deepEqual(calls, [{ prompt: 'A friendly robot who learns to bake bread', compute: 'cpu', motionModel: 'auto' }]);
  handle.destroy();
});

test('confirmed setup forwards Google Colab once; unconfirmed setup opens setup instead', () => {
  const { root, prompt } = fakeRoot();
  const calls = [];
  let opened = 0;
  let setup = { compute: 'colab', spendCap: 7.5, confirmed: false };
  const handle = mountSuperEasy({
    root, state: () => state(), onMoreControl: () => {},
    setup: () => setup, onSetup: () => { opened += 1; }, onGenerate: input => calls.push(input),
  });
  prompt.value = 'A tiny lighthouse crew races the coming storm';
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.equal(opened, 1);
  assert.deepEqual(calls, []);
  setup = { ...setup, confirmed: true };
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.deepEqual(calls, [{ prompt: prompt.value, compute: 'colab', motionModel: 'auto', setupConfirmed: true }]);
  handle.destroy();
});

test('the motion-model selector offers Auto, H3 and LTX and saves changes', () => {
  const { root } = fakeRoot();
  let selected = null;
  const handle = mountSuperEasy({
    root, state: () => state(), onMoreControl: () => {},
    setup: () => ({ compute: 'cpu', motionModel: 'auto', spendCap: 10, confirmed: false }),
    onMotionModelChange: model => { selected = model; },
  });
  assert.match(root.innerHTML, /Auto — H3 acting \+ LTX camera/u);
  assert.match(root.innerHTML, /MiniMax H3 — characters \+ native sound/u);
  assert.match(root.innerHTML, /LTX-2.5 — cinematic motion plates/u);
  assert.match(root.innerHTML, /Klein only — stills \+ code motion/u);
  root.fire('change', { target: { value: 'ltx', closest: selector => (selector === '[data-super-easy-motion-model]' ? {} : null) } });
  assert.equal(selected, 'ltx');
  handle.destroy();
});

test('Record this run rides along with Generate and remembers the checkbox', () => {
  const { root, prompt } = fakeRoot();
  const toggle = { checked: true };
  const baseQuery = root.querySelector;
  root.querySelector = (selector) => (selector === '[data-procedure-capture-toggle]' ? toggle : baseQuery(selector));
  const calls = [];
  const toggles = [];
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
    captureArmed: () => true,
    onCaptureToggle: (armed) => toggles.push(armed),
    onGenerate: (input) => {
      calls.push(input);
    },
  });

  assert.match(root.innerHTML, /data-procedure-capture-toggle[^>]* checked>/u);
  toggle.checked = false;
  root.fire('change', { target: { checked: false, closest: (selector) => (selector === '[data-procedure-capture-toggle]' ? toggle : null) } });
  assert.deepEqual(toggles, [false]);

  toggle.checked = true;
  prompt.value = 'A friendly robot who learns to bake bread';
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.deepEqual(calls, [{ prompt: 'A friendly robot who learns to bake bread', compute: 'cpu', motionModel: 'auto', capture: true }]);
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

function stableProgressRoot() {
  const writes = { innerHTML: 0, chrome: 0, gallery: 0, actions: 0, live: 0, gauges: 0 };
  const listeners = new Map();
  let html = '';
  let rendered = false;
  let liveText = '';
  const region = (kind) => {
    let value = '';
    return {
      get innerHTML() {
        return value;
      },
      set innerHTML(next) {
        value = next;
        writes[kind] += 1;
      },
    };
  };
  const gauges = ['plan', 'characters', 'shots', 'voice', 'render'].map((id) => {
    let value = '';
    return {
      get innerHTML() {
        return value;
      },
      set innerHTML(next) {
        value = next;
        writes.gauges += 1;
      },
      getAttribute(name) {
        return name === 'data-stage-id' ? id : null;
      },
    };
  });
  const live = {
    get textContent() {
      return liveText;
    },
    set textContent(value) {
      liveText = value;
      writes.live += 1;
    },
    setAttribute() {},
  };
  const nodes = new Map([
    ['[data-super-easy-chrome]', region('chrome')],
    ['[data-super-easy-gallery]', region('gallery')],
    ['[data-super-easy-actions]', region('actions')],
    ['[data-super-easy-live]', live],
    ['[data-super-easy-overall-value]', { textContent: '' }],
    ['[data-super-easy-overall-gauge]', region('gauges')],
  ]);
  const root = {
    dataset: {},
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      writes.innerHTML += 1;
      rendered = true;
    },
    querySelector(selector) {
      if (!rendered) return null;
      return nodes.get(selector) ?? null;
    },
    querySelectorAll(selector) {
      return selector === '[data-super-easy-stage-gauge]' ? gauges : [];
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
  };
  return { root, writes };
}

test('frequent progress repaints leave the playing sample, live region and escapes in place', () => {
  const { root, writes } = stableProgressRoot();
  const snapshot = {
    plan: { status: 'done' },
    characters: { status: 'done' },
    shots: [{ status: 'approved' }],
    voice: { status: 'done', url: '/media/voice.mp3' },
    render: { status: 'running', fraction: 0.2 },
  };
  const handle = mountSuperEasy({
    root,
    state: () => state({ productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } }),
    snapshot: () => snapshot,
    onMoreControl: () => {},
  });

  assert.equal(writes.innerHTML, 1, 'the first paint mounts the whole screen');
  assert.equal(writes.gallery, 0);

  for (const fraction of [0.4, 0.6, 0.8]) {
    snapshot.render.fraction = fraction;
    handle.render();
  }

  assert.equal(writes.innerHTML, 1, 'no full replacement for fraction-only events');
  assert.equal(writes.chrome, 0, 'stage markup stays in place');
  assert.equal(writes.gallery, 0, 'a playing sample is not replaced');
  assert.equal(writes.actions, 0, 'a focused escape is not replaced');
  assert.equal(writes.live, 0, 'the live region keeps the same sentence');
  assert.ok(writes.gauges > 0, 'the measured gauges still move');
  handle.destroy();
});

test('the preview and failure handoffs are clickable escapes', () => {
  const { root } = fakeRoot();
  const reviews = [];
  const retries = [];
  const handle = mountSuperEasy({
    root,
    state: () => state({ packageId: 'pkg_1', productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } }),
    snapshot: () => ({ plan: { status: 'done' }, render: { status: 'running', fraction: 0.2 } }),
    previewReady: () => true,
    failure: () => null,
    onReview: (packageId) => reviews.push(packageId),
    onRetry: () => retries.push(true),
    onMoreControl: () => {},
  });

  assert.match(root.innerHTML, /data-super-easy-review/u);
  root.fire('click', {
    target: clickTarget('[data-super-easy-review]'),
    preventDefault() {},
  });
  assert.deepEqual(reviews, ['pkg_1']);
  assert.deepEqual(retries, []);
  handle.destroy();

  const failed = fakeRoot();
  const retryHandle = mountSuperEasy({
    root: failed.root,
    state: () => state({ productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } }),
    snapshot: () => null,
    failure: () => ({ message: 'The plan could not be written.', retryable: true }),
    onRetry: () => retries.push(true),
    onMoreControl: () => {},
  });

  assert.match(failed.root.innerHTML, /data-super-easy-error/u);
  failed.root.fire('click', {
    target: clickTarget('[data-super-easy-retry]'),
    preventDefault() {},
  });
  assert.deepEqual(retries, [true]);
  retryHandle.destroy();
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

function richRoot() {
  const { root, prompt } = fakeRoot();
  const attributes = new Map();
  Object.assign(prompt, {
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  });
  const error = { hidden: true };
  const plain = root.querySelector;
  root.querySelector = (selector) => (selector === '[data-super-easy-prompt-error]' ? error : plain(selector));
  return { root, prompt, error };
}

test('an idea chip fills its own prompt and clears a shown error', () => {
  const { root, prompt, error } = richRoot();
  const handle = mountSuperEasy({ root, state: () => state(), onMoreControl: () => {} });
  error.hidden = false;
  root.fire('click', {
    target: {
      closest(candidate) {
        return candidate === '[data-super-easy-idea]'
          ? { getAttribute: (name) => (name === 'data-super-easy-idea' ? 'coffee' : null) }
          : null;
      },
    },
    preventDefault() {},
  });
  assert.equal(prompt.value, 'How a coffee bean becomes your morning cup');
  assert.equal(prompt.focused, true);
  assert.equal(error.hidden, true);
  handle.destroy();
});

test('a too-short Generate shows the inline message, and typing hides it again', () => {
  const { root, prompt, error } = richRoot();
  const calls = [];
  const handle = mountSuperEasy({ root, state: () => state(), onMoreControl: () => {}, onGenerate: (input) => calls.push(input) });
  prompt.value = 'robot';
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.deepEqual(calls, []);
  assert.equal(error.hidden, false);
  assert.equal(prompt.getAttribute('aria-invalid'), 'true');
  assert.match(prompt.getAttribute('aria-describedby'), /super-easy-prompt-error/u);

  root.fire('input', { target: clickTarget('#super-easy-prompt') });
  assert.equal(error.hidden, true);
  assert.equal(prompt.getAttribute('aria-invalid'), null);
  handle.destroy();
});

test('Download MP4 hands the package to export, falling back to Review', () => {
  const exported = [];
  const reviewed = [];
  const withExport = fakeRoot();
  const first = mountSuperEasy({
    root: withExport.root,
    state: () => state({ packageId: 'pkg_1', generate: { status: 'running' } }),
    onMoreControl: () => {},
    onReview: (id) => reviewed.push(id),
    onExport: (id) => exported.push(id),
  });
  withExport.root.fire('click', { target: clickTarget('[data-super-easy-export]'), preventDefault() {} });
  assert.deepEqual(exported, ['pkg_1']);
  assert.deepEqual(reviewed, []);
  first.destroy();

  const reviewOnly = fakeRoot();
  const second = mountSuperEasy({
    root: reviewOnly.root,
    state: () => state({ packageId: 'pkg_2', generate: { status: 'running' } }),
    onMoreControl: () => {},
    onReview: (id) => reviewed.push(id),
  });
  reviewOnly.root.fire('click', { target: clickTarget('[data-super-easy-export]'), preventDefault() {} });
  assert.deepEqual(reviewed, ['pkg_2']);
  second.destroy();
});

test('the caller can supply the gauges for a snapshot the journal cannot fill', () => {
  const { root } = fakeRoot();
  const seen = [];
  const handle = mountSuperEasy({
    root,
    state: () => state({ generate: { status: 'running' } }),
    snapshot: () => ({ marker: 1 }),
    stages(snapshot) {
      seen.push(snapshot);
      return {
        overall: 0.5,
        finalReady: false,
        complete: false,
        stages: ['plan', 'characters', 'shots', 'voice', 'render'].map((id) => ({
          id,
          label: id,
          status: id === 'plan' ? 'done' : 'waiting',
          statusText: id === 'plan' ? 'Done' : 'Waiting',
          fraction: id === 'plan' ? 1 : 0,
          error: null,
        })),
      };
    },
    onMoreControl: () => {},
  });
  assert.deepEqual(seen[0], { marker: 1 });
  assert.match(root.innerHTML, /data-super-easy-stage="plan" data-stage-status="done"/u);
  assert.match(root.innerHTML, /data-super-easy-overall-value>50%</u);
  handle.destroy();
});

test('the Easy mount sends Download MP4 to the Studio Export step and merges local gauges', () => {
  const source = readFileSync(EASY_MOUNT, 'utf8');
  assert.match(source, /onExport: \(packageId\) => openStudioFromSuperEasy\('export', packageId\)/u);
  assert.match(source, /stages: \(snapshot\) => superEasyStages\(snapshot\)/u);
  assert.match(source, /mergeLocalStages\(readStages\(snapshot\), localStageReadings\(/u);
  assert.match(source, /currentStep !== step\) showStep\(step\)/u, 'Export is shown once, so it renders once');
});
