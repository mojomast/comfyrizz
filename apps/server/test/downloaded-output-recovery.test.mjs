// Real CPU-encoded fixture media, simulated generation/failed collection only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.mjs';
import { compilePackage } from '../src/compile-package.mjs';
import { hash } from '../../../packages/jobs/test/recovery-fixture.mjs';
import { seedRecoveryRuntime } from './helpers/downloaded-output-recovery.mjs';

const TOKEN = 'recovery-test-token-0123456789';
const json = path => JSON.parse(readFileSync(path));
async function harness(t, mutate) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'recovery-http-')); t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const f = seedRecoveryRuntime(runtimeDir); mutate?.(f);
  let backendCalls = 0, renderCalls = 0;
  const app = createApp({ runtimeDir, token: TOKEN,
    backendFactory: async () => { backendCalls++; throw Error('NO GPU / backend factory allowed'); },
    render: async (packagePath, output) => {
      renderCalls++;
      const pkg = json(packagePath), timeline = compilePackage(pkg, dirname(packagePath));
      copyFileSync(join(dirname(packagePath), pkg.assets.a_video.file), output);
      return { package: pkg, timeline, bytes: readFileSync(output).length, frames: timeline.durationInFrames };
    } });
  const server = createServer(app.handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(url + path, { ...options, headers: { origin: url, 'content-type': 'application/json', 'x-comfyrizz-token': TOKEN } });
  const wait = async id => {
    for (let i = 0; i < 100; i++) {
      const res = await request(`/api/run/${id}`); const { run } = await res.json();
      if (run.finished) return run;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('recovery timed out');
  };
  return { ...f, app, runtimeDir, request, wait, backendCalls: () => backendCalls, renderCalls: () => renderCalls };
}
test('authenticated recovery UI -> new operation -> normal CAS apply/render/download; historical failure stays byte-identical', async t => {
  const h = await harness(t);
  const originalState = readFileSync(h.statePath), originalPackage = readFileSync(join(h.workDir, 'package.json'));
  const originalProduction = readFileSync(join(h.runtimeDir, 'productions', h.state.productionId, 'state.json'));
  let response = await h.request(`/api/run/${h.runId}/recovery/view`);
  assert.equal(response.status, 200);
  const page = await response.text(); assert.match(page, /Recover downloaded outputs and render/); assert.match(page, /baseRevision/);
  response = await h.request(`/api/run/${h.runId}/recovery`, { method: 'POST', body: JSON.stringify({ baseRevision: h.pkg.revision }) });
  assert.equal(response.status, 202, await response.clone().text());
  const started = await response.json(), finished = await h.wait(started.runId);
  assert.equal(finished.status, 'completed', finished.error);
  assert.notEqual(started.runId, h.runId);
  assert.equal(finished.allocation, 'none'); assert.equal(finished.additionalGenerationCredits, 0);
  assert.equal(finished.command.type, 'recover_downloaded_outputs');
  assert.deepEqual(finished.events.map(event => event.type), ['recovery.requested', 'recovery.verified', 'recovery.completed']);
  assert.equal(h.backendCalls(), 0); assert.equal(h.renderCalls(), 1);
  assert.equal(h.app.store.read(h.pkg.id).revision, h.pkg.revision + 1);
  assert.equal(h.app.store.read(h.pkg.id).assets.a_video.status, 'ready');
  assert.deepEqual(readFileSync(h.statePath), originalState);
  assert.deepEqual(readFileSync(join(h.runtimeDir, 'runs', started.runId, 'source', 'state.json')), originalState);
  assert.deepEqual(readFileSync(join(h.runtimeDir, 'runs', started.runId, 'source', 'package.json')), originalPackage);
  assert.deepEqual(readFileSync(join(h.workDir, 'package.json')), originalPackage);
  assert.deepEqual(readFileSync(join(h.runtimeDir, 'productions', h.state.productionId, 'state.json')), originalProduction);
  assert.equal(existsSync(join(h.outputDir, h.manifest.jobs[1].outputs[0].workflow)), false);
  response = await h.request(finished.render.url);
  assert.equal(response.status, 200);
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), finished.render.video_sha256);
  response = await h.request(`/api/run/${h.runId}/recovery`, { method: 'POST', body: JSON.stringify({ baseRevision: h.pkg.revision }) });
  assert.equal(response.status, 409, 'repeat cannot overwrite the newly applied package');
});
for (const issue of ['stale', 'missing', 'bad-hash', 'incomplete', 'unconfirmed', 'unapproved', 'paths']) test(`HTTP recovery rejects ${issue} without GPU or imported assets`, async t => {
  const h = await harness(t, f => {
    if (issue === 'missing') rmSync(join(f.outputDir, f.manifest.jobs[1].outputs[0].relative));
    if (issue === 'bad-hash') { f.manifest.jobs[1].outputs[0].sha256 = '0'.repeat(64); f.save(); }
    if (issue === 'incomplete') { f.manifest.complete = false; f.save(); }
    if (issue === 'unconfirmed') { f.state.teardown.state = 'stop_unconfirmed'; writeFileSync(f.statePath, JSON.stringify(f.state)); }
    if (issue === 'unapproved') { f.state.actionPlanHash = 'b'.repeat(64); writeFileSync(f.statePath, JSON.stringify(f.state)); }
  });
  if (issue === 'stale') h.app.store.save(h.pkg.id, { ...h.pkg, title: 'Owner changed the review' }, h.pkg.revision);
  const before = h.app.store.read(h.pkg.id);
  const response = await h.request(`/api/run/${h.runId}/recovery`, { method: 'POST', body: JSON.stringify({ baseRevision: h.pkg.revision,
    ...(issue === 'paths' ? { outputDir: h.outputDir } : {}) }) });
  if (response.status === 202) {
    const started = await response.json(), finished = await h.wait(started.runId);
    assert.equal(finished.status, 'failed'); assert.equal(finished.errorCode, 'RECOVERY_EVIDENCE_INVALID');
    assert.equal(existsSync(join(h.runtimeDir, 'runs', started.runId, '.comfy-provenance')), false);
  } else {
    const body = await response.json();
    assert.ok([400, 409].includes(response.status), JSON.stringify(body));
    if (issue !== 'paths') assert.ok(body.code?.startsWith('RECOVERY_'), JSON.stringify(body));
  }
  assert.deepEqual(h.app.store.read(h.pkg.id), before); assert.equal(h.backendCalls(), 0); assert.equal(h.renderCalls(), 0);
  assert.equal(existsSync(join(h.runtimeDir, '.comfy-provenance')), false);
});
