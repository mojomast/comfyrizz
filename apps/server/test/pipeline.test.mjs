import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipelineController } from '../src/pipeline.mjs';
import { planPipeline, selectedPresenterScenes } from '../src/pipeline-contract.mjs';
import { correctionFor } from '../src/pipeline-media.mjs';
import { progressLines } from '../../../packages/backends/src/progress-lines.mjs';

const example = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url)));
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
