import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createRunController } from '../src/run.mjs';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const EXAMPLE_PACKAGE = JSON.parse(readFileSync(join(repoRoot, 'examples', 'launch-demo', 'package.json'), 'utf8'));

function fixturePackage() {
  return structuredClone(EXAMPLE_PACKAGE);
}

/**
 * A fake backend whose `runPackage` is the only run entry point (C9): the controller must delegate
 * to it rather than re-implement the plan/up/run/collect/teardown sequence.
 */
function fakeBackend(id, { gpuMinutes = 2, teardownState = 'stopped', failRun = false } = {}) {
  const calls = [];
  const backend = {
    id,
    calls,
    async describe() {
      return { label: id === 'colab' ? 'Google Colab G4' : 'Your own ComfyUI', costVisibility: id === 'colab' ? 'account-estimate' : 'external-unknown' };
    },
    async runPackage(pkg, opts = {}) {
      const dry = opts.dryRun === true;
      calls.push(['runPackage', dry]);
      const emit = opts.onEvent ?? (() => {});
      const jobsDoc = { jobs: [{ id: 'j1' }] };
      const estimate = { gpuMinutes: gpuMinutes, overheadMinutes: 5, ratePerHour: 8.9 };
      emit({ v: 1, event: 'run_phase', phase: 'planned', jobs: jobsDoc.jobs.length });
      if (dry) return { workDir: opts.workDir ?? null, outDir: opts.outDir ?? null, jobsDoc, estimate, dryRun: true, teardown: null };
      emit({ v: 1, event: 'run_phase', phase: 'up', state: 'started' });
      if (failRun) {
        const teardown = await backend.teardown('error');
        const error = new Error('job blew up');
        error.runPackage = { jobsDoc, estimate, teardown, package: null, manifest: null, counts: null };
        throw error;
      }
      emit({ v: 1, event: 'run_phase', phase: 'ran', counts: { succeeded: 1 } });
      emit({ v: 1, event: 'run_phase', phase: 'applied', assets: 0, candidates: 0 });
      const teardown = await backend.teardown('done');
      emit({ v: 1, event: 'run_phase', phase: 'teardown', state: teardown.state });
      return {
        workDir: opts.workDir ?? null,
        outDir: opts.outDir ?? null,
        jobsDoc,
        estimate,
        manifest: { complete: true, counts: { succeeded: 1 } },
        counts: { succeeded: 1 },
        ok: true,
        package: pkg,
        applied: [],
        candidates: [],
        untouched: [],
        teardown,
      };
    },
    async teardown(reason) {
      calls.push(['teardown', reason]);
      return { state: teardownState, evidence: `fake teardown (${reason})` };
    },
  };
  return backend;
}

/** A stub render that never touches Remotion: the run controller only forwards its result. */
const stubRender = async () => ({ output: '/tmp/run.mp4', bytes: 1234, frames: 7, hash: 'stub' });

function makeApp({ factory }) {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-run-'));
  const app = createApp({ token: TOKEN, runtimeDir: runtime, backendFactory: factory, render: stubRender });
  return { app, runtime };
}

test('colab run needs approval, then runs the lifecycle and reports estimate spend', async () => {
  const factory = async (id) => fakeBackend(id);
  const { app, runtime } = makeApp({ factory });
  try {
    const first = await app.runs.start({ backendId: 'colab', pkg: fixturePackage(), budgetUnits: 100 });
    assert.equal(first.approvalRequired, true);
    assert.equal(first.requiresApproval, true);
    assert.equal(first.approved, false);
    assert.equal(first.planHash?.length, 64);
    assert.ok(first.budget.required > 0);

    const approved = app.runs.approve(first.planHash);
    assert.equal(approved.approved, true);

    const started = await app.runs.start({ backendId: 'colab', pkg: fixturePackage(), budgetUnits: 100, approved: true });
    assert.equal(started.status, 'starting');
    assert.equal(started.approved, true);
    const finished = await app.runs.wait(started.runId);
    assert.equal(finished.status, 'done');
    assert.equal(finished.teardown.state, 'stopped');
    const dryRuns = finished.events.filter((event) => event.phase === 'planned').length;
    assert.ok(dryRuns >= 1);
    const phases = finished.events.filter((event) => event.event === 'run_phase').map((event) => event.phase);
    assert.deepEqual(phases, ['planned', 'up', 'ran', 'applied', 'teardown']);
    assert.equal(app.runs.status().spentEstimate > 0, true);
    assert.equal(finished.render.frames, 7);
    assert.equal(finished.revision > 0, true);
  } finally {
    app.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('a budget that cannot cover the next job is refused before any VM starts', async () => {
  const factory = async (id) => fakeBackend(id, { gpuMinutes: 600 });
  const { app, runtime } = makeApp({ factory });
  try {
    const result = await app.runs.start({ backendId: 'colab', pkg: fixturePackage(), budgetUnits: 1, approved: true });
    assert.equal(result.refused, true);
    assert.equal(result.budget.allowed, false);
    assert.equal(result.budget.state, 'refused');
    assert.equal(app.runs.status().activeRunId, null);
  } finally {
    app.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('BYO ComfyUI runs without approval and reports an unknown cost', async () => {
  const factory = async (id) => fakeBackend(id, { gpuMinutes: 0 });
  const { app, runtime } = makeApp({ factory });
  try {
    const started = await app.runs.start({ backendId: 'byo-comfyui', pkg: fixturePackage(), budgetUnits: 0, comfyuiUrl: 'http://127.0.0.1:9999' });
    assert.notEqual(started.approvalRequired, true);
    assert.equal(started.budget.state, 'external');
    const finished = await app.runs.wait(started.runId);
    assert.equal(finished.status, 'done');
    assert.equal(finished.backend.costVisibility, 'external-unknown');
  } finally {
    app.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('an unconfirmed stop is surfaced honestly', async () => {
  const factory = async (id) => fakeBackend(id, { teardownState: 'stop_unconfirmed' });
  const { app, runtime } = makeApp({ factory });
  try {
    const started = await app.runs.start({ backendId: 'byo-comfyui', pkg: fixturePackage() });
    const finished = await app.runs.wait(started.runId);
    assert.equal(finished.status, 'stop_unconfirmed');
    assert.equal(finished.teardown.state, 'stop_unconfirmed');
  } finally {
    app.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('a backend failure is reported and teardown is still attempted', async () => {
  const factory = async () => fakeBackend('colab', { failRun: true });
  const { app, runtime } = makeApp({ factory });
  try {
    const started = await app.runs.start({ backendId: 'colab', pkg: fixturePackage(), budgetUnits: 100, approved: true });
    const finished = await app.runs.wait(started.runId);
    assert.equal(finished.status, 'failed');
    assert.match(finished.error, /job blew up/);
    assert.equal(finished.teardown.state, 'stopped', 'a failed run still says what became of the VM');
    const failedPhase = finished.events.find((event) => event.phase === 'up');
    assert.ok(failedPhase, 'the phases up to the failure are on the record');
  } finally {
    app.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('the HTTP routes expose estimate, approve and status (C9: packages, not jobs)', async () => {
  const factory = async (id) => fakeBackend(id, { gpuMinutes: 0 });
  const { app, runtime } = makeApp({ factory });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'x-comfyrizz-token': TOKEN,
            origin: `http://127.0.0.1:${port}`,
            host: `127.0.0.1:${port}`,
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  try {
    const approval = await call('POST', '/api/run', { backendId: 'colab', package: fixturePackage(), budgetUnits: 100 });
    assert.equal(approval.status, 200);
    assert.equal(approval.json.approvalRequired, true);
    const approved = await call('POST', '/api/run/approve', { planHash: approval.json.planHash });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.approved, true);
    const started = await call('POST', '/api/run', { backendId: 'colab', package: fixturePackage(), budgetUnits: 100, approved: true });
    assert.equal(started.status, 200);
    const record = await call('GET', `/api/run/${started.json.runId}`);
    assert.equal(record.status, 200);
    const status = await call('GET', '/api/run');
    assert.equal(status.status, 200);
    assert.ok(Array.isArray(status.json.runs));
    const missing = await call('POST', '/api/run', { backendId: 'colab' });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /packageId or package required/);
  } finally {
    app.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('createRunController validates its backend factory', () => {
  assert.throws(() => createRunController({ runtimeDir: '/tmp', events: null }), /backendFactory/);
});
