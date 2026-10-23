// @ts-nocheck
// UR28: Review shot panel (versions, Keep, Try again, Compare).
//
// These tests cover the pure render contract, the Google Colab retry cost
// string, the no-cap block, the Keep API sequence and the no-native-confirm
// rule. They need no DOM, network or paid runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPY } from '../src/easy/copy.ts';
import {
  NO_CAP_REASON,
  SHOT_CARD_SOMETHING_ELSE,
  keepVersion,
  renderShotCard,
  retryBlockReason,
  retryCostText,
} from '../src/easy/shot-card.ts';

const shot = {
  id: 'scene-2',
  shotId: 'scene-2',
  clipId: 'clip-scene-2',
  sceneId: 'scene-2',
  number: 2,
  title: 'Hands knead dough',
};

const oneVersion = [{ takeId: 'take-a', n: 1, verdict: 'unreviewed' }];
const twoVersions = [
  { takeId: 'take-a', n: 1, verdict: 'unreviewed' },
  { takeId: 'take-b', n: 2, verdict: 'unreviewed' },
];

test('one version hides the version switcher', () => {
  const html = renderShotCard({
    shot,
    versions: oneVersion,
    selectedVersionId: 'take-a',
    compute: 'cpu',
  });

  assert.match(html, /Shot 2 · Hands knead dough/);
  assert.doesNotMatch(html, /data-easy-version-switch/);
  assert.doesNotMatch(html, /data-easy-version="(?:prev|next)"/);
  assert.doesNotMatch(html, /Previous version|Next version/);
  assert.equal(html.includes('Version 1 of 1'), false);
  assert.match(html, /data-easy-words/);
  assert.match(html, /Keep this version/);
});

test('two versions show the second version and Compare versions', () => {
  const html = renderShotCard({
    shot,
    versions: twoVersions,
    selectedVersionId: 'take-b',
    compute: 'cpu',
  });

  assert.match(html, /data-easy-version-switch/);
  assert.match(html, /Version 2 of 2/);
  assert.match(html, /aria-label="Previous version"/);
  assert.match(html, /aria-label="Next version"/);
  assert.match(html, /data-easy-version="prev"/);
  assert.match(html, /data-easy-version="next"/);
  assert.match(html, /Compare versions/);
});

test('retry chips map to the exact ids and labels', () => {
  const html = renderShotCard({
    shot,
    versions: oneVersion,
    selectedVersionId: 'take-a',
    compute: 'cpu',
  });

  const chips = Array.from(html.matchAll(/data-easy-scene-chip="([^"]+)"[^>]*>([^<]+)<\/button>/g))
    .map((match) => [match[1], match[2]]);
  const expected = Object.entries(COPY.review.retryChips);
  assert.deepEqual(chips, expected);
  assert.deepEqual(expected.map(([id]) => id), ['warmer', 'calmer-motion', 'more-depth', 'less-busy']);
  assert.deepEqual(expected.map(([, label]) => label), ['Warmer', 'Calmer', 'More detail', 'Simpler']);

  assert.match(html, new RegExp(`data-easy-ask="${SHOT_CARD_SOMETHING_ELSE}"[^>]*>${COPY.review.somethingElse}<\\/button>`));
});

test('the Google Colab retry cost text uses the shot, cost, left and cap', () => {
  assert.equal(
    retryCostText({ n: 2, cost: 2, left: 4.4, cap: 15 }),
    'Try shot 2 again: up to 2 Google Colab units (4.4 of 15 left).',
  );
});

test('a missing spend cap blocks the paid retry and asks for a cap', () => {
  assert.equal(retryCostText({ n: 2, cost: 2, left: 4.4, cap: null }), null);
  assert.equal(retryCostText({ n: 2, cost: 2, left: 4.4, cap: '' }), null);
  assert.equal(retryBlockReason(null), NO_CAP_REASON);
  assert.equal(retryBlockReason(''), NO_CAP_REASON);
  assert.equal(retryBlockReason(15), null);

  const html = renderShotCard({
    shot,
    versions: oneVersion,
    selectedVersionId: 'take-a',
    compute: 'colab',
    colabLeft: 4.4,
    cap: null,
  });
  assert.match(html, /Set a Google Colab spend cap/);
  assert.doesNotMatch(html, /of 15 left/);
});

test('Keep selects the version, records the approved verdict, then refreshes', async () => {
  const calls = [];
  const takesApi = {
    async select(packageId, clipId, takeId) {
      calls.push(['select', packageId, clipId, takeId]);
      return { kind: 'selected' };
    },
    async verdict(packageId, clipId, verdict, options) {
      calls.push(['verdict', packageId, clipId, verdict, options]);
      return { kind: 'verdict' };
    },
  };
  const host = {
    async refreshClips() {
      calls.push(['refreshClips']);
    },
  };

  await keepVersion({
    packageId: 'pkg-1',
    clipId: 'clip-scene-2',
    takeId: 'take-b',
    takesApi,
    host,
  });

  assert.deepEqual(calls, [
    ['select', 'pkg-1', 'clip-scene-2', 'take-b'],
    ['verdict', 'pkg-1', 'clip-scene-2', 'approved', { takeId: 'take-b' }],
    ['refreshClips'],
  ]);
});

test('Easy source never calls a native confirm()', () => {
  const root = fileURLToPath(new URL('../src/easy/', import.meta.url));
  const files = readdirSync(root, { recursive: true })
    .filter((name) => typeof name === 'string' && name.endsWith('.ts'))
    .map((name) => join(root, name));

  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    // `confirmDialog(...)` and the injected `confirm({ title, ... })` helper
    // are in-app dialogs. A native confirm() receives text, not an object.
    const nativeCall = /(?:\b(?:window|globalThis|self)\.)?\bconfirm\s*\(\s*(?!\{)/g;
    for (const match of source.matchAll(nativeCall)) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${file}:${line}`);
    }
  }

  assert.deepEqual(offenders, []);
});
