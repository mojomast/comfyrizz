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
    idea: { text: '', lengthS: 30, aspect: '16:9', look: 'cinematic-dark', sound: true },
    questions: [],
    questionsAsked: false,
    answers: {},
    cast: [],
    narration: { on: true, voiceId: null },
    level: 'draft',
    levelTouched: false,
    compute: 'cpu',
    motionModel: 'auto',
    videoType: null,
    songTrim: null,
    lyricsStyle: 'off',
    lyricsLrc: '',
    attachmentSignature: null,
    attachmentRevision: 0,
    spendCap: 15,
    planHash: null,
    builtPackageInputsHash: null,
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
  for (const lengthS of [0, 121, 120.5, 12.5, '12', null]) {
    assert.equal(normalizeEasyState({ version: 1, idea: { lengthS } }).idea.lengthS, 30);
  }
  for (const lengthS of [1, 12, 40, 90, 91, 120]) {
    assert.equal(normalizeEasyState({ version: 1, idea: { lengthS } }).idea.lengthS, lengthS);
  }
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

test('old version-1 state restores as Custom with no persisted attachment payload', () => {
  const old = { ...defaultEasyState(), idea: { ...defaultEasyState().idea, text: 'Existing prompt' } };
  delete old.videoType;
  delete old.songTrim;
  delete old.lyricsStyle;
  delete old.lyricsLrc;
  delete old.attachmentSignature;
  delete old.attachmentRevision;
  const restored = normalizeEasyState(old);
  assert.equal(restored.idea.text, 'Existing prompt');
  assert.equal(restored.videoType, null);
  assert.equal(restored.songTrim, null);
  assert.equal(restored.lyricsStyle, 'off');
  assert.equal(restored.lyricsLrc, '');
  assert.equal(restored.attachmentSignature, null);
  assert.equal(restored.attachmentRevision, 0);
  assert.equal(restored.builtPackageInputsHash, null);
  assert.equal(Object.hasOwn(restored, 'attachments'), false);
});

test('video type or attachment changes invalidate a ready plan, unchanged approval does not', () => {
  const state = defaultEasyState();
  state.plan = { status: 'ready', error: null, errorAt: null, wordsChanged: false };
  state.planHash = planInputsHash(state);
  assert.equal(markPlanStaleIfInputsChanged(state).plan.status, 'ready');

  const typed = { ...state, videoType: 'motion-explainer' as const };
  assert.equal(markPlanStaleIfInputsChanged(typed).plan.status, 'stale');
  const attached = { ...state, attachmentSignature: 'ctx_12345678_1', attachmentRevision: 1 };
  assert.equal(markPlanStaleIfInputsChanged(attached).plan.status, 'stale');
  const revised = { ...state, attachmentRevision: state.attachmentRevision + 1 };
  assert.equal(markPlanStaleIfInputsChanged(revised).plan.status, 'stale');
  const trimmed = { ...state, songTrim: { startSeconds: 4.5, endSeconds: 30 } };
  assert.equal(markPlanStaleIfInputsChanged(trimmed).plan.status, 'stale');
  assert.notEqual(planInputsHash(trimmed), planInputsHash({ ...trimmed, songTrim: null }));
  const styled = { ...state, lyricsStyle: 'caption' as const };
  assert.equal(markPlanStaleIfInputsChanged(styled).plan.status, 'stale');
  const pasted = { ...state, lyricsLrc: '[00:01.00]A changed lyric draft' };
  assert.equal(markPlanStaleIfInputsChanged(pasted).plan.status, 'stale');
  assert.notEqual(planInputsHash(pasted), planInputsHash({ ...pasted, lyricsLrc: '[00:01.00]Another draft' }));
});

test('Music Video song trim normalizes, persists and rejects invalid legacy values', () => {
  const storage = makeStorage();
  const store = createEasyStore({ storage, key: 'music-trim' });
  store.patch({ videoType: 'music-video', songTrim: { startSeconds: 2.25, endSeconds: 29.5 } });
  store.flush();
  const restored = createEasyStore({ storage, key: 'music-trim' }).get();
  assert.equal(restored.videoType, 'music-video');
  assert.deepEqual(restored.songTrim, { startSeconds: 2.25, endSeconds: 29.5 });
  assert.equal(normalizeEasyState({ ...restored, songTrim: { startSeconds: -1, endSeconds: 20 } }).songTrim, null);
  assert.equal(normalizeEasyState({ ...restored, songTrim: { startSeconds: 20, endSeconds: 20 } }).songTrim, null);
  assert.equal(normalizeEasyState({ ...restored, songTrim: { startSeconds: 0, endSeconds: Number.NaN } }).songTrim, null);
});

test('Music Video lyric style and exact raw LRC normalize, persist, and reset for a new project', () => {
  const storage = makeStorage();
  const store = createEasyStore({ storage, key: 'music-lyrics' });
  const raw = '\n[00:01.25]<00:01.25>Exact <00:01.75>text\r\n[00:03.00]Next line\n';
  store.patch({ videoType: 'music-video', lyricsStyle: 'reel', lyricsLrc: raw });
  store.flush();
  const restored = createEasyStore({ storage, key: 'music-lyrics' }).get();
  assert.equal(restored.lyricsStyle, 'reel');
  assert.equal(restored.lyricsLrc, raw);
  assert.equal(normalizeEasyState({ ...restored, lyricsStyle: 'invalid' }).lyricsStyle, 'off');
  assert.equal(normalizeEasyState({ ...restored, lyricsLrc: null }).lyricsLrc, '');

  const fresh = store.startNew();
  assert.equal(fresh.lyricsStyle, 'off');
  assert.equal(fresh.lyricsLrc, '');
});

test('storageKey(null) returns new key', () => {
  assert.equal(storageKey(null), 'comfyrizz.easy.new');
});
