import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_STRENGTHS, planChainedShot } from '../../src/ref-watch/chain.mjs';

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
    return { overall: overrides.overall ?? 'pass' };
  };
  return { calls, extractLastFrame, reviewKeyframe };
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
