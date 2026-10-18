/**
 * K1: caption styles. The renderer's layer is React and the suite has no DOM, so
 * the style choice and the active-word logic live in `caption-model.js` and are
 * tested directly; a source check confirms `captions.tsx` draws all four styles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CAPTION_STYLES,
  activeWordIndex,
  captionWords,
  resolveCaptionStyle,
  wordPopProgress,
  wordPopScale,
} from '../src/caption-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'captions.tsx'), 'utf8');

const cue = {
  text: 'Meet Orbit today.',
  from: 0,
  to: 60,
  sceneId: 's1',
  estimated: false,
  words: [
    { text: 'Meet', from: 0, to: 15 },
    { text: 'Orbit', from: 15, to: 40 },
    { text: 'today.', from: 40, to: 60 },
  ],
};

test('K1: an explicit caption style wins, and 9:16 defaults to big-word', () => {
  assert.deepEqual(CAPTION_STYLES, ['sentence', 'karaoke', 'word-pop', 'big-word']);
  for (const style of CAPTION_STYLES) {
    assert.equal(resolveCaptionStyle({ captions: { style } }, { width: 1920, height: 1080 }), style);
  }
  assert.equal(resolveCaptionStyle({}, { width: 1920, height: 1080 }), 'sentence');
  assert.equal(resolveCaptionStyle({}, { width: 1080, height: 1920 }), 'big-word');
  assert.equal(resolveCaptionStyle({ captions: { style: 'shout' } }, { width: 1080, height: 1920 }), 'big-word', 'an unknown style falls back to the aspect default');
  assert.equal(resolveCaptionStyle({ captions: { style: 'shout' } }, { width: 1920, height: 1080 }), 'sentence');
});

test('K1: a cue without words falls back to the whole sentence', () => {
  assert.deepEqual(captionWords(cue), cue.words);
  assert.deepEqual(captionWords({ text: 'No words.', from: 0, to: 30 }), [
    { text: 'No words.', from: 0, to: 30 },
  ]);
});

test('K1: the active word tracks the frame and holds through the tail', () => {
  const words = cue.words;
  assert.equal(activeWordIndex(words, -1), -1);
  assert.equal(activeWordIndex(words, 0), 0);
  assert.equal(activeWordIndex(words, 14), 0);
  assert.equal(activeWordIndex(words, 15), 1);
  assert.equal(activeWordIndex(words, 39), 1);
  assert.equal(activeWordIndex(words, 40), 2);
  assert.equal(activeWordIndex(words, 59), 2);
  assert.equal(activeWordIndex(words, 60), 2, 'the last word holds past the cue end');
});

test('K1: a popping word scales 0.6 -> 1 and never overshoots', () => {
  const word = { text: 'Orbit', from: 15, to: 40 };
  assert.equal(wordPopProgress(word, 15), 0);
  assert.equal(wordPopScale(0), 0.6);
  assert.equal(wordPopProgress(word, 21), 1);
  assert.equal(wordPopScale(1), 1);
  assert.ok(wordPopScale(wordPopProgress(word, 18)) > 0.6);
  assert.ok(wordPopScale(wordPopProgress(word, 18)) < 1);
  assert.equal(wordPopScale(2), 1, 'progress is clamped');
});

test('K1: captions.tsx draws all four styles and keeps the sentence default', () => {
  assert.match(source, /resolveCaptionStyle\(pkg/, 'the style is read from the package');
  assert.match(source, /style === 'sentence'/, 'the unchanged sentence branch is present');
  assert.match(source, /style === 'big-word'/);
  assert.match(source, /style === 'word-pop'/);
  assert.match(source, /karaoke/, 'the karaoke highlight branch is present');
  assert.match(source, /zIndex: 100/, 'N11: captions still sit above scrims and panels');
});
