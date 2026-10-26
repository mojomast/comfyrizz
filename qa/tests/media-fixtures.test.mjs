import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import {
  AUDIO_FRAME_SECONDS, decodeAudioLabel, decodeImageLabel, decodePng, decodeVideoAudioLabel, decodeVideoFrameLabel,
  decodeWav, ffmpegStatus, labelId, makeLabelledMp4, makeLabelledPng, makeLabelledWav, tempMediaDir, writeMediaSet,
} from '../lib/media-fixtures.mjs';

const LABELS = ['take-intro-a', 'take-intro-b', 'take-outro-a', 's_intro:clip-1', 'asset-plate-7'];

test('every label decodes back to its own identity from audio samples', () => {
  for (const label of LABELS) {
    const { samples, sampleRate } = decodeWav(makeLabelledWav({ label, seconds: 3 }));
    assert.equal(decodeAudioLabel(samples, sampleRate).id, labelId(label), label);
    // A seek lands inside a later repetition of the frame and still names the same take.
    assert.equal(decodeAudioLabel(samples, sampleRate, { offsetSeconds: 2.2 }).id, labelId(label), `${label} after seek`);
  }
  assert.ok(AUDIO_FRAME_SECONDS > 0.4 && AUDIO_FRAME_SECONDS < 0.5);
});

test('audio decoding survives resampling and distinguishes different takes', () => {
  const a = decodeWav(makeLabelledWav({ label: 'take-intro-a', seconds: 1, sampleRate: 48000 }));
  assert.equal(decodeAudioLabel(a.samples, a.sampleRate).id, labelId('take-intro-a'));
  const b = decodeWav(makeLabelledWav({ label: 'take-intro-b', seconds: 1 }));
  assert.notEqual(decodeAudioLabel(b.samples, b.sampleRate).id, labelId('take-intro-a'));
});

test('silence or a demo tone is not mistaken for a labelled take', () => {
  assert.throws(() => decodeAudioLabel(new Float32Array(8000), 8000), /no label sync/);
  const tone = Float32Array.from({ length: 8000 }, (_, n) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / 8000));
  assert.throws(() => decodeAudioLabel(tone, 8000), /no label sync/);
});

test('picture labels decode from PNG bytes at the source and at another scale', () => {
  for (const label of LABELS) {
    const png = makeLabelledPng({ label });
    assert.equal(decodeImageLabel(png).id, labelId(label), label);
    const large = decodePng(makeLabelledPng({ label, width: 640, height: 360 }));
    assert.equal(decodeImageLabel(large).id, labelId(label), `${label} @640`);
  }
});

test('writeMediaSet writes distinct files with a manifest', t => {
  const { dir, cleanup } = tempMediaDir();
  t.after(cleanup);
  const set = writeMediaSet(dir, ['take-intro-a', 'take-intro-b'], { video: false });
  assert.equal(Object.keys(set).length, 2);
  assert.notEqual(set['take-intro-a'].id, set['take-intro-b'].id);
  assert.equal(set['take-intro-a'].png.startsWith(join(dir)), true);
});

test('labelled MP4 frames and soundtrack decode to the same identity (local ffmpeg)', t => {
  const status = ffmpegStatus();
  if (!status.available) return t.skip(status.reason);
  const { dir, cleanup } = tempMediaDir();
  t.after(cleanup);
  const mp4 = makeLabelledMp4({ label: 'take-outro-a', seconds: 2, dir });
  assert.equal(decodeVideoFrameLabel(mp4, 0.5).id, labelId('take-outro-a'));
  assert.equal(decodeVideoAudioLabel(mp4, 0.2).id, labelId('take-outro-a'));
  const other = makeLabelledMp4({ label: 'take-intro-b', seconds: 2, dir });
  assert.notEqual(decodeVideoFrameLabel(other, 0.5).id, labelId('take-outro-a'));
});
