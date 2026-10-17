import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline, hashTimeline, LAYOUT_LIMITS, MAX_FLEXIBLE_FRAMES, TimelineError, type ComfyrizzPackage } from '../src/index.js';

function scene(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    layout: 'title' as const,
    variant: 'centered',
    preferredFrames: 150,
    copy: { headline: `Scene ${id}` },
    transitionOut: { type: 'fade', frames: 15 },
    ...extra,
  };
}

function pkg(scenes = [scene('s1'), scene('s2'), scene('s3'), scene('s4'), scene('s5'), scene('s6', { transitionOut: { type: 'none', frames: 0 } })]): ComfyrizzPackage {
  return {
    id: 'pkg_test',
    title: 'Timeline test',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible' },
    scenes,
  };
}

test('six 150-frame scenes with five 15-frame fades compile to 825 frames', () => {
  const timeline = compileTimeline(pkg());
  assert.equal(timeline.durationInFrames, 825);
  assert.deepEqual(timeline.scenes.map(s => s.from), [0, 135, 270, 405, 540, 675]);
  assert.equal(timeline.scenes.at(-1)!.from + timeline.scenes.at(-1)!.durationInFrames, 825);
  // Overlaps are recorded on the right scenes.
  assert.deepEqual(timeline.scenes.map(s => s.transitionInFrames), [0, 15, 15, 15, 15, 15]);
  assert.deepEqual(timeline.scenes.map(s => s.transitionOutFrames), [15, 15, 15, 15, 15, 0]);
});

test('a transition longer than either neighbour fails with a usable error', () => {
  const broken = pkg([
    scene('s1', { transitionOut: { type: 'fade', frames: 40 } }),
    scene('s2', { preferredFrames: 30, transitionOut: { type: 'none', frames: 0 } }),
  ]);
  assert.throws(
    () => compileTimeline(broken),
    (error: unknown) => error instanceof TimelineError && error.code === 'transition-out-of-range' && /does not fit/.test((error as Error).message),
  );
});

test('a transition on the last scene fails', () => {
  const broken = pkg([scene('s1'), { ...scene('s2'), transitionOut: { type: 'fade', frames: 15 } }]);
  assert.throws(() => compileTimeline(broken), (error: unknown) => error instanceof TimelineError && error.code === 'transition-out-of-range');
});

test('target mode grows toward targetFrames and reports a deviation it cannot reach', () => {
  const exact = compileTimeline({ ...pkg(), duration: { mode: 'target', targetFrames: 900 } });
  assert.equal(exact.mode, 'target');
  assert.equal(exact.target.requested, 900);
  assert.equal(exact.target.actual, 900);
  assert.equal(exact.target.deviationFrames, 0);
  assert.equal(exact.target.requiresAcceptance, false);

  const capped = compileTimeline({ ...pkg(), duration: { mode: 'target', targetFrames: 5000 } });
  assert.equal(capped.target.requested, 5000);
  assert.ok(capped.target.actual < 5000, 'must not fabricate frames past layout limits');
  assert.ok(capped.target.deviationFrames > 0);
  assert.equal(capped.target.requiresAcceptance, true);
});

test('narration is provisional until measured chunks exist, then sets the scene length', () => {
  const narrated = pkg([
    scene('s1', { narration: 'Meet Orbit.' }),
    scene('s2', { narration: 'Two sentences here now.', transitionOut: { type: 'none', frames: 0 } }),
  ]);
  narrated.voice = { enabled: true, engine: 'kokoro', voice: 'af_heart', speed: 1 };
  const provisional = compileTimeline(narrated);
  assert.equal(provisional.provisional, true);
  assert.match(provisional.warnings.join(' '), /provisional/);
  assert.equal(provisional.scenes[0].durationInFrames, 150);

  const measured = compileTimeline(narrated, {
    narration: {
      s1: [{ text: 'Meet Orbit.', seconds: 8 }],
      s2: [{ text: 'Two sentences here now.', seconds: 12 }],
    },
  });
  assert.equal(measured.provisional, false);
  // 8 s + 0.25 padding = 8.25 s -> 248 frames, above the 150 preferred length.
  assert.equal(measured.scenes[0].durationInFrames, 248);
  assert.equal(measured.scenes[1].durationInFrames, 368);
  assert.equal(measured.captions.length, 2);
  assert.ok(measured.captions.every(cue => cue.estimated === false));
});

test('preferred lengths are clamped to layout limits', () => {
  const tiny = compileTimeline(pkg([scene('s1', { preferredFrames: 2, transitionOut: { type: 'none', frames: 0 } })]));
  assert.equal(tiny.scenes[0].durationInFrames, LAYOUT_LIMITS.title.min);
});

test('24 fps plates are retimed to the 30 fps timeline explicitly', () => {
  const withPlate = pkg([scene('s1', { background: { asset: 'a_plate', fit: 'cover', loop: true }, transitionOut: { type: 'none', frames: 0 } })]);
  withPlate.assets = {
    a_plate: { kind: 'video', media: { width: 960, height: 544, fps: 24, frames: 97, audio: 'muted' } },
  };
  const timeline = compileTimeline(withPlate);
  assert.equal(timeline.plates.length, 1);
  const [plate] = timeline.plates;
  assert.equal(plate.assetId, 'a_plate');
  assert.equal(plate.sourceFps, 24);
  assert.equal(plate.targetFps, 30);
  assert.equal(plate.speed, 1.25);
  assert.equal(plate.retimedFrames, 78);
  assert.equal(plate.strategy, 'retime');
});

test('identical input gives an identical hash, any edit changes it', () => {
  const one = compileTimeline(pkg());
  const two = compileTimeline(pkg());
  assert.equal(one.hash, two.hash);
  assert.equal(hashTimeline(one), one.hash);

  const edited = pkg();
  edited.scenes[0].copy = { headline: 'Changed' };
  const three = compileTimeline(edited);
  assert.notEqual(three.hash, one.hash);
  assert.notEqual(three.sourceHash, one.sourceHash);
  assert.equal(three.scenes[0].copy.headline, 'Changed');
});

test('flexible timelines past the 90 s cap warn and propose shorter copy without cutting speech', () => {
  const long = pkg(Array.from({ length: 6 }, (_, index) => scene(`s${index + 1}`, index === 5 ? { layout: 'list', preferredFrames: 500, transitionOut: { type: 'none', frames: 0 } } : { layout: 'list', preferredFrames: 500 })));
  const timeline = compileTimeline(long, {
    narration: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`s${index + 1}`, [{ text: 'long', seconds: 20 }]])),
  });
  assert.ok(timeline.durationInFrames > MAX_FLEXIBLE_FRAMES);
  assert.match(timeline.warnings.join(' '), /90 s/);
  assert.equal(timeline.proposals.length, 1);
  assert.match(timeline.proposals[0], /Shorten copy/);
});

test('media_only and lower_third survive the compile (N8)', () => {
  const withOverlay = pkg([
    scene('s1', {
      media_only: true,
      lower_third: { kicker: 'How it flows', text: 'Wind -> Grid' },
      transitionOut: { type: 'none', frames: 0 },
    }),
  ]);
  const timeline = compileTimeline(withOverlay);
  assert.equal(timeline.scenes[0].mediaOnly, true);
  assert.deepEqual(timeline.scenes[0].lowerThird, { kicker: 'How it flows', text: 'Wind -> Grid' });

  const plain = compileTimeline(pkg([scene('s1', { transitionOut: { type: 'none', frames: 0 } })]));
  assert.equal(plain.scenes[0].mediaOnly, false);
  assert.equal(plain.scenes[0].lowerThird, null);
});

test('empty or duplicate scene ids fail closed', () => {
  assert.throws(() => compileTimeline({ ...pkg(), scenes: [] }), (error: unknown) => error instanceof TimelineError && error.code === 'empty-package');
  assert.throws(
    () => compileTimeline(pkg([scene('dup'), scene('dup')])),
    (error: unknown) => error instanceof TimelineError && error.code === 'duplicate-scene-id',
  );
});
