import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.mjs';
import { createColabBackend } from '../../../packages/backends/src/colab-backend.mjs';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';

test('run-button dry plan stages stored inputs before selecting the real backend, with no allocation', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'run-inputs-'));
  const bytes = Buffer.from('test-only-voice-reference');
  const asset = JSON.parse(readFileSync(join(repoRoot, 'examples/data-story/package.json'))).assets.a_data_still;
  asset.gen.workflow_sha256 = createHash('sha256').update(readFileSync(join(repoRoot, asset.gen.workflow))).digest('hex');
  const pkg = {
    schemaVersion: 1, revision: 1, id: 'pkg_run_inputs', title: 'Input staging',
    format: { width: 1920, height: 1080, fps: 24 }, duration: { mode: 'target', targetFrames: 96 },
    scenes: [{ id: 's1', layout: 'hero', copy: { headline: 'Test' }, preferredFrames: 96, background: { asset: 'a_still' } }],
    assets: { a_still: asset, a_ref: { kind: 'audio', origin: 'upload', status: 'ready', file: 'refs/voice.wav',
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      license: { id: 'CC0-1.0' }, redistributable: true } },
    compliance: { open_weights_only: true },
  };
  const staged = [];
  const app = createApp({ token: 'test-run-inputs-token', runtimeDir: runtime, backendFactory: (id, opts) => {
    if (staged.length === 0) assert.deepEqual(readFileSync(join(opts.workDir, 'refs/voice.wav')), bytes);
    assert.equal(JSON.parse(readFileSync(join(opts.workDir, 'package.json'))).id, pkg.id);
    staged.push(opts.workDir);
    return createColabBackend({ packageId: opts.packageId, packageDir: opts.workDir, scratchDir: opts.scratchDir,
      budgetUnits: opts.budgetUnits, cli: { run() { throw Error('Dry planning must not call Colab'); } } });
  } });
  try {
    mkdirSync(join(runtime, 'packages/refs'), { recursive: true });
    writeFileSync(join(runtime, 'packages/refs/voice.wav'), bytes);
    const plan = await app.runs.estimate({ backendId: 'colab', pkg, budgetUnits: 12 });
    assert.equal(plan.jobs, 1);
    assert.equal(plan.budget.allowed, true);
    assert.equal(plan.requiresApproval, true);
    assert.equal(app.runs.status().activeRunId, null);
    assert.ok(staged.every(dir => !existsSync(dir)), 'temporary plans are cleaned up');
    // A later missing source cannot silently reuse an earlier staged copy.
    rmSync(join(runtime, 'packages/refs/voice.wav'));
    await assert.rejects(app.runs.estimate({ backendId: 'colab', pkg, budgetUnits: 12 }), /package names 1 file/);
  } finally { app.close(); rmSync(runtime, { recursive: true, force: true }); }
});
