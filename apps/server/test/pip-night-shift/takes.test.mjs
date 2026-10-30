import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMockContribution, approveMockContribution } from '../helpers/comfy-contribution.mjs';
import { writeStubSource } from '../helpers/stub-source.mjs';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TAKES_SCHEMA, deriveClipState, validateTakes } from '../../src/takes/model.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';
import { readEditor, validateEditor, writeEditor } from '../../src/editor-sidecar.mjs';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const exampleDir = new URL('../../../../examples/pip-night-shift/', import.meta.url);
const TOKEN = 'pip-night-shift-takes-test-token';
const CLIP_ASSETS = [
  ['s1_dawn', 'a_dawn_plate'],
  ['s2_counter', 'a_counter_plate'],
  ['s3_juno', 'a_juno_plate'],
  ['s4_outro', 'a_outro_still'],
];

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

const pkg = readJson(new URL('package.json', exampleDir));
const takesDoc = readJson(new URL('takes.json', exampleDir));
const editorDoc = readJson(new URL('editor.json', exampleDir));

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
const { finalGate } = await import('../../src/takes/gate.mjs');
const { listClips } = await import('../../src/takes/clips.mjs');
const { validatePackage } = await import('../../../../packages/schema/src/index.mjs');

function tempRuntime(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-pip-takes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function selectedTake(assetId) {
  const entry = takesDoc.clips[assetId];
  return entry.takes.find(take => take.takeId === entry.selected);
}

function packageWithMedia() {
  const fixture = clone(pkg);
  for (const [sceneId, assetId] of CLIP_ASSETS) {
    const scene = fixture.scenes.find(candidate => candidate.id === sceneId);
    const take = selectedTake(assetId);
    const extension = take.file.split('.').pop();
    scene.background = { asset: assetId };
    fixture.assets[assetId] = {
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
  return fixture;
}

function fakeBackend() {
  return {
    id: 'byo-comfyui',
    async describe() {
      return { label: 'fake BYO ComfyUI', costVisibility: 'external-unknown' };
    },
    async runPackage() {
      throw new Error('not used by the takes test');
    },
  };
}

async function withServer(app, fn) {
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, body) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, 'x-comfyrizz-token': TOKEN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    return await fn({ base, call });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('PN04: takes sidecar loads through takes/store and takes/model', (t) => {
  assert.equal(validateTakes(takesDoc).ok, true);
  assert.equal(takesDoc.schema, TAKES_SCHEMA);
  assert.equal(takesDoc.packageId, pkg.id);
  assert.deepEqual(Object.keys(takesDoc.clips), CLIP_ASSETS.map(([, assetId]) => assetId));
  assert.deepEqual(takesDoc.overrides, []);
  for (const [assetId, entry] of Object.entries(takesDoc.clips)) {
    for (const take of entry.takes) {
      assert.equal(take.takeId, `tk_${take.sha256.slice(0, 12)}`);
      assert.equal(take.assetId, assetId);
      assert.equal(take.file, `takes/${assetId}/${take.takeId}.${take.file.split('.').pop()}`);
    }
  }

  const runtimeDir = tempRuntime(t);
  const store = createTakeStore({ runtimeDir, packageDir: join(runtimeDir, 'packages') });
  store.write(pkg.id, takesDoc);

  const loaded = store.read(pkg.id);
  assert.deepEqual(loaded, takesDoc);
  assert.equal(validateTakes(loaded).ok, true);
  assert.equal(store.path(pkg.id), join(runtimeDir, 'takes', `${pkg.id}.json`));
});

test('PN04: s3 take 1 is rejected with Juno correction and take 2 awaits approval', () => {
  const entry = takesDoc.clips.a_juno_plate;
  assert.equal(entry.takes.length, 2);
  const [first, second] = entry.takes;

  assert.equal(first.n, 1);
  assert.equal(first.verdict, 'rejected');
  assert.equal(first.correction.by, 'user');
  assert.equal(first.correction.note, "keep Juno's yellow jacket and helmet, slower entry");
  assert.equal(first.correction.diff[0].path, '/gen/inputs/prompt');
  assert.match(first.correction.diff[0].before, /grey jacket, fast entry/);
  assert.match(first.correction.diff[0].after, /yellow jacket and helmet, slower entry/);

  assert.equal(second.n, 2);
  assert.equal(second.verdict, 'unreviewed');
  assert.equal(second.takeId, entry.selected);
  assert.equal(second.file, `takes/a_juno_plate/${second.takeId}.mp4`);
  assert.equal(second.gen.inputs.scene, 's3_juno');
  assert.notDeepEqual(second.gen.inputs, first.gen.inputs);

  assert.equal(deriveClipState({ takes: entry }), 'review');
});

test('PN04: s1, s2 and s4 are approved', () => {
  for (const [sceneId, assetId] of CLIP_ASSETS.filter(([sceneId]) => sceneId !== 's3_juno')) {
    const entry = takesDoc.clips[assetId];
    assert.equal(entry.takes.length, 1, `${sceneId} take count`);
    assert.equal(entry.selected, entry.takes[0].takeId);
    assert.equal(entry.takes[0].verdict, 'approved', `${sceneId} verdict`);
    assert.equal(deriveClipState({ takes: entry }), 'approved', `${sceneId} state`);
  }
});

test('PN04: the sidecar media view passes package validation and exposes four clips', () => {
  const fixture = packageWithMedia();
  const report = validatePackage(fixture);
  assert.deepEqual(report.errors, []);
  assert.equal(report.valid, true);

  const clips = listClips(fixture);
  assert.deepEqual(clips.map(clip => clip.clipId), [
    's1_dawn:a_dawn_plate',
    's2_counter:a_counter_plate',
    's3_juno:a_juno_plate',
    's4_outro:a_outro_still',
  ]);
});

test('PN04: the gate reports 3/4 and blocks render at the frozen state', () => {
  const fixture = packageWithMedia();
  const gate = finalGate(fixture, takesDoc);

  assert.equal(gate.ok, false);
  assert.equal(gate.approved, 3);
  assert.equal(gate.total, 4);
  assert.deepEqual(gate.blocking, [{ clipId: 's3_juno:a_juno_plate', state: 'review' }]);
});

test('PN04: approving s3 take 2 with a verified mocked plate makes the gate 5/5 and unblocks render', async (t) => {
  const runtimeDir = tempRuntime(t);
  const renders = [];
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    backendFactory: async () => fakeBackend(),
    render: async (packagePath, output) => {
      renders.push({ packagePath, output });
      const bytes = Buffer.from('fake pip night shift render');
      writeFileSync(output, bytes);
      return { output, bytes: bytes.length, frames: 1, hash: 'pip-night-shift-test' };
    },
  });
  t.after(() => app.close());

  const fixture = packageWithMedia();
  collectMockContribution(fixture, app.store.dir);
  cpSync(new URL('assets/', exampleDir), join(app.store.dir, 'assets'), { recursive: true });
  for (const [, id] of CLIP_ASSETS) writeStubSource(fixture, app.store.dir, id);
  app.store.seed(fixture);
  app.takeStore.write(pkg.id, takesDoc);
  approveMockContribution(app.takeStore, fixture, app.store.dir);

  await withServer(app, async ({ call }) => {
    const listed = await call(`/api/package/${pkg.id}/clips`);
    assert.equal(listed.status, 200);
    const listing = await listed.json();
    assert.equal(listing.clips.length, 5);
    assert.equal(listing.clips.filter(clip => clip.state === 'approved').length, 4);
    const juno = listing.clips.find(clip => clip.clipId === 's3_juno:a_juno_plate');
    assert.equal(juno.state, 'review');
    assert.equal(juno.takeCount, 2);
    assert.equal(juno.selectedN, 2);

    const blocked = await call('/api/render', { packageId: pkg.id });
    assert.equal(blocked.status, 409);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.code, 'RENDER_GATE_BLOCKED');
    assert.equal(blockedBody.approved, 4);
    assert.equal(blockedBody.total, 5);
    assert.equal(renders.length, 0);

    const clipId = encodeURIComponent('s3_juno:a_juno_plate');
    const approved = await call(`/api/package/${pkg.id}/clips/${clipId}/verdict`, {
      verdict: 'approved',
      note: 'Juno is on-model and the slower entry works.',
    });
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json();
    assert.equal(approvedBody.takeId, takesDoc.clips.a_juno_plate.selected);
    assert.equal(approvedBody.clip.state, 'approved');

    const gate = finalGate(fixture, app.takeStore.read(pkg.id));
    assert.equal(gate.ok, true);
    assert.equal(gate.approved, 5);
    assert.equal(gate.total, 5);
    assert.deepEqual(gate.blocking, []);

    const rendered = await call('/api/render', { packageId: pkg.id });
    assert.equal(rendered.status, 200);
    assert.equal(renders.length, 1);
  });
});

test('PN04: the editor sidecar is valid and round-trips through the sidecar store', (t) => {
  const parsed = validateEditor(editorDoc);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.editor, editorDoc);
  assert.equal(parsed.editor.version, 1);
  assert.deepEqual(parsed.editor.captionOverrides, []);

  const runtimeDir = tempRuntime(t);
  writeEditor(runtimeDir, pkg.id, parsed.editor);
  assert.deepEqual(readEditor(runtimeDir, pkg.id), editorDoc);
});
