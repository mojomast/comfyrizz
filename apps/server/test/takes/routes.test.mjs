import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PackageStore } from '../../src/store.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';
import { createTakeRoutes } from '../../src/takes/routes.mjs';

const fixturePath = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const CLIP = 's1:a_plate1';
const CLIP_STILL = 's2:a_plate1_still';

const clone = value => JSON.parse(JSON.stringify(value));

function makePackage() {
  const pkg = clone(fixture);
  pkg.scenes.push({
    id: 's2',
    layout: 'hero',
    preferredFrames: 60,
    copy: { headline: 'A still frame' },
    background: { asset: 'a_plate1_still' },
    foreground: [],
  });
  return pkg;
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-take-routes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDir = join(root, 'runtime');
  const packageDir = join(runtimeDir, 'packages');
  mkdirSync(packageDir, { recursive: true });
  return { root, runtimeDir, packageDir };
}

function fakeRuns(mode = 'started') {
  const calls = [];
  return {
    calls,
    async start(args) {
      calls.push(args);
      if (mode === 'busy') {
        return { error: 'run busy', runId: 'run_active', status: 409, planHash: 'c'.repeat(64) };
      }
      if (mode === 'approval' && args.approved !== true) {
        return {
          approvalRequired: true,
          requiresApproval: true,
          approved: false,
          planHash: 'a'.repeat(64),
          estimate: { gpuMinutes: 2, overheadMinutes: 1 },
          budget: { allowed: true, required: 1 },
          backend: { id: args.backendId },
          jobs: 1,
        };
      }
      return {
        runId: 'run_new',
        status: 'starting',
        planHash: 'b'.repeat(64),
        estimate: { gpuMinutes: 1, overheadMinutes: 1 },
        budget: { allowed: true, required: 1 },
        approved: true,
      };
    },
  };
}

function fakeResponse() {
  const out = { status: null, headers: null, raw: null, json: null };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(body) {
      out.raw = body;
      try {
        out.json = body ? JSON.parse(body) : null;
      } catch {
        out.json = null;
      }
    },
  };
}

function fakeRequest(body, method = 'POST') {
  const stream = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  stream.method = method;
  return stream;
}

async function call(routes, path, { method, body } = {}) {
  const response = fakeResponse();
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const matched = await routes.handle(fakeRequest(body, verb), response, new URL(`http://127.0.0.1${path}`));
  return { matched, ...response.out };
}

function setup(t, { runMode = 'started' } = {}) {
  const space = workspace(t);
  const store = new PackageStore(space.packageDir);
  const pkg = makePackage();
  store.write(pkg);
  const takeStore = createTakeStore({
    runtimeDir: space.runtimeDir,
    packageDir: space.packageDir,
    clock: () => new Date('2026-10-20T12:00:00.000Z'),
  });
  const runs = fakeRuns(runMode);
  const events = {
    list: [],
    publish(event) {
      this.list.push(event);
    },
  };
  const mints = [];
  const mediaTickets = {
    mint(file) {
      mints.push(file);
      return { ticket: 'd'.repeat(32), expiresAt: '2026-10-20T12:10:00.000Z', url: `/api/media/${'d'.repeat(32)}` };
    },
  };
  const routes = createTakeRoutes({ store, takeStore, runs, events, mediaTickets });
  return { ...space, store, pkg, takeStore, runs, events, mints, routes };
}

function addTake(ctx, bytes, name = 'take.mp4') {
  const source = join(ctx.root, name);
  writeFileSync(source, bytes);
  return ctx.takeStore.addTake(ctx.pkg.id, 'a_plate1', {
    srcPath: source,
    media: clone(ctx.pkg.assets.a_plate1.media),
    gen: clone(ctx.pkg.assets.a_plate1.gen),
    runId: 'run_seed',
  });
}

test('TR08: non-clip paths are not handled', async (t) => {
  const ctx = setup(t);
  assert.equal((await call(ctx.routes, '/api/takes')).matched, false);
  assert.equal((await call(ctx.routes, `/api/package/${ctx.pkg.id}/assets`)).matched, false);
  assert.equal((await call(ctx.routes, `/api/package/${ctx.pkg.id}/clip`)).matched, false);
  assert.equal((await call(ctx.routes, '/api/package')).matched, false);
});

test('TR08: GET clips lists each clip with its derived state and take summary', async (t) => {
  const ctx = setup(t);
  const take = addTake(ctx, Buffer.from('take-one'));

  const listed = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips`);
  assert.equal(listed.matched, true);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.packageId, ctx.pkg.id);
  const clips = listed.json.clips;
  assert.equal(clips.length, 2);
  const clip = clips.find(item => item.clipId === CLIP);
  assert.equal(clip.assetId, 'a_plate1');
  assert.equal(clip.state, 'review');
  assert.equal(clip.selected, take.takeId);
  assert.equal(clip.selectedN, 1);
  assert.equal(clip.takeCount, 1);
  assert.equal(clip.newTakes, 0);
  assert.equal(clip.queued, false);
  const still = clips.find(item => item.clipId === CLIP_STILL);
  assert.equal(still.state, 'planned');
  assert.equal(still.takeCount, 0);
});

test('TR08: GET takes returns the take list and the selected take', async (t) => {
  const ctx = setup(t);
  const take = addTake(ctx, Buffer.from('take-one'));

  const listed = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/takes`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.assetId, 'a_plate1');
  assert.equal(listed.json.selected, take.takeId);
  assert.equal(listed.json.takes.length, 1);
  assert.equal(listed.json.clip.state, 'review');
  assert.equal(listed.json.lastJob, null);
  assert.equal(listed.json.queued, null);

  const missing = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/s9:a_plate1/takes`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'UNKNOWN_CLIP');
});

test('TR08: regenerate returns approval_required with planHash for colab and starts no run', async (t) => {
  const ctx = setup(t, { runMode: 'approval' });
  const before = clone(ctx.store.read(ctx.pkg.id));

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, {
    body: { change: { note: 'cleaner background', seed: 'keep' }, backendId: 'colab', budgetUnits: 10 },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.kind, 'approval_required');
  assert.equal(response.json.approvalRequired, true);
  assert.equal(response.json.planHash, 'a'.repeat(64));
  assert.equal(response.json.assetId, 'a_plate1');
  assert.equal(response.json.correction.note, 'cleaner background');
  assert.equal(ctx.runs.calls.length, 1);
  const args = ctx.runs.calls[0];
  assert.equal(args.backendId, 'colab');
  assert.equal(args.mode, 'take');
  assert.deepEqual(args.assets, ['a_plate1']);
  assert.equal(args.includeReady, true);
  assert.equal(args.approved, false);
  assert.equal(args.budgetUnits, 10);
  assert.equal(args.corrections.a_plate1.note, 'cleaner background');
  assert.deepEqual(ctx.store.read(ctx.pkg.id), before, 'an approval request does not rewrite the package');
  assert.equal(ctx.takeStore.read(ctx.pkg.id), null);
});

test('TR08: regenerate starts a take-mode run and records the job', async (t) => {
  const ctx = setup(t);

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, {
    body: { change: { note: 'shift the seed', seed: 99 }, backendId: 'byo-comfyui' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.kind, 'started');
  assert.equal(response.json.runId, 'run_new');
  assert.equal(response.json.assetId, 'a_plate1');
  assert.equal(response.json.correction.seed, 99);
  assert.ok(response.json.diff.some(entry => entry.path === 'gen.inputs.seed' && entry.after === 99));
  const args = ctx.runs.calls[0];
  assert.equal(args.backendId, 'byo-comfyui');
  assert.equal(args.mode, 'take');
  assert.deepEqual(args.assets, ['a_plate1']);
  assert.equal(args.includeReady, true);
  assert.equal(args.pkg.assets.a_plate1.gen.inputs.seed, 99);
  const doc = ctx.takeStore.read(ctx.pkg.id);
  assert.equal(doc.clips.a_plate1.lastJob.runId, 'run_new');
  assert.equal(doc.clips.a_plate1.queued, undefined);
  assert.ok(ctx.events.list.some(event => event.type === 'clip.job' && event.assetId === 'a_plate1'));
});

test('TR08: regenerate while a run is busy records queued in the sidecar and returns 202', async (t) => {
  const ctx = setup(t, { runMode: 'busy' });

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, {
    body: { change: { note: 'try again later', seed: 'keep' }, backendId: 'colab' },
  });

  assert.equal(response.status, 202);
  assert.equal(response.json.kind, 'queued');
  assert.equal(response.json.planHash, 'c'.repeat(64));
  const doc = ctx.takeStore.read(ctx.pkg.id);
  assert.equal(doc.clips.a_plate1.queued.correction.note, 'try again later');
  assert.equal(doc.clips.a_plate1.queued.planHash, 'c'.repeat(64));
  assert.equal(doc.clips.a_plate1.queued.backendId, 'colab');
  assert.equal(doc.clips.a_plate1.lastJob, undefined);
  assert.ok(ctx.events.list.some(event => event.type === 'clip.queued' && event.clipId === CLIP));

  const listed = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips`);
  assert.equal(listed.json.clips.find(item => item.clipId === CLIP).state, 'queued');
});

test('TR08: regenerate-batch folds many corrections into one take-mode run', async (t) => {
  const ctx = setup(t);

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/regenerate-batch`, {
    body: {
      items: [
        { clipId: CLIP, change: { note: 'warmer background', seed: 11 } },
        { clipId: CLIP_STILL, change: { note: 'sharper still', seed: 12 } },
      ],
      backendId: 'colab',
      budgetUnits: 20,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.kind, 'started');
  assert.equal(response.json.items.length, 2);
  assert.equal(ctx.runs.calls.length, 1);
  const args = ctx.runs.calls[0];
  assert.deepEqual([...args.assets].sort(), ['a_plate1', 'a_plate1_still']);
  assert.equal(args.includeReady, true);
  assert.equal(args.mode, 'take');
  assert.equal(args.corrections.a_plate1.note, 'warmer background');
  assert.equal(args.corrections.a_plate1_still.note, 'sharper still');
  assert.equal(args.pkg.assets.a_plate1.gen.inputs.seed, 11);
  assert.equal(args.pkg.assets.a_plate1_still.gen.inputs.seed, 12);
  const doc = ctx.takeStore.read(ctx.pkg.id);
  assert.equal(doc.clips.a_plate1.lastJob.runId, 'run_new');
  assert.equal(doc.clips.a_plate1_still.lastJob.runId, 'run_new');
});

test('TR08: regenerate-batch is queued as one unit when the runner is busy', async (t) => {
  const ctx = setup(t, { runMode: 'busy' });

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/regenerate-batch`, {
    body: { items: [{ clipId: CLIP, change: { note: 'later', seed: 'keep' } }], backendId: 'colab' },
  });

  assert.equal(response.status, 202);
  assert.equal(response.json.kind, 'queued');
  const doc = ctx.takeStore.read(ctx.pkg.id);
  assert.equal(doc.clips.a_plate1.queued.correction.note, 'later');
  assert.equal(ctx.events.list.filter(event => event.type === 'clip.queued').length, 1);
});

test('TR08: select writes the take into the package and revert restores the previous one', async (t) => {
  const ctx = setup(t);
  const first = addTake(ctx, Buffer.from('take-one'), 'one.mp4');
  const second = addTake(ctx, Buffer.from('take-two'), 'two.mp4');
  const revision = ctx.store.read(ctx.pkg.id).revision;

  const selected = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/select`, {
    body: { takeId: first.takeId },
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.json.kind, 'selected');
  assert.equal(selected.json.takeId, first.takeId);
  assert.equal(selected.json.clip.selected, first.takeId);
  let saved = ctx.store.read(ctx.pkg.id);
  assert.equal(saved.assets.a_plate1.sha256, first.sha256);
  assert.equal(saved.assets.a_plate1.file, first.file);
  assert.equal(saved.revision, revision + 1);
  assert.equal(ctx.takeStore.read(ctx.pkg.id).clips.a_plate1.selected, first.takeId);
  assert.ok(ctx.events.list.some(event => event.type === 'clip.take.selected' && event.takeId === first.takeId));

  const reverted = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/revert`, { body: {} });
  assert.equal(reverted.status, 200);
  assert.equal(reverted.json.kind, 'reverted');
  assert.equal(reverted.json.takeId, second.takeId);
  saved = ctx.store.read(ctx.pkg.id);
  assert.equal(saved.assets.a_plate1.sha256, second.sha256);
  assert.equal(saved.revision, revision + 2);
  assert.equal(ctx.takeStore.read(ctx.pkg.id).clips.a_plate1.selected, second.takeId);
});

test('TR08: verdict marks the selected take and changes the derived state', async (t) => {
  const ctx = setup(t);
  const take = addTake(ctx, Buffer.from('take-one'));

  const verdict = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/verdict`, {
    body: { verdict: 'approved', note: 'logo is readable' },
  });
  assert.equal(verdict.status, 200);
  assert.equal(verdict.json.kind, 'verdict');
  assert.equal(verdict.json.takeId, take.takeId);
  assert.equal(verdict.json.clip.state, 'approved');
  const doc = ctx.takeStore.read(ctx.pkg.id);
  assert.equal(doc.clips.a_plate1.takes[0].verdict, 'approved');
  assert.equal(doc.clips.a_plate1.takes[0].verdictNote, 'logo is readable');
  assert.ok(ctx.events.list.some(event => event.type === 'clip.verdict' && event.verdict === 'approved'));

  const listed = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips`);
  assert.equal(listed.json.clips.find(item => item.clipId === CLIP).state, 'approved');

  const bad = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/verdict`, {
    body: { verdict: 'maybe' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'INVALID_VERDICT');
});

test('TR08: a take ticket mints a media URL for the take file only', async (t) => {
  const ctx = setup(t);
  const take = addTake(ctx, Buffer.from('take-one'));

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/takes/${take.takeId}/ticket`, {
    body: {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.kind, 'ticket');
  assert.equal(response.json.takeId, take.takeId);
  assert.equal(response.json.url, `/api/media/${'d'.repeat(32)}`);
  assert.equal(ctx.mints.length, 1);
  assert.equal(ctx.mints[0], join(ctx.packageDir, ctx.pkg.id, take.file));

  const missing = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/takes/tk_000000000000/ticket`, {
    body: {},
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'UNKNOWN_TAKE');
});

test('TR08: invalid JSON is a client error and unknown clip routes are 404', async (t) => {
  const ctx = setup(t);
  const broken = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, { body: '{' });
  assert.equal(broken.status, 400);
  assert.equal(broken.json.code, 'INVALID_BODY');

  const unknown = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/nope`, { body: {} });
  assert.equal(unknown.status, 404);
});
