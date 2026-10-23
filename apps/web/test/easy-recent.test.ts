// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PACKAGE_ID } from '../src/default-project.ts';
import { rememberVideo, renderRecent, timeAgo } from '../src/easy/recent.ts';

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
  };
}

test('rememberVideo dedupes by package id and keeps the newest title', () => {
  const storage = memoryStorage();
  rememberVideo({ id: 'pkg_a', title: 'First' }, storage, 1_000);
  rememberVideo({ id: 'pkg_b', title: 'Second' }, storage, 2_000);
  const videos = rememberVideo({ id: 'pkg_a', title: 'First again' }, storage, 3_000);
  assert.deepEqual(videos.map((item) => item.packageId), ['pkg_a', 'pkg_b']);
  assert.equal(videos[0].title, 'First again');
});

test('rememberVideo keeps at most 8 videos', () => {
  const storage = memoryStorage();
  let videos = [];
  for (let n = 0; n < 9; n += 1) {
    videos = rememberVideo({ id: `pkg_${n}`, title: `Video ${n}` }, storage, n);
  }
  assert.equal(videos.length, 8);
  assert.equal(videos[0].packageId, 'pkg_8');
  assert.equal(videos.some((item) => item.packageId === 'pkg_0'), false);
});

test('timeAgo boundaries are just now, minutes, and days', () => {
  assert.equal(timeAgo(59_000), 'just now');
  assert.equal(timeAgo(61_000), '1 minute ago');
  assert.equal(timeAgo(25 * 60 * 60 * 1000), '1 day ago');
});

test('the example link opens the seeded video on review', () => {
  const html = renderRecent([], 0);
  assert.match(html, new RegExp(`href="\\?package=${DEFAULT_PACKAGE_ID}&amp;step=review"`));
  assert.match(html, /Try the example/);
});
