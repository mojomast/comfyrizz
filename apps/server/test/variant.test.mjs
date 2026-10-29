// L1 acceptance: one export per language/aspect variant plus a variants.json
// manifest. The render is a fake that writes a stub MP4, so this is CPU-only and
// offline (no Google Colab runtime, no model, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExporter } from '../src/export.mjs';
import { buildVariants, variantPackageId, variantSlug } from '../src/variant.mjs';

const repo = new URL('../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(repo, 'examples', 'launch-demo', 'package.json'), 'utf8'));

const FRENCH = {
  s_title: { copy: { headline: 'Comfyrizz FR' }, narration: 'Bonjour le monde.' },
  s_list: { narration: 'Voici ce que fait le moteur.' },
};

function makeWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-l1-variant-'));
  const packageDir = join(dir, 'package');
  mkdirSync(packageDir, { recursive: true });
  cpSync(join(repo, 'examples', 'launch-demo', 'assets'), join(packageDir, 'assets'), { recursive: true });
  const pkg = structuredClone(seed);
  collectMockContribution(pkg, packageDir);
  pkg.scenes[0].narration = 'Comfyrizz turns a brief into a video.';
  pkg.scenes[4].narration = 'Here is what the CPU slice does.';
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return { dir, packageDir, pkg, packagePath: join(packageDir, 'package.json') };
}

function fakeRender(calls) {
  return async (packagePath, outputPath) => {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    calls.push({ id: pkg.id, width: pkg.format.width, height: pkg.format.height, outputPath });
    writeFileSync(outputPath, Buffer.from(`stub:${pkg.id}`));
    return { output: outputPath, frames: pkg.scenes.length, hash: `hash-${pkg.id}`, bytes: 5 };
  };
}

test('L1: buildVariants makes every language/aspect pair and keeps the base id', () => {
  const work = makeWorkdir();
  try {
    const variants = buildVariants(work.pkg, { languages: ['en', 'fr'], aspects: ['16:9', '9:16'], translations: { fr: FRENCH } });
    assert.deepEqual(variants.map(v => v.slug), ['en-16x9', 'en-9x16', 'fr-16x9', 'fr-9x16']);
    const base = variants[0];
    assert.equal(base.isBase, true);
    assert.equal(base.package.id, work.pkg.id);
    assert.equal(base.narration, undefined);
    const fr = variants.find(v => v.slug === 'fr-16x9');
    assert.equal(fr.package.id, variantPackageId(work.pkg.id, { language: 'fr', aspect: '16:9' }));
    assert.equal(fr.package.voice.language, 'fr-fr');
    assert.equal(fr.package.scenes[0].copy.headline, 'Comfyrizz FR');
    assert.equal(fr.package.scenes[0].narration, 'Bonjour le monde.');
    assert.deepEqual(fr.narration, {}, 'a language variant re-estimates captions');
    const vertical = variants.find(v => v.slug === 'en-9x16');
    assert.equal(vertical.package.format.width, 1080);
    assert.equal(vertical.package.format.height, 1920);
    assert.deepEqual(vertical.package.assets, work.pkg.assets, 're-layout never crops assets');
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
});

test('L1: draft variant bundles preserve translated captions while final delivery requires regenerated narration', async () => {
  const work = makeWorkdir();
  const exportsDir = join(work.dir, 'out', 'export');
  const calls = [];
  try {
    const exporter = createExporter({ exportsDir, render: fakeRender(calls) });
    const variants = buildVariants(work.pkg, { languages: ['en', 'fr'], aspects: ['16:9', '9:16'], translations: { fr: FRENCH } });
    await assert.rejects(exporter.variants({ pkg: work.pkg, packagePath: work.packagePath, variants }), { code: 'NARRATION_PENDING' });
    const result = await exporter.variants({ pkg: work.pkg, packagePath: work.packagePath, variants, intent: 'draft' });

    // Every variant has its own complete bundle.
    assert.equal(result.manifest.variants.length, 4);
    for (const entry of result.manifest.variants) {
      assert.deepEqual(entry.files, ['video.mp4', 'captions.srt', 'captions.vtt', 'CREDITS.md', 'package.zip']);
      for (const name of entry.files) {
        assert.ok(existsSync(join(entry.dir, name)), `${entry.slug} is missing ${name}`);
      }
    }

    // The manifest records language, aspect and frame size per variant.
    const base = result.manifest.variants.find(v => v.slug === 'en-16x9');
    assert.equal(base.isBase, true);
    assert.deepEqual(base.format, { width: 1920, height: 1080 });
    const frVertical = result.manifest.variants.find(v => v.slug === 'fr-9x16');
    assert.equal(frVertical.language, 'fr');
    assert.equal(frVertical.aspect, '9:16');
    assert.deepEqual(frVertical.format, { width: 1080, height: 1920 });
    assert.equal(frVertical.id, `${work.pkg.id}-fr-9x16`);

    assert.ok(existsSync(result.manifestPath));
    assert.equal(result.manifestPath, join(exportsDir, work.pkg.id, 'variants.json'));
    assert.equal(JSON.parse(readFileSync(result.manifestPath, 'utf8')).variants.length, 4);

    // The fake render saw the re-laid-out size for the portrait variants.
    const rendered = Object.fromEntries(calls.map(call => [call.id, call]));
    assert.equal(rendered[`${work.pkg.id}-en-9x16`].height, 1920);
    assert.equal(rendered[`${work.pkg.id}-fr-9x16`].width, 1080);

    // The French captions come from the translated narration, not the English source.
    const srt = readFileSync(join(frVertical.dir, 'captions.srt'), 'utf8');
    assert.match(srt, /Bonjour le monde/);
    assert.doesNotMatch(srt, /Comfyrizz turns a brief into a video/);

    // Sidecar variant packages are cleaned up after the export.
    const leftovers = readdirSync(work.packageDir).filter(name => name.endsWith('.variant.json'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
});

test('L1: variantSlug and variantPackageId are stable and the base keeps its id', () => {
  assert.equal(variantSlug({ language: 'fr', aspect: '9:16' }), 'fr-9x16');
  assert.equal(variantSlug({}), 'en-16x9');
  assert.equal(variantPackageId('pkg_demo000001', { language: 'en', aspect: '16:9' }), 'pkg_demo000001');
  assert.equal(variantPackageId('pkg_demo000001', { language: '1', aspect: '1:1' }), 'pkg_demo000001-1-1x1');
});
