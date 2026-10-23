// IP51P: scene.audio_trim timing is shared by the renderer composition, the
// incremental-audio ffmpeg plan and the editor audition. No render or ffmpeg
// process runs here: the mix timing and the bus plan are pure data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAudioMix } from '../../renderer/src/audio-mix-model.js';
import { planAudioBuses } from '../../renderer/scripts/incremental-audio.mjs';

const FPS = 10;

const assets = {
  a_s1: { kind: 'video', status: 'ready', file: 'assets/s1.mp4', media: { audio: 'present' } },
  a_s2: { kind: 'video', status: 'ready', file: 'assets/s2.mp4', media: { audio: 'present' } },
  a_s3: { kind: 'video', status: 'ready', file: 'assets/s3.mp4', media: { audio: 'present' } },
};

const timeline = {
  fps: FPS,
  durationInFrames: 130,
  scenes: [
    { id: 's1', from: 10, durationInFrames: 40, transitionOutFrames: 0 },
    { id: 's2', from: 50, durationInFrames: 50, transitionOutFrames: 0 },
    { id: 's3', from: 100, durationInFrames: 30, transitionOutFrames: 0 },
  ],
  captions: [],
};

const trims = {
  // Linked: the source in-point follows the picture trim (2 s), not
  // audio_trim.startSeconds; the audio spans the placed scene duration.
  s1: { startSeconds: 9, endSeconds: 30, offsetFrames: -5, linked: true },
  // Unlinked: an independent J/L window, shifted 4 frames into the timeline.
  s2: { startSeconds: 1, endSeconds: 2.5, offsetFrames: 4, linked: false },
};

function fixture({ withTrim }) {
  const scene = (id, trimStart) => ({
    id,
    background: { asset: `a_${id}`, trim: { startSeconds: trimStart } },
    ...(withTrim && trims[id] ? { audio_trim: trims[id] } : {}),
  });
  return {
    audio: { ambience: { gain_db: -24, duck: { enabled: false } } },
    assets,
    scenes: [scene('s1', 2), scene('s2', 0), scene('s3', 0)],
  };
}

const timing = item => ({
  sceneId: item.sceneId,
  from: item.from,
  durationInFrames: item.durationInFrames,
  hasStart: Object.hasOwn(item, 'startSeconds'),
  hasEnd: Object.hasOwn(item, 'endSeconds'),
  ...(Object.hasOwn(item, 'startSeconds') ? { startSeconds: item.startSeconds } : {}),
  ...(Object.hasOwn(item, 'endSeconds') ? { endSeconds: item.endSeconds } : {}),
});

const busTiming = bus => ({
  file: bus.file,
  from: bus.from,
  seconds: bus.seconds,
  hasStart: Object.hasOwn(bus, 'startSeconds'),
  hasEnd: Object.hasOwn(bus, 'endSeconds'),
  ...(Object.hasOwn(bus, 'startSeconds') ? { startSeconds: bus.startSeconds } : {}),
  ...(Object.hasOwn(bus, 'endSeconds') ? { endSeconds: bus.endSeconds } : {}),
});

test('linked audio_trim uses the placed scene window from the picture in-point', () => {
  const mix = resolveAudioMix(fixture({ withTrim: true }), timeline);
  const [s1, s2] = mix.ambience;
  assert.deepEqual(timing(s1), {
    sceneId: 's1',
    from: 5, // 10 - 5 offset frames
    durationInFrames: 40, // exactly the placed scene, not endSeconds - startSeconds
    hasStart: true,
    hasEnd: true,
    startSeconds: 2, // picture in-point wins over audio_trim.startSeconds
    endSeconds: 6, // 2 s + 40 frames / 10 fps
  });
  assert.deepEqual(timing(s2), {
    sceneId: 's2',
    from: 54, // 50 + 4 offset frames
    durationInFrames: 15, // round((2.5 - 1) * 10)
    hasStart: true,
    hasEnd: true,
    startSeconds: 1,
    endSeconds: 2.5,
  });
});

test('scenes without audio_trim keep the legacy stack and expose no source trim', () => {
  const mix = resolveAudioMix(fixture({ withTrim: false }), timeline);
  assert.deepEqual(mix.ambience.map(timing), [
    { sceneId: 's1', from: 10, durationInFrames: 40, hasStart: false, hasEnd: false },
    { sceneId: 's2', from: 50, durationInFrames: 50, hasStart: false, hasEnd: false },
    { sceneId: 's3', from: 100, durationInFrames: 30, hasStart: false, hasEnd: false },
  ]);
});

test('incremental audio plan carries the same frames and source in/out', () => {
  const buses = planAudioBuses({ pkg: fixture({ withTrim: true }), timeline });
  assert.deepEqual(buses.filter(bus => bus.kind === 'ambience').map(busTiming), [
    { file: 'assets/s1.mp4', from: 5, seconds: 4, hasStart: true, hasEnd: true, startSeconds: 2, endSeconds: 6 },
    { file: 'assets/s2.mp4', from: 54, seconds: 1.5, hasStart: true, hasEnd: true, startSeconds: 1, endSeconds: 2.5 },
    { file: 'assets/s3.mp4', from: 100, seconds: 3, hasStart: false, hasEnd: false },
  ]);
});

test('incremental audio plan is byte-identical for scenes without audio_trim', () => {
  const buses = planAudioBuses({ pkg: fixture({ withTrim: false }), timeline });
  assert.deepEqual(buses.filter(bus => bus.kind === 'ambience').map(busTiming), [
    { file: 'assets/s1.mp4', from: 10, seconds: 4, hasStart: false, hasEnd: false },
    { file: 'assets/s2.mp4', from: 50, seconds: 5, hasStart: false, hasEnd: false },
    { file: 'assets/s3.mp4', from: 100, seconds: 3, hasStart: false, hasEnd: false },
  ]);
  for (const bus of buses) {
    assert.equal(Object.hasOwn(bus, 'startSeconds'), false);
    assert.equal(Object.hasOwn(bus, 'endSeconds'), false);
  }
});
