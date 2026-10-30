// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { generationStatusOf, withGenerationStatus } from './generation-status.ts';
import { renderGenerationStatus } from './generation-status-view.ts';
import { pollFinalRun } from './run.ts';
import { createSuperEasySession } from './session.ts';
import { createEasyStore } from '../store.ts';

const runId = 'run_123456789abc', productionId = 'prod_activity', packageId = 'pkg_activity';
const base = { runId, productionId, packageId, status: 'running', startedAt: '2026-10-30T10:00:00Z', jobs: 2,
  events: [{ event: 'run_phase', phase: 'generating' }, { event: 'job_start', job: 'a.plate', at: '2026-10-30T10:00:01Z' }],
  result: { jobsDoc: { jobs: [{ id: 'a.plate', model: 'ltx-2.5' }] } } };
const failed = { ...base, status: 'failed', counts: { succeeded: 2 }, errorCode: 'RENDER_FAILED', error: 'Visible contribution gate rejected the final render.',
  finishedAt: '2026-10-30T10:02:00Z', teardown: { state: 'stopped' }, manifest: { jobs: [{ job: 'a.plate', status: 'succeeded', outputs: [{ relative: 'a.mp4' }] }] } };
const journal = () => ({ production: { id: productionId, packageId }, shots: [{ id: 's1', url: '/api/media/ready', status: 'ready' }], events: [
  { type: 'plan.proposed', productionId, data: { planHash: 'plan' } },
  { type: 'action.state_changed', productionId, data: { kind: 'final', productionId, runId, planHash: 'plan', state: 'running' } },
] });

test('actual job, model and event timestamp remain stable across unchanged polls without fabricated percentages', () => {
  const first = generationStatusOf(base, null, 'owner-run', Date.parse('2026-10-30T10:00:10Z'));
  const again = generationStatusOf(base, first, 'owner-run', Date.parse('2026-10-30T10:02:00Z'));
  assert.equal(again.progressAt, first.progressAt); assert.equal(again.observedChangeAt, first.observedChangeAt);
  assert.equal(again.jobId, 'a.plate'); assert.equal(again.model, 'ltx-2.5');
  const html = renderGenerationStatus({ generationStatus: again }, Date.parse('2026-10-30T10:02:00Z'));
  assert.match(html, /no update since 1m 59s ago/); assert.doesNotMatch(html, /\d+%|stalled/);
});

test('completed generation jobs do not hide a failed render or confirmed GPU stop', () => {
  const snapshot = withGenerationStatus(journal(), failed, 'owner-run');
  assert.equal(snapshot.shots.length, 1); assert.equal(snapshot.run.manifest.jobs[0].outputs.length, 1);
  assert.equal(snapshot.generationStatus.stage, 'render');
  const html = renderGenerationStatus(snapshot);
  assert.match(html, /status: failed/); assert.match(html, /2 \/ 2/); assert.match(html, /GPU stop confirmed/);
  assert.match(html, /contribution gate rejected/); assert.doesNotMatch(html, /Making your video/);
});

test('unresolved hosted usage never turns a zero estimate into a free or settled charge', () => {
  const status = generationStatusOf({ status: 'completed', spentEstimateCu: 0,
    accounting: { status: 'unresolved', reservedEstimateCu: 3, actualSpendCu: 0 } }, null, 'hosted-result');
  assert.equal(status.accounting.actualSpendCu, null);
  const html = renderGenerationStatus({ generationStatus: status });
  assert.match(html, /Usage indeterminate; CU reserved/);
  assert.match(html, /Reserved allowance: 3 CU/);
  assert.doesNotMatch(html, /Verified usage: 0|no Google Colab CU charged/);
});

test('paused, queued, disconnected and absent hosted metadata are distinct without inventing model or stage', () => {
  for (const status of ['paused', 'queued']) assert.equal(generationStatusOf({ status }).status, status);
  const unknown = generationStatusOf({ status: 'running' }, null, 'hosted-result');
  assert.equal(unknown.model, null); assert.equal(unknown.total, null); assert.equal(unknown.startedAt, null);
  const html = renderGenerationStatus({ generationStatus: { ...unknown, connection: 'unknown' } });
  assert.match(html, /Connection interrupted/); assert.match(html, /does not confirm/); assert.match(html, /Not reported/);
});

test('polling publishes failed and cancelled records with artifacts before rejecting', async () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const records = [];
    await assert.rejects(pollFinalRun({ getRun: async () => ({ run: { ...failed, status } }) }, runId,
      { onRecord: record => records.push(record) }), /contribution gate/);
    assert.equal(records[0].status, status); assert.equal(records[0].manifest.jobs.length, 1);
  }
});

test('polling connection failures retry reads only and report reconnection without replaying work', async () => {
  let calls = 0; const connections = [];
  const result = await pollFinalRun({ getRun: async () => { if (++calls === 1) throw Error('offline'); return { ...base, status: 'done' }; } }, runId,
    { setTimer: cb => cb(), onConnection: state => connections.push(state) });
  assert.equal(result.status, 'done'); assert.deepEqual(connections, [false, true]); assert.equal(calls, 2);
});

function sessionHarness(hosted = false) {
  const store = createEasyStore({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  store.patch({ packageId, productionId, generate: { status: 'running' } });
  let listener, stops = 0, record = failed;
  const calls = [], api = { getRun: async id => { calls.push(['owner', id]); return { run: record }; },
    guestResult: async id => { calls.push(['guest', id]); return record; } };
  const session = createSuperEasySession({ api, store, hostedInvite: hosted, host: { getPackage: () => ({ id: packageId }) }, go() {},
    watch: options => { listener = options.onState; return () => { stops++; }; } });
  return { session, store, calls, listener: () => listener, stops: () => stops, set: value => { record = value; }, api };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('reload follows actual owner failure read-only, preserves completed media, and ends the watch', async () => {
  const h = sessionHarness(); h.session.resumeGeneration(journal()); await settle();
  assert.equal(h.session.status(), 'error'); assert.match(h.session.failure().message, /contribution gate/);
  assert.equal(h.session.failure().retryable, false); assert.equal(h.stops(), 1);
  assert.equal(h.session.snapshot().shots.length, 1); assert.equal(h.session.snapshot().run.counts.succeeded, 2);
  assert.deepEqual(h.calls, [['owner', runId]]);
  h.session.stop();
});

test('hosted failed or cancelled results use guest API only and stop making-video state', async () => {
  for (const status of ['failed', 'cancelled']) {
    const h = sessionHarness(true); h.set({ ...failed, status }); h.session.resumeGeneration(journal()); await settle();
    assert.equal(h.session.status(), status === 'failed' ? 'error' : 'stopped');
    assert.equal(h.calls.some(([kind]) => kind === 'owner'), false); assert.equal(h.stops(), 1);
    h.session.stop();
  }
});

test('detaching a reload observer discards late results without cancelling server execution', async () => {
  const h = sessionHarness(); let release;
  h.api.getRun = () => new Promise(resolve => { release = resolve; });
  h.session.resumeGeneration(journal()); h.session.detachGeneration(); release({ run: failed }); await settle();
  assert.equal(h.session.failure(), null); assert.equal(h.stops(), 1); h.session.stop();
});

test('switching packages discards a late owner or hosted execution record', async () => {
  for (const hosted of [false, true]) {
    const h = sessionHarness(hosted); let release;
    h.api[hosted ? 'guestResult' : 'getRun'] = () => new Promise(resolve => { release = resolve; });
    h.session.resumeGeneration(journal()); h.store.patch({ packageId: 'pkg_other' });
    release(hosted ? failed : { run: failed }); await settle();
    assert.equal(h.session.failure(), null); assert.equal(h.session.snapshot().generationStatus, undefined);
    h.session.stop();
  }
});

test('completed hosted runs without media or with unconfirmed stop never become final success', async () => {
  for (const result of [
    { status: 'completed' },
    { status: 'completed', url: '/api/media/' + 'a'.repeat(32), teardown: { state: 'stop_unconfirmed' } },
  ]) {
    const h = sessionHarness(true); h.set(result); h.session.resumeGeneration(journal()); await settle();
    assert.equal(h.session.status(), 'error'); assert.equal(h.session.failure().retryable, false);
    assert.equal(h.stops(), 1); h.session.stop();
  }
});

test('terminal timestamps are never fabricated from the observation clock', () => {
  const status = generationStatusOf({ status: 'failed', startedAt: base.startedAt }, null, 'hosted-result');
  assert.equal(status.finishedAt, null);
  assert.match(renderGenerationStatus({ generationStatus: status }), /Completion time not reported/);
});
