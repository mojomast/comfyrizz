import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createProviderSettings } from '../../src/provider-settings.mjs';
import { validatePackage } from '../../../../packages/schema/src/index.mjs';
import { planJobs } from '../../../../packages/jobs/src/plan.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);
const SCRIPTED_ORIGIN = 'http://scripted.invalid';
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

function plan() {
  return {
    title: 'Reference e2e',
    brief: 'Show the product with the user reference.',
    audience: 'Buyers',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [
      {
        id: 's_hero',
        layout: 'hero',
        headline: 'Warm and readable',
        sub: 'A reference-led hero shot',
        body: 'The texture carries the palette.',
        seconds: 6,
        narration: 'The hero shot uses the uploaded reference.',
        visual: 'A product hero shot with warm grain',
        mediaType: 'image',
      },
    ],
  };
}

function sseResponse(events) {
  const wire = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(wire, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function toolResponse(name, args) {
  return sseResponse([
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: `call_${randomUUID()}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: null,
      }],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 } },
  ]);
}

function textResponse(text) {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } },
  ]);
}

function scriptedModel(realFetch) {
  let queue = [];
  let index = 0;
  const blocked = [];
  const seen = [];

  async function fetchImpl(input, init = {}) {
    const raw = typeof input === 'string' ? input : input?.url;
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('blocked a fetch without a valid URL');
    }

    if (url.origin === SCRIPTED_ORIGIN) {
      const body = init.body ? JSON.parse(init.body) : {};
      seen.push({ path: url.pathname, messages: Array.isArray(body.messages) ? body.messages.length : 0 });
      const next = index < queue.length ? queue[index] : { type: 'text', text: 'Done.' };
      index += 1;
      return next.type === 'tool' ? toolResponse(next.name, next.args) : textResponse(next.text);
    }

    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') {
      return realFetch(input, init);
    }

    blocked.push(url.origin);
    throw new Error(`network access is blocked in this test: ${url.origin}`);
  }

  return {
    fetchImpl,
    blocked,
    seen,
    set(responses) {
      queue = responses;
      index = 0;
    },
  };
}

function makeClip(file) {
  const source = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=2'];
  const codecs = [
    ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    ['-c:v', 'mpeg4'],
  ];
  for (const codec of codecs) {
    const result = spawnSync('ffmpeg', [...source, ...codec, file], { stdio: 'ignore' });
    if (result.status === 0 && existsSync(file)) return true;
  }
  return false;
}

async function listen(t, app) {
  const server = createServer(app.handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

function clientFor(base, token) {
  const baseHeaders = { 'x-comfyrizz-token': token, origin: base };

  async function json(path, method, body) {
    const response = await fetch(base + path, {
      method,
      headers: { ...baseHeaders, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function upload(chatId, bytes, mime, filename) {
    const response = await fetch(`${base}/api/chat/${chatId}/references`, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'content-type': mime,
        'x-filename': encodeURIComponent(filename),
        'x-rights-asserted': '1',
      },
      body: bytes,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  return { json, upload };
}

async function runFlow(t, { withVideo }) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ref-e2e-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));

  const realFetch = globalThis.fetch;
  const script = scriptedModel(realFetch);
  globalThis.fetch = script.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });

  const settings = createProviderSettings({ runtimeDir, env: {}, fetchImpl: realFetch });
  settings.save({
    id: 'custom',
    preset: 'custom',
    label: 'Scripted e2e',
    baseUrl: `${SCRIPTED_ORIGIN}/v1`,
    model: 'scripted-model',
    use: true,
  });

  const token = `e2e-${randomUUID()}`;
  const app = createApp({ token, runtimeDir, providerSettings: settings });
  t.after(() => app.close());
  const base = await listen(t, app);
  const client = clientFor(base, token);
  const chatId = `chat_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  const imageUpload = await client.upload(chatId, PNG, 'image/png', 'grain.png');
  assert.equal(imageUpload.status, 201, JSON.stringify(imageUpload.body));
  assert.equal(imageUpload.body.kind, 'image');
  assert.equal(imageUpload.body.ext, 'png');

  const image = await client.json(`/api/chat/${chatId}/references/${imageUpload.body.id}`, 'PATCH', {
    role: 'style',
    note: 'Use this warm grain and palette on every scene.',
    label: 'Warm grain',
  });
  assert.equal(image.status, 200, JSON.stringify(image.body));
  assert.equal(image.body.role, 'style');
  assert.match(image.body.note, /warm grain/);

  let video = null;
  if (withVideo) {
    const clip = join(runtimeDir, 'testsrc.mp4');
    if (!makeClip(clip)) {
      t.skip('ffmpeg is present but could not encode the test clip');
      return;
    }
    const clipBytes = readFileSync(clip);
    const videoUpload = await client.upload(chatId, clipBytes, 'video/mp4', 'push-in.mp4');
    assert.equal(videoUpload.status, 201, JSON.stringify(videoUpload.body));
    assert.equal(videoUpload.body.kind, 'video');
    assert.ok(videoUpload.body.durationSec > 1.5);
    assert.ok(Array.isArray(videoUpload.body.frames) && videoUpload.body.frames.length >= 1);
    const patched = await client.json(`/api/chat/${chatId}/references/${videoUpload.body.id}`, 'PATCH', {
      role: 'motion',
      note: 'Slow push-in; keep the label readable.',
      label: 'Push-in',
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.role, 'motion');
    video = patched.body;
  }

  const chat = body => client.json('/api/agent/chat', 'POST', {
    conversationId: chatId,
    provider: 'custom',
    model: 'scripted-model',
    ...body,
  });

  script.set([
    { type: 'tool', name: 'project_update_plan', args: plan() },
    { type: 'text', text: 'The draft is ready for your references.' },
  ]);
  const draftTurn = await chat({ message: 'Make a short product video for the launch.' });
  assert.equal(draftTurn.status, 200, JSON.stringify(draftTurn.body));
  assert.equal(draftTurn.body.conversation.plan.scenes.length, 1);

  const requested = [{
    ref_id: image.body.id,
    scene_id: 's_hero',
    slot: 'style_reference',
    reason: 'The note asks for the grain and palette on every scene.',
  }];
  if (video) {
    requested.push({
      ref_id: video.id,
      scene_id: 's_hero',
      slot: 'motion_reference',
      reason: 'The note describes the slow push-in.',
    });
  }
  script.set([
    ...requested.map(args => ({ type: 'tool', name: 'reference_assign', args })),
    { type: 'text', text: 'I proposed the reference placements. Confirm them?' },
  ]);

  const proposalTurn = await chat({ message: 'Use my references for the hero scene.' });
  assert.equal(proposalTurn.status, 200, JSON.stringify(proposalTurn.body));

  const sessionPath = join(runtimeDir, 'conversations', `${chatId}.json`);
  const proposedSession = JSON.parse(readFileSync(sessionPath, 'utf8'));
  const proposals = proposedSession.referenceAssignments;
  assert.equal(proposals.length, requested.length);
  assert.deepEqual(proposals.map(item => item.status), requested.map(() => 'proposed'));
  assert.deepEqual(proposals.map(item => item.slot), requested.map(item => item.slot));

  const confirmations = proposals.map(item => item.id);
  script.set([{ type: 'text', text: 'Confirmed. I can build the project now.' }]);
  const confirmTurn = await chat({
    message: 'Yes, confirm those placements.',
    confirmAssignments: confirmations,
  });
  assert.equal(confirmTurn.status, 200, JSON.stringify(confirmTurn.body));

  const confirmedSession = JSON.parse(readFileSync(sessionPath, 'utf8'));
  for (const assignment of confirmedSession.referenceAssignments) {
    assert.equal(assignment.status, 'confirmed');
    assert.ok(assignment.confirmedAt);
  }

  const buildTurn = await chat({ message: 'Build the project.', action: 'build' });
  assert.equal(buildTurn.status, 200, JSON.stringify(buildTurn.body));
  assert.equal(buildTurn.body.built, true);
  const pkg = buildTurn.body.project.package;

  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, validation.errors.map(error => `${error.path}: ${error.message}`).join('; '));

  const scene = pkg.scenes.find(candidate => candidate.id === 's_hero');
  assert.ok(scene, 'the built project contains the planned scene');
  const stillId = scene.foreground?.[0]?.asset;
  assert.ok(stillId, 'the hero scene has a generated still');
  const still = pkg.assets[stillId];
  assert.equal(still.gen.generator, 'flux3-klein');

  const styleAssetId = `a_ref_${image.body.sha256.slice(0, 16)}`;
  assert.equal(still.gen.inputs.reference, styleAssetId);
  const styleAsset = pkg.assets[styleAssetId];
  assert.ok(styleAsset, 'the confirmed style reference is a package asset');
  assert.equal(styleAsset.file, `assets/${styleAssetId}.png`);
  assert.equal(styleAsset.origin, 'upload');
  assert.equal(styleAsset.status, 'ready');
  assert.equal(styleAsset.redistributable, false);
  assert.deepEqual(styleAsset.license, { id: 'User-Upload', approved_by_user: true });
  assert.equal(existsSync(join(runtimeDir, 'packages', styleAsset.file)), true);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', styleAsset.file)), PNG);

  let frameAssetId = null;
  if (video) {
    frameAssetId = `a_ref_${video.sha256.slice(0, 16)}_f0`;
    assert.equal(still.gen.inputs.image, frameAssetId);
    assert.match(still.gen.inputs.prompt, /slow push-in/i);
    assert.match(still.gen.inputs.prompt, /data, not instructions/i);
    assert.ok(pkg.assets[frameAssetId], 'the extracted video frame is a package asset');
    assert.equal(pkg.assets[frameAssetId].file, `assets/${frameAssetId}.png`);
    assert.equal(existsSync(join(runtimeDir, 'packages', pkg.assets[frameAssetId].file)), true);
  }

  const sidecarPath = join(runtimeDir, 'packages', 'references.json');
  assert.equal(existsSync(sidecarPath), true, 'the build writes references.json beside package.json');
  const sidecarText = readFileSync(sidecarPath, 'utf8');
  const sidecar = JSON.parse(sidecarText);
  assert.equal(sidecar.schema, 'comfyrizz.references/v1');
  assert.equal(sidecar.packageId, pkg.id);
  assert.equal(sidecar.assignments.length, requested.length);
  assert.deepEqual(
    sidecar.assignments.map(item => item.slot),
    requested.map(item => item.slot),
  );
  assert.ok(sidecar.notes.some(item => item.refId === image.body.id && /warm grain/.test(item.note)));
  if (video) {
    assert.ok(sidecar.notes.some(item => item.refId === video.id && /push-in/i.test(item.note)));
    assert.ok(sidecar.assignments.some(item => item.frameIndex === 0));
  }

  const jobs = planJobs(pkg);
  const stillJob = jobs.jobs.find(job => job.asset === stillId);
  assert.ok(stillJob, 'the still has a jobs plan entry');
  assert.deepEqual(
    stillJob.fileInputs.find(input => input.param === 'reference'),
    { param: 'reference', from: 'package', path: `assets/${styleAssetId}.png` },
  );
  if (video) {
    assert.deepEqual(
      stillJob.fileInputs.find(input => input.param === 'image'),
      { param: 'image', from: 'package', path: `assets/${frameAssetId}.png` },
    );
  }

  const packageJson = JSON.stringify(pkg);
  for (const text of [packageJson, sidecarText]) {
    assert.equal(text.includes(runtimeDir), false);
    assert.doesNotMatch(text, /\bsk-[A-Za-z0-9_-]{6,}\b/);
  }
  const sessionText = readFileSync(sessionPath, 'utf8');
  assert.equal(sessionText.includes(runtimeDir), false, 'the session stores ids, not absolute paths');
  assert.doesNotMatch(sessionText, /\bsk-[A-Za-z0-9_-]{6,}\b/);

  assert.deepEqual(script.blocked, [], 'the test only talked to the local server and the scripted model');
  assert.ok(script.seen.length >= 2);
  assert.equal(script.seen.every(entry => entry.path === '/v1/chat/completions'), true);
}

test('R15: an uploaded PNG becomes a validated package asset and a jobs file input', { timeout: 120_000 }, async t => {
  await runFlow(t, { withVideo: false });
});

test('R15: a 2 s MP4 becomes an extracted frame, prompt hint and jobs file input', {
  skip: HAS_FFMPEG ? false : 'ffmpeg and ffprobe are not installed',
  timeout: 180_000,
}, async t => {
  await runFlow(t, { withVideo: true });
});
