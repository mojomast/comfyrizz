import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_STRENGTHS, chainDefaultFor, planChainedShot } from '../../src/ref-watch/chain.mjs';

const acceptedClip = Object.freeze({ id: 'clip_s02', status: 'accepted', video: 'out/clip_s02.mp4' });
const frame = 'out/clip_s02_last_frame.png';

function harness(overrides = {}) {
  const calls = [];
  const extractLastFrame = async (clip) => {
    calls.push(['extractLastFrame', clip]);
    if (overrides.extractThrows) throw new Error('ffmpeg failed');
    return overrides.frame ?? frame;
  };
  const reviewKeyframe = async (input) => {
    calls.push(['reviewKeyframe', input]);
    if (overrides.reviewThrows) throw new Error('judge unavailable');
    return {
      overall: overrides.overall ?? 'pass',
      ...(overrides.checks === undefined ? {} : { checks: overrides.checks }),
    };
  };
  return { calls, extractLastFrame, reviewKeyframe };
}

const characters = Object.freeze([
  Object.freeze({ characterId: 'hero', identityLock: 'soft face, dark curls' }),
]);

function shot(overrides = {}) {
  return { sceneId: 'scene_01', index: 1, ...overrides };
}

test('RW-W9C: chaining is off by default and calls neither dependency', () => {
  const { calls, extractLastFrame, reviewKeyframe } = harness();
  const result = planChainedShot({ previousClip: acceptedClip, extractLastFrame, reviewKeyframe });
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('RW-W9C: chaining off never calls extraction or review even when a clip is accepted', async () => {
  const { calls, extractLastFrame, reviewKeyframe } = harness();
  const result = await planChainedShot({
    previousClip: acceptedClip,
    chainFromPrevious: false,
    extractLastFrame,
    reviewKeyframe,
  });
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('RW-W9C: an accepted previous clip is extracted, then reviewed, then returned', async () => {
  const { calls, extractLastFrame, reviewKeyframe } = harness();
  const result = await planChainedShot({
    previousClip: acceptedClip,
    chainFromPrevious: true,
    extractLastFrame,
    reviewKeyframe,
  });

  assert.deepEqual(calls.map(([name]) => name), ['extractLastFrame', 'reviewKeyframe']);
  assert.deepEqual(calls[0][1], acceptedClip);
  assert.deepEqual(calls[1][1], { kind: 'keyframe', image: frame });
  assert.equal(result.loadImage, frame);
  assert.deepEqual(result.imgToVideoInplace, { strength: 0.7, strength2: 0.7 });
  assert.match(result.note, /ref-watch identity judge check/);
  assert.match(result.note, /chained clip frames/);
});

test('RW-W9C: chain strengths are exactly 0.7 and 0.7, never 1.0', async () => {
  assert.equal(CHAIN_STRENGTHS.strength, 0.7);
  assert.equal(CHAIN_STRENGTHS.strength2, 0.7);
  assert.notEqual(CHAIN_STRENGTHS.strength, 1);
  assert.notEqual(CHAIN_STRENGTHS.strength2, 1);

  const { extractLastFrame, reviewKeyframe } = harness();
  const result = await planChainedShot({
    previousClip: acceptedClip,
    chainFromPrevious: true,
    extractLastFrame,
    reviewKeyframe,
  });
  assert.equal(result.imgToVideoInplace.strength, 0.7);
  assert.equal(result.imgToVideoInplace.strength2, 0.7);
  assert.notEqual(result.imgToVideoInplace.strength, 1);
  assert.notEqual(result.imgToVideoInplace.strength2, 1);
});

test('RW-W9C: refuses an unaccepted previous clip without extracting or reviewing', async () => {
  for (const status of ['pending', 'reviewing', 'regenerating', 'held', 'overridden', undefined]) {
    const { calls, extractLastFrame, reviewKeyframe } = harness();
    await assert.rejects(
      planChainedShot({
        previousClip: status === undefined ? {} : { ...acceptedClip, status },
        chainFromPrevious: true,
        extractLastFrame,
        reviewKeyframe,
      }),
      /accepted/,
      `status ${String(status)} is refused`,
    );
    assert.deepEqual(calls, [], `status ${String(status)} calls nothing`);
  }
});

test('RW-W9C: refuses when the keyframe review fails', async () => {
  const { extractLastFrame, reviewKeyframe } = harness({ overall: 'fail' });
  await assert.rejects(
    planChainedShot({ previousClip: acceptedClip, chainFromPrevious: true, extractLastFrame, reviewKeyframe }),
    /review/,
  );
});

test('RW-W9C: refuses when the keyframe review errors', async () => {
  const { extractLastFrame, reviewKeyframe } = harness({ overall: 'error' });
  await assert.rejects(
    planChainedShot({ previousClip: acceptedClip, chainFromPrevious: true, extractLastFrame, reviewKeyframe }),
    /review/,
  );
});

test('RW-W9C: refuses when the keyframe review throws', async () => {
  const { extractLastFrame, reviewKeyframe } = harness({ reviewThrows: true });
  await assert.rejects(
    planChainedShot({ previousClip: acceptedClip, chainFromPrevious: true, extractLastFrame, reviewKeyframe }),
    /judge unavailable/,
  );
});

test('RW-W9C: refuses when extraction throws and does not review', async () => {
  const { calls, extractLastFrame, reviewKeyframe } = harness({ extractThrows: true });
  await assert.rejects(
    planChainedShot({ previousClip: acceptedClip, chainFromPrevious: true, extractLastFrame, reviewKeyframe }),
    /ffmpeg failed/,
  );
  assert.deepEqual(calls.map(([name]) => name), ['extractLastFrame']);
});

// --- SP01: same-scene chain default ----------------------------------------

test('SP01: chainDefaultFor turns a same-scene consecutive shot on', () => {
  assert.equal(
    chainDefaultFor({ shot: shot(), previousShot: shot({ index: 0 }) }),
    true,
  );
});

test('SP01: chainDefaultFor stays off across scenes, on the first shot, and on override false', () => {
  assert.equal(
    chainDefaultFor({ shot: shot({ sceneId: 'scene_02' }), previousShot: shot({ index: 0 }) }),
    false,
    'different scene',
  );
  assert.equal(chainDefaultFor({ shot: shot({ index: 0 }), previousShot: null }), false, 'first shot');
  assert.equal(chainDefaultFor({ shot: shot(), previousShot: undefined }), false, 'missing previous shot');
  assert.equal(
    chainDefaultFor({ shot: shot(), previousShot: shot({ index: 0 }), override: false }),
    false,
    'explicit override false wins',
  );
});

test('SP01: chainDefaultFor refuses a cut or hard transition on either shot', () => {
  assert.equal(
    chainDefaultFor({ shot: shot({ cut: true }), previousShot: shot({ index: 0 }) }),
    false,
    'current shot marked cut',
  );
  assert.equal(
    chainDefaultFor({ shot: shot(), previousShot: shot({ index: 0, cut: true }) }),
    false,
    'previous shot marked cut',
  );
  assert.equal(
    chainDefaultFor({ shot: shot({ transition: 'hard' }), previousShot: shot({ index: 0 }) }),
    false,
    'current shot has a hard transition',
  );
  assert.equal(
    chainDefaultFor({ shot: shot(), previousShot: shot({ index: 0, transition: 'hard' }) }),
    false,
    'previous shot has a hard transition',
  );
});

test('SP01: override true forces chaining on even across scenes or a cut', () => {
  assert.equal(
    chainDefaultFor({ shot: shot({ sceneId: 'scene_02', cut: true }), previousShot: null, override: true }),
    true,
  );
});

test('SP01: chainDefaultFor does not treat a skipped shot as directly preceding', () => {
  assert.equal(
    chainDefaultFor({ shot: shot({ index: 2 }), previousShot: shot({ index: 0 }) }),
    false,
  );
});

// --- SP01: identity gate on the chained frame ------------------------------

test('SP01: chained review asks for the identity dimension with the characters', async () => {
  const { calls, extractLastFrame, reviewKeyframe } = harness({
    checks: [{ dimension: 'identity', pass: true, severity: 'hard', evidence: 'same face' }],
  });
  const result = await planChainedShot({
    previousClip: acceptedClip,
    chainFromPrevious: true,
    characters,
    extractLastFrame,
    reviewKeyframe,
  });

  assert.deepEqual(calls.map(([name]) => name), ['extractLastFrame', 'reviewKeyframe']);
  assert.deepEqual(calls[1][1], {
    kind: 'keyframe',
    image: frame,
    characters,
    dimensions: ['identity'],
  });
  assert.equal(result.loadImage, frame);
  assert.deepEqual(result.imgToVideoInplace, { strength: 0.7, strength2: 0.7 });
});

test('SP01: identity failure on the chained frame falls back to the shot keyframe', async () => {
  const { extractLastFrame, reviewKeyframe } = harness({
    checks: [{ dimension: 'identity', pass: false, severity: 'hard', evidence: 'face drift' }],
  });
  const result = await planChainedShot({
    previousClip: acceptedClip,
    chainFromPrevious: true,
    characters,
    extractLastFrame,
    reviewKeyframe,
  });

  assert.equal(result.fallback, 'keyframe');
  assert.match(result.reason, /identity/i);
  assert.equal(result.loadImage, undefined, 'never uses the unreviewed chained frame');
  assert.equal(result.imgToVideoInplace, undefined);
});

test('SP01: a missing identity verdict falls back instead of using the chained frame', async () => {
  const { extractLastFrame, reviewKeyframe } = harness({
    checks: [{ dimension: 'technical', pass: true, severity: 'hard', evidence: 'ok' }],
  });
  const result = await planChainedShot({
    previousClip: acceptedClip,
    chainFromPrevious: true,
    characters,
    extractLastFrame,
    reviewKeyframe,
  });

  assert.equal(result.fallback, 'keyframe');
  assert.match(result.reason, /identity/i);
  assert.equal(result.loadImage, undefined);
});

test('SP01: an overall failed review still refuses before the identity fallback', async () => {
  const { extractLastFrame, reviewKeyframe } = harness({
    overall: 'fail',
    checks: [{ dimension: 'identity', pass: false, severity: 'hard', evidence: 'face drift' }],
  });
  await assert.rejects(
    planChainedShot({
      previousClip: acceptedClip,
      chainFromPrevious: true,
      characters,
      extractLastFrame,
      reviewKeyframe,
    }),
    /review/,
  );
});
