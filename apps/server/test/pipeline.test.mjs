import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  let message, exit, cancelled = false;
  const dependencies = { runtimeDir, events: { publish() {} }, stageInputs: async () => {}, launch: (_spec, receive, done) => { message = receive; exit = done; return { cancel() { cancelled = true; } }; }, ...options };
  return { dependencies, controller: createPipelineController(dependencies), message: value => message(value), exit: code => exit(code), cancelled: () => cancelled };
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
