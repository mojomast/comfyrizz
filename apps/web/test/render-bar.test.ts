// The web package typecheck has no @types/node; node:test imports are runtime
// only, like the other web tests that use node:test.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approveSharedAsset,
  approvedLabel,
  approvedPillLabel,
  renderRenderBar,
  summarizeGate,
} from '../src/takes/render-bar.ts';
import { renderReviewDrawer } from '../src/takes/review-drawer.ts';

function clip(sceneId, assetId, from, overlap = {}) {
  return {
    clipId: `${sceneId}:${assetId}`,
    sceneId,
    assetId,
    slot: 'background',
    kind: 'still',
    from,
    durationInFrames: 90,
    state: 'review',
    selected: `tk_${assetId}`,
    selectedN: 1,
    takeCount: 1,
    newTakes: 0,
    lastJob: null,
    queued: false,
    ...overlap,
  };
}

/** The seeded launch demo: a_icon_check backs two clips in two scenes. */
function launchDemoClips() {
  return [
    clip('s_title', 'a_icon_check', 0),
    clip('s_hero', 'a_diagram_flow', 90),
    clip('s_stat', 'a_icon_check', 180),
    clip('s_list', 'a_pattern_dots', 270),
    clip('s_outro', 'a_anim_bars', 360),
  ];
}

test('a shared asset approval counts every clip that uses it, not the verdict call', () => {
  const clips = launchDemoClips();
  const initial = summarizeGate(clips);
  assert.equal(initial.approved, 0);
  assert.equal(initial.total, 5);
  assert.equal(initial.blocking.length, 5);

  const afterOneVerdict = approveSharedAsset(clips, 'a_icon_check');
  const gate = summarizeGate(afterOneVerdict);
  assert.equal(gate.approved, 2, 'both scenes using a_icon_check are approved');
  assert.equal(gate.total, 5);
  assert.equal(gate.blocking.length, 3);
  assert.deepEqual(
    gate.blocking.map(blocker => blocker.clipId),
    ['s_hero:a_diagram_flow', 's_list:a_pattern_dots', 's_outro:a_anim_bars'],
  );
  assert.equal(approvedPillLabel(gate), '2/5 approved');
  assert.equal(approvedLabel(gate), '2/5 clips approved');

  // The input list is untouched: a verdict returns a new clip list.
  assert.equal(clips.filter(item => item.state === 'review').length, 5);

  const pill = renderRenderBar(gate);
  assert.match(pill, /2\/5 approved/);
  assert.match(pill, /data-gate-ok="false"/);
  assert.doesNotMatch(pill, /data-render-blocker/);

  const drawer = renderReviewDrawer(afterOneVerdict, { open: true, filter: 'approved' });
  assert.match(drawer, /data-review-count>2\/5 approved/);
  assert.match(drawer, /shared · 2 scenes/);
});

test('an unknown or missing assetId leaves every clip state unchanged', () => {
  const clips = launchDemoClips();
  for (const assetId of ['', 'a_missing', undefined, null]) {
    const next = approveSharedAsset(clips, assetId);
    assert.equal(next.length, clips.length);
    assert.deepEqual(next.map(item => item.state), clips.map(item => item.state));
  }
});

test('approving every shared asset reaches the same 5/5 gate the pill shows', () => {
  let clips = launchDemoClips();
  for (const assetId of ['a_icon_check', 'a_diagram_flow', 'a_pattern_dots', 'a_anim_bars']) {
    clips = approveSharedAsset(clips, assetId);
  }
  const gate = summarizeGate(clips);
  assert.equal(gate.ok, true);
  assert.equal(gate.approved, 5);
  assert.equal(gate.total, 5);
  assert.equal(gate.blocking.length, 0);
  assert.equal(approvedPillLabel(gate), '5/5 approved');

  const pill = renderRenderBar(gate);
  assert.match(pill, /5\/5 approved/);
  assert.match(pill, /data-gate-ok="true"/);
  assert.match(pill, /data-render-ready/);
  assert.doesNotMatch(pill, /data-render-blocker/);
});
