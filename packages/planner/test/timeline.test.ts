import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline, hashTimeline, LAYOUT_LIMITS, MAX_FLEXIBLE_FRAMES, targetFramesForSeconds, TimelineError, type ComfyrizzPackage, type SceneMotion } from '../src/index.js';

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

test('a cut is a hard cut even if it carries frames', () => {
  const timeline = compileTimeline(pkg([
    scene('s1', { transitionOut: { type: 'cut', frames: 15 } }),
    scene('s2', { transitionOut: { type: 'cut', frames: 0 } }),
  ]));
  assert.deepEqual(timeline.scenes.map(s => s.transitionOutFrames), [0, 0]);
  assert.deepEqual(timeline.scenes.map(s => s.transitionInFrames), [0, 0]);
  assert.equal(timeline.durationInFrames, timeline.scenes.reduce((acc, s) => acc + s.durationInFrames, 0));
});

test('media-only cinematic inserts retain short frame-exact timing and measured speech', () => {
  const p = pkg([scene('insert', { layout: 'hero', media_only: true, preferredFrames: 24, transitionOut: { type: 'cut', frames: 0 } })]);
  assert.equal(compileTimeline(p).durationInFrames, 24);
  const measured = compileTimeline(p, { narration: { insert: [{ text: 'Keep the whole line.', seconds: 2 }] }, narrationPaddingSeconds: 0 });
  assert.equal(measured.durationInFrames, 60);
  p.scenes[0].media_only = false;
  assert.equal(compileTimeline(p).durationInFrames, LAYOUT_LIMITS.hero.min);
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

test('targetFramesForSeconds is the cutdown target at the package fps', () => {
  assert.equal(targetFramesForSeconds(6, 30), 180);
  assert.equal(targetFramesForSeconds(15, 30), 450);
  assert.equal(targetFramesForSeconds(30, 30), 900);
  assert.throws(() => targetFramesForSeconds(0, 30), (error: unknown) => error instanceof TimelineError && (error as TimelineError).code === 'bad-target');
});

test('target mode holds a 6 s cutdown whose scene is already the target length', () => {
  const cut = compileTimeline({
    ...pkg([scene('s1', { preferredFrames: 180, transitionOut: { type: 'none', frames: 0 } })]),
    duration: { mode: 'target', targetFrames: targetFramesForSeconds(6, 30) },
  });
  assert.equal(cut.mode, 'target');
  assert.equal(cut.durationInFrames, 180);
  assert.ok(Math.abs(cut.durationInFrames / cut.fps - 6) <= 0.5);
  assert.equal(cut.target.requiresAcceptance, false);
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

test('measured speech exceeds a stat layout cap without truncating the audio or captions', () => {
  const film = pkg([scene('s1', { layout: 'stat', narration: 'A longer explanation.', preferredFrames: 300, transitionOut: { type: 'cut', frames: 0 } })]);
  const timeline = compileTimeline(film, { narration: { s1: [{ text: 'A longer explanation.', seconds: 17 }] }, narrationPaddingSeconds: 0.5 });
  assert.equal(timeline.scenes[0].durationInFrames, 525);
  assert.ok(timeline.scenes[0].durationInFrames > LAYOUT_LIMITS.stat.max);
  assert.equal(timeline.captions[0].to, 510);
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

/* P-pres: the presenter track (H17 presenter block + per-scene override). */

test('P-pres: no presenter block means no presenter track, and the hash is untouched', () => {
  const timeline = compileTimeline(pkg());
  assert.equal(timeline.presenters, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(timeline, 'presenters'), false);
});

test('P-pres: bookends is the default coverage and pip-br the landscape placement', () => {
  const withPresenter = { ...pkg(), presenter: { enabled: true, portrait: 'a_portrait' } };
  const timeline = compileTimeline(withPresenter);
  assert.ok(timeline.presenters);
  assert.deepEqual(timeline.presenters!.map(p => p.sceneId), ['s1', 's6']);
  const first = timeline.presenters![0];
  assert.equal(first.placement, 'pip-br');
  assert.equal(first.shape, 'circle');
  assert.equal(first.size, 0.24);
  assert.equal(first.label, 'AI presenter');
  assert.equal(first.assetId, 'a_portrait');
  assert.equal(first.from, 0);
  assert.equal(first.durationInFrames, 150);
});

test('P-pres: all coverage and an explicit id list both resolve, and off removes a scene', () => {
  const all = compileTimeline({ ...pkg(), presenter: { enabled: true, portrait: 'a_portrait', scenes: 'all' as const } });
  assert.equal(all.presenters!.length, 6);
  const picked = compileTimeline({
    ...pkg([
      scene('s1'),
      scene('s2', { presenter: 'off' }),
      scene('s3', { transitionOut: { type: 'none', frames: 0 } }),
    ]),
    presenter: { enabled: true, portrait: 'a_portrait', scenes: ['s1', 's2', 's3'] },
  });
  assert.deepEqual(picked.presenters!.map(p => p.sceneId), ['s1', 's3']);
});

test('P-pres: a per-scene clip wins, split moves to the left card, portrait defaults pip-bc', () => {
  const portraitPkg = {
    ...pkg([scene('s1'), scene('s2', { layout: 'hero', presenter: 'split', presenter_asset: 'a_clip2', transitionOut: { type: 'none', frames: 0 } })]),
    format: { width: 1080, height: 1920, fps: 30 },
    presenter: { enabled: true, portrait: 'a_portrait', scenes: 'all' as const },
  };
  const timeline = compileTimeline(portraitPkg);
  assert.deepEqual(timeline.presenters!.map(p => [p.sceneId, p.assetId, p.placement]), [
    ['s1', 'a_portrait', 'pip-bc'],
    ['s2', 'a_clip2', 'split-left'],
  ]);
});

test('P-pres: split on a layout with no split card falls back to the package placement', () => {
  const timeline = compileTimeline({
    ...pkg([scene('s1'), scene('s2', { presenter: 'split', transitionOut: { type: 'none', frames: 0 } })]),
    presenter: { enabled: true, portrait: 'a_portrait', placement: 'pip-bl', scenes: 'all' as const },
  });
  assert.deepEqual(timeline.presenters!.map(p => [p.sceneId, p.placement]), [
    ['s1', 'pip-bl'],
    ['s2', 'pip-bl'],
  ]);
});

test('P-pres: size is clamped to the schema range and the seam dissolve follows the transition', () => {
  const timeline = compileTimeline({
    ...pkg([scene('s1', { transitionOut: { type: 'fade', frames: 12 } }), scene('s2', { transitionOut: { type: 'none', frames: 0 } })]),
    presenter: { enabled: true, portrait: 'a_portrait', size: 0.9, scenes: 'all' as const },
  });
  assert.equal(timeline.presenters![0].size, 0.32);
  assert.equal(timeline.presenters![0].dissolveOutFrames, 5);
  assert.equal(timeline.presenters![1].dissolveInFrames, 5);
  assert.equal(timeline.presenters![1].dissolveOutFrames, 0);
});

test('K1: measured word timings become caption word cues inside the sentence', () => {
  const narrated = pkg([scene('s1', { narration: 'Meet Orbit.', transitionOut: { type: 'none', frames: 0 } })]);
  narrated.voice = { enabled: true, engine: 'kokoro', voice: 'af_heart', speed: 1 };
  const timeline = compileTimeline(narrated, {
    narration: {
      s1: [
        {
          text: 'Meet Orbit.',
          seconds: 2,
          words: [
            { text: 'Meet', start: 0, end: 0.5 },
            { text: 'Orbit.', start: 0.5, end: 2 },
          ],
        },
      ],
    },
  });
  const cue = timeline.captions[0];
  assert.equal(cue.text, 'Meet Orbit.');
  assert.equal(cue.from, 0);
  assert.equal(cue.to, 60);
  assert.deepEqual(cue.words, [
    { text: 'Meet', from: 0, to: 15 },
    { text: 'Orbit.', from: 15, to: 60 },
  ]);
  // monotonic and inside the sentence span
  for (const word of cue.words ?? []) {
    assert.ok(word.from >= cue.from && word.to <= cue.to && word.to > word.from);
  }
});

test('K1: a sentence without words keeps the old caption shape', () => {
  const narrated = pkg([scene('s1', { narration: 'Meet Orbit.', transitionOut: { type: 'none', frames: 0 } })]);
  narrated.voice = { enabled: true, engine: 'kokoro', voice: 'af_heart', speed: 1 };
  const timeline = compileTimeline(narrated, { narration: { s1: [{ text: 'Meet Orbit.', seconds: 2 }] } });
  assert.equal(timeline.captions[0].words, undefined);
});

/* ANIM: cue_phrases resolve against measured captions/word cues, with conservative provenance. */

const CUE_TEXT = 'The request reaches the worker, then the worker replies.';
const CUE_WORDS = [
  { text: 'The', start: 0, end: 0.2 },
  { text: 'request', start: 0.2, end: 0.8 },
  { text: 'reaches', start: 0.8, end: 1.2 },
  { text: 'the', start: 1.2, end: 1.3 },
  { text: 'worker,', start: 1.3, end: 1.8 },
  { text: 'then', start: 1.8, end: 2.1 },
  { text: 'the', start: 2.1, end: 2.2 },
  { text: 'worker', start: 2.2, end: 2.7 },
  { text: 'replies.', start: 2.7, end: 4 },
];

function cueFilm(motion: SceneMotion, extra: Record<string, unknown> = {}) {
  const film = pkg([scene('s1', { narration: CUE_TEXT, motion, transitionOut: { type: 'none', frames: 0 }, ...extra })]);
  film.voice = { enabled: true, engine: 'kokoro', voice: 'af_heart', speed: 1 };
  return film;
}

const cueOptions = { narration: { s1: [{ text: CUE_TEXT, seconds: 4, words: CUE_WORDS }] } };

test('ANIM: cue phrases resolve to their first measured word without changing scene timing', () => {
  const timeline = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'] }), cueOptions);
  const plain = compileTimeline(cueFilm({ recipe: 'technical-flow' }), cueOptions);
  assert.equal(timeline.durationInFrames, plain.durationInFrames, 'cues never change total timing');
  assert.equal(timeline.scenes[0].durationInFrames, plain.scenes[0].durationInFrames);
  assert.equal(timeline.scenes[0].narration, plain.scenes[0].narration);

  const [cue] = timeline.scenes[0].motionCues!;
  assert.deepEqual(cue, {
    phrase: 'reaches the worker',
    frame: 24,
    seconds: 0.8,
    source: 'word-cues',
    estimated: false,
    occurrence: 1,
  });
  assert.equal(timeline.motionCueDiagnostics, undefined, 'a clean measured cue needs no diagnostic');
  assert.equal(plain.scenes[0].motionCues, undefined, 'no cue_phrases means no timeline addition');
});

test('ANIM: a missing phrase stays unresolved and says so instead of inventing alignment', () => {
  const timeline = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['the manager'] }), cueOptions);
  const [cue] = timeline.scenes[0].motionCues!;
  assert.equal(cue.frame, null);
  assert.equal(cue.seconds, null);
  assert.equal(cue.source, 'unresolved');
  assert.equal(cue.estimated, false);
  assert.equal(timeline.motionCueDiagnostics![0].code, 'MOTION_CUE_PHRASE_MISSING');
  assert.match(timeline.warnings.join(' '), /no matching measured caption or word cue/);
  assert.match(timeline.warnings.join(' '), /no forced alignment is claimed/);
});

test('ANIM: a repeated phrase picks occurrence 1 and emits an explicit ambiguity diagnostic', () => {
  const timeline = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['the worker'] }), cueOptions);
  const [cue] = timeline.scenes[0].motionCues!;
  assert.equal(cue.frame, 36, 'the first "the" word cue');
  assert.equal(cue.occurrence, 1);
  assert.equal(cue.source, 'word-cues');
  assert.equal(timeline.motionCueDiagnostics![0].code, 'MOTION_CUE_PHRASE_AMBIGUOUS');
  assert.match(timeline.motionCueDiagnostics![0].message, /occurs 2 times.*occurrence 1/);
});

test('ANIM: explicit cue_seconds take priority over phrase resolution', () => {
  const timeline = compileTimeline(
    cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'], cue_seconds: [3.5] }),
    cueOptions,
  );
  const [cue] = timeline.scenes[0].motionCues!;
  assert.deepEqual(cue, {
    phrase: 'reaches the worker',
    frame: 105,
    seconds: 3.5,
    source: 'explicit-seconds',
    estimated: false,
  });
  assert.equal(timeline.motionCueDiagnostics, undefined);
});

test('ANIM: estimated captions are labelled estimated, never measured or forced-aligned', () => {
  const film = cueFilm({ recipe: 'kinetic', cue_phrases: ['reaches the worker'] });
  film.voice = { enabled: false };
  const timeline = compileTimeline(film);
  const [cue] = timeline.scenes[0].motionCues!;
  assert.equal(cue.source, 'estimated-caption');
  assert.equal(cue.estimated, true);
  assert.ok(cue.frame !== null);
  const codes = timeline.motionCueDiagnostics!.map((diagnostic) => diagnostic.code);
  assert.deepEqual(codes, ['MOTION_CUE_ESTIMATED']);
  assert.match(timeline.warnings.join(' '), /anchored to estimated captions/);
});

test('ANIM: syllable-fallback words are estimated boundaries inside measured audio', () => {
  const fallbackOptions = {
    narration: { s1: [{ text: CUE_TEXT, seconds: 4, words: CUE_WORDS, timing: 'syllable-fallback' as const }] },
  };
  const timeline = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'] }), fallbackOptions);
  const caption = timeline.captions[0];
  assert.equal(caption.estimated, false, 'the sentence duration itself is measured');
  assert.equal(caption.timing, 'syllable-fallback');
  const [cue] = timeline.scenes[0].motionCues!;
  assert.equal(cue.source, 'word-cues');
  assert.equal(cue.estimated, true, 'the word boundary is estimated');
  assert.equal(cue.timing, 'syllable-fallback');
  assert.equal(cue.frame, 24, 'estimated word positions are still useful as cues');
  const [diagnostic] = timeline.motionCueDiagnostics!;
  assert.equal(diagnostic.code, 'MOTION_CUE_ESTIMATED');
  assert.match(diagnostic.message, /sentence audio is measured/);
  assert.match(diagnostic.message, /word boundary is estimated/);
  assert.doesNotMatch(diagnostic.message, /will move when audio is measured/);
});

test('ANIM: aligner word timings keep accurate provenance and no estimate diagnostic', () => {
  const alignerOptions = {
    narration: { s1: [{ text: CUE_TEXT, seconds: 4, words: CUE_WORDS, timing: 'aligner' as const }] },
  };
  const timeline = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'] }), alignerOptions);
  assert.equal(timeline.captions[0].timing, 'aligner');
  const [cue] = timeline.scenes[0].motionCues!;
  assert.equal(cue.source, 'word-cues');
  assert.equal(cue.estimated, false);
  assert.equal(cue.timing, 'aligner');
  assert.equal(timeline.motionCueDiagnostics, undefined);
});

test('ANIM: unknown timing strings are carried but do not claim aligner accuracy', () => {
  const vendorOptions = {
    narration: { s1: [{ text: CUE_TEXT, seconds: 4, words: CUE_WORDS, timing: 'vendor-word-timing' }] },
  };
  const timeline = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'] }), vendorOptions);
  assert.equal(timeline.captions[0].timing, 'vendor-word-timing');
  const [cue] = timeline.scenes[0].motionCues!;
  assert.equal(cue.source, 'word-cues');
  assert.equal(cue.estimated, false);
  assert.equal(cue.timing, 'vendor-word-timing');
  assert.equal(timeline.motionCueDiagnostics, undefined);
});

test('ANIM: a chunk without timing keeps the exact legacy caption and cue shape', () => {
  const timeline = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'] }), cueOptions);
  const caption = timeline.captions[0];
  assert.equal(Object.prototype.hasOwnProperty.call(caption, 'timing'), false);
  const [cue] = timeline.scenes[0].motionCues!;
  assert.equal(Object.prototype.hasOwnProperty.call(cue, 'timing'), false);
  assert.equal(cue.estimated, false);
  assert.equal(timeline.motionCueDiagnostics, undefined);
});

test('ANIM: a caption override changes display text but keeps cue frame, seconds and timing', () => {
  const measured = {
    narration: { s1: [{ text: CUE_TEXT, seconds: 4, words: CUE_WORDS, timing: 'aligner' as const }] },
  };
  const baseline = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'] }), measured);
  const edited = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'] }), {
    ...measured,
    captionOverrides: [{ sceneId: 's1', index: 0, text: 'Corrected display line.' }],
  });

  assert.equal(edited.captions[0].text, 'Corrected display line.');
  assert.deepEqual(edited.captions[0].words, baseline.captions[0].words);
  assert.equal(edited.captions[0].timing, 'aligner');
  assert.deepEqual(edited.scenes[0].motionCues, baseline.scenes[0].motionCues);
  assert.equal(edited.scenes[0].motionCues![0].frame, 24);
  assert.equal(edited.scenes[0].motionCues![0].seconds, 0.8);
  assert.equal(edited.scenes[0].motionCues![0].timing, 'aligner');
  assert.equal(edited.scenes[0].narration, baseline.scenes[0].narration, 'the spoken line is untouched');
  assert.equal(edited.durationInFrames, baseline.durationInFrames, 'a wording fix never retimes the film');
  assert.equal(edited.motionCueDiagnostics, undefined);
});

test('ANIM: a caption override never turns a spoken cue into an unresolved phrase', () => {
  const measured = { narration: { s1: [{ text: CUE_TEXT, seconds: 4 }] } };
  const baseline = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'] }), measured);
  const edited = compileTimeline(cueFilm({ recipe: 'technical-flow', cue_phrases: ['reaches the worker'] }), {
    ...measured,
    captionOverrides: [{ sceneId: 's1', index: 0, text: 'A visually corrected line.' }],
  });

  assert.equal(edited.captions[0].text, 'A visually corrected line.');
  assert.equal(edited.scenes[0].motionCues![0].source, 'measured-caption');
  assert.equal(edited.scenes[0].motionCues![0].frame, baseline.scenes[0].motionCues![0].frame);
  assert.equal(edited.scenes[0].motionCues![0].seconds, baseline.scenes[0].motionCues![0].seconds);
  assert.equal(edited.motionCueDiagnostics, undefined);
});
