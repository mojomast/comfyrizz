import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePackageComposition } from '../src/composition-model.js';
import { resolveMediaSrc } from '../src/media-src.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const pkg = {
  format: { width: 1920, height: 1080, fps: 30 },
  voice: { enabled: true },
  scenes: [
    { id: 's1', layout: 'hero', preferredFrames: 90, narration: 'Hello there.', narration_asset: 'a_voice', transitionOut: { type: 'none', frames: 0 } },
  ],
  assets: { a_voice: { kind: 'audio', status: 'ready', file: 'audio/narration.wav' } },
};

test('measured narration and captions are the shared composition props', () => {
  const timeline = compileTimeline(pkg, { narration: { s1: [{ text: 'Hello there.', seconds: 1.1 }] } });
  const resolved = resolvePackageComposition(pkg, timeline);
  assert.equal(resolved.narration.file, 'audio/narration.wav');
  assert.equal(resolved.narration.missing, false);
  assert.equal(resolved.captions[0].text, 'Hello there.');
  assert.equal(resolved.captions[0].estimated, false);
  assert.equal(Number.isInteger(resolved.captions[0].from), true);
});

test('estimated captions are not burned in, and a missing file is flagged', () => {
  const timeline = compileTimeline(pkg, {});
  const resolved = resolvePackageComposition(pkg, timeline, { missingMedia: ['audio/narration.wav'] });
  assert.equal(resolved.captions, null);
  assert.equal(resolved.narration.missing, true);
});

test('export media urls do not carry a session token', () => {
  assert.equal(resolveMediaSrc('audio/narration.wav', null, file => `static:${file}`), 'static:audio/narration.wav');
  const preview = resolveMediaSrc('audio/narration.wav', { packageId: 'pkg_demo', token: 'local-session-token' }, () => 'static');
  assert.match(preview, /^\/api\/package\/pkg_demo\/media\?/);
  assert.match(preview, /path=audio%2Fnarration\.wav/);
  assert.match(preview, /token=local-session-token/);
});
