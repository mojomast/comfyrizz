// @ts-nocheck
// SE13: Super Easy landing preferences.
//
// These flags live beside Easy, not inside the global UI mode. A bare visit
// lands on Super Easy until the person explicitly asks for more control, and
// that choice is remembered across visits.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY,
  defaultSuperEasyPrefs,
  markSuperEasySeen,
  normalizeSuperEasyPrefs,
  prefersStudio,
  readSuperEasyPrefs,
  setPreferStudio,
  writeSuperEasyPrefs,
} from './prefs.ts';

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

test('a fresh profile keeps Super Easy as the landing and has not seen it yet', () => {
  assert.deepEqual(defaultSuperEasyPrefs(), { preferStudio: false, seenSuperEasy: false });
  assert.deepEqual(readSuperEasyPrefs(new FakeStorage()), { preferStudio: false, seenSuperEasy: false });
});

test('prefer Studio is sticky', () => {
  const storage = new FakeStorage();
  const saved = setPreferStudio(true, storage);
  assert.deepEqual(saved, { preferStudio: true, seenSuperEasy: false });
  assert.deepEqual(readSuperEasyPrefs(storage), { preferStudio: true, seenSuperEasy: false });
  assert.equal(prefersStudio(storage), true);
});

test('Studio can be switched back to Super Easy', () => {
  const storage = new FakeStorage();
  setPreferStudio(true, storage);
  setPreferStudio(false, storage);
  assert.equal(prefersStudio(storage), false);
  assert.deepEqual(readSuperEasyPrefs(storage), { preferStudio: false, seenSuperEasy: false });
});

test('seenSuperEasy is sticky and independent of preferStudio', () => {
  const storage = new FakeStorage();
  const saved = markSuperEasySeen(storage);
  assert.deepEqual(saved, { preferStudio: false, seenSuperEasy: true });
  assert.deepEqual(readSuperEasyPrefs(storage), { preferStudio: false, seenSuperEasy: true });

  const both = writeSuperEasyPrefs({ preferStudio: true }, storage);
  assert.deepEqual(both, { preferStudio: true, seenSuperEasy: true });
});

test('writing one flag keeps the other flag', () => {
  const storage = new FakeStorage();
  writeSuperEasyPrefs({ seenSuperEasy: true }, storage);
  writeSuperEasyPrefs({ preferStudio: true }, storage);
  assert.deepEqual(readSuperEasyPrefs(storage), { preferStudio: true, seenSuperEasy: true });
});

test('invalid or partial stored records fall back safely, one field at a time', () => {
  const storage = new FakeStorage();
  assert.deepEqual(normalizeSuperEasyPrefs(null), { preferStudio: false, seenSuperEasy: false });
  assert.deepEqual(normalizeSuperEasyPrefs('yes'), { preferStudio: false, seenSuperEasy: false });
  assert.deepEqual(normalizeSuperEasyPrefs({ preferStudio: 'yes' }), { preferStudio: false, seenSuperEasy: false });
  assert.deepEqual(normalizeSuperEasyPrefs({ preferStudio: true }), { preferStudio: true, seenSuperEasy: false });
  assert.deepEqual(normalizeSuperEasyPrefs({ seenSuperEasy: true }), { preferStudio: false, seenSuperEasy: true });

  storage.setItem(STORAGE_KEY, '{not json');
  assert.deepEqual(readSuperEasyPrefs(storage), { preferStudio: false, seenSuperEasy: false });
  storage.setItem(STORAGE_KEY, '[]');
  assert.deepEqual(readSuperEasyPrefs(storage), { preferStudio: false, seenSuperEasy: false });
});

test('missing or failing storage never throws and returns the defaults', () => {
  assert.deepEqual(readSuperEasyPrefs(null), { preferStudio: false, seenSuperEasy: false });
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(readSuperEasyPrefs(broken), { preferStudio: false, seenSuperEasy: false });
  assert.deepEqual(setPreferStudio(true, broken), { preferStudio: true, seenSuperEasy: false });
  assert.deepEqual(markSuperEasySeen(broken), { preferStudio: false, seenSuperEasy: true });
});

test('the flags use their own key and never write the global UI mode', () => {
  const storage = new FakeStorage();
  setPreferStudio(true, storage);
  assert.equal(storage.getItem('comfyrizz.ui'), null);
  assert.deepEqual([...storage.map.keys()], [STORAGE_KEY]);
  assert.notEqual(STORAGE_KEY, 'comfyrizz.ui');
  const stored = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.deepEqual(Object.keys(stored).sort(), ['preferStudio', 'seenSuperEasy']);
});
