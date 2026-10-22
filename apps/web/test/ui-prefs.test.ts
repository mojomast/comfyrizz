// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DENSITY,
  DEFAULT_MODE,
  DEFAULT_PANELS,
  STORAGE_KEY,
  applyPrefs,
  createPrefsStore,
  defaultPrefs,
  getPrefs,
  loadPrefs,
  normalizePrefs,
  savePrefs,
  subscribePrefs,
} from '../src/ui/prefs.ts';

class MemoryStorage {
  items = new Map();

  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }

  setItem(key, value) {
    this.items.set(key, String(value));
  }

  removeItem(key) {
    this.items.delete(key);
  }

  clear() {
    this.items.clear();
  }

  read() {
    const raw = this.getItem(STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw);
  }
}

function fakeRoot() {
  return {
    dataset: {},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      this.dataset[name.replace(/^data-/, '')] = String(value);
    },
  };
}

function makeStore() {
  const storage = new MemoryStorage();
  const root = fakeRoot();
  const store = createPrefsStore({ storage, root });
  return { storage, root, store };
}

test('a new user starts in easy mode with comfortable density', () => {
  const { storage, root, store } = makeStore();

  const prefs = store.load();

  assert.equal(prefs.mode, 'easy');
  assert.equal(prefs.density, 'comfortable');
  assert.deepEqual(prefs.panels, DEFAULT_PANELS);
  assert.deepEqual(prefs, defaultPrefs());
  assert.equal(DEFAULT_MODE, 'easy');
  assert.equal(DEFAULT_DENSITY, 'comfortable');
  assert.equal(root.dataset.mode, 'easy');
  assert.equal(root.dataset.density, 'comfortable');
  assert.equal(root.attributes['data-mode'], 'easy');
  assert.equal(root.attributes['data-density'], 'comfortable');
  assert.equal(storage.read(), null);
});

test('advanced defaults to compact until the user picks a density explicitly', () => {
  const { storage, root, store } = makeStore();
  store.load();

  const advanced = store.setMode('advanced');

  assert.equal(advanced.mode, 'advanced');
  assert.equal(advanced.density, 'compact');
  assert.equal(root.dataset.density, 'compact');
  assert.deepEqual(storage.read(), {
    mode: 'advanced',
    density: 'compact',
    densityExplicit: false,
    panels: { left: true, right: true, timeline: true },
  });

  const easy = store.setMode('easy');
  assert.equal(easy.density, 'comfortable');
});

test('an explicit density choice survives mode switches and reloads', () => {
  const { storage, root, store } = makeStore();
  store.load();

  store.setDensity('comfortable');
  const advanced = store.setMode('advanced');
  assert.equal(advanced.mode, 'advanced');
  assert.equal(advanced.density, 'comfortable');

  store.setDensity('compact');
  const easy = store.setMode('easy');
  assert.equal(easy.mode, 'easy');
  assert.equal(easy.density, 'compact');
  assert.equal(root.dataset.density, 'compact');

  const reloaded = createPrefsStore({ storage, root }).load();
  assert.equal(reloaded.mode, 'easy');
  assert.equal(reloaded.density, 'compact');
});

test('a mode-derived density is not explicit, so a reload still follows the mode default', () => {
  const { storage, root, store } = makeStore();
  store.load();

  store.setMode('advanced');
  assert.equal(storage.read().densityExplicit, false);

  const reloaded = createPrefsStore({ storage, root }).load();
  assert.equal(reloaded.mode, 'advanced');
  assert.equal(reloaded.density, 'compact');

  const easy = createPrefsStore({ storage, root }).setMode('easy');
  assert.equal(easy.mode, 'easy');
  assert.equal(easy.density, 'comfortable');
  assert.equal(storage.read().densityExplicit, false);
});

test('an explicit density choice is persisted with its flag and survives a reload', () => {
  const { storage, root, store } = makeStore();
  store.load();

  store.setDensity('compact');
  assert.equal(storage.read().densityExplicit, true);
  assert.equal(storage.read().density, 'compact');

  const reloaded = createPrefsStore({ storage, root }).load();
  assert.equal(reloaded.density, 'compact');

  const advanced = createPrefsStore({ storage, root }).setMode('advanced');
  assert.equal(advanced.mode, 'advanced');
  assert.equal(advanced.density, 'compact');
  assert.equal(storage.read().densityExplicit, true);
});

test('legacy records without an explicit flag keep their stored density', () => {
  const { storage } = makeStore();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ mode: 'easy', density: 'compact', panels: DEFAULT_PANELS }),
  );

  const reloaded = createPrefsStore({ storage, root: fakeRoot() }).load();
  assert.equal(reloaded.mode, 'easy');
  assert.equal(reloaded.density, 'compact');

  const advanced = createPrefsStore({ storage, root: fakeRoot() }).setMode('advanced');
  assert.equal(advanced.density, 'compact');
  assert.equal(storage.read().densityExplicit, true);
});

test('saved preferences load and panel changes merge without dropping defaults', () => {
  const { storage, store } = makeStore();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      mode: 'advanced',
      density: 'comfortable',
      panels: { left: false, timeline: false },
    }),
  );

  const loaded = store.load();
  assert.equal(loaded.mode, 'advanced');
  assert.equal(loaded.density, 'comfortable');
  assert.deepEqual(loaded.panels, { left: false, right: true, timeline: false });

  const saved = store.save({ panels: { right: false } });
  assert.deepEqual(saved.panels, { left: false, right: false, timeline: false });

  const toggled = store.save({ panels: { left: true } });
  assert.deepEqual(toggled.panels, { left: true, right: false, timeline: false });
});

test('subscribers receive committed changes and can unsubscribe', () => {
  const { store } = makeStore();
  const events = [];
  const unsubscribe = store.subscribe((next, previous) => {
    events.push({ next, previous });
  });

  store.load();
  assert.equal(events.length, 0);

  store.setMode('advanced');
  assert.equal(events.length, 1);
  assert.equal(events[0].next.mode, 'advanced');
  assert.equal(events[0].previous.mode, 'easy');
  assert.equal(events[0].next.density, 'compact');

  unsubscribe();
  store.setMode('easy');
  assert.equal(events.length, 1);
});

test('invalid or missing storage falls back to safe defaults', () => {
  const { storage, store } = makeStore();
  storage.setItem(STORAGE_KEY, '{not json');
  assert.deepEqual(store.load(), defaultPrefs());

  storage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'cinema', density: 'tiny', panels: { left: 'no' } }));
  assert.deepEqual(store.load(), defaultPrefs());

  assert.deepEqual(normalizePrefs({ mode: 'advanced' }), {
    mode: 'advanced',
    density: 'compact',
    panels: { left: true, right: true, timeline: true },
  });
});

test('the default load/save/subscribe helpers use localStorage and the html root', () => {
  const previousStorage = globalThis.localStorage;
  const previousDocument = globalThis.document;
  const storage = new MemoryStorage();
  const root = fakeRoot();
  globalThis.localStorage = storage;
  globalThis.document = { documentElement: root };

  try {
    const initial = loadPrefs();
    assert.equal(initial.mode, 'easy');
    assert.equal(initial.density, 'comfortable');
    assert.equal(root.dataset.mode, 'easy');

    const events = [];
    const unsubscribe = subscribePrefs(next => events.push(next));
    const advanced = savePrefs({ mode: 'advanced' });
    assert.equal(advanced.density, 'compact');
    assert.equal(root.dataset.mode, 'advanced');
    assert.equal(root.dataset.density, 'compact');
    assert.equal(events.length, 1);
    assert.equal(getPrefs().mode, 'advanced');
    assert.equal(storage.read().mode, 'advanced');

    unsubscribe();
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('applyPrefs writes both dataset properties and tolerates a missing root', () => {
  const root = fakeRoot();
  applyPrefs({ mode: 'advanced', density: 'compact' }, root);
  assert.deepEqual(root.dataset, { mode: 'advanced', density: 'compact' });
  assert.deepEqual(root.attributes, {
    'data-mode': 'advanced',
    'data-density': 'compact',
  });

  assert.doesNotThrow(() => applyPrefs({ mode: 'easy', density: 'comfortable' }, null));
});
