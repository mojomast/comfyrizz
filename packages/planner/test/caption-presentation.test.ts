import test from 'node:test';
import assert from 'node:assert/strict';
import { phraseCaptions } from '../src/caption-presentation.js';
import type { TimelineCaption } from '../src/timeline.js';
import { compileTimeline } from '../src/timeline.js';
import { readFileSync } from 'node:fs';

const text = 'Give it motion. Give it a little mischief.';
const words = text.split(' ').map((text, i) => ({ text, from: i * 8, to: (i + 1) * 8 }));
const cue: TimelineCaption = { text, words, from: 0, to: 90, sceneId: 'motion', estimated: false };
test('keeps the punchline in its phrase and preserves exact word positions', () => {
  const before = structuredClone(cue);
  const output = phraseCaptions([cue], 24);
  assert.deepEqual(output.map(c => c.text), ['Give it motion.', 'Give it a little mischief.']);
  assert.deepEqual(output.flatMap(c => c.words!), words);
  assert.equal(output[1].to, 90);
  assert.deepEqual(cue, before);
});
test('short final sentence stays attached rather than flashing an orphan', () => {
  const short = { ...cue, text: 'Again. Yes.', to: 30, words: [{ text: 'Again.', from: 0, to: 24 }, { text: 'Yes.', from: 24, to: 30 }] };
  assert.equal(phraseCaptions([short], 24).length, 1);
});
test('ASR case and punctuation differences retain alignment and use sentence punctuation', () => {
  const raw = { ...cue, words: words.map(w => ({ ...w, text: w.text.toLowerCase().replace(/\./g, '') })) };
  assert.deepEqual(phraseCaptions([raw], 24).map(c => c.text), ['Give it motion.', 'Give it a little mischief.']);
});
test('display corrections and missing alignment never invent measured word timing', () => {
  const changed = { ...cue, text: 'Different corrected wording.' };
  assert.deepEqual(phraseCaptions([changed], 24), [changed]);
  const unaligned = { ...cue, words: undefined };
  assert.deepEqual(phraseCaptions([unaligned], 24), [unaligned]);
});

test('package setting reaches the compiler without changing scene timing or legacy override indices', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../schema/fixtures/valid/minimal.json', import.meta.url), 'utf8'));
  const scene = pkg.scenes[0];
  scene.narration = text;
  scene.transitionOut = { type: 'cut', frames: 0 };
  const options = { narration: { [scene.id]: [{ text, seconds: 3.75,
    words: words.map(w => ({ text: w.text, start: w.from / 24, end: w.to / 24 })) }] } };
  pkg.format.fps = 24;
  const legacy = compileTimeline(pkg, options);
  pkg.captions = { presentation: 'phrases' };
  const phrases = compileTimeline(pkg, options);
  assert.equal(legacy.captions.length, 1);
  assert.deepEqual(phrases.captions.map(c => c.text), ['Give it motion.', 'Give it a little mischief.']);
  assert.deepEqual(phrases.scenes, legacy.scenes);
  assert.equal(phrases.durationInFrames, legacy.durationInFrames);
  const edited = compileTimeline(pkg, { ...options, captionOverrides: [{ sceneId: scene.id, index: 0, text: 'Display correction.' }] });
  assert.deepEqual(edited.captions.map(c => c.text), ['Display correction.']);
});
