import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captionsToSrt,
  captionsToVtt,
  captionsToWordVtt,
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

test('K1: per-word timings ride along with the measured chunks', () => {
  const withWords = parseDurations({
    version: 1,
    sampleRate: 24000,
    scenes: {
      s1: {
        chunks: [
          {
            text: 'One package.',
            seconds: 1.2,
            words: [
              { text: 'One', start: 0, end: 0.4 },
              { text: 'package.', start: 0.4, end: 1.2 },
            ],
          },
        ],
      },
    },
  });
  const options = compileOptionsFromDurations(withWords);
  assert.deepEqual(options.narration.s1[0].words, [
    { text: 'One', start: 0, end: 0.4 },
    { text: 'package.', start: 0.4, end: 1.2 },
  ]);
});

test('K1: a chunk with no words stays exactly as before', () => {
  const options = compileOptionsFromDurations(durations);
  assert.equal(options.narration.s_title[0].words, undefined);
});

test('animation anchors retain known word timing provenance within measured audio', () => {
  const input = (engine: string, timing?: string) => ({ version: 1, engine, sampleRate: 24000,
    scenes: { s1: { chunks: [{ text: 'Hello.', seconds: 1, words: [{ text: 'Hello.', start: 0, end: 1 }], ...(timing ? { timing } : {}) }] } } });
  assert.equal(compileOptionsFromDurations(parseDurations(input('kokoro-onnx'))).narration.s1[0].timing, 'syllable-fallback');
  assert.equal(compileOptionsFromDurations(parseDurations(input('qwen3-tts', 'aligner'))).narration.s1[0].timing, 'aligner');
  assert.equal(compileOptionsFromDurations(parseDurations(input('qwen3-tts', 'syllable-fallback'))).narration.s1[0].timing, 'syllable-fallback');
  assert.equal(compileOptionsFromDurations(parseDurations(input('unknown'))).narration.s1[0].timing, undefined);
});

test('K1: bad word timings are rejected, not silently repaired', () => {
  const scene = (words: unknown) => ({
    version: 1,
    sampleRate: 24000,
    scenes: { s1: { chunks: [{ text: 'One two', seconds: 1, words }] } },
  });
  assert.throws(
    () => parseDurations(scene([{ text: 'One', start: 0.6, end: 0.5 }])),
    /monotonic/,
  );
  assert.throws(
    () => parseDurations(scene([{ text: 'One', start: 0, end: 2 }])),
    /outside/,
  );
  assert.throws(
    () => parseDurations(scene([{ text: 'One', start: 0, end: 0.5 }])),
    /sentence is 1s/,
  );
  assert.throws(
    () => parseDurations(scene([{ text: '', start: 0, end: 1 }])),
    /no text/,
  );
});

test('K1: the word-level VTT uses word cues and leaves sentence VTT alone', () => {
  const cues = [
    {
      text: 'Meet Orbit.',
      from: 0,
      to: 60,
      words: [
        { text: 'Meet', from: 0, to: 15 },
        { text: 'Orbit.', from: 15, to: 60 },
      ],
    },
  ];
  const wordVtt = captionsToWordVtt(cues, 30);
  assert.match(wordVtt, /^WEBVTT\n\nword-1\n00:00:00\.000 --> 00:00:00\.500\nMeet\n/);
  assert.match(wordVtt, /word-2\n00:00:00\.500 --> 00:00:02\.000\nOrbit\.\n$/);
  // Sentence output is unchanged whether or not words are present.
  assert.match(captionsToVtt(cues, 30), /cue-1\n00:00:00\.000 --> 00:00:02\.000\nMeet Orbit\.\n$/);
  assert.equal(captionsToWordVtt([{ text: 'No words.', from: 0, to: 30 }], 30), 'WEBVTT\n\n');
});

test('R3: a qwen3-tts durations file keeps K1 word timings for the compiler', () => {
  const parsed = parseDurations({
    version: 1,
    engine: 'qwen3-tts',
    sampleRate: 24000,
    scenes: {
      s1: {
        chunks: [
          {
            text: 'Meet Orbit.',
            seconds: 1,
            words: [
              { text: 'Meet', start: 0, end: 0.2 },
              { text: 'Orbit.', start: 0.2, end: 1 },
            ],
          },
        ],
        seconds: 1.25,
      },
    },
  });
  const options = compileOptionsFromDurations(parsed);
  assert.equal(parsed.engine, 'qwen3-tts');
  assert.deepEqual(options.narration.s1[0].words, [
    { text: 'Meet', start: 0, end: 0.2 },
    { text: 'Orbit.', start: 0.2, end: 1 },
  ]);
});
