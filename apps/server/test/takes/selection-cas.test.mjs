// UX10: take selection is a compare-and-swap transaction with a stable command id.
//
// Two tabs must not silently overwrite each other, an identical Revert must not
// toggle the selection twice, and a crash between the package and sidecar writes
// must be repairable by retrying the same command. Authority/scope refusals are
// never reported as a queued or started run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { PackageStore } from '../../src/store.mjs';
import { createTakeRoutes } from '../../src/takes/routes.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';

const FIXTURE_PATH = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const CLIP = 's1:a_plate1';
const ASSET_ID = 'a_plate1';

const clone = value => JSON.parse(JSON.stringify(value));

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-selection-cas-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDir = join(root, 'runtime');
  const packageDir = join(runtimeDir, 'packages');
  mkdirSync(packageDir, { recursive: true });
  return { root, runtimeDir, packageDir };
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
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  stream.method = method;
  return stream;
}

async function call(routes, path, { method, body } = {}) {
  const response = fakeResponse();
  const matched = await routes.handle(
    fakeRequest(body, method ?? (body === undefined ? 'GET' : 'POST')),
    response,
    new URL(`http://127.0.0.1${path}`),
  );
  return { matched, ...response.out };
}

function startedRun() {
  return {
    runId: 'run_new',
    status: 'starting',
    planHash: 'b'.repeat(64),
    estimate: { gpuMinutes: 1, overheadMinutes: 1 },
    budget: { allowed: true, required: 1 },
    approved: true,
  };
}

function fakeRuns(start = startedRun) {
  return {
    calls: [],
    async start(args) {
      this.calls.push(args);
      return start(args);
    },
  };
}

function setup(t, { runs = fakeRuns() } = {}) {
  const space = workspace(t);
  const store = new PackageStore(space.packageDir);
  const pkg = clone(fixture);
  delete pkg.scenes.at(-1).transitionOut;
  store.write(pkg);
  const takeStore = createTakeStore({
    runtimeDir: space.runtimeDir,
    packageDir: space.packageDir,
    clock: () => new Date('2026-10-20T12:00:00.000Z'),
  });
  const events = {
    list: [],
    publish(event) {
      this.list.push(event);
    },
  };
  const routes = createTakeRoutes({ store, takeStore, runs, events });
  return { ...space, store, pkg, takeStore, events, runs, routes };
}

function addTake(ctx, bytes, name) {
  const source = join(ctx.root, name);
  writeFileSync(source, bytes);
  return ctx.takeStore.addTake(ctx.pkg.id, ASSET_ID, {
    srcPath: source,
    media: clone(ctx.pkg.assets[ASSET_ID].media),
    gen: clone(ctx.pkg.assets[ASSET_ID].gen),
    runId: 'run_seed',
  });
}

function seedTakes(ctx) {
  const first = addTake(ctx, Buffer.from('take-one'), 'one.mp4');
  const second = addTake(ctx, Buffer.from('take-two'), 'two.mp4');
  ctx.takeStore.setSelected(ctx.pkg.id, ASSET_ID, null);
  return { first, second };
}

function revisionOf(ctx) {
  return ctx.store.read(ctx.pkg.id).revision;
}

function selectionOf(ctx) {
  return ctx.takeStore.read(ctx.pkg.id)?.clips?.[ASSET_ID]?.selected ?? null;
}

function select(ctx, body) {
  return call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/select`, { body });
}

function revert(ctx, body) {
  return call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/revert`, { body });
}

function assertNoRunProjection(ctx) {
  assert.equal(ctx.takeStore.read(ctx.pkg.id), null, 'a refusal writes no queued or started projection');
  assert.equal(ctx.events.list.filter(event => event.type === 'clip.queued' || event.type === 'clip.job').length, 0);
}

test('UX10: two tabs selecting with the same package revision cannot both win', async (t) => {
  const ctx = setup(t);
  const { first, second } = seedTakes(ctx);
  const revision = revisionOf(ctx);

  const winner = await select(ctx, {
    takeId: first.takeId,
    expected: { packageRevision: revision, selected: second.takeId },
  });
  assert.equal(winner.status, 200);
  assert.equal(winner.json.kind, 'selected');
  assert.equal(winner.json.takeId, first.takeId);

  const stale = await select(ctx, {
    takeId: second.takeId,
    expected: { packageRevision: revision, selected: second.takeId },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'REVISION_CONFLICT');
  assert.equal(stale.json.currentRevision, revision + 1);
  assert.equal(stale.json.baseRevision, revision);
  assert.equal(ctx.store.read(ctx.pkg.id).assets[ASSET_ID].sha256, first.sha256);
  assert.equal(selectionOf(ctx), first.takeId);
});

test('UX10: an expected selection conflict is distinct from a revision conflict', async (t) => {
  const ctx = setup(t);
  const { first, second } = seedTakes(ctx);
  const revision = revisionOf(ctx);

  const winner = await select(ctx, { takeId: first.takeId, expected: { packageRevision: revision, selected: second.takeId } });
  assert.equal(winner.status, 200);

  const stale = await select(ctx, { takeId: second.takeId, expected: { selected: second.takeId } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'SELECTION_CONFLICT');
  assert.equal(stale.json.currentSelection, first.takeId);
  assert.equal(selectionOf(ctx), first.takeId);
});

test('UX10: replaying a select command id is a duplicate and does not bump the revision', async (t) => {
  const ctx = setup(t);
  const { first, second } = seedTakes(ctx);
  const revision = revisionOf(ctx);
  const body = {
    takeId: first.takeId,
    commandId: 'cmd_select_one',
    expected: { packageRevision: revision, selected: second.takeId },
  };

  const firstCall = await select(ctx, body);
  assert.equal(firstCall.status, 200);
  assert.equal(firstCall.json.duplicate, undefined);
  const afterFirst = revisionOf(ctx);

  const replay = await select(ctx, body);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.duplicate, true);
  assert.equal(replay.json.takeId, first.takeId);
  assert.equal(revisionOf(ctx), afterFirst, 'a replayed command does not bump the package revision');
});

test('UX10: identical Revert twice is safe and never toggles the selection back', async (t) => {
  const ctx = setup(t);
  const { first, second } = seedTakes(ctx);

  const firstChoice = await select(ctx, {
    takeId: first.takeId,
    commandId: 'cmd_select_first',
    expected: { packageRevision: revisionOf(ctx), selected: second.takeId },
  });
  assert.equal(firstChoice.status, 200);

  const secondChoice = await select(ctx, {
    takeId: second.takeId,
    commandId: 'cmd_select_second',
    expected: { packageRevision: revisionOf(ctx), selected: first.takeId },
  });
  assert.equal(secondChoice.status, 200);
  assert.equal(selectionOf(ctx), second.takeId);

  const body = {
    commandId: 'cmd_revert_once',
    expected: { packageRevision: revisionOf(ctx), selected: second.takeId },
  };
  const reverted = await revert(ctx, body);
  assert.equal(reverted.status, 200);
  assert.equal(reverted.json.kind, 'reverted');
  assert.equal(reverted.json.takeId, first.takeId);
  const afterRevert = revisionOf(ctx);
  assert.equal(selectionOf(ctx), first.takeId);

  const replay = await revert(ctx, body);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.duplicate, true);
  assert.equal(replay.json.takeId, first.takeId);
  assert.equal(revisionOf(ctx), afterRevert, 'the duplicate Revert does not bump the revision');
  assert.equal(selectionOf(ctx), first.takeId, 'the duplicate Revert does not toggle back');
  assert.deepEqual(ctx.takeStore.read(ctx.pkg.id).clips[ASSET_ID].history ?? [], []);
});

test('UX10: a stale Revert request that is not the recorded command is refused', async (t) => {
  const ctx = setup(t);
  const { first, second } = seedTakes(ctx);

  await select(ctx, {
    takeId: first.takeId,
    commandId: 'cmd_select_first',
    expected: { packageRevision: revisionOf(ctx), selected: second.takeId },
  });
  await select(ctx, {
    takeId: second.takeId,
    commandId: 'cmd_select_second',
    expected: { packageRevision: revisionOf(ctx), selected: first.takeId },
  });
  const before = revisionOf(ctx);
  const reverted = await revert(ctx, {
    commandId: 'cmd_revert_once',
    expected: { packageRevision: before, selected: second.takeId },
  });
  assert.equal(reverted.status, 200);
  assert.equal(selectionOf(ctx), first.takeId);

  const stale = await revert(ctx, {
    commandId: 'cmd_revert_again',
    expected: { packageRevision: before, selected: second.takeId },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'REVISION_CONFLICT');
  assert.equal(selectionOf(ctx), first.takeId);
});

test('UX10: a crash after the package save repairs the sidecar on retry without a second revision', async (t) => {
  const ctx = setup(t);
  const { first, second } = seedTakes(ctx);
  const body = {
    takeId: first.takeId,
    commandId: 'cmd_crash_sidecar',
    expected: { packageRevision: revisionOf(ctx), selected: second.takeId },
  };

  const originalWrite = ctx.takeStore.write.bind(ctx.takeStore);
  let failOnce = true;
  ctx.takeStore.write = (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated crash between package and sidecar writes');
    }
    return originalWrite(...args);
  };

  const crashed = await select(ctx, body);
  assert.equal(crashed.status, 500);
  assert.equal(ctx.store.read(ctx.pkg.id).assets[ASSET_ID].sha256, first.sha256, 'the package was saved before the crash');
  assert.equal(selectionOf(ctx), null, 'the sidecar still has the old selection');
  const afterCrash = revisionOf(ctx);

  const retried = await select(ctx, body);
  assert.equal(retried.status, 200);
  assert.equal(retried.json.takeId, first.takeId);
  assert.equal(revisionOf(ctx), afterCrash, 'the retry repairs the sidecar instead of bumping the revision');
  assert.equal(selectionOf(ctx), first.takeId);
  assert.equal(ctx.takeStore.read(ctx.pkg.id).clips[ASSET_ID].selectionCommand.commandId, 'cmd_crash_sidecar');
});

test('UX10: a crash before the package save leaves the sidecar untouched and retry applies once', async (t) => {
  const ctx = setup(t);
  const { first, second } = seedTakes(ctx);
  const revision = revisionOf(ctx);
  const body = {
    takeId: first.takeId,
    commandId: 'cmd_crash_package',
    expected: { packageRevision: revision, selected: second.takeId },
  };

  const originalSave = ctx.store.save.bind(ctx.store);
  let failOnce = true;
  ctx.store.save = (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated crash before package save');
    }
    return originalSave(...args);
  };

  const crashed = await select(ctx, body);
  assert.equal(crashed.status, 500);
  assert.equal(selectionOf(ctx), null, 'the sidecar is not written before the package save');
  assert.equal(revisionOf(ctx), revision);

  const retried = await select(ctx, body);
  assert.equal(retried.status, 200);
  assert.equal(selectionOf(ctx), first.takeId);
  assert.equal(revisionOf(ctx), revision + 1);
});

test('UX10: a Revert crash after the package save does not revert twice on retry', async (t) => {
  const ctx = setup(t);
  const { first, second } = seedTakes(ctx);

  await select(ctx, {
    takeId: first.takeId,
    commandId: 'cmd_select_first',
    expected: { packageRevision: revisionOf(ctx), selected: second.takeId },
  });
  await select(ctx, {
    takeId: second.takeId,
    commandId: 'cmd_select_second',
    expected: { packageRevision: revisionOf(ctx), selected: first.takeId },
  });

  const body = {
    commandId: 'cmd_crash_revert',
    expected: { packageRevision: revisionOf(ctx), selected: second.takeId },
  };

  const originalWrite = ctx.takeStore.write.bind(ctx.takeStore);
  let failOnce = true;
  ctx.takeStore.write = (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated revert sidecar crash');
    }
    return originalWrite(...args);
  };

  const crashed = await revert(ctx, body);
  assert.equal(crashed.status, 500);
  assert.equal(ctx.store.read(ctx.pkg.id).assets[ASSET_ID].sha256, first.sha256, 'the package already holds the reverted take');
  assert.equal(selectionOf(ctx), second.takeId, 'the sidecar still points at the reverted-away take');
  const afterCrash = revisionOf(ctx);

  const retried = await revert(ctx, body);
  assert.equal(retried.status, 200);
  assert.equal(retried.json.takeId, first.takeId);
  assert.equal(revisionOf(ctx), afterCrash, 'the retry repairs the sidecar instead of reverting again');
  assert.equal(selectionOf(ctx), first.takeId);
  assert.deepEqual(ctx.takeStore.read(ctx.pkg.id).clips[ASSET_ID].history ?? [], []);
});

test('UX10: scope and authority refusals are never queued or started', async (t) => {
  const cases = [
    {
      name: 'scope refusal thrown',
      runs: fakeRuns(async () => {
        throw Object.assign(new Error('scope is empty'), { code: 'SCOPE_EMPTY', status: 409 });
      }),
      status: 409,
      code: 'SCOPE_EMPTY',
    },
    {
      name: 'shot lock refusal thrown',
      runs: fakeRuns(async () => {
        throw Object.assign(new Error('shot is locked'), { code: 'ITERATION_SHOT_LOCKED', status: 409 });
      }),
      status: 409,
      code: 'ITERATION_SHOT_LOCKED',
    },
    {
      name: 'authority refusal returned',
      runs: fakeRuns(async () => ({ refused: true, code: 'PRODUCTION_NOT_ACTIVE', status: 409, planHash: 'c'.repeat(64) })),
      status: 409,
      code: 'PRODUCTION_NOT_ACTIVE',
    },
    {
      name: 'revision conflict returned',
      runs: fakeRuns(async () => ({ code: 'REVISION_CONFLICT', status: 409, currentRevision: 9, planHash: 'c'.repeat(64) })),
      status: 409,
      code: 'REVISION_CONFLICT',
    },
  ];

  for (const item of cases) {
    const ctx = setup(t, { runs: item.runs });
    const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, {
      body: { change: { note: item.name, seed: 'keep' }, backendId: 'byo-comfyui' },
    });
    assert.equal(response.status, item.status, item.name);
    assert.equal(response.json.code, item.code, item.name);
    assert.notEqual(response.json.kind, 'queued', `${item.name} is not queued`);
    assert.notEqual(response.json.kind, 'started', `${item.name} is not started`);
    assertNoRunProjection(ctx);
  }
});

test('UX10: started requires a run identity and never reports a bare success', async (t) => {
  const ctx = setup(t, { runs: fakeRuns(async () => ({ status: 'starting' })) });

  const response = await call(ctx.routes, `/api/package/${ctx.pkg.id}/clips/${CLIP}/regenerate`, {
    body: { change: { note: 'no run id', seed: 'keep' }, backendId: 'byo-comfyui' },
  });

  assert.equal(response.status, 502);
  assert.equal(response.json.code, 'RUN_IDENTITY_REQUIRED');
  assert.notEqual(response.json.kind, 'started');
  assert.equal(ctx.takeStore.read(ctx.pkg.id), null);
  assert.equal(ctx.events.list.filter(event => event.type === 'clip.job').length, 0);
});
