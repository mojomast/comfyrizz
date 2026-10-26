// EX04: Make it simple clears the sticky studio preference and returns to
// Super Easy. These tests cover the reverse of the more-control path without
// any network, Google Colab or real browser.
//
// node:test imports are runtime-only, so type checking is skipped like the
// other Easy render tests.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

import { homeVideos, renderHome, renderHomeScreen } from './home.ts';
import {
  STORAGE_KEY,
  prefersStudio,
  readSuperEasyPrefs,
  setPreferStudio,
} from './super-easy/prefs.ts';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  const result = await next(url, context);
  if (url.endsWith('.ts')) {
    const source = String(result.source)
      .replace(/import\\s+['"][^'"]+\\.css['"];?/g, '')
      .replace(/import\\.meta\\.glob\\([^;]*\\)/g, '({})');
    return { ...result, source };
  }
  return result;
}
`));

const { mountEasyStudio } = await import('./mount.ts');

const RECENT_KEY = 'comfyrizz.recent';
const RECENT_RAW = JSON.stringify([
  { packageId: 'pkg_recent', title: 'Recent video', updatedAt: '2026-10-20T15:30:00.000Z' },
]);
const fixture = [
  { id: 'pkg_newer', title: 'Newer cut', durationS: 45, aspect: '16:9', updatedAt: '2026-10-20T15:30:00.000Z', thumbnail: null },
  { id: 'pkg_older', title: 'Older cut', durationS: 30, aspect: '1:1', updatedAt: '2026-10-01T12:00:00.000Z', thumbnail: null },
];

class FakeStorage {
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

class FakeWindow {
  constructor() {
    this.location = { search: '', pathname: '/', hash: '' };
    this.history = {
      pushState: (_state, _title, url) => {
        const text = String(url ?? '');
        if (text === '') return;
        const next = new URL(text, 'http://fake.local/');
        this.location.search = next.search;
        this.location.pathname = next.pathname;
        this.location.hash = next.hash;
      },
    };
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type, event = {}) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
}

class FakeDocument {
  constructor() {
    this.defaultView = new FakeWindow();
    this.documentElement = { dataset: {}, setAttribute() {} };
    this.activeElement = null;
    this.title = '';
  }
  getElementById() {
    return null;
  }
}

class FakeButton {
  constructor() {
    this.listeners = new Set();
  }
  addEventListener(_type, listener) {
    this.listeners.add(listener);
  }
  removeEventListener(_type, listener) {
    this.listeners.delete(listener);
  }
  click() {
    for (const listener of Array.from(this.listeners)) listener({ preventDefault() {} });
  }
}

class FakeRoot {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this._html = '';
    this.dataset = {};
    this.hidden = false;
    this.listeners = new Map();
    this.prompt = { value: '', focus() {} };
    this.buttons = new Map();
  }
  set innerHTML(value) {
    this._html = String(value);
    this.buttons = new Map();
  }
  get innerHTML() {
    return this._html;
  }
  set textContent(value) {
    this._html = String(value);
  }
  get textContent() {
    return this._html;
  }
  querySelector(selector) {
    if (selector === '#super-easy-prompt') return this.prompt;
    if (selector === '[data-easy-make-simple]') {
      let button = this.buttons.get(selector);
      if (!button) {
        button = new FakeButton();
        this.buttons.set(selector, button);
      }
      return button;
    }
    return null;
  }
  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type, event) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
}

function makeHost(calls) {
  return {
    apiFetch: async (input) => {
      calls.push(String(input));
      return { ok: false, status: 404, json: async () => ({}) };
    },
    hasToken: () => false,
    editorStore: {
      getState: () => ({
        doc: { editSequence: 1 },
        derived: { timeline: { durationInFrames: 90 }, compiledSequence: 1 },
      }),
    },
    getPackage: () => null,
    clips: () => [],
    subscribeClips: () => () => {},
    takesApi: {
      getTakes: async () => [],
      select: async () => {},
      verdict: async () => {},
    },
    adoptBuiltPackage() {},
    renderMp4: async () => ({ blob: new Blob(), revision: 1 }),
    seekToScene() {},
    previewTake: async () => {},
    refreshClips: async () => {},
    clipGate: () => ({ ok: true, approved: 0, total: 0, blocking: [] }),
    applySceneChip: async () => {},
    aiSelection: async () => ({ provider: 'none' }),
    openAgentSettings() {},
    openEditor() {},
    playerElement: () => null,
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'timed out waiting for the Studio home wiring');
}

test('the Studio home offers one secondary Make it simple button', () => {
  const html = renderHome(homeVideos(fixture, []));
  const buttons = html.match(/<button\b[^>]*data-easy-make-simple[^>]*>[^<]*<\/button>/gu) ?? [];
  assert.equal(buttons.length, 1, 'exactly one Make it simple button');
  assert.match(buttons[0], /type="button"/u);
  assert.match(buttons[0], /btn-secondary/u);
  assert.match(buttons[0], />Make it simple<\/button>$/u);

  const empty = renderHome(homeVideos([], []));
  assert.equal((empty.match(/data-easy-make-simple/gu) ?? []).length, 1);
  assert.match(empty, />Make it simple<\/button>/u);
});

test('rendering Make it simple keeps every recent video and the start links', () => {
  const html = renderHome(homeVideos(fixture, []));
  const screen = renderHomeScreen(homeVideos(fixture, []));
  for (const view of [html, screen]) {
    assert.match(view, /href="\?package=pkg_newer"/u);
    assert.match(view, /href="\?package=pkg_older"/u);
    assert.match(view, /Newer cut · 45 s · 16:9/u);
    assert.match(view, /href="\?step=idea"/u);
    assert.match(view, /Try the example/u);
    assert.match(view, /data-easy-make-simple/u);
  }
});

test('the prefs reverse path clears only preferStudio and leaves recents alone', () => {
  const storage = new FakeStorage();
  storage.setItem(RECENT_KEY, RECENT_RAW);

  setPreferStudio(true, storage);
  assert.equal(prefersStudio(storage), true);

  setPreferStudio(false, storage);
  assert.equal(prefersStudio(storage), false);
  assert.deepEqual(readSuperEasyPrefs(storage), { preferStudio: false, seenSuperEasy: false });
  assert.equal(storage.getItem(RECENT_KEY), RECENT_RAW);
  assert.equal(storage.getItem('comfyrizz.ui'), null);
});

test('Make it simple in the real mount clears the sticky choice and paints Super Easy', async () => {
  const previousStorage = globalThis.localStorage;
  const storage = new FakeStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ preferStudio: true, seenSuperEasy: true }));
  storage.setItem(RECENT_KEY, RECENT_RAW);
  globalThis.localStorage = storage;

  const calls = [];
  const document = new FakeDocument();
  const root = new FakeRoot(document);
  const dispose = mountEasyStudio(root, makeHost(calls));
  try {
    await waitFor(() => root.innerHTML.includes('data-easy-make-simple'));
    await waitFor(() => root.querySelector('[data-easy-make-simple]').listeners.size > 0);
    assert.match(root.innerHTML, /data-easy-home/u);
    assert.equal(prefersStudio(storage), true);

    root.querySelector('[data-easy-make-simple]').click();

    assert.equal(prefersStudio(storage), false);
    assert.deepEqual(readSuperEasyPrefs(storage), { preferStudio: false, seenSuperEasy: true });
    assert.equal(root.dataset.superEasyView, 'home');
    assert.match(root.innerHTML, /data-super-easy-home/u);
    assert.doesNotMatch(root.innerHTML, /data-easy-home/u);
    assert.equal(storage.getItem(RECENT_KEY), RECENT_RAW);
    assert.equal(calls.some((call) => /recent|delete/iu.test(call)), false);
  } finally {
    dispose();
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('more control still takes Super Easy back to the Studio', async () => {
  const previousStorage = globalThis.localStorage;
  const storage = new FakeStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ preferStudio: false, seenSuperEasy: true }));
  globalThis.localStorage = storage;

  const document = new FakeDocument();
  const root = new FakeRoot(document);
  const dispose = mountEasyStudio(root, makeHost([]));
  try {
    await waitFor(() => root.dataset.superEasyView === 'home');

    root.fire('click', {
      target: {
        closest: (selector) => (selector === '[data-super-easy-more-control]' ? {} : null),
      },
      preventDefault() {},
    });

    assert.equal(prefersStudio(storage), true);
    assert.match(document.defaultView.location.search, /step=idea/u);
    assert.match(root.innerHTML, /data-easy-shell/u);
  } finally {
    dispose();
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('the mount binds Make it simple to the shared prefs API, not a second store', () => {
  const mount = readFileSync(fileURLToPath(new URL('./mount.ts', import.meta.url)), 'utf8');
  assert.match(mount, /import \{[^}]*setPreferStudio[^}]*\} from '\.\/super-easy\/prefs\.ts'/u);
  assert.match(mount, /data-easy-make-simple/u);
  assert.match(mount, /setPreferStudio\(false\)/u);

  const start = mount.indexOf('function makeItSimple');
  const end = mount.indexOf('\n  function ', start + 1);
  assert.ok(start >= 0 && end > start, 'makeItSimple is a mount function');
  const body = mount.slice(start, end);
  const clear = body.indexOf('setPreferStudio(false)');
  const show = body.indexOf('showSuperEasy()');
  assert.ok(clear >= 0, 'Make it simple clears preferStudio');
  assert.ok(show > clear, 'Make it simple paints Super Easy after clearing the flag');
  assert.doesNotMatch(body, /removeItem|localStorage|recent/iu);
});
