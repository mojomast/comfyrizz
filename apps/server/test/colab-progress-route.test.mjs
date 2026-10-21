// GET /api/colab/progress: the live Google Colab gauges, behind the same token as every other route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createColabProgressSink } from '../../../packages/backends/src/colab-progress.mjs';

const TOKEN = 'test-token-0123456789abcdef';

test('the route returns the latest gauge of each run and refuses without the token', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-gauge-route-'));
  const colabProgressDir = join(runtime, 'gauges');
  const sink = createColabProgressSink({ runId: 'comfyrizz-demo.render.1', dir: colabProgressDir });
  sink.write({ job: 'render', stage: 'frames', label: 'frames render', n: 100, total: 450 });
  sink.write({ job: 'render', stage: 'frames', label: 'frames render', n: 225, total: 450, rate: 30, eta: 7.5 });
  const app = createApp({ root: new URL('../../..', import.meta.url).pathname, token: TOKEN, runtimeDir: runtime, colabProgressDir });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/colab/progress`)).status, 401);
    const response = await fetch(`${base}/api/colab/progress`, { headers: { 'x-comfyrizz-token': TOKEN } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.runs.length, 1);
    assert.deepEqual(body.runs[0].gauges.map(g => [g.stage, g.n, g.total, g.eta]), [['frames', 225, 450, 7.5]]);
  } finally {
    app.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtime, { recursive: true, force: true });
  }
});
