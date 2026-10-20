import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileTimeline as compileNode, sha256Hex, measuredFromReport } from '../src/index.js';
import { compileTimeline as compileBrowser, compileInputHash, frameProjection, normalizeMeasured } from '../src/browser.js';
import type { ComfyrizzPackage } from '../src/index.js';

test('sha256 matches node crypto', () => {
  for (const value of ['', 'abc', '{"a":1}', 'café']) {
    assert.equal(sha256Hex(value), createHash('sha256').update(value).digest('hex'));
  }
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('shared durations mapping preserves known provenance across browser and server compilation', () => {
  const chunk = { text: 'Result', seconds: 2, words: [{ text: 'Result', start: 0.5, end: 1 }] };
  for (const [engine, timing, expected] of [
    ['kokoro', undefined, 'syllable-fallback'],
    ['kokoro', 'aligner', 'aligner'],
    ['other', 'syllable-fallback', 'syllable-fallback'],
    ['other', undefined, undefined],
  ] as const) {
    const measured = measuredFromReport({ engine, scenes: { s1: { chunks: [{ ...chunk, ...(timing ? { timing } : {}) }] } } });
    assert.equal(measured.narration?.s1[0].timing, expected);
    const pkg: ComfyrizzPackage = { format: { width: 1280, height: 720, fps: 30 }, scenes: [{ id: 's1', layout: 'hero', preferredFrames: 120, narration: 'Result', motion: { recipe: 'morph', cue_phrases: ['Result'] } }] };
    assert.deepEqual(compileBrowser(pkg, measured), compileNode(pkg, measured));
    assert.equal(compileBrowser(pkg, measured).scenes[0].motionCues?.[0].timing, expected);
  }
});

test('adopting aligned words also adopts their provenance without inventing alignment', () => {
  const chunk = { text: 'Result', seconds: 2 };
  const words = [{ text: 'Result', start: 0.5, end: 1 }];
  const options = normalizeMeasured({ narration: { s1: [{ ...chunk, timing: 'syllable-fallback' }] }, alignment: { s1: [{ ...chunk, words, timing: 'aligner' }] } });
  assert.equal(options.narration?.s1[0].timing, 'aligner');
  const unknown = normalizeMeasured({ narration: { s1: [{ ...chunk, timing: 'aligner' }] }, alignment: { s1: [{ ...chunk, words }] } });
  assert.equal(unknown.narration?.s1[0].timing, undefined);
});

test('browser compile matches the node compiler, including caption overrides', () => {
  const pkg: ComfyrizzPackage = {
    format: { width: 1280, height: 720, fps: 30 },
    scenes: [
      { id: 's1', layout: 'title', preferredFrames: 90, narration: 'Hello there.', copy: { headline: 'Hello' }, transitionOut: { type: 'none', frames: 0 } },
    ],
  };
  const measured = { narration: { s1: [{ text: 'Hello there.', seconds: 1.2, words: [{ text: 'Hello', start: 0, end: 0.4 }, { text: 'there.', start: 0.4, end: 1.2 }] }] } };
  const doc = { package: pkg, editSequence: 3, editor: { version: 1 as const, captionOverrides: [{ sceneId: 's1', index: 0, text: 'Hello, corrected.' }] } };
  const browser = compileBrowser(doc, measured);
  const node = compileNode(pkg, { ...normalizeMeasured(measured), captionOverrides: doc.editor.captionOverrides });
  assert.deepEqual(frameProjection(browser), frameProjection(node));
  assert.equal(browser.hash, node.hash);
  assert.equal(browser.captions[0]!.text, 'Hello, corrected.');
  assert.equal(browser.scenes[0]!.narration, 'Hello there.');
  assert.equal(compileInputHash(doc, measured), compileInputHash(doc, measured));
  for (const scene of browser.scenes) {
    assert.equal(Number.isInteger(scene.from), true);
    assert.equal(Number.isInteger(scene.durationInFrames), true);
  }
});

test('browser compile keeps animation cue timing alongside editor caption overrides', () => {
  const pkg: ComfyrizzPackage = {
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [
      {
        id: 's1',
        layout: 'hero',
        preferredFrames: 120,
        narration: 'The request reaches the worker.',
        motion: { recipe: 'technical-flow', cue_phrases: ['reaches the worker'] },
        transitionOut: { type: 'none', frames: 0 },
      },
    ],
  };
  const measured = {
    narration: {
      s1: [{
        text: 'The request reaches the worker.',
        seconds: 4,
        words: [
          { text: 'The', start: 0, end: 0.2 },
          { text: 'request', start: 0.2, end: 0.8 },
          { text: 'reaches', start: 0.8, end: 1.2 },
          { text: 'the', start: 1.2, end: 1.3 },
          { text: 'worker.', start: 1.3, end: 2 },
        ],
        timing: 'syllable-fallback' as const,
      }],
    },
  };
  const doc = {
    package: pkg,
    editor: { version: 1 as const, captionOverrides: [{ sceneId: 's1', index: 0, text: 'Corrected display line.' }] },
  };
  const timeline = compileBrowser(doc, measured);

  assert.equal(timeline.captions[0]!.text, 'Corrected display line.');
  assert.equal(timeline.captions[0]!.timing, 'syllable-fallback');
  const cue = timeline.scenes[0]!.motionCues![0]!;
  assert.equal(cue.phrase, 'reaches the worker');
  assert.equal(cue.frame, 24);
  assert.equal(cue.seconds, 0.8);
  assert.equal(cue.source, 'word-cues');
  assert.equal(cue.estimated, true);
  assert.equal(cue.timing, 'syllable-fallback');
  assert.equal(timeline.motionCueDiagnostics![0]!.code, 'MOTION_CUE_ESTIMATED');
  assert.equal(timeline.scenes[0]!.narration, 'The request reaches the worker.');
});
