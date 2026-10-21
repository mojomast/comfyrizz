import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildFixtureState,
  createDemoController,
  loadDemoData,
  seedFixtureState,
} from '../src/demo/main.mjs';
import { createFixtureBackend, fixtureEvents } from '../src/demo/fixture.mjs';
import { createStore } from '../src/demo/store.mjs';
import { activityRows, phaseProgress } from '../src/demo/activity-panel.mjs';
import { licenceChips } from '../src/demo/licence-chips.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../demo.html');
const mainSource = read('../src/demo/main.mjs');
const viteSource = read('../vite.config.ts');

const REGION_IDS = ['chat', 'preview', 'storyboard', 'licence-chips', 'spend-card', 'activity'];
const DEMO_MODULES = [
  'api.mjs',
  'events.mjs',
  'store.mjs',
  'chat-panel.mjs',
  'storyboard.mjs',
  'licence-chips.mjs',
  'spend-card.mjs',
  'activity-panel.mjs',
  'instant-edit.mjs',
  'scene-rerun.mjs',
  'fixture.mjs',
  'preview-frames.mjs',
  'preview-mount.tsx',
];

test('demo.html declares all six regions and loads the demo entry', () => {
  for (const id of REGION_IDS) {
    assert.match(html, new RegExp(`id="${id}"`), `missing region #${id}`);
  }
  for (const region of ['chat', 'preview', 'storyboard', 'licences', 'spend', 'activity']) {
    assert.match(html, new RegExp(`data-region="${region}"`), `missing data-region ${region}`);
  }
  assert.match(html, /<script type="module" src="\/src\/demo\/main\.mjs"><\/script>/);
  assert.match(html, /href="\/src\/demo\/demo\.css"/);
});

test('main.mjs imports every demo module', () => {
  for (const moduleName of DEMO_MODULES) {
    assert.ok(mainSource.includes(moduleName), `main.mjs does not import ${moduleName}`);
  }
});

test('vite builds both the main app and demo.html', () => {
  assert.match(viteSource, /rollupOptions:\s*\{\s*input:\s*\{\s*main:\s*'index\.html',\s*demo:\s*'demo\.html'\s*\}/);
});

test('fixture state boots from data alone with no network and no DOM', () => {
  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network disabled in the shell smoke test');
  };
  globalThis.EventSource = function BlockedEventSource() {
    networkCalls += 1;
    throw new Error('network disabled in the shell smoke test');
  };

  try {
    const data = loadDemoData();
    const state = seedFixtureState({ ...data, now: '2026-10-20T12:00:00.000Z' });
    assert.deepEqual(state, buildFixtureState({ ...data, now: '2026-10-20T12:00:00.000Z' }));
    assert.equal(state.pkg.id, 'pkg_launchdemo0001');
    assert.equal(state.timeline.scenes.length, 6);
    assert.equal(Object.keys(state.scenes).length, 6);
    assert.equal(state.backend, 'colab');
    assert.ok(state.chat.length >= 2);
    assert.equal(state.spend?.backendId, 'colab');
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.EventSource = realEventSource;
  }
});

test('fixture activity reaches VM stopped (verified) and every phase in order', () => {
  const events = fixtureEvents();
  const rows = activityRows(events);
  const progress = phaseProgress(rows);
  assert.deepEqual(progress.map(step => step.phase), ['vm', 'health', 'jobs', 'collected', 'stopped']);
  const stopped = progress.find(step => step.phase === 'stopped');
  assert.equal(stopped.label, 'VM stopped (verified)');
  assert.equal(stopped.status, 'current');
});

test('licence chips show one approved CC BY and one blocked CC BY-NC', () => {
  const chips = licenceChips(loadDemoData().licencePkg);
  assert.equal(chips.filter(chip => chip.tone === 'ok').length, 1);
  assert.equal(chips.filter(chip => chip.tone === 'blocked').length, 1);
  assert.match(chips.find(chip => chip.tone === 'blocked').detail, /non-commercial|NC/i);
});

test('controller wires chat, instant edits and per-scene re-runs through the fixture api', async () => {
  const data = loadDemoData();
  const store = createStore(seedFixtureState(data));
  const api = createFixtureBackend({ pkg: data.pkg, timeline: data.timeline });
  const controller = createDemoController({ api, store, now: () => '2026-10-20T12:01:00.000Z' });

  const before = store.get().chat.length;
  await controller.send('make scene 3 warmer');
  const after = store.get();
  assert.equal(after.chat.length, before + 2);
  assert.equal(after.chat.at(-1).role, 'assistant');

  const edit = controller.applyEdit({ kind: 'chart', sceneId: 's_chart', index: 0, value: 99 });
  assert.deepEqual(edit.changedScenes, ['s_chart']);
  assert.equal(store.get().scenes.s_chart.status, 'stale');
  assert.equal(store.get().scenes.s_title.status, 'ready');

  const rerun = await controller.rerunScene('s_list', { instruction: 'less busy' });
  assert.equal(rerun.ok, true);
  assert.equal(store.get().scenes.s_list.status, 'ready');
  assert.equal(store.get().scenes.s_chart.status, 'stale');
  assert.ok(store.get().activity.some(row => /scene s_list re-rendering/.test(row.text)));
});
