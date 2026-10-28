// PS07: every TimelineError is a typed 422 package problem, never a naked 500.
// Live run 20261028T070232Z-eef4c9 returned HTTP 500 for M09/D14/M10 because the
// last-scene transition escaped /api/agent as an untyped Error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline, TimelineError, type ComfyrizzPackage } from '../src/index.js';

function scene(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    layout: 'title' as const,
    preferredFrames: 150,
    copy: { headline: `Scene ${id}` },
    ...extra,
  };
}

function pkg(scenes: ReturnType<typeof scene>[]): ComfyrizzPackage {
  return {
    id: 'pkg_ps07',
    title: 'PS07 timeline test',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible' },
    scenes,
  } as ComfyrizzPackage;
}

function typedTimelineProblem(fn: () => unknown, code: string): TimelineError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TimelineError, `expected TimelineError, got ${String(error)}`);
    assert.equal(error.name, 'TimelineError');
    assert.equal((error as TimelineError & { status?: number }).status, 422, 'a timeline problem is a client-correctable 422');
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected TimelineError ${code}`);
}

test('PS07 a transition on the last scene is a typed 422 with its scene id', () => {
  const broken = pkg([
    scene('s1', { transitionOut: { type: 'fade', frames: 15 } }),
    scene('s2', { transitionOut: { type: 'fade', frames: 15 } }),
  ]);
  const error = typedTimelineProblem(() => compileTimeline(broken), 'transition-out-of-range');
  assert.equal(error.sceneId, 's2');
  assert.match(error.message, /last scene/i);
});

test('PS07 a transition that does not fit its neighbours is a typed 422', () => {
  const broken = pkg([
    scene('s1', { transitionOut: { type: 'fade', frames: 40 } }),
    scene('s2', { preferredFrames: 30 }),
  ]);
  const error = typedTimelineProblem(() => compileTimeline(broken), 'transition-out-of-range');
  assert.equal(error.sceneId, 's1');
  assert.match(error.message, /does not fit/i);
});

test('PS07 structural package errors keep their stable code and add status 422', () => {
  const empty = typedTimelineProblem(() => compileTimeline(pkg([])), 'empty-package');
  assert.equal((empty as TimelineError & { status?: number }).status, 422);

  const duplicate = pkg([scene('s1'), scene('s1')]);
  const error = typedTimelineProblem(() => compileTimeline(duplicate), 'duplicate-scene-id');
  assert.equal(error.sceneId, 's1');
});
