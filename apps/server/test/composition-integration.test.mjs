import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExporter, compositionRenderFingerprint } from '../src/export.mjs';
import { stagePipelineInputs } from '../src/pipeline-media.mjs';
import { loadCompositionManifest } from '../../../packages/compositions/src/index.mjs';
import { collectMockContribution, recordMockRender } from './helpers/comfy-contribution.mjs';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'composition-integration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  cpSync(new URL('../../../examples/composition-stories/', import.meta.url), source, { recursive: true });
  const packagePath = join(source, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath));
  pkg.scenes.unshift({ id: 's_mock_plate', layout: 'title', copy: { headline: 'Editorial context' }, preferredFrames: 90 });
  collectMockContribution(pkg, source);
  writeFileSync(packagePath, JSON.stringify(pkg));
  return { root, source, packagePath, pkg };
}

test('isolated pipeline snapshot and exported ZIP preserve editable composition source', async t => {
  const { root, source, packagePath, pkg } = project(t);
  const original = readFileSync(packagePath);
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(source, 'private-token'), 'not-a-project-input');
  await stagePipelineInputs(pkg, source, work);
  assert.deepEqual(loadCompositionManifest(work, pkg), loadCompositionManifest(source, pkg));
  assert.equal(existsSync(join(work, 'private-token')), false);
  const exporter = createExporter({ exportsDir: join(root, 'exports'), materialize: async ({ pkg }) => ({ pkg }), render: async (path, output) => {
    assert.notEqual(path, packagePath);
    assert.deepEqual(JSON.parse(readFileSync(path)), pkg);
    writeFileSync(output, 'test video');
    return { frames: 480 };
  } });
  const result = await exporter({ pkg, packagePath });
  const extract = join(root, 'extracted');
  mkdirSync(extract);
  execFileSync('unzip', ['-q', join(result.dir, 'package.zip'), '-d', extract]);
  const restored = JSON.parse(readFileSync(join(extract, 'package.json')));
  assert.deepEqual(loadCompositionManifest(extract, restored), loadCompositionManifest(source, pkg));
  assert.deepEqual(readFileSync(packagePath), original);
});

test('composition export reuse follows source, media sidecar, removal, readdition and video integrity', async t => {
  const { root, source, packagePath, pkg } = project(t);
  let renders = 0;
  const exporter = createExporter({ exportsDir: join(root, 'exports'), materialize: async ({ pkg }) => ({ pkg }), render: async (_path, output) => {
    writeFileSync(output, `test video ${++renders}`);
    return { frames: 480 };
  } });
  const run = () => exporter({ pkg, packagePath });
  let result = await run();
  assert.equal(result.reused, false);
  assert.equal((await run()).reused, true);
  const manifestPath = join(source, 'compositions/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.scenes[0].params.resultLabel = 'New assignment result';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal((await run()).reused, false);
  writeFileSync(join(source, 'media.json'), JSON.stringify({ lowerThird: { s_transfer: { text: 'An editorial label' } } }));
  assert.equal((await run()).reused, false);
  writeFileSync(join(result.dir, 'video.mp4'), 'tampered video');
  assert.equal((await run()).reused, false);
  rmSync(manifestPath);
  assert.equal((await run()).reused, false, 'removing a manifest invalidates the previously composed video');
  assert.equal(existsSync(join(result.dir, 'composition-video.json')), false);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal((await run()).reused, false);
  assert.equal(renders, 6);
});

test('verified pipeline video may be reused only with its exact bytes', async t => {
  const { root, source, packagePath, pkg } = project(t);
  const exportsDir = join(root, 'exports');
  const dir = join(exportsDir, pkg.id);
  mkdirSync(dir, { recursive: true });
  const video = Buffer.from('verified current run');
  writeFileSync(join(dir, 'video.mp4'), video);
  recordMockRender(pkg, source, join(dir, 'video.mp4'));
  const exporter = createExporter({ exportsDir, materialize: async ({ pkg }) => ({ pkg }), render: () => { throw new Error('unexpected render'); } });
  const result = await exporter({ pkg, packagePath, verifiedVideoSha256: createHash('sha256').update(video).digest('hex') });
  assert.equal(result.reused, true);
  writeFileSync(join(dir, 'video.mp4'), 'different bytes');
  await assert.rejects(exporter({ pkg, packagePath, verifiedVideoSha256: createHash('sha256').update(video).digest('hex') }), /unexpected render/);
});

test('render fingerprint tracks actual declared asset bytes instead of trusting stale metadata', async t => {
  const { source, pkg } = project(t);
  mkdirSync(join(source, 'assets'), { recursive: true });
  writeFileSync(join(source, 'assets/picture.png'), 'original bytes');
  pkg.assets.a_picture = { file: 'assets/picture.png', sha256: 'unchanged-declaration' };
  const options = { pkg, timeline: {}, sources: [], packageDir: source };
  const before = await compositionRenderFingerprint(options);
  writeFileSync(join(source, 'assets/picture.png'), 'replacement bytes');
  assert.notEqual(await compositionRenderFingerprint(options), before);
});
