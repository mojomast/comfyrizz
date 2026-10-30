import { test, after } from 'node:test';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipelineController } from '../src/pipeline.mjs';
import { createOperationCoordinator } from '../src/operations.mjs';
import { startColabAuth } from '../src/colab-auth.mjs';
import { EventEmitter } from 'node:events';
import { planPipeline, selectedPresenterScenes, syncnetConfigured, syncnetDiagnostics } from '../src/pipeline-contract.mjs';
import { correctionFor } from '../src/pipeline-media.mjs';
import { progressLines } from '../../../packages/backends/src/progress-lines.mjs';

const example = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url)));
const contributionRoot = mkdtempSync(join(tmpdir(), 'pipeline-receipt-'));
collectMockContribution(example, join(contributionRoot, 'package'));
after(() => rmSync(contributionRoot, { recursive: true, force: true }));
function fixture(t, options = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  let message, exit, cancelled = false, killed = null;
  const dependencies = { runtimeDir, events: { publish() {} }, stageInputs: async () => {}, launch: (_spec, receive, done) => { message = receive; exit = done; return { cancel() { cancelled = true; }, kill(signal) { killed = signal; } }; }, ...options };
  return { dependencies, controller: createPipelineController(dependencies), message: value => message(value), exit: code => exit(code), cancelled: () => cancelled, killed: () => killed };
}

test('pipeline keeps rendering active until verification/export and clean worker exit', async t => {
  const f = fixture(t);
  const started = await f.controller.start(example, { backendId: 'cpu' }, '.');
  const id = started.run.runId;
  f.message({ kind: 'stage', stageId: 'render', status: 'running' });
  f.message({ kind: 'progress', stageId: 'render', progress: { completed: 20, total: 100, unit: 'frames', mode: 'measured' } });
  assert.equal(f.controller.get(id).status, 'running');
  assert.equal(f.controller.get(id).stages.find(s => s.id === 'render').progress.completed, 20);
  f.message({ kind: 'result', result: { files: [] } });
  assert.equal(f.controller.get(id).status, 'running');
  for (const stage of started.run.stages) f.message({ kind: 'stage', stageId: stage.id, status: 'completed' });
  f.exit(0);
  assert.equal(f.controller.get(id).status, 'completed');
  const reopened = createPipelineController(f.dependencies);
  assert.equal(reopened.get(id).status, 'completed');
  assert.deepEqual(reopened.replay(id, 2).map(e => e.sequence), Array.from({ length: 12 }, (_, i) => i + 3));
});

test('concurrent starts cannot both enter staging or allocate', async t => {
  let release;
  const f = fixture(t, { stageInputs: () => new Promise(resolve => { release = resolve; }) });
  const first = f.controller.start(example, { backendId: 'cpu' }, '.');
  const second = await f.controller.start(example, { backendId: 'cpu' }, '.');
  assert.equal(second.status, 409);
  release(); await first; f.exit(1);
});

test('bounded concurrent pipelines isolate workspaces, cancellation and capacity including staging', async t => {
  const releases = [], workers = [];
  const operations = createOperationCoordinator();
  const f = fixture(t, { operations, maxConcurrent: 2, parallelAdmission: ({ pkg }) => pkg.id !== 'pkg_owner',
    stageInputs: () => new Promise(resolve => releases.push(resolve)),
    launch: (path, receive, done) => {
      const worker = { spec: JSON.parse(readFileSync(path)), receive, done, cancelled: false };
      workers.push(worker);
      return { cancel() { worker.cancelled = true; }, kill() {} };
    },
  });
  t.after(() => f.controller.close());
  const secondPkg = { ...example, id: 'pkg_parallel_second' };
  const first = f.controller.start(example, { backendId: 'cpu' }, '.');
  assert.equal((await f.controller.start(example, { backendId: 'cpu' }, '.')).status, 409);
  const second = f.controller.start(secondPkg, { backendId: 'cpu' }, '.');
  assert.equal(releases.length, 2);
  const full = await f.controller.start({ ...example, id: 'pkg_over_capacity' }, { backendId: 'cpu' }, '.');
  assert.equal(full.status, 409);
  assert.equal(full.submission, 'not_submitted');
  assert.equal(full.runId, undefined);
  assert.equal((await f.controller.start({ ...example, id: 'pkg_owner' }, { backendId: 'colab', budgetUnits: 1 }, '.')).status, 409);
  assert.equal(operations.tryAcquire('export', 'export_during_staging').busy, true);
  releases.forEach(release => release());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(workers.length, 2);
  const runningFull = await f.controller.start({ ...example, id: 'pkg_over_capacity' }, { backendId: 'cpu' }, '.');
  assert.equal(runningFull.holderRunId, a.run.runId);
  assert.equal(runningFull.runId, undefined);
  assert.notEqual(workers[0].spec.workDir, workers[1].spec.workDir);
  assert.notEqual(workers[0].spec.runDir, workers[1].spec.runDir);
  f.controller.cancel(a.run.runId);
  assert.equal(workers[0].cancelled, true);
  assert.equal(workers[1].cancelled, false);
  workers[0].receive({ kind: 'cancelled' }); workers[0].done(1);
  assert.equal(f.controller.active(), true);
  assert.equal(operations.tryAcquire('render', 'render_after_one_cancel').busy, true);
  assert.equal((await f.controller.start({ ...example, id: 'pkg_owner' }, { backendId: 'colab', budgetUnits: 1 }, '.')).status, 409);
  for (const stage of b.run.stages) workers[1].receive({ kind: 'stage', stageId: stage.id, status: 'completed' });
  workers[1].receive({ kind: 'result', result: { files: [] } }); workers[1].done(0);
  assert.equal(f.controller.get(a.run.runId).status, 'cancelled');
  assert.equal(f.controller.get(b.run.runId).status, 'completed');
  assert.equal(f.controller.active(), false);
  assert.equal(operations.status().busy, false);
});

test('increasing capacity alone never enables owner parallelism, including owner staging', async t => {
  let release;
  const f = fixture(t, { maxConcurrent: 4, stageInputs: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => f.controller.close());
  const pending = f.controller.start(example, { backendId: 'colab', budgetUnits: 1 }, '.');
  const next = { ...example, id: 'pkg_second_owner' };
  assert.equal((await f.controller.start(next, { backendId: 'colab', budgetUnits: 1 }, '.')).status, 409);
  release(); await pending;
  assert.equal((await f.controller.start(next, { backendId: 'colab', budgetUnits: 1 }, '.')).status, 409);
  f.exit(1);
});

test('an exclusive owner excludes trusted invite work until its worker exits', async t => {
  const f = fixture(t, { maxConcurrent: 4, parallelAdmission: ({ pkg }) => pkg.id === 'pkg_invite' });
  t.after(() => f.controller.close());
  await f.controller.start(example, { backendId: 'colab', budgetUnits: 1 }, '.');
  assert.equal((await f.controller.start({ ...example, id: 'pkg_invite' }, { backendId: 'cpu' }, '.')).status, 409);
  f.message({ kind: 'failed', message: 'failure before process close' });
  assert.equal(f.controller.accountBusy(), true);
  assert.equal((await f.controller.start({ ...example, id: 'pkg_invite' }, { backendId: 'cpu' }, '.')).status, 409);
  f.exit(1);
  assert.equal(f.controller.accountBusy(), false);
});

test('unconfirmed shutdown retains account and operation exclusion through close, restart and reconciliation', async t => {
  const operations = createOperationCoordinator();
  const f = fixture(t, { operations });
  const { run } = await f.controller.start(example, { backendId: 'colab', budgetUnits: 1 }, '.');
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'allocating', ownership: 'managed' } });
  assert.equal(f.controller.accountBusy(), true);
  const deniedAuth = () => startColabAuth({ isBusy: () => f.controller.accountBusy(), spawn() { throw new Error('must never spawn auth'); } });
  assert.equal((await deniedAuth()).errorCode, 'COLAB_ACCOUNT_BUSY');
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'running', ownership: 'managed' } });
  assert.equal((await deniedAuth()).errorCode, 'COLAB_ACCOUNT_BUSY');
  f.controller.close();
  assert.equal(operations.status().busy, true, 'close only requests cancellation');
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'stop_unconfirmed', ownership: 'managed' } });
  f.message({ kind: 'cancelled' }); f.exit(1);
  assert.equal(operations.status().busy, true);
  const recoveredOperations = createOperationCoordinator();
  const recovered = createPipelineController({ ...f.dependencies, operations: recoveredOperations });
  t.after(() => recovered.close());
  assert.equal(recovered.accountBusy(), true);
  assert.equal(recoveredOperations.tryAcquire('export', 'blocked_export').busy, true);
  assert.equal(recovered.reconcile(run.runId).status, 202);
  assert.equal(recovered.accountBusy(), true);
  assert.equal((await startColabAuth({ isBusy: () => recovered.accountBusy(), spawn() { throw new Error('must never spawn auth'); } })).errorCode, 'COLAB_ACCOUNT_BUSY');
  f.exit(1);
  assert.equal(recovered.accountBusy(), true, 'unsuccessful reconcile retains ownership');
  assert.equal(recovered.reconcile(run.runId).status, 202);
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'stopped', ownership: 'managed' } }); f.exit(0);
  assert.equal(recovered.accountBusy(), false);
  assert.equal(recoveredOperations.status().busy, false);
});

test('active auth prevents paid pipeline admission but allows zero-budget CPU work', async t => {
  const f = fixture(t);
  t.after(() => f.controller.close());
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const pending = startColabAuth({ home: '/nonexistent-home', spawn: () => child });
  try {
    const paid = await f.controller.start(example, { backendId: 'colab', budgetUnits: 1 }, '.');
    assert.equal(paid.code, 'COLAB_AUTH_BUSY');
    assert.equal(paid.submission, 'not_submitted');
    const cpu = await f.controller.start(example, { backendId: 'cpu', budgetUnits: 0 }, '.');
    assert.equal(cpu.status, 202);
    assert.equal(f.controller.accountBusy(), false);
    f.exit(1);
  } finally { child.emit('close', 0); await pending; }
});

test('cancellation remains cancelling until cleanup returns; never completes with a late result', async t => {
  const f = fixture(t), { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  f.controller.cancel(run.runId);
  assert.equal(f.cancelled(), true);
  assert.equal(f.controller.get(run.runId).status, 'cancelling');
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'stopped' } });
  f.message({ kind: 'cancelled', message: 'Cancelled after cleanup' });
  f.message({ kind: 'result', result: {} }); f.exit(0);
  assert.equal(f.controller.get(run.runId).status, 'cancelled');
  assert.equal(f.controller.get(run.runId).runtimes.media.state, 'stopped');
});

test('restart marks an in-flight allocation interrupted and shutdown unconfirmed', async t => {
  const f = fixture(t), { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'allocating' } });
  const restored = createPipelineController(f.dependencies).get(run.runId);
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.runtimes.media.state, 'stop_unconfirmed');
  assert.equal(restored.result, null);
});

test('paid approval binds voice, project content and allocation ceilings', () => {
  const pkg = structuredClone(example);
  pkg.voice = { enabled: true, engine: 'qwen3-tts', strict: true, voice: 'test-narrator' };
  pkg.scenes[0].narration = 'A new narrated scene.';
  const options = { backendId: 'colab', budgetUnits: 4, narrationUnits: 2 };
  const before = planPipeline(pkg, options);
  assert.equal(before.requiresApproval, true);
  pkg.scenes[0].narration = 'Changed speech.';
  assert.notEqual(planPipeline(pkg, options).planHash, before.planHash);
  assert.notEqual(planPipeline(pkg, { ...options, budgetUnits: 5 }).planHash, before.planHash);
});

test('a configured music-only mix requires final audio verification', () => {
  const pkg = structuredClone(example);
  assert.equal(planPipeline(pkg, { backendId: 'cpu' }).requiresAudio, false);
  pkg.assets.a_score = {
    kind: 'audio', origin: 'generated', status: 'ready', file: 'assets/score.wav',
    sha256: '0'.repeat(64), bytes: 44, media: { durationSeconds: 1 },
    gen: { generator: 'procedural-audio', model: 'deterministic-pcm-v2', inputs: { plan: 'test score', seed: 1 } },
    license: { id: 'CC0-1.0' }, redistributable: true,
  };
  pkg.audio = { music: { asset: 'a_score' } };
  assert.equal(planPipeline(pkg, { backendId: 'cpu' }).requiresAudio, true);
});

test('render location defaults to local and is part of the approved plan', () => {
  const local = planPipeline(example, { backendId: 'cpu' });
  assert.equal(local.options.renderLocation, 'local');
  assert.equal(local.remoteRender, false);
  assert.equal(planPipeline(example, { backendId: 'cpu', renderLocation: 'local' }).planHash, local.planHash);
  assert.notEqual(planPipeline(example, { backendId: 'cpu', renderLocation: 'colab' }).planHash, local.planHash);
  assert.throws(() => planPipeline(example, { renderLocation: 'remote' }), /Unknown render location/);
});

test('Google Colab rendering requires that backend and a generated-media session', () => {
  const wrong = planPipeline(example, { backendId: 'cpu', renderLocation: 'colab' });
  assert.equal(wrong.remoteRender, false);
  assert.equal(wrong.ready, false);
  assert.ok(wrong.issues.some(issue => issue.code === 'REMOTE_RENDER_REQUIRES_GOOGLE_COLAB'));
  const idle = planPipeline(example, { backendId: 'colab', budgetUnits: 1, renderLocation: 'colab' });
  assert.equal(idle.remoteRender, false);
  assert.match(idle.remoteRenderNote, /stays on this machine/);
  assert.equal(idle.issues.some(issue => issue.code === 'REMOTE_RENDER_REQUIRES_GOOGLE_COLAB'), false);
  const data = JSON.parse(readFileSync(new URL('../../../examples/data-story/package.json', import.meta.url)));
  for (const asset of Object.values(data.assets)) if (asset.gen?.workflow) asset.gen.workflow_sha256 = '0'.repeat(64);
  const remote = planPipeline(data, { backendId: 'colab', budgetUnits: 4, narrationUnits: 0, renderLocation: 'colab' });
  assert.equal(remote.options.renderLocation, 'colab');
  assert.equal(remote.remoteRender, true);
  assert.match(remote.remoteRenderNote, /Google Colab VM/);
  assert.match(remote.budget.estimateNote, /final render/);
});

test('split JSON records and trailing records survive transport boundaries', () => {
  const events = [], lines = progressLines(e => events.push(e));
  lines.write('{"event":"pro'); lines.write('gress","value":0.'); lines.write('5}\n{"event":"job_done"}'); lines.end();
  assert.deepEqual(events, [{ event: 'progress', value: 0.5 }, { event: 'job_done' }]);
});

test('presenter correction is bounded, confidence-gated and uses native frame rate', () => {
  assert.equal(correctionFor({ passed: false, confidence: 9, offsetMs: -120 }, 24), 3);
  assert.equal(correctionFor({ passed: false, confidence: 9, offsetMs: 160 }, 24), -4);
  assert.equal(correctionFor({ passed: true }, 24), 0);
  assert.throws(() => correctionFor({ confidence: 0.8, offsetMs: -120 }, 24), /unreliable/);
  assert.throws(() => correctionFor({ confidence: 9, offsetMs: 560 }, 24), /bounded/);
});

test('default and bookend presenter coverage match renderer semantics', () => {
  const pkg = { presenter: { enabled: true }, scenes: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] };
  assert.deepEqual(selectedPresenterScenes(pkg).map(s => s.id), ['s1', 's3']);
  pkg.presenter.scenes = 'bookends';
  assert.deepEqual(selectedPresenterScenes(pkg).map(s => s.id), ['s1', 's3']);
  pkg.presenter.scenes = 'all'; pkg.scenes[0].presenter = 'off';
  assert.deepEqual(selectedPresenterScenes(pkg).map(s => s.id), ['s2', 's3']);
});

test('pipeline history redacts credentials before persistence and replay', async t => {
  const f = fixture(t), { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  const secret = 'hf_' + 'a'.repeat(34);
  f.message({ kind: 'diagnostic', message: `token ${secret}` });
  assert.ok(!JSON.stringify(f.controller.replay(run.runId)).includes(secret));
  f.exit(1);
});

test('reconciliation blocks new work until managed runtime shutdown is confirmed', async t => {
  const f = fixture(t), { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'stop_unconfirmed', ownership: 'managed' } });
  f.message({ kind: 'failed', message: 'Lost execution' }); f.exit(1);
  assert.equal((await f.controller.start(example, { backendId: 'cpu' }, '.')).status, 409);
  assert.equal(f.controller.reconcile(run.runId).status, 202);
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'stopped', ownership: 'managed' } }); f.exit(0);
  assert.equal(f.controller.get(run.runId).status, 'failed', 'reconciliation does not pretend the video succeeded');
  const next = await f.controller.start(example, { backendId: 'cpu' }, '.');
  assert.equal(next.status, 202); f.exit(1);
});

test('a truncated journal tail cannot erase shutdown state or break reconnect replay', async t => {
  const f = fixture(t), { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'allocating' } });
  appendFileSync(join(f.dependencies.runtimeDir, 'pipelines', run.runId, 'events.jsonl'), '{"partiallyWritten":');
  const recovered = createPipelineController(f.dependencies);
  assert.equal(recovered.get(run.runId).runtimes.media.state, 'stop_unconfirmed');
  assert.equal(recovered.replay(run.runId).at(-1).kind, 'interrupted');
});

// PO-4: a reconcile whose CLI never answers left the run blocking every new pipeline, with no way to stop
// it. It now has a deadline, a kill after a grace period, and a durable outcome on the record.
test('a reconcile that never returns is stopped by its deadline and stays unconfirmed', async t => {
  const f = fixture(t, { reconcileTimeoutMs: 30, reconcileStopGraceMs: 20 });
  const { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'stop_unconfirmed', ownership: 'managed' } });
  f.message({ kind: 'failed', message: 'Lost execution' }); f.exit(1);
  assert.equal(f.controller.reconcile(run.runId).status, 202);
  assert.equal(f.controller.get(run.runId).reconcile.confirmed, null, 'in flight is not a verdict');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.controller.get(run.runId).reconcile.timedOut, true);
  assert.equal(f.cancelled(), true, 'the reconcile worker is asked to stop first');
  assert.equal(f.killed(), 'SIGKILL', 'and killed when it does not');
  f.exit(null);
  const record = f.controller.get(run.runId);
  assert.equal(record.status, 'failed', 'the run keeps its own outcome; it was the reconcile that failed');
  assert.equal(record.reconcile.confirmed, false);
  assert.match(record.reconcile.message, /not confirmed within/);
  assert.equal(record.runtimes.media.state, 'stop_unconfirmed');
  assert.equal((await f.controller.start(example, { backendId: 'cpu' }, '.')).status, 409, 'unconfirmed shutdown still blocks');
});

test('a reconcile can be cancelled without marking the run itself cancelled', async t => {
  const f = fixture(t, { reconcileTimeoutMs: 60000 });
  const { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  f.message({ kind: 'runtime', runtime: 'media', value: { state: 'stop_unconfirmed', ownership: 'managed' } });
  f.message({ kind: 'failed', message: 'Lost execution' }); f.exit(1);
  f.controller.reconcile(run.runId);
  const cancelling = f.controller.cancel(run.runId);
  assert.equal(cancelling.status, 'reconciling', 'the run is not the thing being cancelled');
  assert.equal(cancelling.reconcile.cancelled, true);
  assert.equal(f.cancelled(), true);
  f.exit(1);
  const record = f.controller.get(run.runId);
  assert.equal(record.reconcile.cancelled, true);
  assert.equal(record.reconcile.confirmed, false);
  assert.equal(record.status, 'failed');
});

// PO-4: the busy flag lived in memory only, so two servers on one runtime directory both accepted runs.
test('one runtime directory admits one server process, and a dead owner does not lock the next one', async t => {
  const f = fixture(t), { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  f.exit(1);
  // Same process: a supervisor (or a test) re-creating the controller is not a second server.
  const reopened = createPipelineController(f.dependencies);
  assert.equal(reopened.get(run.runId).status, 'failed');
  const lock = join(f.dependencies.runtimeDir, 'pipelines', 'owner.json');
  assert.equal(JSON.parse(readFileSync(lock)).pid, process.pid);
  // Another live process owns the directory: refuse, with a message that says what to do.
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: new Date().toISOString() }));
  assert.throws(() => createPipelineController(f.dependencies), /belongs to another Comfyrizz server/);
  // A lock left behind by a process that no longer exists is taken over instead of blocking forever.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(lock, JSON.stringify({ pid: Number(dead), host: hostname(), startedAt: new Date().toISOString() }));
  assert.doesNotThrow(() => createPipelineController(f.dependencies));
});

// PO-4 review: a lock written by another host could never go stale, and the error did not name the file.
test('a foreign-host lock goes stale after its heartbeat ages out, and --take-over overrides a live one', async t => {
  const f = fixture(t);
  const lock = join(f.dependencies.runtimeDir, 'pipelines', 'owner.json');
  const fresh = new Date().toISOString();
  writeFileSync(lock, JSON.stringify({ pid: 4242, host: 'some-other-host', startedAt: fresh, heartbeatAt: fresh }));
  assert.throws(() => createPipelineController(f.dependencies), error => error.message.includes(lock) && /--take-over/.test(error.message));
  // An explicit takeover replaces a live foreign lock.
  const taken = createPipelineController({ ...f.dependencies, takeOver: true });
  assert.equal(JSON.parse(readFileSync(lock)).host, hostname());
  taken.close();
  // A foreign lock whose heartbeat is older than the staleness window is taken over without a flag.
  const old = new Date(Date.now() - 11 * 60000).toISOString();
  writeFileSync(lock, JSON.stringify({ pid: 4242, host: 'some-other-host', startedAt: old, heartbeatAt: old }));
  const reclaimed = createPipelineController(f.dependencies);
  const owner = JSON.parse(readFileSync(lock));
  assert.equal(owner.pid, process.pid);
  assert.ok(owner.heartbeatAt, 'the new owner records a heartbeat');
  reclaimed.close();
  // An old lock with only startedAt (written before heartbeats) also ages out.
  writeFileSync(lock, JSON.stringify({ pid: 4242, host: 'some-other-host', startedAt: old }));
  assert.doesNotThrow(() => createPipelineController(f.dependencies).close());
  // ...but the window is configurable.
  writeFileSync(lock, JSON.stringify({ pid: 4242, host: 'some-other-host', startedAt: old, heartbeatAt: old }));
  assert.throws(() => createPipelineController({ ...f.dependencies, ownerStaleMs: 60 * 60000 }), /belongs to another Comfyrizz server/);
});

// PO-4: replay re-read and re-parsed the whole journal on every poll.
test('replay reads only the events appended since the last poll, and tolerates a torn tail', async t => {
  const f = fixture(t), { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  const first = f.controller.replay(run.runId);
  assert.equal(first.length, 1, 'started');
  f.message({ kind: 'diagnostic', message: 'first' });
  const second = f.controller.replay(run.runId, first.at(-1).sequence);
  assert.deepEqual(second.map(event => event.sequence), [2]);
  // A crashed writer can leave a partial line. Until it is terminated it is not an event, and it cannot
  // hide the events that follow once the line is closed (the restart path appends the missing newline).
  const journal = join(f.dependencies.runtimeDir, 'pipelines', run.runId, 'events.jsonl');
  appendFileSync(journal, '{"partiallyWritten":');
  assert.deepEqual(f.controller.replay(run.runId, 2), [], 'a torn tail is not replayed as an event');
  appendFileSync(journal, '\n');
  f.message({ kind: 'diagnostic', message: 'second' });
  const third = f.controller.replay(run.runId, 2);
  assert.deepEqual(third.map(event => event.message).filter(Boolean), ['second']);
  assert.deepEqual(f.controller.replay(run.runId).map(event => event.sequence), [1, 2, 3], 'incremental reads keep the order');
  f.exit(1);
});

test('a heartbeat updates the record without appending a journal line every ten seconds', async t => {
  const f = fixture(t), { run } = await f.controller.start(example, { backendId: 'cpu' }, '.');
  const before = f.controller.replay(run.runId).length;
  f.message({ kind: 'heartbeat', stageId: 'render' });
  assert.equal(f.controller.replay(run.runId).length, before, 'a heartbeat is not a durable event');
  assert.ok(f.controller.get(run.runId).lastHeartbeatAt, 'but the record still says the worker is alive');
  assert.equal(f.controller.get(run.runId).heartbeatStage, 'render');
  f.exit(1);
});

test('presenter plans warn when SyncNet is unset and do not block on that warning', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/presenter-demo/package.json', import.meta.url)));
  assert.equal(syncnetConfigured({}), false);
  const skipped = syncnetDiagnostics({});
  assert.equal(skipped.syncnet.configured, false);
  assert.equal(skipped.syncnet.code, 'SYNCNET_UNAVAILABLE');
  assert.match(skipped.syncnet.message, /SyncNet is not configured/);
  assert.equal(Object.hasOwn(skipped.syncnet, 'path'), false);

  const plan = planPipeline(pkg, { backendId: 'cpu' }, { env: {} });
  const warning = plan.warnings.find((entry) => entry.code === 'SYNCNET_UNAVAILABLE');
  assert.ok(warning, JSON.stringify(plan.warnings));
  assert.match(warning.message, /SyncNet is not configured/);
  assert.match(warning.message, /Keep or Reject/);
  assert.equal(plan.issues.some((issue) => /SYNCNET/.test(issue.code)), false);
  assert.equal(plan.ready, plan.issues.length === 0);
});

test('a configured SyncNet install omits the presenter skip warning', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/presenter-demo/package.json', import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), 'syncnet-ready-'));
  try {
    const python = join(dir, 'python');
    const modelDir = join(dir, 'syncnet');
    mkdirSync(modelDir);
    writeFileSync(python, '');
    writeFileSync(join(modelDir, 'syncnet_v2.model'), '');
    const env = { COMFYRIZZ_SYNCNET_PYTHON: python, COMFYRIZZ_SYNCNET_DIR: modelDir };
    assert.equal(syncnetConfigured(env), true);
    assert.deepEqual(syncnetDiagnostics(env), { syncnet: { configured: true } });
    const plan = planPipeline(pkg, { backendId: 'cpu' }, { env });
    assert.equal(plan.warnings.some((entry) => entry.code === 'SYNCNET_UNAVAILABLE'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
