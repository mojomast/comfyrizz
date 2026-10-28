// IP26: the mounted app's chat must reach the production coordinator for a
// production-bound package. The legacy run controller stays the executor for an
// unbound package, but a bound package never starts a paid run from chat: the
// only authority is the IP20 action slot, so chat returns approval_required and
// the user approves spend on the production plan card.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/app.mjs';
import { createProviderSettings } from '../src/provider-settings.mjs';
import { createBudgetLedger } from '../src/productions/ledger.mjs';
import { TAKES_SCHEMA } from '../src/takes/model.mjs';
import { buildCorrection } from '../src/takes/correction.mjs';

const TOKEN = 'ip26-chat-wiring-token';
const KEY = 'ip26-chat-test-secret';
const FIXTURE_PATH = fileURLToPath(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const ASSET_ID = 'a_plate1';
const CORRECTION = 'warmer light on the plate';
const CONVERSATION = 'chat_ip26_wiring_0001';
const clone = value => JSON.parse(JSON.stringify(value));

function fixturePlan() {
  return {
    title: fixture.title,
    brief: 'IP26 wiring test plan.',
    audience: 'Testers',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [{
      id: fixture.scenes[0].id,
      layout: 'title',
      headline: fixture.scenes[0].copy.headline,
      sub: fixture.scenes[0].copy.sub,
      narration: fixture.scenes[0].narration,
      seconds: (fixture.scenes[0].preferredFrames ?? 120) / fixture.format.fps,
      visual: 'Launch title card',
    }],
  };
}

function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startModel(t) {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url.endsWith('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    sse(response, { choices: [{ delta: { content: 'The correction is queued for production review.' } }] });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function listen(t, server) {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

function fakeColab() {
  const bytes = Buffer.from('ip26 fake take bytes');
  const sha = createHash('sha256').update(bytes).digest('hex');
  return {
    id: 'colab',
    async describe() {
      return { label: 'fake Google Colab', costVisibility: 'external-unknown' };
    },
    async runPackage(pkg, opts = {}) {
      const jobsDoc = {
        v: 1,
        jobs: [{
          id: `${ASSET_ID}.plate`, asset: ASSET_ID, kind: 'plate', generator: 'ltx25',
          workflow: 'workflows/ltx25_i2v.api.json', workflowSha256: '1'.repeat(64),
          model: 'ltx-2.5-22b-distilled', backend: 'colab:G4',
          inputs: { seed: 7, prompt: CORRECTION }, dims: { width: 1024, height: 576 }, fps: 24, frames: 97,
        }],
      };
      const estimate = { gpuMinutes: 1, overheadMinutes: 0, ratePerHour: 8.9 };
      if (opts.dryRun) return { jobsDoc, estimate, dryRun: true, teardown: null };
      const relative = `assets/${ASSET_ID}.mp4`;
      mkdirSync(join(opts.outDir, 'assets'), { recursive: true });
      writeFileSync(join(opts.outDir, relative), bytes);
      const emit = opts.onEvent ?? (() => {});
      emit({ v: 1, event: 'job_start', job: `${ASSET_ID}.plate` });
      emit({ v: 1, event: 'job_done', job: `${ASSET_ID}.plate`, status: 'succeeded' });
      const applied = clone(pkg);
      applied.assets[ASSET_ID] = {
        ...applied.assets[ASSET_ID], status: 'ready', file: relative, sha256: sha, bytes: bytes.length,
      };
      const manifest = {
        v: 1,
        complete: true,
        counts: { succeeded: 1 },
        updatedAt: '2026-10-23T12:00:00.000Z',
        jobs: [{
          job: `${ASSET_ID}.plate`, status: 'succeeded', job_id: 'job_ip26', attempt_id: 'att_ip26',
          outputs: [{ relative, sha256: sha, bytes: bytes.length }],
        }],
      };
      return {
        jobsDoc, manifest, counts: { succeeded: 1 }, ok: true, package: applied,
        applied: [{ job: `${ASSET_ID}.plate`, asset: ASSET_ID, file: relative, sha256: sha }],
        candidates: [], teardown: { state: 'stopped', evidence: 'fake teardown' },
      };
    },
  };
}

function seedPackageAndChat(app, runtimeDir) {
  const pkg = clone(fixture);
  for (const scene of pkg.scenes) delete scene.transitionOut;
  app.store.write(pkg);
  mkdirSync(join(app.store.dir, 'assets'), { recursive: true });
  writeFileSync(
    join(app.store.dir, 'assets', 'a_logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0d0f14"/></svg>',
  );
  const sha = pkg.assets[ASSET_ID].sha256;
  const takeId = `tk_${sha.slice(0, 12)}`;
  app.takeStore.write(pkg.id, {
    schema: TAKES_SCHEMA,
    packageId: pkg.id,
    clips: {
      [ASSET_ID]: {
        selected: takeId,
        takes: [{
          takeId, assetId: ASSET_ID, n: 1,
          file: `takes/${ASSET_ID}/${takeId}.mp4`,
          sha256: sha, bytes: pkg.assets[ASSET_ID].bytes,
          media: clone(pkg.assets[ASSET_ID].media), gen: clone(pkg.assets[ASSET_ID].gen),
          createdAt: '2026-10-23T10:00:00.000Z', verdict: 'unreviewed',
        }],
      },
    },
    overrides: [],
  });
  const session = {
    id: CONVERSATION,
    revision: 1,
    messages: [
      { role: 'user', content: `Correct the plate: ${CORRECTION}.` },
      { role: 'assistant', content: 'I proposed a correction.' },
    ],
    plan: fixturePlan(),
    phase: 'built',
    projectId: pkg.id,
    projectRevision: pkg.revision,
    previousPlan: fixturePlan(),
    clipProposals: [{
      id: 'cp_correct_ip26', status: 'proposed', kind: 'correction',
      clipId: ASSET_ID, assetId: ASSET_ID,
      change: { note: CORRECTION },
      createdAt: '2026-10-23T10:05:00.000Z',
    }],
  };
  writeFileSync(join(runtimeDir, 'conversations', `${CONVERSATION}.json`), `${JSON.stringify(session, null, 2)}\n`);
  return { pkg, takeId };
}

async function setup(t, { backend = fakeColab() } = {}) {
  const upstream = await startModel(t);
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ip26-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const settings = createProviderSettings({ runtimeDir, env: {} });
  settings.save({ id: 'custom', baseUrl: `${upstream}/v1`, apiKey: KEY, model: 'stub-model', use: true });
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    providerSettings: settings,
    backendFactory: async () => backend,
    render: async (packagePath, output) => {
      const bytes = Buffer.from('ip26 fake render');
      writeFileSync(output, bytes);
      return { output, bytes: bytes.length, frames: 3, hash: 'ip26-render' };
    },
  });
  t.after(() => app.close());
  const base = await listen(t, createServer(app.handler));
  const api = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-comfyrizz-token': TOKEN, origin: base, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const seeded = seedPackageAndChat(app, runtimeDir);
  return { app, runtimeDir, api, base, ...seeded };
}

function chatTurn(api, turnId) {
  return api('/api/agent/chat', {
    conversationId: CONVERSATION,
    baseRevision: 1,
    turnId,
    message: `Apply the correction: ${CORRECTION}.`,
    provider: 'custom',
    model: 'stub-model',
    confirmClipProposals: ['cp_correct_ip26'],
  });
}

async function approvedPlanHash(app, pkg) {
  const built = buildCorrection(pkg, ASSET_ID, { note: CORRECTION }, { takesCount: 1 });
  const estimate = await app.runs.estimate({
    backendId: 'colab', pkg: built.package, includeReady: true, assets: [ASSET_ID],
  });
  app.runs.approve(estimate.planHash);
  return estimate.planHash;
}

test('an unbound package still regenerates through the legacy run controller and lands a take', { timeout: 30_000 }, async t => {
  const { app, api, pkg, takeId } = await setup(t);
  await approvedPlanHash(app, pkg);

  const response = await chatTurn(api, 'turn-unbound-2601');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const proposal = response.body.conversation.clipProposals.find(item => item.id === 'cp_correct_ip26');
  assert.equal(proposal.status, 'confirmed');
  assert.ok(proposal.runId, 'the correction started a run');
  assert.ok(app.runs.get(proposal.runId), 'the run controller owns the run');

  const finished = await app.runs.wait(proposal.runId);
  assert.equal(finished.status, 'done');

  const doc = app.takeStore.read(pkg.id);
  const takes = doc.clips[ASSET_ID].takes;
  assert.equal(takes.length, 2, 'the new take is in the take store');
  assert.notEqual(takes.at(-1).takeId, takeId);
  assert.ok(app.events.entries.some(event => event.type === 'clip.job' && event.runId === proposal.runId));
  assert.ok(app.events.entries.some(event => event.type === 'clip.take.landed' && event.runId === proposal.runId));
});

test('a production-bound correction creates a trusted plan but never starts from chat', { timeout: 30_000 }, async t => {
  const { app, api, pkg, runtimeDir, takeId } = await setup(t);
  const planHash = await approvedPlanHash(app, pkg);

  const created = await api('/api/productions', {
    commandId: 'cmd_ip26_create',
    idempotencyKey: 'key_ip26_create',
    kind: 'production.create',
    payload: { conversationId: CONVERSATION, packageId: pkg.id, intent: 'active' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const productionId = created.body.productionId;
  assert.equal(created.body.production.packageId, pkg.id);

  const beforeSnapshot = await api(`/api/productions/${productionId}`);
  const beforeEvents = await api(`/api/productions/${productionId}/events`);
  const ledger = createBudgetLedger({ runtimeDir, ledgerId: created.body.production.budgetLedgerId });
  const beforeLedger = ledger.snapshot();
  const eventCount = app.events.entries.length;

  const response = await chatTurn(api, 'turn-bound-2601');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const proposal = response.body.conversation.clipProposals.find(item => item.id === 'cp_correct_ip26');
  assert.equal(proposal.status, 'plan_ready');
  assert.match(proposal.planHash, /^[a-f0-9]{64}$/);
  assert.match(proposal.planId, /^plan_/);
  assert.equal(proposal.productionId, productionId);
  assert.equal(proposal.runId, undefined);
  assert.equal(proposal.queued, undefined);

  assert.equal(app.runs.status().activeRunId, null, 'no run started for the bound package');
  assert.equal(app.runs.status().planHash, undefined);
  const clipEvents = app.events.entries.slice(eventCount).filter(event => event.type === 'clip.job' || event.type === 'clip.take.landed' || event.type === 'clip.queued');
  assert.deepEqual(clipEvents, [], 'no clip job, queue or landed take event');

  const doc = app.takeStore.read(pkg.id);
  assert.deepEqual(doc.clips[ASSET_ID].takes.map(take => take.takeId), [takeId], 'the take store did not land a take');
  assert.equal(doc.clips[ASSET_ID].lastJob, undefined);
  assert.equal(doc.clips[ASSET_ID].queued, undefined);

  const afterSnapshot = await api(`/api/productions/${productionId}`);
  const afterEvents = await api(`/api/productions/${productionId}/events`);
  assert.ok(afterSnapshot.body.revision > beforeSnapshot.body.revision, 'the signed plan is journaled');
  const planEvent = afterEvents.body.events.find(event => event.type === 'plan.proposed' && event.data?.planHash === proposal.planHash);
  assert.ok(planEvent, 'the exact chat correction plan is in the production journal');
  assert.equal(planEvent.data.id, proposal.planId);
  assert.ok(planEvent.data.actions.length > 0, 'the corrected shot has a dispatchable generation action');
  assert.deepEqual(ledger.snapshot(), beforeLedger, 'plan creation still reserves no spend');

  const legacy = app.runs.approve(planHash);
  assert.equal(legacy.approved, true, 'the legacy hash approval existed, and still cannot authorise a bound run');
  assert.equal(app.runs.status().activeRunId, null);
});
