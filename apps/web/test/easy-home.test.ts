// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PACKAGE_ID } from '../src/default-project.ts';
import { homeVideos, renderHome } from '../src/easy/home.ts';

const fixture = [
  { id: 'pkg_newer', title: 'Newer cut', durationS: 45, aspect: '16:9', updatedAt: '2026-10-20T15:30:00.000Z', thumbnail: null },
  { id: 'pkg_older', title: 'Older cut', durationS: 30, aspect: '1:1', updatedAt: '2026-10-01T12:00:00.000Z', thumbnail: null },
];

test('the home grid links each video and the example', () => {
  const html = renderHome(homeVideos(fixture, []));
  assert.match(html, /class="easy-home-grid"/);
  assert.match(html, /href="\?package=pkg_newer"/);
  assert.match(html, /href="\?package=pkg_older"/);
  assert.match(html, /Newer cut · 45 s · 16:9/);
  assert.match(html, /href="\?step=idea"/);
  assert.match(html, /New video/);
  assert.match(html, new RegExp(`href="\\?package=${DEFAULT_PACKAGE_ID}&amp;step=review"`));
  assert.match(html, /Try the example/);
  assert.doesNotMatch(html, /No videos yet/);
});

test('an empty library shows the empty state and New video', () => {
  const html = renderHome(homeVideos([], []));
  assert.match(html, /No videos yet\. Start your first one\./);
  assert.match(html, /href="\?step=idea"/);
  assert.match(html, /New video/);
  assert.doesNotMatch(html, /easy-home-grid/);
});

test('a stored list is used when the library response is empty', () => {
  const html = renderHome(homeVideos([], [{ packageId: 'pkg_local', title: 'On this computer', updatedAt: '2026-10-22T00:00:00.000Z' }]));
  assert.match(html, /href="\?package=pkg_local"/);
  assert.match(html, /On this computer/);
  assert.doesNotMatch(html, /No videos yet/);
});
