import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { readPlanningCorrection } from '../src/hybrid-planning-correction.mjs';
import { replayProvider } from './fake-provider.mjs';

const TOKEN = 'hybrid-correction-token';
const SEED = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));
const FILM_BRIEF = 'Create a 6-second live-action generated film in 1 shot. A photorealistic human skater rolls forward. Native soundscape. Give the first AI-footage shot a Remotion title opener (layout:title, variant:centered) and a Remotion end card (layout:title, variant:outro). No narration.';

function withEnv(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function httpCall(port, { method = 'POST', path = '/api/agent', body, token = TOKEN } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        'x-comfyrizz-token': token,
        origin: `http://127.0.0.1:${port}`,
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, json: text ? JSON.parse(text) : {} });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('HTTP planningCorrection is 400 when the env flag is off', async t => {
  withEnv(t, 'COMFYRIZZ_HYBRID_PLANNING_CORRECTION', undefined);
  const runtimeDir = mkdtempSync(join(tmpdir(), 'hybrid-http-off-'));
  const seen = [];
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    agentRunner: async input => {
      seen.push(input);
      throw new Error('runner should not run');
    },
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const response = await httpCall(server.address().port, {
    body: {
      brief: 'Create a 6-second motion-graphics title card. Exact headline: Harbor Light.',
      thinking: 'enabled',
      planningCorrection: { packageId: 'pkg_missing', failures: [{ code: 'REMOTION_OPENER', detail: 'missing opener' }] },
    },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'HYBRID_CORRECTION_DISABLED');
  assert.equal(seen.length, 0);
});

test('HTTP planningCorrection loads the stored package only when opted in', async t => {
  withEnv(t, 'COMFYRIZZ_HYBRID_PLANNING_CORRECTION', '1');
  const runtimeDir = mkdtempSync(join(tmpdir(), 'hybrid-http-on-'));
  const seed = structuredClone(SEED);
  const seen = [];
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    agentRunner: async input => {
      seen.push(input);
      return {
        package: input.planningCorrection.package,
        live: true,
        fallback: false,
        provider: 'custom',
        model: 'deepseek-flash',
        usage: {
          input: 1,
          output: 1,
          total: 2,
          phases: {
            initial: { input: 0, output: 0, total: 0 },
            repair: { input: 0, output: 0, total: 0 },
            correction: { input: 1, output: 1, total: 2 },
          },
        },
        hybrid: { applied: true, fullReplan: false, discarded: false, phase: 'correction' },
        routes: [],
        pendingGpu: [],
        svgAssets: [],
        generatedAssets: {},
      };
    },
  });
  app.store.write(seed);
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const port = server.address().port;
  const missing = await httpCall(port, {
    body: {
      brief: 'Create a 6-second motion-graphics title card. Exact headline: Seed.',
      thinking: 'enabled',
      planningCorrection: { packageId: 'pkg_unknown', failures: [{ code: 'REMOTION_OPENER', detail: 'missing opener' }] },
    },
  });
  assert.equal(missing.status, 404);
  const ok = await httpCall(port, {
    body: {
      brief: 'Create a 6-second motion-graphics title card. Exact headline: Seed.',
      thinking: 'enabled',
      planningCorrection: { packageId: seed.id, failures: [{ code: 'HEADLINE_MISSING', detail: 'headline' }] },
    },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.hybrid.applied, true);
  assert.equal(seen[0].planningCorrection.package.id, seed.id);
  assert.equal(seen[0].thinking, 'enabled');
});

test('runner correction is thinking-enabled, single-pass, and discards storyboard.propose', async t => {
  withEnv(t, 'COMFYRIZZ_HYBRID_PLANNING_CORRECTION', '1');
  const runtimeDir = mkdtempSync(join(tmpdir(), 'hybrid-runner-'));
  const draft = structuredClone(SEED);
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief: FILM_BRIEF, title: 'Replan', scenes: [{ id: 's99', layout: 'title', preferredFrames: 12 }] } },
  ]);
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const result = await runner({
    brief: FILM_BRIEF,
    provider: 'custom',
    model: 'deepseek-flash',
    thinking: 'enabled',
    motionModel: 'h3',
    planningCorrection: {
      package: draft,
      failures: [{ code: 'REMOTION_OPENER', detail: 'missing opener', sceneId: 's_title' }],
    },
  });
  assert.equal(result.hybrid.applied, true);
  assert.equal(result.hybrid.fullReplan, true);
  assert.equal(result.hybrid.discarded, true);
  assert.equal(result.package.id, draft.id);
  assert.ok(result.package.scenes.some(scene => scene.id === 's_title'));
  assert.ok(result.usage.phases.correction.total > 0);
  assert.equal(result.usage.phases.initial.total, 0);
  assert.equal(result.usage.phases.repair.total, 0);
  assert.ok(provider.requests.length >= 1);
  assert.deepEqual(provider.requests[0].thinking, { type: 'enabled' });
  const user = provider.requests[0].messages.find(message => message.role === 'user')?.content ?? '';
  assert.match(String(user), /REMOTION_OPENER/);
  assert.match(String(user), new RegExp(draft.id));
});

test('normal repair inherits thinking disabled on every provider request', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'hybrid-repair-think-'));
  const brief = 'Create a 6-second generated film in 1 shot. A mustard felt jerboa restores a lighthouse lamp. Native soundscape. No captions.';
  const proposal = { logline: 'A jerboa restores the lamp.', look: 'Felt miniatures.', soundtrack: 'Wind.' };
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief, title: 'Lamp', proposal, scenes: [{ id: 'shot1', layout: 'hero', preferredFrames: 300 }] } },
  ]);
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  let repaired = false;
  await assert.rejects(() => runner({
    brief,
    provider: 'custom',
    motionModel: 'klein',
    thinking: 'disabled',
    onEvent: event => {
      if (event.type === 'done' && !repaired) {
        repaired = true;
        provider.setCalls([
          { name: 'storyboard.edit', args: { scene_id: 'shot1', patch: { preferredFrames: 180 } } },
        ]);
      }
    },
  }));
  assert.equal(repaired, true);
  const thinkingBodies = provider.requests.filter(body => Array.isArray(body.messages));
  assert.ok(thinkingBodies.length >= 2);
  for (const body of thinkingBodies) {
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.reasoning_effort, undefined);
  }
});

test('readPlanningCorrection is a no-op without the field', () => {
  assert.deepEqual(readPlanningCorrection({ brief: 'x', thinking: 'disabled' }), { value: null });
});
