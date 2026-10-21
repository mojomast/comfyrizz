// TR18: the whole take loop through createApp, a loopback HTTP server and a fake backend.
// Nothing here needs a network, a GPU, a colab CLI or the renderer: the fake backend writes
// a media stub plus a manifest, and the render spy writes a stub MP4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/app.mjs';
import { takesPath } from '../../src/takes/store.mjs';

const TOKEN = 'tr18-test-token-0123456789abcdef';
const FIXTURE_PATH = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const ASSET_ID = 'a_plate1';
const CLIP_ID = `s1:${ASSET_ID}`;
const JOB_ID = `${ASSET_ID}.plate`;
const OUTPUT_REL = `assets/${ASSET_ID}.mp4`;
const INITIAL_BYTES = Buffer.concat([Buffer.from('TR18 adopted initial plate'), Buffer.from([0, 1, 2, 3])]);
const REGEN_BYTES = Buffer.concat([Buffer.from('TR18 corrected take'), Buffer.from([4, 5, 6, 7])]);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function fixturePackage() {
  const pkg = clone(FIXTURE);
  delete pkg.scenes.at(-1).transitionOut;
  return pkg;
}

function seedPackage(app, pkg) {
  const dir = dirname(app.store.path(pkg.id));
  const asset = pkg.assets[ASSET_ID];
  const target = join(dir, asset.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, INITIAL_BYTES);
  asset.sha256 = sha256(INITIAL_BYTES);
  asset.bytes = INITIAL_BYTES.length;
  app.store.seed(pkg);
  return dir;
}

function fakeBackend(id, state) {
  return {
    id,
    async describe() {
      return {
        label: id === 'colab' ? 'Fake Google Colab G4' : 'Fake BYO ComfyUI',
        costVisibility: id === 'colab' ? 'account-estimate' : 'external-unknown',
      };
    },
    async runPackage(pkg, opts = {}) {
      const asset = pkg.assets[ASSET_ID];
      const media = asset.media ?? {};
      const jobsDoc = {
        v: 1,
        jobs: [{
          id: JOB_ID,
          asset: ASSET_ID,
          kind: 'plate',
          generator: asset.gen?.generator ?? 'ltx25',
          workflow: asset.gen?.workflow,
          workflowSha256: asset.gen?.workflow_sha256,
          model: asset.gen?.model,
          backend: id === 'colab' ? 'colab:G4' : id,
          dims: { width: media.width ?? 1024, height: media.height ?? 576 },
          fps: media.fps ?? 24,
          frames: media.frames ?? 97,
        }],
      };
      const estimate = { gpuMinutes: 1, overheadMinutes: 0, ratePerHour: 8.9 };
      if (opts.dryRun) return { jobsDoc, estimate, dryRun: true, teardown: null };

      mkdirSync(join(opts.outDir, 'assets'), { recursive: true });
      writeFileSync(join(opts.outDir, OUTPUT_REL), REGEN_BYTES);
      state.runs += 1;

      const emit = opts.onEvent ?? (() => {});
      emit({ v: 1, event: 'job_start', job: JOB_ID });
      emit({ v: 1, event: 'job_done', job: JOB_ID, status: 'succeeded' });
      const manifest = {
        v: 1,
        complete: true,
        counts: { succeeded: 1 },
        updatedAt: '2026-10-21T12:00:00.000Z',
        jobs: [{
          job: JOB_ID,
          status: 'succeeded',
          job_id: 'job_tr18',
          attempt_id: 'att_tr18',
          outputs: [{ relative: OUTPUT_REL, sha256: sha256(REGEN_BYTES), bytes: REGEN_BYTES.length }],
        }],
      };
      return {
        jobsDoc,
        manifest,
        counts: { succeeded: 1 },
        ok: true,
        package: clone(pkg),
        applied: [],
        candidates: [],
        teardown: { state: 'stopped', evidence: 'fake teardown' },
      };
    },
  };
}

function makeApp(t) {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-tr18-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const renderCalls = [];
  const backendState = { runs: 0 };
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    backendFactory: async id => fakeBackend(id, backendState),
    render: async (packagePath, output) => {
      renderCalls.push({ packagePath, output });
      const bytes = Buffer.from('fake final mp4');
      writeFileSync(output, bytes);
      return { output, bytes: bytes.length, frames: 3, hash: 'tr18-render' };
    },
  });
  t.after(() => app.close());
  const pkg = fixturePackage();
  seedPackage(app, pkg);
  return { app, runtime, pkg, renderCalls, backendState };
}

function request(base, { method = 'GET', path = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const url = new URL(base);
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      method,
      headers: {
        host: url.host,
        origin: base,
        'x-comfyrizz-token': TOKEN,
        ...(payload === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        }),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withServer(app, fn) {
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({
      base,
      call: (path, body, method = body === undefined ? 'GET' : 'POST') => request(base, { method, path, body }),
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('TR18: adopted take, approved colab correction, gate and one final render', async t => {
  const { app, runtime, pkg, renderCalls, backendState } = makeApp(t);

  await withServer(app, async ({ call }) => {
    const clips = await call(`/api/package/${pkg.id}/clips`);
    assert.equal(clips.status, 200, clips.text);
    assert.equal(clips.json.clips.length, 1);
    const clip = clips.json.clips[0];
    assert.equal(clip.clipId, CLIP_ID);
    assert.equal(clip.assetId, ASSET_ID);
    assert.equal(clip.takeCount, 1);
    assert.equal(clip.selectedN, 1);
    assert.equal(clip.state, 'review');
    assert.equal(backendState.runs, 0, 'adopting the ready asset starts no backend run');

    const adopted = JSON.parse(readFileSync(takesPath(runtime, pkg.id), 'utf8'));
    const adoptedEntry = adopted.clips[ASSET_ID];
    const first = adoptedEntry.takes[0];
    assert.equal(adopted.schema, 'comfyrizz.takes/v1');
    assert.equal(adopted.packageId, pkg.id);
    assert.equal(adoptedEntry.selected, first.takeId);
    assert.equal(first.n, 1);
    assert.equal(first.assetId, ASSET_ID);
    assert.equal(first.correction.by, 'initial');
    assert.equal(first.verdict, 'unreviewed');
    assert.equal(first.sha256, sha256(INITIAL_BYTES));
    assert.deepEqual(readFileSync(join(runtime, 'packages', pkg.id, first.file)), INITIAL_BYTES);

    const before = app.store.read(pkg.id);
    const blockedBefore = await call('/api/render', { packageId: pkg.id, baseRevision: before.revision });
    assert.equal(blockedBefore.status, 409);
    assert.equal(blockedBefore.json.code, 'RENDER_GATE_BLOCKED');
    assert.equal(blockedBefore.json.approved, 0);
    assert.equal(blockedBefore.json.total, 1);
    assert.deepEqual(blockedBefore.json.blocking, [{ clipId: CLIP_ID, state: 'review' }]);
    assert.equal(renderCalls.length, 0, 'the gate runs before the renderer');

    const change = {
      note: 'slower push-in, keep the logo readable',
      by: 'user',
      promptAppend: 'clean negative space top-right for the logo',
      negativeAppend: 'busy background',
      seed: 'new',
    };
    const regenPath = `/api/package/${pkg.id}/clips/${encodeURIComponent(CLIP_ID)}/regenerate`;
    const approval = await call(regenPath, { change, backendId: 'colab', budgetUnits: 100 });
    assert.equal(approval.status, 200);
    assert.equal(approval.json.kind, 'approval_required');
    assert.equal(approval.json.approvalRequired, true);
    assert.match(approval.json.planHash, /^[0-9a-f]{64}$/);
    assert.ok(approval.json.diff.some(item => item.path === 'gen.inputs.prompt'));
    assert.ok(approval.json.diff.some(item => item.path === 'gen.inputs.negative'));
    assert.ok(approval.json.diff.some(item => item.path === 'gen.inputs.seed'));
    assert.equal(backendState.runs, 0, 'the Colab correction needs its own spend approval first');
    assert.equal(renderCalls.length, 0);

    const approved = await call('/api/run/approve', { planHash: approval.json.planHash });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.approved, true);

    const started = await call(regenPath, { change, backendId: 'colab', budgetUnits: 100, approved: true });
    assert.equal(started.status, 200);
    assert.equal(started.json.kind, 'started');
    assert.equal(started.json.planHash, approval.json.planHash);
    assert.equal(typeof started.json.runId, 'string');

    const finished = await app.runs.wait(started.json.runId);
    assert.equal(finished.status, 'done', finished.error ?? finished.renderError ?? finished.status);
    assert.equal(finished.mode, 'take');
    assert.equal(finished.render, null);
    assert.equal(backendState.runs, 1);
    assert.equal(renderCalls.length, 0, 'the second take lands without a full render');

    const doc = JSON.parse(readFileSync(takesPath(runtime, pkg.id), 'utf8'));
    const entry = doc.clips[ASSET_ID];
    assert.deepEqual(Object.keys(doc.clips), [ASSET_ID]);
    assert.equal(entry.takes.length, 2);
    assert.notEqual(entry.takes[0].takeId, entry.takes[1].takeId);
    assert.equal(entry.selected, entry.takes[1].takeId);
    const [firstTake, second] = entry.takes;
    assert.equal(second.n, 2);
    assert.equal(second.assetId, ASSET_ID);
    assert.equal(second.runId, started.json.runId);
    assert.equal(second.verdict, 'unreviewed');
    assert.equal(second.sha256, sha256(REGEN_BYTES));
    assert.equal(second.bytes, REGEN_BYTES.length);
    assert.equal(second.correction.note, change.note);
    assert.equal(second.correction.by, 'user');
    assert.equal(second.correction.promptAppend, change.promptAppend);
    assert.equal(second.correction.negativeAppend, change.negativeAppend);
    assert.equal(second.correction.seed, 'new');
    assert.ok(second.gen.inputs.prompt.endsWith(change.promptAppend));
    assert.ok(second.gen.inputs.negative.includes(change.negativeAppend));
    assert.notEqual(second.gen.inputs.seed, firstTake.gen.inputs.seed);

    const takeDir = join(runtime, 'packages', pkg.id, 'takes', ASSET_ID);
    const takeFiles = readdirSync(takeDir).sort();
    assert.deepEqual(takeFiles, [basename(firstTake.file), basename(second.file)].sort());
    assert.deepEqual(readFileSync(join(runtime, 'packages', pkg.id, firstTake.file)), INITIAL_BYTES);
    assert.deepEqual(readFileSync(join(runtime, 'packages', pkg.id, second.file)), REGEN_BYTES);

    const after = app.store.read(pkg.id);
    assert.equal(after.assets[ASSET_ID].file, second.file);
    assert.equal(after.assets[ASSET_ID].sha256, second.sha256);
    assert.equal(after.assets[ASSET_ID].bytes, second.bytes);
    assert.deepEqual(after.scenes, before.scenes);
    for (const [assetId, asset] of Object.entries(before.assets)) {
      if (assetId !== ASSET_ID) assert.deepEqual(after.assets[assetId], asset, `${assetId} was not touched`);
    }

    const blockedAfter = await call('/api/render', { packageId: pkg.id, baseRevision: after.revision });
    assert.equal(blockedAfter.status, 409);
    assert.equal(blockedAfter.json.code, 'RENDER_GATE_BLOCKED');
    assert.deepEqual(blockedAfter.json.blocking, [{ clipId: CLIP_ID, state: 'review' }]);
    assert.equal(renderCalls.length, 0);

    const selected = await call(`/api/package/${pkg.id}/clips/${encodeURIComponent(CLIP_ID)}/select`, { takeId: second.takeId });
    assert.equal(selected.status, 200);
    assert.equal(selected.json.takeId, second.takeId);

    const verdict = await call(`/api/package/${pkg.id}/clips/${encodeURIComponent(CLIP_ID)}/verdict`, {
      takeId: second.takeId,
      verdict: 'approved',
      note: 'logo stays readable',
    });
    assert.equal(verdict.status, 200);
    assert.equal(verdict.json.verdict, 'approved');
    assert.equal(verdict.json.clip.state, 'approved');

    const readiness = await call(`/api/package/${pkg.id}/clips`);
    assert.equal(readiness.json.clips.length, 1);
    assert.equal(readiness.json.clips[0].state, 'approved');

    const current = app.store.read(pkg.id);
    assert.equal(current.assets[ASSET_ID].file, second.file);
    assert.equal(current.assets[ASSET_ID].sha256, second.sha256);
    const rendered = await call('/api/render', { packageId: pkg.id, baseRevision: current.revision });
    assert.equal(rendered.status, 200);
    assert.equal(rendered.headers['content-type'], 'video/mp4');
    assert.equal(renderCalls.length, 1, 'the approved gate lets exactly one final render through');

    const renderedPackage = JSON.parse(readFileSync(renderCalls[0].packagePath, 'utf8'));
    assert.equal(renderedPackage.assets[ASSET_ID].file, second.file);
    assert.equal(renderedPackage.assets[ASSET_ID].sha256, second.sha256);
    assert.equal(renderedPackage.assets[ASSET_ID].bytes, second.bytes);
    assert.ok(existsSync(join(runtime, 'packages', pkg.id, second.file)));

    const blockedEvents = app.events.entries.filter(event => event.type === 'render.gate.blocked');
    assert.equal(blockedEvents.length, 2);
    assert.ok(app.events.entries.some(event => event.type === 'clip.take.landed' && event.runId === started.json.runId));
    assert.ok(app.events.entries.some(event => event.type === 'clip.verdict' && event.verdict === 'approved'));
    assert.equal(app.takeStore.read(pkg.id).overrides.length, 0);
  });
});
