import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileTimeline as compileNode, sha256Hex } from '../src/index.js';
import { compileTimeline as compileBrowser, compileInputHash, frameProjection, normalizeMeasured } from '../src/browser.js';
import type { ComfyrizzPackage } from '../src/index.js';

test('sha256 matches node crypto', () => {
  for (const value of ['', 'abc', '{"a":1}', 'café']) {
    assert.equal(sha256Hex(value), createHash('sha256').update(value).digest('hex'));
  }
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
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
