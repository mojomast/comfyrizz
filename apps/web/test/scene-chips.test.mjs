import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatDuration, renderSceneChips, sceneChips } from '../src/scene-chips.mjs';

const launchTimeline = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../examples/launch-demo/timeline.json', import.meta.url)), 'utf8'),
);

test('launch demo yields one time-ordered chip per scene with positive durations', () => {
  const chips = sceneChips(launchTimeline);
  assert.equal(chips.length, launchTimeline.scenes.length);
  assert.deepEqual(chips.map(chip => chip.id), launchTimeline.scenes.map(scene => scene.id));

  for (const chip of chips) {
    assert.equal(typeof chip.id, 'string');
    assert.equal(typeof chip.label, 'string');
    assert.equal(typeof chip.kind, 'string');
    assert.equal(typeof chip.status, 'string');
    assert.ok(chip.durationSec > 0, `${chip.id} has a positive duration`);
  }

  const starts = chips.map(chip => chip.startSec);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.deepEqual(chips.map(chip => chip.index), chips.map((_, index) => index + 1));

  const totalSeconds = chips.reduce((sum, chip) => sum + chip.durationSec, 0);
  const timelineSeconds = launchTimeline.durationInFrames / launchTimeline.fps;
  assert.ok(Math.abs(totalSeconds - timelineSeconds) < timelineSeconds * 0.1);
  assert.equal(chips[0].label, 'Comfyrizz');
  assert.equal(chips[0].kind, 'title');
});

test('clips and second-based timing are accepted alongside frames', () => {
  const chips = sceneChips({
    fps: 25,
    durationSec: 10,
    clips: [
      { id: 'b', label: 'Second', startSec: 4, durationSec: 2, kind: 'clip', status: 'ready' },
      { id: 'a', name: 'First', startFrame: 0, durationInFrames: 50, type: 'clip' },
    ],
  });

  assert.deepEqual(chips.map(chip => chip.id), ['a', 'b']);
  assert.equal(chips[0].startSec, 0);
  assert.equal(chips[0].durationSec, 2);
  assert.equal(chips[1].startSec, 4);
  assert.equal(chips[1].durationSec, 2);
  assert.equal(chips[1].status, 'ready');
  assert.equal(chips[0].status, 'ready');
});

test('labels and ids are escaped in rendered HTML', () => {
  const html = renderSceneChips([
    { id: 's<&"', index: 1, label: '<b>&"', durationSec: 4, kind: 'title', status: 'ready' },
  ]);

  assert.match(html, /<ol class="scene-chips" aria-label="Storyboard">/);
  assert.match(html, /<li><button[^>]*data-scene-id="s&lt;&amp;&quot;"/);
  assert.match(html, /&lt;b&gt;&amp;&quot;/);
  assert.ok(!html.includes('<b>'));
  assert.match(html, />4\.0s</);
});

test('activeId marks exactly the matching chip with aria-current', () => {
  const chips = sceneChips(launchTimeline);
  const html = renderSceneChips(chips, { activeId: 's_stat' });

  const active = html.match(/<button[^>]*data-scene-id="s_stat"[^>]*>/)[0];
  assert.match(active, /aria-current="true"/);
  assert.equal((html.match(/aria-current=/g) ?? []).length, 1);
  assert.match(renderSceneChips(chips), /aria-label="Storyboard"/);
});

test('empty and invalid timelines return no chips', () => {
  assert.deepEqual(sceneChips(null), []);
  assert.deepEqual(sceneChips(undefined), []);
  assert.deepEqual(sceneChips('nope'), []);
  assert.deepEqual(sceneChips({}), []);
  assert.deepEqual(sceneChips({ scenes: [] }), []);
  assert.deepEqual(sceneChips({ clips: [] }), []);
});

test('formatDuration uses one decimal and a seconds suffix', () => {
  assert.equal(formatDuration(4), '4.0s');
  assert.equal(formatDuration(3.55), '3.6s');
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(undefined), '0.0s');
});
