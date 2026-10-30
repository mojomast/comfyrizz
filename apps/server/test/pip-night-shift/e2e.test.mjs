import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMockContribution, approveMockContribution } from '../helpers/comfy-contribution.mjs';
import { writeStubSource } from '../helpers/stub-source.mjs';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEMO_CHAT_ID } from '../../src/seed-demo.mjs';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const examplesDir = join(repoRoot, 'examples');
const exampleDir = join(examplesDir, 'pip-night-shift');
const TOKEN = 'pip-night-shift-e2e-test-token';
const S3_CLIP_ID = 's3_juno:a_juno_plate';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const pkg = readJson(join(exampleDir, 'package.json'));
const takesDoc = readJson(join(exampleDir, 'takes.json'));
const editorDoc = readJson(join(exampleDir, 'editor.json'));

function ensureLibraries() {
  const planner = join(repoRoot, 'packages/planner/dist/src/index.js');
  const agent = join(repoRoot, 'packages/agent/dist/src/index.js');
  if (existsSync(planner) && existsSync(agent)) return;
  const build = spawnSync('pnpm', ['run', 'build:libs'], { cwd: repoRoot, encoding: 'utf8' });
  if (build.status !== 0) {
    throw new Error(`library build failed: ${build.stderr || build.stdout || build.error?.message || 'unknown error'}`);
  }
}

ensureLibraries();
const { createApp } = await import('../../src/app.mjs');
const { seedProjects } = await import('../../src/index.mjs');
const { finalGate } = await import('../../src/takes/gate.mjs');

function tempRuntime(t) {
  const directory = mkdtempSync(join(tmpdir(), 'comfyrizz-pn09-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function packageWithMedia(source, takes) {
  const next = clone(source);
  for (const [assetId, entry] of Object.entries(takes.clips)) {
    const take = entry.takes.find(candidate => candidate.takeId === entry.selected);
    if (!take) throw new Error(`${assetId} has no selected take`);
    const sceneId = take.gen?.inputs?.scene;
    const scene = next.scenes.find(candidate => candidate.id === sceneId);
    if (!scene) throw new Error(`${assetId} points at unknown scene ${sceneId}`);
    const extension = take.file.split('.').pop();
    scene.background = { asset: assetId };
    next.assets[assetId] = {
      kind: extension === 'png' ? 'image' : 'video',
      origin: 'generated',
      status: 'ready',
      file: `assets/${assetId}.${extension}`,
      sha256: take.sha256,
      bytes: take.bytes,
      media: clone(take.media),
      license: { id: 'CC0-1.0' },
      model_license: { id: 'LTX-2.x-Community', commercial_ok_if: 'revenue<10M' },
      redistributable: true,
      gen: clone(take.gen),
    };
  }
  return next;
}

function fakeBackend(state) {
  return {
    id: 'fake-local',
    async describe() {
      return { label: 'Fake local backend', costVisibility: 'external-unknown' };
    },
    async runPackage() {
      state.runs += 1;
      throw new Error('the CPU render must not start a backend run');
    },
  };
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
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, bytes, text, json });
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

test('PN09: first open with a verified mocked plate reaches the 4/5 gate, then approves s3 and renders on CPU', async t => {
  const runtimeDir = tempRuntime(t);
  const seeded = seedProjects({ runtimeDir, examplesDir, env: {}, generateMedia: false });
  assert.equal(seeded.pip.packageId, pkg.id);

  const packagePath = join(runtimeDir, 'packages', `${pkg.id}.json`);
  const fixture = packageWithMedia(pkg, takesDoc);
  collectMockContribution(fixture, join(runtimeDir, 'packages'));
  for (const id of Object.keys(takesDoc.clips)) writeStubSource(fixture, join(runtimeDir, 'packages'), id);
  writeFileSync(packagePath, `${JSON.stringify(fixture, null, 2)}\n`);

  const renderCalls = [];
  const renderBytes = Buffer.from('PN09 fake CPU render bytes');
  const backendState = { runs: 0 };
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    backendFactory: async () => fakeBackend(backendState),
    datasetFetch: async () => {
      throw new Error('the editor must not fetch over the network');
    },
    render: async (sourcePath, output) => {
      renderCalls.push({ packagePath: sourcePath, output });
      writeFileSync(output, renderBytes);
      return { output, bytes: renderBytes.length, frames: 4, hash: sha256(renderBytes) };
    },
  });
  t.after(() => app.close());
  approveMockContribution(app.takeStore, fixture, app.store.dir);

  await withServer(app, async ({ call }) => {
    const packageResponse = await call(`/api/package/${pkg.id}`);
    assert.equal(packageResponse.status, 200, packageResponse.text);
    assert.equal(packageResponse.json.package.id, pkg.id);
    assert.equal(packageResponse.json.package.title, "Pip's Night Shift");
    assert.equal(packageResponse.json.package.scenes.length, 4);
    assert.equal(packageResponse.json.revision, pkg.revision);
    assert.deepEqual(packageResponse.json.editor, editorDoc);

    const clipList = await call(`/api/package/${pkg.id}/clips`);
    assert.equal(clipList.status, 200, clipList.text);
    assert.equal(clipList.json.clips.length, 5);
    assert.equal(clipList.json.clips.filter(clip => clip.state === 'approved').length, 4);
    const juno = clipList.json.clips.find(clip => clip.clipId === S3_CLIP_ID);
    assert.equal(juno.takeCount, 2);
    assert.equal(juno.selectedN, 2);
    assert.equal(juno.state, 'review');

    const junoTakes = await call(`/api/package/${pkg.id}/clips/${encodeURIComponent(S3_CLIP_ID)}/takes`);
    assert.equal(junoTakes.status, 200, junoTakes.text);
    assert.equal(junoTakes.json.takes.length, 2);
    assert.deepEqual(junoTakes.json.takes.map(take => take.verdict), ['rejected', 'unreviewed']);
    assert.equal(junoTakes.json.selected, takesDoc.clips.a_juno_plate.selected);

    const references = await call(`/api/chat/${DEMO_CHAT_ID}/references`);
    assert.equal(references.status, 200, references.text);
    assert.equal(references.json.references.length, 2);
    assert.equal(references.json.assignments.length, 2);
    for (const reference of references.json.references) {
      assert.ok(reference.note.trim().length > 0, `${reference.id} keeps its note`);
    }

    const blocked = await call('/api/render', { packageId: pkg.id });
    assert.equal(blocked.status, 409, blocked.text);
    assert.equal(blocked.json.code, 'RENDER_GATE_BLOCKED');
    assert.equal(blocked.json.approved, 4);
    assert.equal(blocked.json.total, 5);
    assert.deepEqual(blocked.json.blocking, [{ clipId: S3_CLIP_ID, state: 'review' }]);
    assert.equal(renderCalls.length, 0);
    assert.equal(backendState.runs, 0);

    const approved = await call(`/api/package/${pkg.id}/clips/${encodeURIComponent(S3_CLIP_ID)}/verdict`, {
      verdict: 'approved',
      note: 'Juno is on-model and the slower entry works.',
    });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.json.clip.state, 'approved');
    assert.equal(approved.json.takeId, takesDoc.clips.a_juno_plate.selected);

    const gate = finalGate(app.store.read(pkg.id), app.takeStore.read(pkg.id));
    assert.deepEqual(
      { ok: gate.ok, approved: gate.approved, total: gate.total, blocking: gate.blocking },
      { ok: true, approved: 5, total: 5, blocking: [] },
    );

    const afterApproval = await call(`/api/package/${pkg.id}/clips`);
    assert.equal(afterApproval.status, 200, afterApproval.text);
    assert.equal(afterApproval.json.clips.filter(clip => clip.state === 'approved').length, 5);

    const rendered = await call('/api/render', { packageId: pkg.id });
    assert.equal(rendered.status, 200, rendered.text);
    assert.match(rendered.headers['content-type'], /^video\/mp4/);
    assert.match(rendered.headers['x-comfyrizz-render-id'], /^r_[a-f0-9]{12}$/);
    assert.deepEqual(rendered.bytes, renderBytes);
    assert.equal(renderCalls.length, 1);
    assert.notEqual(renderCalls[0].packagePath, packagePath, 'render uses frozen source staging');
    assert.equal(existsSync(renderCalls[0].packagePath), false, 'staging is cleaned up');
    assert.equal(backendState.runs, 0, 'the CPU render never touched the fake backend');
  });
});

test('PN09: every seeded artifact comes from the local example tree', async t => {
  const runtimeDir = tempRuntime(t);
  const seeded = seedProjects({ runtimeDir, examplesDir, env: {}, generateMedia: false });
  assert.equal(seeded.packageIds[0], pkg.id);
  assert.equal(seeded.packageIds.length, 2);
  assert.equal(existsSync(join(runtimeDir, 'packages', `${pkg.id}.json`)), true);
  assert.equal(existsSync(join(runtimeDir, 'takes', `${pkg.id}.json`)), true);
  assert.equal(existsSync(join(runtimeDir, 'editor', `${pkg.id}.json`)), true);
  assert.equal(existsSync(join(runtimeDir, 'references', DEMO_CHAT_ID, 'refs.json')), true);
  const text = JSON.stringify(seeded);
  for (const pattern of [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    /sk-[A-Za-z0-9_-]{6,}/,
    /secret[_-]?key\s*[:=]/i,
  ]) {
    assert.equal(pattern.test(text), false);
  }
});
