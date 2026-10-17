import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createRunController } from '../src/run.mjs';

const TOKEN = 'test-token-0123456789abcdef';

/** A fake backend that records every lifecycle call and can be told to fail teardown. */
function fakeBackend(id, { gpuMinutes = 2, teardownState = 'stopped' } = {}) {
  const calls = [];
  return {
    id,
    calls,
    async describe() {
      return { label: id === 'colab' ? 'Google Colab G4' : 'Your own ComfyUI', costVisibility: id === 'colab' ? 'account-estimate' : 'external-unknown' };
    },
    async estimate(jobs) {
      calls.push(['estimate', jobs.length]);
      return { gpuMinutes: gpuMinutes * jobs.length, overheadMinutes: 5, ratePerHour: 8.9 };
    },
    async ensureUp({ approved } = {}) {
      calls.push(['ensureUp', approved]);
      return { state: 'started', evidence: 'fake ensureUp' };
    },
    async health() {
      calls.push(['health']);
      return { ok: true, detail: 'fake health', vramFreeGB: 12 };
    },
    async run(jobsFile, onEvent) {
      calls.push(['run', jobsFile]);
      onEvent?.({ type: 'job', id: 'j1' });
      return { manifest: { outputs: [{ path: 'out/a.png' }] } };
    },
    async collect(manifest, destDir) {
      calls.push(['collect', destDir]);
      return { files: manifest.outputs.length, destDir };
    },
    async teardown(reason) {
      calls.push(['teardown', reason]);
      return { state: teardownState, evidence: `fake teardown (${reason})` };
    },
  };
}

function makeApp({ factory }) {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-run-'));
  const app = createApp({ token: TOKEN, runtimeDir: runtime, backendFactory: factory });
  return { app, runtime };
}

test('colab run needs approval, then runs the lifecycle and reports estimate spend', async () => {
  const backends = new Map();
  const factory = async (id) => {
    if (!backends.has(id)) backends.set(id, fakeBackend(id));
    return backends.get(id);
  };
  const { app, runtime } = makeApp({ factory });
  try {
    const first = await app.runs.start({ backendId: 'colab', jobs: [{ id: 'j1' }], budgetUnits: 100 });
    assert.equal(first.approvalRequired, true);
    assert.equal(first.requiresApproval, true);
    assert.equal(first.approved, false);
    assert.ok(!backends.get('colab').calls.some(([name]) => name === 'ensureUp'), 'nothing starts a VM before approval');
    assert.ok(first.budget.required > 0);

    const approved = app.runs.approve(first.planHash);
    assert.equal(approved.approved, true);

    const started = await app.runs.start({ backendId: 'colab', jobs: [{ id: 'j1' }], budgetUnits: 100, approved: true });
    assert.equal(started.status, 'starting');
    assert.equal(started.approved, true);
    const finished = await app.runs.wait(started.runId);
    assert.equal(finished.status, 'done');
    const order = backends.get('colab').calls.map(([name]) => name);
    assert.deepEqual(order, ['estimate', 'estimate', 'ensureUp', 'health', 'run', 'collect', 'teardown']);
    assert.equal(app.runs.status().spentEstimate > 0, true);
    const types = finished.events.map((event) => event.type);
    assert.ok(types.includes('health'));
    assert.ok(types.includes('collected'));
    assert.ok(types.includes('teardown'));
  } finally {
    app.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('a budget that cannot cover the next job is refused before any VM starts', async () => {
  const factory = async (id) => fakeBackend(id, { gpuMinutes: 60 });
  const { app, runtime } = makeApp({ factory });
  try {
    const result = await app.runs.start({ backendId: 'colab', jobs: [{ id: 'j1' }, { id: 'j2' }], budgetUnits: 1, approved: true });
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
    const started = await app.runs.start({ backendId: 'byo-comfyui', jobs: [{ id: 'j1' }], budgetUnits: 0, comfyuiUrl: 'http://127.0.0.1:9999' });
    assert.notEqual(started.approvalRequired, true);
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
    const started = await app.runs.start({ backendId: 'byo-comfyui', jobs: [{ id: 'j1' }] });
    const finished = await app.runs.wait(started.runId);
    assert.equal(finished.status, 'stop_unconfirmed');
    assert.equal(finished.teardown.state, 'stop_unconfirmed');
  } finally {
    app.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('a backend failure is reported and teardown is still attempted', async () => {
  const broken = {
    id: 'colab',
    async describe() {
      return { label: 'Google Colab G4', costVisibility: 'account-estimate' };
    },
    async estimate() {
      return { gpuMinutes: 2, overheadMinutes: 5, ratePerHour: 8.9 };
    },
    async ensureUp() {
      return { state: 'started' };
    },
    async health() {
      return { ok: true, detail: 'ok' };
    },
    async run() {
      throw new Error('job blew up');
    },
    async collect() {
      return {};
    },
    async teardown(reason) {
      return { state: 'stopped', evidence: `stopped after ${reason}` };
    },
  };
  const { app, runtime } = makeApp({ factory: async () => broken });
  try {
    const started = await app.runs.start({ backendId: 'colab', jobs: [{ id: 'j1' }], budgetUnits: 100, approved: true });
    const finished = await app.runs.wait(started.runId);
    assert.equal(finished.status, 'failed');
    assert.match(finished.error, /job blew up/);
    assert.equal(finished.teardown.state, 'stopped');
  } finally {
    app.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('the HTTP routes expose estimate, approve and status', async () => {
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
    const approval = await call('POST', '/api/run', { backendId: 'colab', jobs: [{ id: 'j1' }], budgetUnits: 100 });
    assert.equal(approval.status, 200);
    assert.equal(approval.json.approvalRequired, true);
    const approved = await call('POST', '/api/run/approve', { planHash: approval.json.planHash });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.approved, true);
    const started = await call('POST', '/api/run', { backendId: 'colab', jobs: [{ id: 'j1' }], budgetUnits: 100, approved: true });
    assert.equal(started.status, 200);
    const record = await call('GET', `/api/run/${started.json.runId}`);
    assert.equal(record.status, 200);
    const status = await call('GET', '/api/run');
    assert.equal(status.status, 200);
    assert.ok(Array.isArray(status.json.runs));
  } finally {
    app.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('createRunController validates its backend factory', () => {
  assert.throws(() => createRunController({ runtimeDir: '/tmp', events: null }), /backendFactory/);
});
