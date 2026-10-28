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
import { createCommandHandler } from '../../src/productions/commands.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';

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

function setup(t, { runMode = 'started', bindProduction = false } = {}) {
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
  let production = null;
  if (bindProduction) {
    const clock = () => new Date('2026-10-20T12:00:00.000Z');
    const productionStore = createProductionStore({ runtimeDir: join(space.runtimeDir, 'production'), clock });
    t.after(() => productionStore.close?.());
    const handler = createCommandHandler({ store: productionStore, clock });
    const context = { actor: 'user', userEventId: 'ue_routes' };
    const created = handler.execute({
      commandId: 'cmd_production_create',
      idempotencyKey: 'key_production_create',
      kind: 'production.create',
      expected: { productionRevision: 0 },
      payload: { conversationId: 'conv_routes', packageId: pkg.id },
    }, { actor: 'user', userEventId: 'ue_create' });
    production = {
      store: productionStore,
      handler,
      context,
      productionId: created.productionId,
      revision: created.revision,
      bind: async () => ({ productionId: created.productionId, handler, context }),
    };
  }
  const routes = createTakeRoutes({
    store,
    takeStore,
    runs,
    events,
    mediaTickets,
    ...(production ? { production: production.bind } : {}),
  });
  return { ...space, store, pkg, takeStore, runs, events, mints, routes, production };
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

test('TR08: non-timeline visual references appear live and use the same take-ticket boundary', async (t) => {
  const ctx = setup(t);
  const pkg = ctx.store.read(ctx.pkg.id);
  pkg.assets.a_character_ref = clone(pkg.assets.a_plate1_still);
  ctx.store.save(pkg.id, pkg, pkg.revision);
  const source = join(ctx.root, 'character.png');
  writeFileSync(source, 'real reference bytes');
  const take = ctx.takeStore.addTake(ctx.pkg.id, 'a_character_ref', {
    srcPath: source, media: { width: 1024, height: 576 }, gen: { generator: 'flux3-klein' }, runId: 'run_reference',
  });
  const listed = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.references, [{ assetId: 'a_character_ref', takeId: take.takeId, kind: 'image', state: 'review' }]);
  assert.ok(listed.json.clips.every(clip => clip.assetId !== 'a_character_ref'), 'references do not become approval clips');
  const ticket = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/a_character_ref/takes/${take.takeId}/ticket`, { method: 'POST' });
  assert.equal(ticket.status, 200);
  assert.equal(ticket.json.takeId, take.takeId);
  assert.ok(ctx.mints.at(-1).endsWith('.png'));
});

test('TR08: invalid JSON is a client error and unknown clip routes are 404', async (t) => {
  const ctx = setup(t);
  const broken = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, { body: '{' });
  assert.equal(broken.status, 400);
  assert.equal(broken.json.code, 'INVALID_BODY');

  const unknown = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/nope`, { body: {} });
  assert.equal(unknown.status, 404);
});


function boundBody(overrides = {}) {
  return {
    commandId: 'cmd_take_request',
    idempotencyKey: 'key_take_request',
    expected: { productionRevision: 1 },
    ...overrides,
  };
}

test('IP23: bound regenerate journals take.request and never dispatches paid work', async (t) => {
  const ctx = setup(t, { bindProduction: true });
  const beforeEvents = ctx.production.store.readEvents(ctx.production.productionId).length;

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, {
    body: boundBody({
      change: { note: 'cleaner background', seed: 'keep' },
      backendId: 'colab',
      approved: true,
      budgetUnits: 99,
    }),
  });

  assert.equal(response.status, 202);
  assert.equal(response.json.kind, 'requested');
  assert.equal(response.json.productionId, ctx.production.productionId);
  assert.equal(response.json.productionRevision, 2);
  assert.equal(response.json.commandId, 'cmd_take_request');
  assert.equal(response.json.clip.assetId, 'a_plate1');
  assert.equal(response.json.clip.clipId, CLIP);
  assert.equal(ctx.runs.calls.length, 0, 'a bound request never starts a run');
  assert.equal(ctx.takeStore.read(ctx.pkg.id), null, 'a bound request does not write legacy queued state');

  const events = ctx.production.store.readEvents(ctx.production.productionId);
  assert.equal(events.length, beforeEvents + 1);
  const event = events.at(-1);
  assert.equal(event.type, 'take.requested');
  assert.equal(event.commandId, 'cmd_take_request');
  assert.equal(event.userEventId, 'ue_routes');
  assert.equal(event.data.assetId, 'a_plate1');
  assert.equal(event.data.correction.note, 'cleaner background');
  assert.equal(event.data.approved, undefined, 'the legacy approval flag is not journaled');
  assert.equal(event.data.budgetUnits, undefined, 'the legacy budget is not journaled');
});

test('IP23: bound regenerate-batch journals one take.request and never dispatches paid work', async (t) => {
  const ctx = setup(t, { bindProduction: true });

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/regenerate-batch`, {
    body: boundBody({
      commandId: 'cmd_take_batch',
      idempotencyKey: 'key_take_batch',
      items: [
        { clipId: CLIP, change: { note: 'warmer background', seed: 11 } },
        { clipId: CLIP_STILL, change: { note: 'sharper still', seed: 12 } },
      ],
      backendId: 'colab',
      approved: true,
      budgetUnits: 50,
    }),
  });

  assert.equal(response.status, 202);
  assert.equal(response.json.kind, 'requested');
  assert.equal(response.json.productionId, ctx.production.productionId);
  assert.equal(response.json.productionRevision, 2);
  assert.equal(response.json.commandId, 'cmd_take_batch');
  assert.equal(response.json.items.length, 2);
  assert.equal(ctx.runs.calls.length, 0);
  const event = ctx.production.store.readEvents(ctx.production.productionId).at(-1);
  assert.equal(event.type, 'take.requested');
  assert.equal(event.data.items.length, 2);
  assert.equal(event.data.approved, undefined);
  assert.equal(event.data.budgetUnits, undefined);
});

test('IP23: a bound request without a command id or idempotency key is rejected', async (t) => {
  const ctx = setup(t, { bindProduction: true });
  const beforeEvents = ctx.production.store.readEvents(ctx.production.productionId).length;

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, {
    body: {
      change: { note: 'no key', seed: 'keep' },
      expected: { productionRevision: 1 },
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'MISSING_COMMAND_ID');
  assert.equal(ctx.runs.calls.length, 0);
  assert.equal(ctx.production.store.readEvents(ctx.production.productionId).length, beforeEvents);
});

test('IP23: a bound request requires expected.productionRevision', async (t) => {
  const ctx = setup(t, { bindProduction: true });

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, {
    body: {
      change: { note: 'no revision', seed: 'keep' },
      commandId: 'cmd_no_revision',
      idempotencyKey: 'key_no_revision',
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'PRODUCTION_REVISION_REQUIRED');
  assert.equal(ctx.runs.calls.length, 0);
});

test('IP23: a stale bound revision is a 409 with the current revision', async (t) => {
  const ctx = setup(t, { bindProduction: true });

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, {
    body: boundBody({
      change: { note: 'stale attempt', seed: 'keep' },
      commandId: 'cmd_stale_request',
      idempotencyKey: 'key_stale_request',
      expected: { productionRevision: 0 },
    }),
  });

  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'REVISION_CONFLICT');
  assert.equal(response.json.currentRevision, 1);
  assert.equal(ctx.runs.calls.length, 0);
  assert.equal(ctx.production.store.readEvents(ctx.production.productionId).length, 1);
});

test('IP23: a duplicate bound select after a crash reapplies the selection', async (t) => {
  const ctx = setup(t, { bindProduction: true });
  const first = addTake(ctx, Buffer.from('take-one'), 'one.mp4');
  const second = addTake(ctx, Buffer.from('take-two'), 'two.mp4');
  const originalSave = ctx.store.save.bind(ctx.store);
  let failOnce = true;
  ctx.store.save = (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated crash between journal and package save');
    }
    return originalSave(...args);
  };
  const body = {
    takeId: first.takeId,
    commandId: 'cmd_take_select',
    idempotencyKey: 'key_take_select',
    expected: { productionRevision: 1 },
  };

  const crashed = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/select`, { body });
  assert.equal(crashed.status, 500);
  const journal = ctx.production.store.readEvents(ctx.production.productionId);
  assert.equal(journal.at(-1).type, 'take.selected');
  assert.equal(journal.at(-1).data.takeId, first.takeId);
  assert.equal(ctx.takeStore.read(ctx.pkg.id).clips.a_plate1.selected, second.takeId);
  assert.notEqual(ctx.store.read(ctx.pkg.id).assets.a_plate1.sha256, first.sha256);

  const retried = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/select`, { body });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.kind, 'selected');
  assert.equal(retried.json.duplicate, true);
  assert.equal(retried.json.takeId, first.takeId);
  assert.equal(retried.json.productionId, ctx.production.productionId);
  assert.equal(retried.json.productionRevision, 2);
  assert.equal(retried.json.commandId, 'cmd_take_select');
  assert.equal(ctx.takeStore.read(ctx.pkg.id).clips.a_plate1.selected, first.takeId);
  assert.equal(ctx.store.read(ctx.pkg.id).assets.a_plate1.sha256, first.sha256);
});
