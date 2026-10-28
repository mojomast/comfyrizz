// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultEasyState,
  normalizeEasyState,
  createEasyStore,
  storageKey,
  planInputsHash,
  markPlanStaleIfInputsChanged,
} from '../src/easy/store.ts';

function makeStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test('defaults equal Appendix B', () => {
  const d = defaultEasyState();
  assert.deepEqual(d, {
    version: 1,
    packageId: null,
    chatId: null,
    productionId: null,
    offline: false,
    idea: { text: '', lengthS: 30, aspect: '16:9', look: 'clay', sound: true },
    questions: [],
    questionsAsked: false,
    answers: {},
    cast: [],
    narration: { on: true, voiceId: null },
    level: 'draft',
    levelTouched: false,
    compute: 'cpu',
    motionModel: 'auto',
    spendCap: 15,
    planHash: null,
    plan: { status: 'none', error: null, errorAt: null, wordsChanged: false },
    generate: { status: 'idle' },
    review: { shotId: null },
    exported: { revision: null, at: null },
  });
});

test('normalize wrong version returns defaults', () => {
  assert.deepEqual(normalizeEasyState({ version: 2 }), defaultEasyState());
});

test('normalize keeps default lengthS for invalid', () => {
  const n = normalizeEasyState({ version: 1, idea: { lengthS: 45 } });
  assert.equal(n.idea.lengthS, 30);
});

test('patch keeps other idea fields', () => {
  const storage = makeStorage();
  const store = createEasyStore({ storage, key: 'k' });
  store.patch({ idea: { text: 'x' } });
  const s = store.get();
  assert.equal(s.idea.text, 'x');
  assert.equal(s.idea.lengthS, 30);
});

test('subscriber receives previous and next', () => {
  const storage = makeStorage();
  const store = createEasyStore({ storage, key: 'k' });
  let received = null;
  store.subscribe((next, prev) => {
    received = { next, prev };
  });
  store.patch({ level: 'balanced' });
  assert.equal(received.next.level, 'balanced');
  assert.equal(received.prev.level, 'draft');
});

test('storage holds JSON after flush', () => {
  const storage = makeStorage();
  const store = createEasyStore({ storage, key: 'k' });
  store.patch({ idea: { text: 'x' } });
  store.flush();
  const raw = storage.getItem('k');
  assert.equal(JSON.parse(raw).idea.text, 'x');
});

test('changing level after ready makes stale', () => {
  const state = defaultEasyState();
  state.plan = { status: 'ready', error: null, errorAt: null, wordsChanged: false };
  state.planHash = planInputsHash(state);
  const changed = { ...state, level: 'balanced' as const };
  const res = markPlanStaleIfInputsChanged(changed);
  assert.equal(res.plan.status, 'stale');
  const unchanged = markPlanStaleIfInputsChanged(state);
  assert.equal(unchanged.plan.status, 'ready');
});

test('storageKey(null) returns new key', () => {
  assert.equal(storageKey(null), 'comfyrizz.easy.new');
});
