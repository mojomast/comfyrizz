import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRunSnapshot, runProgressSummary, runIsActive } from '../src/run-progress.ts';
import { backendProgressHtml } from '../src/colab-progress.ts';

test('reload restores an active run without a run.started replay event', async () => {
  const snapshot = { runId: 'run_active', backendId: 'colab', status: 'running', jobs: 101,
    events: [{ type: 'collection_progress', completed: 123, total: 221, file: 'assets/keyframe.png' }] };
  const calls = [];
  const restored = await readRunSnapshot(async path => {
    calls.push(path);
    return Response.json(path === '/api/run' ? { activeRunId: snapshot.runId, runs: [{ runId: 'run_old' }] } : { run: snapshot });
  });
  assert.deepEqual(restored, snapshot);
  assert.deepEqual(calls, ['/api/run', '/api/run/run_active']);
  assert.equal(runIsActive(restored), true);
});

test('collection progress remains visible between generation batches and counts distinct jobs', () => {
  const run = { runId: 'run_active', backendId: 'colab', status: 'running', jobs: 101, events: [
    { event: 'job_done', job: 'a_key.still' }, { event: 'job_done', job: 'a_key.still' },
    { type: 'collection_progress', completed: 123, total: 221, file: 'assets/<key>.png' },
    { type: 'list_out', code: 0 },
  ] };
  assert.deepEqual(runProgressSummary(run), { label: 'Downloading generated files', detail: '123 / 221 files · assets/<key>.png', completed: 1, total: 101, percent: 100 / 101 });
  assert.match(backendProgressHtml(run), /assets\/&lt;key&gt;\.png/);
  run.status = 'failed';run.error = 'Allocation ended';
  assert.equal(runIsActive(run), false);
  assert.equal(runProgressSummary(run).detail, 'Allocation ended');
});

test('empty history is empty, finished history remains readable, and request failures stay explicit', async () => {
  assert.equal(await readRunSnapshot(async () => Response.json({ runs: [] })), null);
  const run = { runId: 'run_done', backendId: 'colab', status: 'done', events: [] };
  assert.deepEqual(await readRunSnapshot(async path => Response.json(path === '/api/run' ? { activeRunId: null, runs: [{ runId: run.runId }] } : { run })), run);
  await assert.rejects(readRunSnapshot(async () => new Response('', { status: 503 })), /HTTP 503/);
});
