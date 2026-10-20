import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { loadCompositionManifest } from '../../../packages/compositions/src/index.mjs';
import { renderPackageIncremental } from '../scripts/render-incremental.mjs';

const source = new URL('../../../examples/composition-stories/', import.meta.url);

test('composition incremental requests always use full preparation, never cached segments', t => {
  const dir = mkdtempSync('/tmp/opencode/composition-incremental-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(new URL('package.json', source)));
  const manifest = JSON.parse(readFileSync(new URL('compositions/manifest.json', source)));
  const path = join(dir, 'package.json');
  const cacheDir = join(dir, 'cache');
  mkdirSync(join(dir, 'compositions'));
  mkdirSync(cacheDir);
  writeFileSync(path, JSON.stringify(pkg));
  const manifestPath = join(dir, 'compositions/manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  // Neither a stale committed timeline nor an old segment may bypass full preparation.
  writeFileSync(join(dir, 'timeline.json'), 'invalid stale timeline');
  writeFileSync(join(cacheDir, 'old.mp4'), 'old segment');
  const logs = [], titles = [];
  const controller = new AbortController();
  const renderFull = (input, output, options) => {
    assert.equal(input, path);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.mixAudio, false);
    titles.push(loadCompositionManifest(dir, pkg).scenes[0].params.title);
    writeFileSync(output, titles.at(-1));
    const timeline = compileTimeline(pkg);
    return { output, frames: timeline.durationInFrames, bytes: 1, hash: timeline.hash, timeline, package: pkg };
  };
  const options = { cacheDir, renderFull, signal: controller.signal, mixAudio: false,
    onLog: line => logs.push(line), renderSegment: () => assert.fail('must not render incremental segments') };
  const first = renderPackageIncremental(path, join(dir, 'first.mp4'), options);
  manifest.scenes[0].params.title = 'A source-only edit';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const second = renderPackageIncremental(path, join(dir, 'second.mp4'), options);
  assert.deepEqual(titles, ['A receipt finds its project', 'A source-only edit']);
  for (const result of [first, second]) {
    assert.equal(result.full, true);
    assert.match(result.reason, /compositions.*full render/);
    assert.equal(result.timelineHash, result.hash);
    assert.deepEqual(result.reused, []);
    assert.equal(result.segments.length, pkg.scenes.length);
    assert.deepEqual(result.rendered, result.segments.map(segment => segment.key));
    assert.equal(result.segments.reduce((sum, segment) => sum + segment.frames, 0), result.frames);
  }
  assert.deepEqual(readdirSync(cacheDir), ['old.mp4'], 'fallback never reads or populates segment cache');
  assert.equal(logs.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(path)), pkg, 'saved source stays editable');
});

test('invalid composition manifests fail instead of silently rendering the procedural fallback', t => {
  const dir = mkdtempSync('/tmp/opencode/composition-incremental-invalid-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(new URL('package.json', source)));
  mkdirSync(join(dir, 'compositions'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'compositions/manifest.json'), '{"version":99,"scenes":[]}');
  assert.throws(() => renderPackageIncremental(join(dir, 'package.json'), join(dir, 'out.mp4'), {
    renderFull: () => assert.fail('invalid manifest must fail before rendering'),
  }), /manifest.version/);
});
