/**
 * A6 per-scene re-render test.
 *
 * The pure tests assert the segment plan (contiguous ranges, stable content
 * keys, invalidation only where it should happen). The integration test does a
 * real CPU render of a tiny fixture, proves an unchanged export reuses every
 * segment, proves a one-scene edit re-renders only the affected segments, and
 * checks the incremental export frame count against the compiled timeline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { inlineGeneratedAssets } from '../scripts/render-package-lib.mjs';
import { planSegments, mergeScenes, renderPackageIncremental } from '../scripts/render-incremental.mjs';
import { collectMockContribution } from '../../server/test/helpers/comfy-contribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'tiny');
const pkg = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
const timeline = compileTimeline(pkg);
const generatedAssets = inlineGeneratedAssets(pkg, fixture);

test('planSegments splits the timeline into contiguous per-scene segments', () => {
  const segments = planSegments(pkg, timeline, { generatedAssets });
  assert.equal(segments.length, timeline.scenes.length);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, timeline.durationInFrames - 1);
  for (let index = 1; index < segments.length; index += 1) {
    assert.equal(segments[index].start, segments[index - 1].end + 1, 'segments are contiguous');
  }
  assert.equal(segments.reduce((sum, segment) => sum + segment.frames, 0), timeline.durationInFrames);
  const again = planSegments(pkg, timeline, { generatedAssets });
  assert.deepEqual(again.map(segment => segment.key), segments.map(segment => segment.key), 'keys are stable');
});

test('P-pres: a presenter change invalidates exactly the segment that draws it', () => {
  const withPresenter = structuredClone(pkg);
  withPresenter.presenter = { enabled: true, portrait: 'a_portrait', scenes: ['s_outro'] };
  withPresenter.assets = { ...(withPresenter.assets ?? {}), a_portrait: { kind: 'image', origin: 'generated', status: 'ready', file: 'assets/portrait.png' } };
  const base = planSegments(withPresenter, compileTimeline(withPresenter), { generatedAssets });
  const moved = structuredClone(withPresenter);
  moved.presenter.placement = 'pip-bl';
  const next = planSegments(moved, compileTimeline(moved), { generatedAssets });
  assert.notEqual(next[2].key, base[2].key, 'the covered scene re-renders');
  assert.equal(next[0].key, base[0].key, 'the scene before it still reuses');
  assert.equal(next[1].key, base[1].key, 'the fading scene before it still reuses');
});

test('mergeScenes keeps committed timing but takes current package content', () => {
  const edited = structuredClone(pkg);
  edited.scenes[1].copy.headline = 'Fresh headline';
  edited.scenes[1].foreground[0].x = 0.11;
  const merged = mergeScenes(edited, timeline);
  assert.equal(merged[1].copy.headline, 'Fresh headline', 'copy comes from the package');
  assert.equal(merged[1].foreground[0].x, 0.11, 'placement comes from the package');
  assert.equal(merged[1].from, timeline.scenes[1].from, 'timing stays committed');
  assert.equal(merged[1].durationInFrames, timeline.scenes[1].durationInFrames, 'duration stays committed');
  // Regression (MS3): the transition vocabulary and motion live only in the package, so a
  // player fed the bare timeline would drop every transition and truncate the tail.
  assert.deepEqual(merged[1].transitionOut, pkg.scenes[1].transitionOut, 'the package transition survives the merge');
  edited.scenes[1].transitionOut = { type: 'push', direction: 'left', frames: 12 };
  edited.scenes[1].motion = { entry: 'waterfall' };
  const withTransition = mergeScenes(edited, timeline);
  assert.deepEqual(withTransition[1].transitionOut, { type: 'push', direction: 'left', frames: 12 });
  assert.deepEqual(withTransition[1].motion, { entry: 'waterfall' });
  const withCues = structuredClone(timeline);
  withCues.scenes[1].motionCues = [{ phrase: 'Fresh', frame: withCues.scenes[1].from + 30, seconds: 1, source: 'word-cues', estimated: false }];
  const mergedCues = mergeScenes(edited, withCues);
  assert.deepEqual(mergedCues[1].motionCues, withCues.scenes[1].motionCues, 'planner-resolved motionCues survive the package merge');
});

test('planSegments keys package content, not just the committed timeline', () => {
  const base = planSegments(pkg, timeline, { generatedAssets });
  const edited = structuredClone(pkg);
  edited.scenes[1].foreground[0].x = 0.11; // content-only edit, same timing
  const next = planSegments(edited, timeline, { generatedAssets }); // deliberately stale timeline
  assert.notEqual(next[1].key, base[1].key, 'a placement edit invalidates the segment');
  assert.equal(next.at(-1).key, base.at(-1).key, 'the untouched outro still reuses');
});

test('editing a scene invalidates only that segment and the fade before it', () => {
  const base = planSegments(pkg, timeline, { generatedAssets });
  const edited = structuredClone(pkg);
  edited.scenes[1].copy.headline = 'Edited headline';
  const editedTimeline = compileTimeline(edited);
  const next = planSegments(edited, editedTimeline, { generatedAssets });
  assert.equal(next.at(-1).key, base.at(-1).key, 'the untouched outro segment reuses');
  assert.notEqual(next[1].key, base[1].key, 'the edited segment invalidates');
  assert.notEqual(next[0].key, base[0].key, 'the fade before the edited scene invalidates');
});

test('a dataset edit invalidates the scene that reads it (chart/stat)', () => {
  const base = planSegments(pkg, timeline, { generatedAssets });
  const edited = structuredClone(pkg);
  edited.datasets.d_tiny.values[0].label = 'Google Colab renders'; // content-only edit, same timing
  const next = planSegments(edited, timeline, { generatedAssets });
  assert.notEqual(next[1].key, base[1].key, 'the stat scene that names d_tiny re-renders');
  // the title fades into the stat scene, so that segment draws it too and must also re-render
  assert.notEqual(next[0].key, base[0].key, 'the fade before the dataset scene re-renders');
  assert.equal(next.at(-1).key, base.at(-1).key, 'the untouched outro still reuses');
});

test('an unchanged incremental export reuses every segment and matches the timeline', { timeout: 300_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), 'comfyrizz-incr-'));
  try {
    const packageDir = join(work, 'tiny');
    cpSync(fixture, packageDir, { recursive: true });
    const packagePath = join(packageDir, 'package.json');
    const source = JSON.parse(readFileSync(packagePath, 'utf8'));
    collectMockContribution(source, packageDir, { sceneId: 's_outro' });
    writeFileSync(packagePath, JSON.stringify(source));
    const cacheDir = join(work, 'cache');
    const outDir = join(work, 'out');
    mkdirSync(outDir, { recursive: true });

    const first = renderPackageIncremental(packagePath, join(outDir, 'first.mp4'), { cacheDir });
    assert.equal(first.frames, first.timeline.durationInFrames, 'first export matches the timeline');
    assert.equal(first.rendered.length, first.segments.length, 'first run renders every segment');
    assert.equal(first.reused.length, 0);

    const second = renderPackageIncremental(packagePath, join(outDir, 'second.mp4'), { cacheDir });
    assert.equal(second.frames, second.timeline.durationInFrames);
    assert.equal(second.rendered.length, 0, 'unchanged export re-renders nothing');
    assert.equal(second.reused.length, second.segments.length, 'unchanged export reuses every segment');

    const mutated = JSON.parse(readFileSync(packagePath, 'utf8'));
    mutated.scenes[1].copy.headline = 'Edited headline';
    writeFileSync(packagePath, JSON.stringify(mutated, null, 2));
    const third = renderPackageIncremental(packagePath, join(outDir, 'third.mp4'), { cacheDir });
    assert.equal(third.frames, third.timeline.durationInFrames, 'edited export still matches the timeline');
    assert.equal(third.rendered.length, 2, 'only the fade + edited segment re-render');
    assert.equal(third.reused.length, third.segments.length - 2, 'the untouched outro segment reuses');
    assert.ok(third.reused.includes(second.segments.at(-1).key), 'reused key is the untouched outro');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
