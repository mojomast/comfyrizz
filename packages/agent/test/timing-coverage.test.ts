import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimingGate,
  clipCoverage,
  durationConstraint,
  timingReportFor,
} from '../src/timing-coverage.js';

test('a 4s source at 0.4x covers 10s, not 14s', () => {
  const coverage = clipCoverage({ sourceSeconds: 4, speed: 0.4, targetSeconds: 14 });
  assert.equal(coverage.playbackSeconds, 10);
  assert.equal(coverage.coverageSeconds, 10);
  assert.equal(coverage.targetSeconds, 14);
  assert.equal(coverage.gapSeconds, 4);
  assert.equal(coverage.state, 'under-covered');
});

test('intentional holds extend coverage without being multiplied by clip speed', () => {
  const coverage = clipCoverage({ sourceSeconds: 4, speed: 0.4, holds: [2], targetSeconds: 12 });
  assert.equal(coverage.holdSeconds, 2);
  assert.equal(coverage.coverageSeconds, 12);
  assert.equal(coverage.gapSeconds, 0);
  assert.equal(coverage.state, 'covered');
});

test('requested duration is a typed frame constraint with an explicit tolerance', () => {
  assert.deepEqual(durationConstraint({ seconds: 10, toleranceSeconds: 0.5 }, 30), {
    mode: 'target',
    requestedFrames: 300,
    toleranceFrames: 15,
    minFrames: 285,
    maxFrames: 315,
  });
  assert.deepEqual(durationConstraint({ frames: 120 }, 24), {
    mode: 'target',
    requestedFrames: 120,
    toleranceFrames: 12,
    minFrames: 108,
    maxFrames: 132,
  });
});

function measuredPackage(): any {
  return {
    revision: 3,
    format: { fps: 30 },
    duration: { mode: 'target', targetFrames: 300, minFrames: 285, maxFrames: 315 },
    voice: { enabled: true },
    assets: { a_voice: { kind: 'audio', status: 'ready', file: 'assets/voice.wav' } },
    scenes: [
      {
        id: 's_one',
        layout: 'title',
        preferredFrames: 300,
        narration: 'A measured line',
        narration_asset: 'a_voice',
        narration_duration_frames: 100,
      },
    ],
  };
}

function measuredTimeline() {
  return {
    fps: 30,
    durationInFrames: 300,
    scenes: [{ id: 's_one', layout: 'title', durationInFrames: 300, provisional: false }],
  };
}

test('timing report separates request, compiled runtime, measured scenes and tolerance', () => {
  const report = timingReportFor(measuredPackage(), measuredTimeline());
  assert.deepEqual(report.requested, {
    mode: 'target',
    frames: 300,
    seconds: 10,
    toleranceFrames: 15,
    toleranceSeconds: 0.5,
  });
  assert.deepEqual(report.compiled, { frames: 300, seconds: 10, fps: 30 });
  assert.equal(report.match, 'within-tolerance');
  assert.equal(report.deviationFrames, 0);
  assert.equal(report.scenes[0].state, 'measured');
  assert.deepEqual(report.coverage, { total: 1, measured: 1, estimated: 0, stale: 0 });
  assert.equal(buildTimingGate(report).ok, true);
});

test('a compiled runtime outside the declared tolerance is a structured mismatch', () => {
  const timeline = measuredTimeline();
  timeline.durationInFrames = 360;
  timeline.scenes[0].durationInFrames = 360;
  const report = timingReportFor(measuredPackage(), timeline);
  assert.equal(report.match, 'mismatch');
  assert.equal(report.deviationFrames, 60);
  assert.equal(report.requiresAcceptance, true);
  const gate = buildTimingGate(report);
  assert.equal(gate.ok, false);
  assert.equal(gate.refusals[0].code, 'TIMING_MISMATCH');
});

test('unmeasured narration is stale, and overfull narration is refused before build', () => {
  const pkg = measuredPackage();
  pkg.scenes[0] = {
    id: 's_one',
    layout: 'title',
    preferredFrames: 60,
    narration: 'one two three four five six seven eight nine ten eleven twelve',
  };
  delete (pkg as { assets?: unknown }).assets;
  pkg.duration = { mode: 'target', targetFrames: 60 };
  const timeline = {
    fps: 30,
    durationInFrames: 60,
    scenes: [{ id: 's_one', layout: 'title', durationInFrames: 60, provisional: true }],
  };
  const report = timingReportFor(pkg, timeline);
  assert.equal(report.scenes[0].state, 'stale');
  assert.ok(report.scenes[0].overflowWords > 0);
  assert.equal(report.coverage.stale, 1);
  const gate = buildTimingGate(report);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.refusals.map(refusal => refusal.code).sort(), ['NARRATION_OVERFLOW', 'TIMING_STALE']);
});

test('a measured scene from another revision is stale', () => {
  const report = timingReportFor(measuredPackage(), measuredTimeline(), {
    measuredRevision: 2,
    currentRevision: 3,
  });
  assert.equal(report.scenes[0].state, 'stale');
  assert.equal(buildTimingGate(report).refusals[0].code, 'TIMING_STALE');
});
