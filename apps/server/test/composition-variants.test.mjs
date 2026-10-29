import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExporter } from '../src/export.mjs';
import { buildVariants } from '../src/variant.mjs';
import { loadCompositionManifest } from '../../../packages/compositions/src/index.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';

const example = new URL('../../../examples/composition-stories/', import.meta.url);

function tree(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry =>
    entry.isDirectory() ? tree(join(dir, entry.name)).map(([name, bytes]) => [`${entry.name}/${name}`, bytes])
      : [[entry.name, readFileSync(join(dir, entry.name)).toString('base64')]]);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'composition-variants-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const exportsDir = join(root, 'exports');
  mkdirSync(sourceDir);
  const pkg = JSON.parse(readFileSync(new URL('package.json', example)));
  pkg.scenes.unshift({ id: 's_mock_plate', layout: 'title', copy: { headline: 'Editorial context' }, preferredFrames: 90 });
  const manifest = JSON.parse(readFileSync(new URL('compositions/manifest.json', example)));
  const asset = Buffer.from('original image bytes');
  pkg.assets.a_original = { kind: 'image', origin: 'upload', status: 'ready', file: 'assets/original.png',
    sha256: createHash('sha256').update(asset).digest('hex'), license: { id: 'CC0-1.0' }, redistributable: true };
  mkdirSync(join(sourceDir, 'assets'));
  writeFileSync(join(sourceDir, 'assets/original.png'), asset);
  writeFileSync(join(sourceDir, 'media.json'), JSON.stringify({ lowerThird: { s_transfer: { text: 'Existing overlay' } } }));
  const manifestPath = join(sourceDir, 'compositions', pkg.id, 'manifest.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  const packagePath = join(sourceDir, 'package.json');
  const save = () => {
    collectMockContribution(pkg, sourceDir);
    writeFileSync(packagePath, JSON.stringify(pkg));
    writeFileSync(manifestPath, JSON.stringify(manifest));
  };
  save();
  const prepared = [], rendered = [], scratch = new Set();
  let renderFailure = false;
  const exporter = createExporter({ exportsDir,
    materialize: async ({ pkg: variant, packageDir, timeline }) => {
      assert.notEqual(packageDir, sourceDir);
      scratch.add(packageDir);
      const source = loadCompositionManifest(packageDir, variant);
      assert.ok(source, 'the variant must see a scoped manifest');
      assert.equal(readFileSync(join(packageDir, 'assets/original.png'), 'utf8'), asset.toString());
      assert.deepEqual(JSON.parse(readFileSync(join(packageDir, 'media.json'))), { lowerThird: { s_transfer: { text: 'Existing overlay' } } });
      assert.ok(existsSync(join(packageDir, 'compositions', variant.id, 'manifest.json')));
      assert.equal(timeline.width, variant.format.width);
      prepared.push({ pkg: variant, source });
      return { pkg: variant, report: {} };
    },
    render: async (path, output) => {
      rendered.push(path);
      if (renderFailure) throw new Error('deliberate variant render failure');
      const variant = JSON.parse(readFileSync(path));
      assert.ok(loadCompositionManifest(dirname(path), variant));
      writeFileSync(output, 'fake MP4');
      return { output, frames: 1, bytes: 8 };
    },
  });
  const assertClean = () => {
    assert.deepEqual(existsSync(exportsDir) ? readdirSync(exportsDir).filter(name => name.startsWith('.composition-variant-')) : [], []);
    for (const dir of scratch) assert.equal(existsSync(dir), false, 'staged inputs are removed');
  };
  return { root, sourceDir, pkg, manifest, packagePath, exporter, prepared, rendered, save, assertClean,
    failRender: () => { renderFailure = true; } };
}

test('scoped composition portrait export preserves the variant namespace through ZIP extraction', async t => {
  const h = fixture(t);
  const original = tree(h.sourceDir);
  const variant = buildVariants(h.pkg, { aspects: ['9:16'] })[0];
  const result = await h.exporter.variants({ pkg: h.pkg, packagePath: h.packagePath, variants: [variant] });
  assert.equal(h.prepared.length, 1);
  assert.equal(h.prepared[0].pkg.format.width, 1080);
  assert.equal(h.prepared[0].pkg.format.height, 1920);
  assert.deepEqual(h.prepared[0].source, h.manifest);
  const zip = result.variants[0].result.files.find(file => file.name === 'package.zip').path;
  const extracted = join(h.root, 'extracted');
  mkdirSync(extracted);
  execFileSync('unzip', ['-q', zip, '-d', extracted]);
  const pkg = JSON.parse(readFileSync(join(extracted, 'package.json')));
  assert.equal(pkg.id, variant.package.id);
  assert.deepEqual(loadCompositionManifest(extracted, pkg), h.manifest);
  assert.ok(existsSync(join(extracted, 'compositions', pkg.id, 'manifest.json')));
  assert.equal(readFileSync(join(extracted, 'assets/original.png'), 'utf8'), 'original image bytes');
  assert.deepEqual(tree(h.sourceDir), original);
  h.assertClean();
});

test('composition cutdown exports retain only entries for surviving scenes', async t => {
  const h = fixture(t);
  const original = tree(h.sourceDir);
  const variant = buildVariants(h.pkg, { aspects: ['9:16'], durations: [6] })[0];
  assert.ok(variant.package.scenes.length < h.pkg.scenes.length, 'real cutdown removes scenes');
  const result = await h.exporter.variants({ pkg: h.pkg, packagePath: h.packagePath, variants: [variant] });
  const ids = variant.package.scenes.filter(scene => scene.composition).map(scene => scene.id);
  assert.deepEqual(h.prepared[0].source.scenes.map(entry => entry.sceneId), ids);
  const zip = result.variants[0].result.files.find(file => file.name === 'package.zip').path;
  const archived = JSON.parse(execFileSync('unzip', ['-p', zip, `compositions/${variant.package.id}/manifest.json`]));
  assert.deepEqual(archived.scenes.map(entry => entry.sceneId), ids);
  assert.deepEqual(tree(h.sourceDir), original);
  h.assertClean();
});

test('variant render failure cleans staging without changing original source', async t => {
  const h = fixture(t);
  const original = tree(h.sourceDir);
  h.failRender();
  await assert.rejects(h.exporter.variants({ pkg: h.pkg, packagePath: h.packagePath,
    variants: buildVariants(h.pkg, { aspects: ['9:16'] }) }), /deliberate variant render failure/);
  assert.equal(h.prepared.length, 1);
  assert.equal(h.rendered.length, 1);
  assert.deepEqual(tree(h.sourceDir), original);
  h.assertClean();
});

test('composition variants reject invalid IDs, missing data, unmatched phrases and unmeasured narration', async t => {
  for (const mode of ['id', 'data', 'phrase', 'narration']) await t.test(mode, async t => {
    const h = fixture(t);
    if (mode === 'phrase') {
      h.pkg.scenes[0].narration = 'A receipt arrives.';
      h.manifest.scenes[0].cues.action = { phrase: 'receipt arrives' };
      h.save();
    }
    const original = tree(h.sourceDir);
    const variant = buildVariants(h.pkg, { aspects: ['9:16'] })[0];
    const expected = {
      id: /Invalid composition variant package id/,
      data: /dataset d_review does not exist/,
      phrase: /no narration timing/,
      narration: /provide measured variant narration/,
    }[mode];
    if (mode === 'id') variant.package.id = '../outside';
    if (mode === 'data') delete variant.package.datasets.d_review;
    if (mode === 'phrase') variant.package.scenes[0].narration = 'The unrelated replacement line.';
    if (mode === 'narration') {
      variant.package.voice = { enabled: true, engine: 'kokoro' };
      variant.package.scenes[0].narration = 'A receipt finds its project.';
      variant.narration = {};
    }
    await assert.rejects(h.exporter.variants({ pkg: h.pkg, packagePath: h.packagePath, variants: [variant] }), expected);
    assert.equal(h.prepared.length, 0);
    assert.equal(h.rendered.length, 0);
    assert.deepEqual(tree(h.sourceDir), original);
    h.assertClean();
  });
});

test('ordinary variant exports render from an isolated delivery package', async t => {
  const h = fixture(t);
  rmSync(join(h.sourceDir, 'compositions'), { recursive: true });
  const original = tree(h.sourceDir);
  let renderedPath;
  const exporter = createExporter({ exportsDir: join(h.root, 'ordinary-exports'),
    materialize: () => assert.fail('ordinary variants must not materialize compositions'),
    render: (path, output) => {
      renderedPath = path;
      assert.notEqual(dirname(path), h.sourceDir);
      assert.equal(readFileSync(join(dirname(path), 'assets/original.png'), 'utf8'), 'original image bytes');
      writeFileSync(output, 'fake MP4');
      return { output, frames: 1, bytes: 8 };
    },
  });
  await exporter.variants({ pkg: h.pkg, packagePath: h.packagePath,
    variants: buildVariants(h.pkg, { aspects: ['9:16'] }) });
  assert.equal(existsSync(renderedPath), false, 'ordinary sidecar cleanup is preserved');
  assert.deepEqual(tree(h.sourceDir), original);
});
