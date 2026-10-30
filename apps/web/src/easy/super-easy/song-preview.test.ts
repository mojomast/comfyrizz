// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSongPreview, previewRange, songPreviewMaster } from './song-preview.ts';

const song = { id: 'ref_1', source: 'media', kind: 'audio', role: 'song', usage: 'editorial' };

test('preview selects only the unique editorial song and uses source-clock range bounds', () => {
  assert.match(songPreviewMaster([song], 'chat_1'), /chat_1\/references\/ref_1\/file$/);
  assert.equal(songPreviewMaster([{ ...song, usage: 'reference' }], 'chat_1'), null);
  assert.equal(songPreviewMaster([song, { ...song, id: 'ref_2' }], 'chat_1'), null);
  assert.deepEqual(previewRange('', '', 12, 30), { start: 0, end: 12 });
  assert.deepEqual(previewRange('3.25', '9.75', 12, 30), { start: 3.25, end: 9.75 });
  assert.equal(previewRange('3', '', 12, 30), null);
  assert.equal(previewRange('3', '13', 12, 30), null);
});

test('authenticated preview loads, captures source playhead, plays only the selected range and releases its blob', async () => {
  const listeners = new Map();
  const player = { hidden: true, duration: 20, currentTime: 0, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, removeAttribute() { this.src = ''; } };
  const start = { value: '' }, end = { value: '' }, status = {}, actions = {};
  const fields = { '[data-song-preview-audio]': player, '[data-song-preview-actions]': actions, '[data-song-preview-status]': status, '[data-super-easy-song-start]': start, '[data-super-easy-song-end]': end };
  const root = { querySelector: key => fields[key] ?? null, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  let master = '/song', calls = 0, changes = 0;
  const preview = createSongPreview({ root, master: () => master, requested: () => 10, changed: () => changes++, fetch: async path => { calls++; assert.equal(path, '/song'); return new Response(new Blob(['song'])); } });
  const click = selector => listeners.get('click')({ target: { closest: key => key === selector }, preventDefault() {} });
  click('[data-song-preview-load]');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.match(player.src, /^blob:/);
  assert.equal(player.hidden, false);
  player.currentTime = 4.1254;
  click('[data-song-preview-start]');
  player.currentTime = 9.8;
  click('[data-song-preview-end]');
  assert.deepEqual([start.value, end.value, changes], ['4.125', '9.8', 2]);
  click('[data-song-preview-play]');
  assert.equal(player.currentTime, 4.125);
  player.currentTime = 9.9;
  listeners.get('timeupdate')({ target: player });
  assert.equal(player.currentTime, 9.8);
  assert.equal(player.paused, true);
  master = null;
  preview.sync();
  assert.equal(player.hidden, true);
  assert.equal(player.src, '');
  preview.destroy();
  assert.equal(listeners.size, 0);
});

test('an in-flight fetch cannot install a preview after the master changes', async () => {
  let resolveFetch, master = '/first';
  const player = { hidden: true };
  const listeners = new Map();
  const root = { querySelector: key => key === '[data-song-preview-audio]' ? player : null, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  const preview = createSongPreview({ root, master: () => master, requested: () => 10, changed() {}, fetch: () => new Promise(resolve => { resolveFetch = resolve; }) });
  listeners.get('click')({ target: { closest: key => key === '[data-song-preview-load]' }, preventDefault() {} });
  master = '/second';
  resolveFetch(new Response(new Blob(['old song'])));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(player.src, undefined);
  preview.destroy();
});
