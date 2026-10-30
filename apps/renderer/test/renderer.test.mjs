import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..');
const repoRoot = join(rendererDir, '..', '..');
const exampleDir = join(repoRoot, 'examples', 'launch-demo');

const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
const timeline = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));

test('the bundled example covers all 5 layouts in 6 scenes over 30-45 s', () => {
  assert.equal(timeline.scenes.length, 6);
  const layouts = new Set(timeline.scenes.map(scene => scene.layout));
  assert.deepEqual([...layouts].sort(), ['chart', 'hero', 'list', 'stat', 'title']);
  const seconds = timeline.durationInFrames / timeline.fps;
  assert.ok(seconds >= 30 && seconds <= 45, `duration ${seconds}s outside 30-45s`);
  assert.equal(timeline.width, 1920);
  assert.equal(timeline.height, 1080);
  assert.equal(timeline.fps, 30);
  assert.equal(timeline.provisional, false);
});

test('the example ships at least 4 generated llm-svg assets with matching hashes', () => {
  const entries = Object.entries(pkg.assets ?? {});
  const generated = entries.filter(([, asset]) => asset.gen?.generator === 'llm-svg');
  assert.ok(generated.length >= 4, `expected >=4 llm-svg assets, got ${generated.length}`);
  const kinds = new Set(generated.map(([, asset]) => asset.kind));
  for (const kind of ['svg', 'vector-anim']) assert.ok(kinds.has(kind), `missing kind ${kind}`);
  for (const [id, asset] of generated) {
    assert.equal(asset.origin, 'generated');
    assert.equal(asset.status, 'ready');
    assert.equal(asset.license.id, 'CC0-1.0');
    assert.equal(asset.redistributable, true);
    assert.equal(asset.gen.sanitizer_version, '1.0.0');
    assert.equal(asset.gen.render_check.ok, true);
    const file = readFileSync(join(exampleDir, asset.file), 'utf8');
    assert.equal(createHash('sha256').update(file).digest('hex'), asset.sha256, `${id} hash mismatch`);
    assert.equal(Buffer.byteLength(file), asset.bytes, `${id} byte count mismatch`);
    assert.doesNotMatch(file, /<script|onload=|foreignObject|https?:\/\/(?!www\.w3\.org)/i);
  }
});

test('compositions contain no network imports or calls', () => {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) files.push(path);
    }
  };
  walk(join(rendererDir, 'src'));
  walk(join(rendererDir, 'scripts'));
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} calls fetch()`);
    assert.doesNotMatch(source, /XMLHttpRequest|from ['"]https?:\/\//, `${file} has a network reference`);
    // www.w3.org is the SVG namespace, not a request target.
    // The same namespace is also escaped in RegExp constructor source strings.
    const urls = source.replaceAll('www\\\\.w3\\\\.org', 'www.w3.org');
    assert.doesNotMatch(urls, /https?:\/\/(?!www\.w3\.org)/, `${file} has an external URL`);
  }
});

test('the timeline is internally consistent (sum - overlaps)', () => {
  const sum = timeline.scenes.reduce((total, scene) => total + scene.durationInFrames, 0);
  const overlaps = timeline.scenes.slice(0, -1).reduce((total, scene) => total + scene.transitionOutFrames, 0);
  assert.equal(sum - overlaps, timeline.durationInFrames);
  let cursor = 0;
  for (const scene of timeline.scenes) {
    assert.equal(scene.from, cursor);
    cursor += scene.durationInFrames - scene.transitionOutFrames;
  }
  assert.equal(cursor, timeline.durationInFrames);
});

test('voice is off and every scene uses a procedural background', () => {
  assert.equal(pkg.voice.enabled, false);
  for (const scene of pkg.scenes) {
    assert.ok(scene.background?.procedural, `${scene.id} needs a procedural background`);
    assert.equal(scene.background.asset, undefined);
  }
});

test('the pinned render config forces limited-range yuv420p, not yuvj420p', () => {
  const config = readFileSync(join(rendererDir, 'remotion.config.ts'), 'utf8');
  assert.match(config, /setPixelFormat\('yuv420p'\)/, 'pixel format stays yuv420p');
  assert.match(config, /setColorSpace\('bt709'\)/, 'bt709 tags limited range, so ffprobe reports yuv420p not yuvj420p');
  assert.match(config, /setCodec\('h264'\)/);
  assert.match(config, /setDelayRenderTimeoutInMilliseconds\(120_000\)/, 'a loaded box needs more than the 30 s Chrome setup default');
});
