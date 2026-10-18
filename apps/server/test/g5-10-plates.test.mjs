// G5-10: completeRun must copy every file the applied package names, not only `assets/`.
//
// GPU test 5 planned non-upscaled plates as `out/intermediates/<id>.plate.mp4`; the runner wrote
// them under the run's output dir but completeRun copied only `<outputDir>/assets`, so the
// renderer warned "media not in this clone" and drew placeholders. This test drives a whole run
// through a fake backend (no Google Colab, no spend) and asserts the plate lands in the package.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.mjs';
import { copyNamedAssets, isInside, namedAssetFiles } from '../src/run-assets.mjs';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';

const TOKEN = 'g5-10-token-0123456789abcdef';
const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A valid one-scene package that names one non-upscaled plate under out/intermediates/. */
function seedPackage() {
  const base = JSON.parse(readFileSync(join(repoRoot, 'examples', 'launch-demo', 'package.json'), 'utf8'));
  const scene = structuredClone(base.scenes.find((entry) => entry.id === 's_chart'));
  return {
    ...base,
    id: 'pkg_g510000000001',
    revision: 1,
    title: 'G5-10 plate copy',
    scenes: [scene],
    assets: {},
    compliance: { ...base.compliance, warnings: ['G5-10 fixture; the plate is a fake collected file.'] },
  };
}

function videoAsset() {
  return {
    kind: 'video',
    origin: 'generated',
    status: 'ready',
    file: 'out/intermediates/a_x.plate.mp4',
    sha256: 'a'.repeat(64),
    bytes: 11,
    license: { id: 'CC0-1.0' },
    model_license: { id: 'LTX-Video-Open-Weights', url: 'https://huggingface.co/Lightricks/LTX-Video' },
    redistributable: true,
    gen: { generator: 'ltx25' },
    media: { width: 64, height: 64, fps: 24, frames: 48 },
  };
}

const PLATE_BYTES = Buffer.from('plate-bytes');

/** Fake BYO backend: writes the plate under the run output dir, then returns an applied package. */
function fakeBackend() {
  return {
    id: 'byo-comfyui',
    describe: async () => ({ id: 'byo-comfyui', label: 'BYO ComfyUI', costVisibility: 'external' }),
    runPackage: async (pkg, opts = {}) => {
      if (opts.dryRun) return { jobsDoc: { jobs: [{ id: 'a_x.plate.job' }] }, estimate: { gpuMinutes: 0, overheadMinutes: 0 } };
      const plateDir = join(opts.outDir, 'out', 'intermediates');
      mkdirSync(plateDir, { recursive: true });
      writeFileSync(join(plateDir, 'a_x.plate.mp4'), PLATE_BYTES);
      const applied = structuredClone(pkg);
      applied.assets = { a_x_plate: videoAsset() };
      applied.scenes = applied.scenes.map((scene) => ({ ...scene, foreground: [{ asset: 'a_x_plate', x: 0.5, y: 0.5, w: 0.6, anim: 'fade-in' }] }));
      return {
        ok: true,
        package: applied,
        manifest: { complete: true },
        counts: { succeeded: 1 },
        applied: [{ asset: 'a_x_plate', status: 'succeeded', file: 'out/intermediates/a_x.plate.mp4' }],
        teardown: { state: 'stopped' },
      };
    },
  };
}

test('G5-10: completeRun copies a non-upscaled plate the applied package names', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-g510-'));
  scratch.push(runtime);
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    backendFactory: async () => fakeBackend(),
    render: async () => ({ output: 'g510.mp4', bytes: 1, frames: 1, hash: 'g510' }),
  });
  const pkg = seedPackage();
  app.store.seed(pkg);
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const started = await httpJson(server, 'POST', '/api/run', { backendId: 'byo-comfyui', packageId: pkg.id, budgetUnits: 0 });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const finished = await app.runs.wait(started.json.runId);
    assert.equal(finished.status, 'done');

    const packageDir = dirname(app.store.path(pkg.id));
    const plate = join(packageDir, 'out', 'intermediates', 'a_x.plate.mp4');
    assert.ok(existsSync(plate), 'the plate the package names was copied into the package dir');
    assert.deepEqual(readFileSync(plate), PLATE_BYTES, 'the copied plate is byte-for-byte the collected file');
    assert.ok(app.store.read(pkg.id).assets.a_x_plate, `the applied package was saved (renderError: ${finished.renderError})`);
    assert.equal(app.store.read(pkg.id).assets.a_x_plate.file, 'out/intermediates/a_x.plate.mp4');
  } finally {
    await new Promise((done) => server.close(done));
    app.close();
  }
});

test('G5-10: namedAssetFiles lists asset and variant files without duplicates', () => {
  const pkg = {
    assets: {
      a_one: { file: 'assets/a_one.png', variants: { upscaled: { file: 'assets/a_one@2x.png' } } },
      a_two: { file: 'assets/a_one.png' },
      a_three: { variants: { upscaled: { file: 'assets/a_three@2x.png' } } },
      a_empty: {},
    },
  };
  assert.deepEqual(namedAssetFiles(pkg).sort(), ['assets/a_one.png', 'assets/a_one@2x.png', 'assets/a_three@2x.png']);
});

test('G5-10: copyNamedAssets skips missing files and paths that escape the output dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-g510-copy-'));
  scratch.push(root);
  const outputDir = join(root, 'collected');
  const packageDir = join(root, 'package');
  mkdirSync(join(outputDir, 'out', 'intermediates'), { recursive: true });
  writeFileSync(join(outputDir, 'out', 'intermediates', 'a_ok.plate.mp4'), 'ok');
  writeFileSync(join(root, 'secret.txt'), 'secret');

  const copied = copyNamedAssets({
    pkg: { assets: { a_ok: { file: 'out/intermediates/a_ok.plate.mp4' }, a_escape: { file: '../secret.txt' }, a_missing: { file: 'out/intermediates/gone.mp4' } } },
    outputDir,
    packageDir,
  });
  assert.deepEqual(copied, ['out/intermediates/a_ok.plate.mp4']);
  assert.equal(readFileSync(join(packageDir, 'out', 'intermediates', 'a_ok.plate.mp4'), 'utf8'), 'ok');
  assert.equal(existsSync(join(root, 'secret.txt')), true, 'the source file is untouched');
  assert.equal(existsSync(join(packageDir, 'secret.txt')), false, 'the escaping path was not copied below the package dir');
});

test('W1: copyNamedAssets also copies the workflow sidecar next to a plate', () => {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-w1-copy-'));
  scratch.push(root);
  const outputDir = join(root, 'collected');
  const packageDir = join(root, 'package');
  mkdirSync(join(outputDir, 'out', 'intermediates'), { recursive: true });
  writeFileSync(join(outputDir, 'out', 'intermediates', 'a_ok.plate.mp4'), 'ok');
  writeFileSync(join(outputDir, 'out', 'intermediates', 'a_ok.plate.workflow.api.json'), '{"1":{"inputs":{"seed":1}}}');
  writeFileSync(join(outputDir, 'out', 'intermediates', 'a_ok.plate.workflow.md'), 'API format');
  const copied = copyNamedAssets({
    pkg: { assets: { a_ok: { file: 'out/intermediates/a_ok.plate.mp4' } } },
    outputDir,
    packageDir,
  });
  assert.deepEqual(copied, [
    'out/intermediates/a_ok.plate.mp4',
    'out/intermediates/a_ok.plate.workflow.api.json',
    'out/intermediates/a_ok.plate.workflow.md',
  ]);
  assert.equal(readFileSync(join(packageDir, 'out', 'intermediates', 'a_ok.plate.workflow.api.json'), 'utf8'), '{"1":{"inputs":{"seed":1}}}');
});

test('G5-10: isInside rejects absolute paths and .. escapes', () => {
  const root = join(tmpdir(), 'any-root');
  assert.equal(isInside(root, 'out/x.mp4'), true);
  assert.equal(isInside(root, '../x.mp4'), false);
  assert.equal(isInside(root, '/etc/passwd'), false);
  assert.equal(isInside(root, ''), false);
});

function httpJson(server, method, path, body) {
  const port = server.address().port;
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'x-comfyrizz-token': TOKEN,
          origin: `http://127.0.0.1:${port}`,
          host: `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolvePromise({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}
