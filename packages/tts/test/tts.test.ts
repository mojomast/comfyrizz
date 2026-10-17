import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captionsToSrt,
  captionsToVtt,
  compileOptionsFromDurations,
  parseDurations,
  sceneNarrationSeconds,
} from '../src/index.js';

const durations = parseDurations({
  version: 1,
  engine: 'kokoro-onnx',
  engineVersion: '0.4.9',
  model: 'kokoro-v1.0.onnx',
  voices: 'voices-v1.0.bin',
  voice: 'af_heart',
  speed: 1,
  sampleRate: 24000,
  gapSeconds: 0.15,
  paddingSeconds: 0.25,
  totalSeconds: 4.0,
  scenes: {
    s_title: {
      chunks: [
        { text: 'One package.', seconds: 1.2 },
        { text: 'One finished video.', seconds: 1.8 },
      ],
      gapSeconds: 0.15,
      paddingSeconds: 0.25,
      seconds: 3.4,
    },
  },
});

test('measured chunks become compiler options without estimates', () => {
  const options = compileOptionsFromDurations(durations);
  assert.equal(options.narration.s_title.length, 2);
  assert.equal(options.narration.s_title[0].text, 'One package.');
  assert.equal(options.narrationGapSeconds, 0.15);
  assert.equal(options.narrationPaddingSeconds, 0.25);
});

test('scene duration is speech + gaps + padding', () => {
  assert.equal(sceneNarrationSeconds(durations.scenes.s_title), 3.4);
});

test('SRT uses comma milliseconds and 1-based indices', () => {
  const srt = captionsToSrt(
    [
      { text: 'One package.', from: 0, to: 36, sceneId: 's_title' },
      { text: 'One finished video.', from: 40, to: 94, sceneId: 's_title' },
    ],
    30,
  );
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,200\nOne package\.\n/);
  assert.match(srt, /\n2\n00:00:01,333 --> 00:00:03,133\nOne finished video\.\n/);
});

test('VTT has a header and uses dots', () => {
  const vtt = captionsToVtt([{ text: 'One package.', from: 0, to: 36 }], 30);
  assert.match(vtt, /^WEBVTT\n\ncue-1\n00:00:00\.000 --> 00:00:01\.200\nOne package\.\n$/);
});

test('bad durations are rejected, not silently repaired', () => {
  assert.throws(() => parseDurations({ version: 2, scenes: {} }), /version/);
  assert.throws(
    () =>
      parseDurations({
        version: 1,
        sampleRate: 24000,
        scenes: { s1: { chunks: [{ text: 'x', seconds: 0 }] } },
      }),
    /duration/,
  );
  assert.throws(
    () =>
      parseDurations({
        version: 1,
        sampleRate: 48000,
        scenes: { s1: { chunks: [{ text: 'x', seconds: 1 }] } },
      }),
    /sample rate/,
  );
});
