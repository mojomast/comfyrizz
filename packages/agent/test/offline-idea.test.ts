import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultCpuScenes } from '../src/package.js';

const BAKERY = 'A 30 second video for my bakery, Crumb & Co, announcing our new sourdough subscription.';
const NUMERIC = 'A 30 second video for my bakery, Crumb & Co, announcing our new sourdough subscription. Revenue grew 40% last quarter.';
const CPU_SCENE_IDS = ['s_title', 's_hero', 's_stat', 's_chart', 's_list', 's_outro'];

function headlines(brief: string): string[] {
  return defaultCpuScenes(brief).map(scene => String(scene.copy.headline ?? ''));
}

test('UR12b: a bakery brief produces no CPU example headlines', () => {
  for (const headline of headlines(BAKERY)) {
    assert.doesNotMatch(headline, /CPU time|example minutes/i);
  }
});

test('UR12b: the title uses the idea\'s words', () => {
  const [title] = headlines(BAKERY);
  assert.match(title, /Crumb & Co/);
});

test('UR12b: the scene ids and count match the CPU default', () => {
  const scenes = defaultCpuScenes(BAKERY);
  assert.deepEqual(scenes.map(scene => scene.id), CPU_SCENE_IDS);
  assert.equal(scenes.length, CPU_SCENE_IDS.length);
});

test('UR12b: a numeric brief still contains the chart scene', () => {
  const scenes = defaultCpuScenes(NUMERIC);
  const chart = scenes.find(scene => scene.id === 's_chart');
  assert.equal(chart?.layout, 'chart');
});
