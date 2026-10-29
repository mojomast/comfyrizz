// Contract tests only: injected render bytes and simulated ComfyUI collection.
// No GPU calls, and these fixtures are not evidence of actual model generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.mjs';
import { compilePackage } from '../src/compile-package.mjs';
import { canonicalJson } from '../../../packages/planner/dist/src/index.js';
import { contributionStore } from '../../../packages/jobs/src/model-contribution.mjs';
import { collectMockContribution, plannedContribution } from './helpers/comfy-contribution.mjs';

const TOKEN = 'legacy-receipt-test-0123456789';
const VIDEO = Buffer.from('mock renderer output: verified film');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));

function fixture() {
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));
  pkg.id = 'pkg_legacyreceipt0001';
  pkg.voice = { enabled: false, engine: 'none' };
  delete pkg.audio;
  pkg.scenes = [{ id: 's_receipt', layout: 'title', variant: 'centered', preferredFrames: 90,
    copy: { headline: 'Receipt-bound film' }, foreground: [] }];
  pkg.assets = {};
  plannedContribution(pkg);
  return pkg;
}

async function harness(t, { source = 'trusted', render, runtime = null } = {}) {
  const directory = runtime ?? mkdtempSync(join(tmpdir(), 'comfyrizz-legacy-receipt-'));
  if (!runtime) t.after(() => rmSync(directory, { recursive: true, force: true }));
  let renderCalls = 0;
  const app = createApp({ token: TOKEN, runtimeDir: directory,
    backendFactory: async id => ({ id, describe: async () => ({ costVisibility: 'external-unknown' }),
      async runPackage(pkg, opts) {
        const plan = { jobsDoc: { jobs: [{ id: 'a_mock_comfy.still' }] }, estimate: { gpuMinutes: 0, overheadMinutes: 0 } };
        if (opts.dryRun) return plan;
        const generated = structuredClone(pkg);
        if (source !== 'pending') {
          collectMockContribution(generated, opts.outDir);
          // Match production's non-upscaled collected-plate path, not just assets/.
          const asset = generated.assets.a_mock_comfy;
          const relative = 'out/intermediates/a_mock_comfy.plate.png';
          mkdirSync(dirname(join(opts.outDir, relative)), { recursive: true });
          renameSync(join(opts.outDir, asset.file), join(opts.outDir, relative));
          asset.file = relative;
          if (source === 'forged') {
            rmSync(contributionStore(opts.outDir), { recursive: true, force: true });
            // Editable package claims cannot substitute for the trusted ledger.
            asset.gen.backend = 'byo-comfyui';
          }
        }
        return { ...plan, ok: true, package: generated, manifest: { complete: true, jobs: [] }, teardown: { state: 'stopped' } };
      },
    }),
    render: async (packagePath, output, opts) => {
      renderCalls++;
      if (render) return render({ app, directory, packagePath, output, opts });
      const pkg = json(packagePath);
      const timeline = compilePackage(pkg, dirname(packagePath));
      writeFileSync(output, VIDEO);
      return { package: pkg, timeline, output, bytes: VIDEO.length, frames: timeline.durationInFrames, hash: timeline.hash };
    },
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    app.close();
    await new Promise(resolve => server.close(resolve));
  };
  t.after(close);
  return { app, directory, close, renderCalls: () => renderCalls,
    async start() {
      const pkg = app.store.write(fixture());
      const started = await app.runs.start({ backendId: 'byo-comfyui', pkg });
      return app.runs.wait(started.runId);
    },
    download: runId => fetch(`http://127.0.0.1:${server.address().port}/api/run/${runId}/video`, { headers: { 'x-comfyrizz-token': TOKEN } }),
  };
}

async function refused(h, runId) {
  const response = await h.download(runId);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'COMFY_RENDER_RECEIPT_REQUIRED');
}

test('legacy completion records exact render bytes and frozen inputs; download survives edits and restart', async t => {
  let stagedPath;
  const h = await harness(t, { render: async ({ app, directory, packagePath, output }) => {
    stagedPath = packagePath;
    assert.notEqual(packagePath, app.store.path(fixture().id));
    assert.equal(existsSync(output), false, 'render output is always fresh');
    assert.equal(existsSync(join(directory, '.comfy-provenance/renders')), false, 'no render proof before completion');
    const pkg = json(packagePath);
    const timeline = compilePackage(pkg, dirname(packagePath));
    const asset = pkg.assets.a_mock_comfy;
    assert.equal(sha(readFileSync(join(dirname(packagePath), asset.file))), asset.sha256);
    assert.ok(existsSync(join(directory, '.comfy-provenance', `${asset.sha256}.json`)), 'generation receipt copied out of run root');
    const current = app.store.read(pkg.id);
    app.store.save(pkg.id, { ...current, title: 'Owner edit during render' }, current.revision);
    writeFileSync(join(app.store.dir, asset.file), 'later source bytes');
    assert.equal(sha(readFileSync(join(dirname(packagePath), asset.file))), asset.sha256, 'render keeps the frozen source');
    writeFileSync(output, VIDEO);
    return { package: pkg, timeline, output, bytes: VIDEO.length, frames: timeline.durationInFrames, hash: timeline.hash };
  } });
  const finished = await h.start();
  assert.equal(finished.status, 'done', finished.renderError);
  assert.equal(h.renderCalls(), 1);
  assert.equal(existsSync(stagedPath), false, 'temporary inputs cleaned up');
  const input = json(join(h.directory, 'runs', finished.runId, 'render-input.json'));
  const receipt = json(join(h.directory, '.comfy-provenance/renders', `${sha(VIDEO)}.json`));
  assert.equal(receipt.packageHash, sha(canonicalJson(input.package)));
  assert.equal(receipt.timelineHash, input.timeline.hash);
  assert.equal(receipt.videoSha256, sha(VIDEO));
  assert.equal(receipt.contribution.ok, true);
  assert.equal(finished.render.package_sha256, receipt.packageHash);
  assert.equal(finished.render.video_sha256, receipt.videoSha256);
  assert.equal(finished.render.timeline_sha256, receipt.timelineHash);
  assert.notEqual(input.package.title, h.app.store.read(input.package.id).title);
  let response = await h.download(finished.runId);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), VIDEO);
  assert.match(response.headers.get('content-disposition'), /attachment/);

  await h.close();
  const resumed = await harness(t, { runtime: h.directory });
  assert.equal(resumed.app.runs.get(finished.runId), null, 'restart reads the durable record');
  response = await resumed.download(finished.runId);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), VIDEO);
  assert.equal(resumed.renderCalls(), 0, 'download never mints render evidence');
});

test('legacy download rejects video tampering, changed input package, mismatched timeline and missing receipt', async t => {
  const h = await harness(t);
  const finished = await h.start();
  assert.equal(finished.status, 'done', finished.renderError);
  const videoPath = join(h.directory, 'renders', `${finished.runId}.mp4`);
  const inputPath = join(h.directory, 'runs', finished.runId, 'render-input.json');
  const originalInput = readFileSync(inputPath);
  writeFileSync(videoPath, Buffer.alloc(VIDEO.length, 'x'));
  await refused(h, finished.runId);
  writeFileSync(videoPath, VIDEO);

  const changed = json(inputPath);
  changed.package.scenes[0].copy.headline = 'Unrelated package using the same model plate';
  writeFileSync(inputPath, JSON.stringify(changed));
  await refused(h, finished.runId);
  writeFileSync(inputPath, originalInput);
  const record = h.app.runs.runs.get(finished.runId);
  const originalHash = record.render.timeline_sha256;
  record.render.timeline_sha256 = 'a'.repeat(64);
  await refused(h, finished.runId);
  record.render.timeline_sha256 = originalHash;

  const receiptPath = join(h.directory, '.comfy-provenance/renders', `${sha(VIDEO)}.json`);
  rmSync(receiptPath);
  await refused(h, finished.runId);
  assert.equal(existsSync(receiptPath), false, 'download cannot retroactively certify a cached MP4');
  assert.equal(h.renderCalls(), 1);
});

test('restart refuses a legacy movie without receipt metadata even when generated sources are trusted', async t => {
  const h = await harness(t);
  const finished = await h.start();
  assert.equal(finished.status, 'done', finished.renderError);
  const statePath = join(h.directory, 'runs', finished.runId, 'state.json');
  const state = { runId: finished.runId, packageId: h.app.store.read(fixture().id).id, status: 'done' };
  state.render = { bytes: VIDEO.length, frames: finished.render.frames, timeline_sha256: finished.render.timeline_sha256, url: finished.render.url };
  writeFileSync(statePath, JSON.stringify(state));
  rmSync(join(h.directory, 'runs', finished.runId, 'render-input.json'));
  rmSync(join(h.directory, '.comfy-provenance/renders'), { recursive: true });
  await h.close();
  const resumed = await harness(t, { runtime: h.directory });
  await refused(resumed, finished.runId);
  assert.equal(existsSync(join(h.directory, '.comfy-provenance/renders')), false);
  assert.equal(resumed.renderCalls(), 0);
});

for (const source of ['pending', 'forged']) test(`legacy completion refuses ${source} model-output evidence`, async t => {
  const h = await harness(t, { source });
  const finished = await h.start();
  assert.equal(finished.status, 'failed');
  assert.match(finished.renderError, /visible, verified ComfyUI contribution/);
  assert.equal(finished.render, null);
  assert.equal(h.renderCalls(), 0);
  assert.equal(existsSync(join(h.directory, '.comfy-provenance/renders')), false);
});

for (const failure of ['throws', 'no-output']) test(`legacy ${failure} renderer cannot certify pre-existing movie bytes`, async t => {
  const h = await harness(t, { render: async ({ directory, output }) => {
    const runId = readdirSync(join(directory, 'runs')).find(name => name.startsWith('run_'));
    writeFileSync(join(directory, 'renders', `${runId}.mp4`), 'old unverified cached movie');
    if (failure === 'throws') {
      writeFileSync(output, VIDEO);
      throw new Error('render failed after partial output');
    }
    return { bytes: VIDEO.length, frames: 90, hash: 'a'.repeat(64) };
  } });
  const finished = await h.start();
  assert.equal(finished.status, 'failed');
  assert.equal(finished.render, null);
  assert.equal(existsSync(join(h.directory, '.comfy-provenance/renders')), false);
  assert.equal(readFileSync(join(h.directory, 'renders', `${finished.runId}.mp4`), 'utf8'), 'old unverified cached movie');
});
