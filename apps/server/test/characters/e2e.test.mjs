// CC17: the character flow through createApp, a loopback HTTP server and a
// scripted model. No network, GPU, Colab or renderer: the model is scripted,
// the still is a planned asset, and a synthetic take stands in for a landed
// GPU render when the library update has to mark the cast clip stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createProviderSettings } from '../../src/provider-settings.mjs';
import { validatePackage } from '../../../../packages/schema/src/index.mjs';
import { planJobs } from '../../../../packages/jobs/src/index.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);
const SCRIPTED_ORIGIN = 'http://scripted.invalid';
const CAST_SCENE = 's_cast';

function plan() {
  return {
    title: 'Pip launches the grinder',
    brief: 'A short fictional launch video hosted by Pip.',
    audience: 'Coffee buyers',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [
      {
        id: 's_intro',
        layout: 'hero',
        headline: 'Fresh is best',
        sub: 'A grinder built for the morning',
        body: 'Pip introduces the launch.',
        seconds: 4,
        narration: 'Fresh is best. Let us grind something good.',
        visual: 'A warm kitchen counter with the grinder in soft light',
        mediaType: 'image',
      },
      {
        id: CAST_SCENE,
        layout: 'hero',
        headline: 'Meet your host',
        sub: 'Pip knows beans',
        body: 'Pip explains the grind.',
        seconds: 6,
        narration: 'Pip keeps every scoop precise and every morning warm.',
        visual: 'A friendly coffee-bean mascot beside the grinder',
        mediaType: 'image',
      },
      {
        id: 's_outro',
        layout: 'title',
        headline: 'Start your morning',
        sub: 'Grind fresh, every day',
        seconds: 4,
        narration: 'Fresh is best.',
        visual: 'A calm product close-up on a wooden counter',
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

  async function uploadCharacterImage(characterId, bytes) {
    const response = await fetch(`${base}/api/characters/${characterId}/images`, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'content-type': 'image/png',
        'x-filename': encodeURIComponent('pip.png'),
        'x-image-view': 'front',
        'x-image-primary': 'true',
        'x-rights-asserted': '1',
      },
      body: bytes,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  return { json, uploadCharacterImage };
}

function characterInput() {
  return {
    name: 'Pip',
    handle: 'pip',
    role: 'presenter',
    fictional: true,
    summary: 'Round, cheerful coffee-bean mascot who hosts the launch.',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown, big white eyes, tiny arms',
      negative: 'human face, text, extra limbs',
      style: 'flat 3D, soft studio light',
      palette: ['#5b3a1e', '#f4e9dc'],
      wardrobe: [{ id: 'w1', label: 'barista apron', prompt: 'green apron with a bean logo', default: true }],
      expressions: [{ id: 'e1', label: 'delighted', prompt: 'wide smile, eyes closed' }],
      seed: 123456789,
      identity: { method: 'klein_ref' },
    },
    voice: {
      engine: 'kokoro',
      voice: 'am_michael',
      chunking: 'paragraph',
      presetId: 'michael-context',
      sampleLines: ['Fresh is best.', 'Let us grind something good.'],
    },
    bible: {
      personality: 'upbeat, a little nerdy about coffee',
      mannerisms: ['bounces when excited'],
      catchphrases: ['Fresh is best.'],
      speakingStyle: 'short sentences, warm and precise',
      do: ['always smiles at the end of a scene'],
      dont: ['never shown drinking coffee'],
      notes: 'Synthetic character used only by this end-to-end test.',
    },
    tags: ['coffee', 'mascot'],
  };
}

test('CC17: character library to cast, build and a stale clip after a library update', { timeout: 120_000 }, async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-char-e2e-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));

  const realFetch = globalThis.fetch;
  const script = scriptedModel(realFetch);
  globalThis.fetch = script.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });

  const settings = createProviderSettings({ runtimeDir, env: {}, fetchImpl: realFetch });
  settings.save({
    id: 'custom',
    preset: 'custom',
    label: 'Scripted character e2e',
    baseUrl: `${SCRIPTED_ORIGIN}/v1`,
    model: 'scripted-character-model',
    use: true,
  });

  const token = `char-e2e-${randomUUID()}`;
  const app = createApp({ token, runtimeDir, providerSettings: settings });
  t.after(() => app.close());
  const base = await listen(t, app);
  const client = clientFor(base, token);
  const chatId = `chat_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  const empty = await client.json('/api/characters', 'GET');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.characters, []);

  const created = await client.json('/api/characters', 'POST', characterInput());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const character = created.body;
  assert.match(character.id, /^chr_[0-9a-f]{16}$/);
  assert.equal(character.revision, 1);
  assert.equal(character.kind, 'fictional');

  const uploaded = await client.uploadCharacterImage(character.id, PNG);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.image.primary, true);
  assert.equal(uploaded.body.image.view, 'front');
  assert.equal(uploaded.body.character.revision, 2);
  const image = uploaded.body.image;

  const chat = body => client.json('/api/agent/chat', 'POST', {
    conversationId: chatId,
    provider: 'custom',
    model: 'scripted-character-model',
    ...body,
  });

  script.set([
    { type: 'tool', name: 'project_update_plan', args: plan() },
    { type: 'text', text: 'The draft is ready.' },
  ]);
  const draftTurn = await chat({ message: 'Make a short launch video for our fictional grinder.' });
  assert.equal(draftTurn.status, 200, JSON.stringify(draftTurn.body));
  assert.equal(draftTurn.body.conversation.plan.scenes.length, 3);

  const added = await client.json(`/api/chat/${chatId}/cast`, 'POST', {
    characterId: character.id,
    overrides: { role: 'presenter', wardrobeId: 'w1' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.castId, 'c_pip');
  assert.equal(added.body.entry.characterId, character.id);
  assert.equal(added.body.entry.pinnedRevision, 2);

  script.set([
    {
      type: 'tool',
      name: 'character_propose_cast',
      args: {
        character_id: character.id,
        scenes: [CAST_SCENE],
        role: 'presenter',
        wardrobe_id: 'w1',
        reason: 'The user asked for Pip to host the middle scene.',
      },
    },
    { type: 'text', text: 'I proposed Pip for the cast scene. Confirm the placement?' },
  ]);
  const proposalTurn = await chat({ message: 'Put Pip in the middle scene as the presenter.' });
  assert.equal(proposalTurn.status, 200, JSON.stringify(proposalTurn.body));

  const sessionPath = join(runtimeDir, 'conversations', `${chatId}.json`);
  const proposedSession = JSON.parse(readFileSync(sessionPath, 'utf8'));
  const [castProposal] = proposedSession.castProposals;
  assert.equal(castProposal.status, 'proposed');
  assert.equal(castProposal.action, 'cast');
  assert.deepEqual(castProposal.scenes, [CAST_SCENE]);
  assert.deepEqual(proposedSession.castPlacements ?? [], [], 'a proposal is not a placement');

  script.set([{ type: 'text', text: 'Confirmed. I can build the project now.' }]);
  const confirmTurn = await chat({
    message: 'Yes, confirm that placement.',
    confirmCastProposals: [castProposal.id],
  });
  assert.equal(confirmTurn.status, 200, JSON.stringify(confirmTurn.body));

  const confirmedSession = JSON.parse(readFileSync(sessionPath, 'utf8'));
  assert.equal(confirmedSession.castProposals[0].status, 'confirmed');
  const placement = confirmedSession.castPlacements.find(item => item.castId === 'c_pip' && item.sceneId === CAST_SCENE);
  assert.ok(placement, 'the confirmed placement is stored in the chat session');
  assert.equal(placement.status, 'confirmed');

  const buildTurn = await chat({ message: 'Build the project.', action: 'build' });
  assert.equal(buildTurn.status, 200, JSON.stringify(buildTurn.body));
  assert.equal(buildTurn.body.built, true);
  const pkg = buildTurn.body.project.package;

  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, validation.errors.map(error => `${error.path}: ${error.message}`).join('; '));

  const castMember = pkg.cast.find(member => member.id === 'c_pip');
  assert.ok(castMember, 'the package cast contains Pip');
  assert.equal(castMember.name, 'Pip');
  assert.equal(castMember.description, characterInput().summary);
  assert.match(castMember.ref_asset, /^a_chr_[0-9a-f]{16}$/);
  const refAsset = castMember.ref_asset;

  const castScene = pkg.scenes.find(scene => scene.id === CAST_SCENE);
  assert.ok(castScene, 'the cast scene is in the package');
  assert.deepEqual(castScene.cast, ['c_pip']);
  for (const scene of pkg.scenes.filter(item => item.id !== CAST_SCENE)) {
    assert.equal(scene.cast, undefined, `${scene.id} has no confirmed cast`);
  }

  assert.equal(pkg.presenter.cast, 'c_pip');
  assert.equal(pkg.presenter.portrait, 'c_pip');
  assert.equal(pkg.voice.enabled, true);
  assert.equal(pkg.voice.engine, 'kokoro');
  assert.equal(pkg.voice.voice, 'am_michael');

  const stillId = castScene.foreground?.[0]?.asset;
  assert.ok(stillId, 'the cast scene has a planned still');
  const still = pkg.assets[stillId];
  assert.equal(still.gen.generator, 'flux3-klein');
  assert.equal(still.gen.inputs.reference, refAsset);
  assert.match(still.gen.inputs.prompt, /^Character Pip: small round coffee bean/);
  assert.match(still.gen.inputs.prompt, /green apron with a bean logo/);
  assert.match(still.gen.inputs.prompt, /Negative: human face, text, extra limbs/);

  const jobs = planJobs(pkg);
  const castJob = jobs.jobs.find(job => job.asset === stillId);
  assert.ok(castJob, 'the cast still has a jobs plan entry');
  assert.equal(castJob.params.reference, refAsset);
  assert.deepEqual(
    castJob.fileInputs.find(input => input.param === 'reference'),
    { param: 'reference', from: 'package', path: `assets/${refAsset}.png` },
  );

  const refFile = join(runtimeDir, 'packages', `assets/${refAsset}.png`);
  assert.equal(existsSync(refFile), true, 'the primary image is copied into the package assets');
  assert.deepEqual(readFileSync(refFile), PNG);
  assert.equal(pkg.assets[refAsset].sha256, image.sha256);
  assert.equal(pkg.assets[refAsset].redistributable, false);

  const sidecarPath = join(runtimeDir, 'packages', 'characters.json');
  assert.equal(existsSync(sidecarPath), true, 'the build writes characters.json beside package.json');
  const sidecarText = readFileSync(sidecarPath, 'utf8');
  const sidecar = JSON.parse(sidecarText);
  assert.equal(sidecar.schema, 'comfyrizz.characters/v1');
  assert.equal(sidecar.packageId, pkg.id);
  assert.equal(sidecar.cast.length, 1);
  assert.equal(sidecar.cast[0].castId, 'c_pip');
  assert.equal(sidecar.cast[0].characterId, character.id);
  assert.equal(sidecar.cast[0].revision, 2);
  assert.equal(sidecar.cast[0].refAsset, refAsset);
  assert.deepEqual(sidecar.cast[0].scenes, [CAST_SCENE]);
  assert.deepEqual(sidecar.assets[refAsset], { castId: 'c_pip', characterId: character.id, revision: 2 });
  assert.deepEqual(sidecar.presenter, { castId: 'c_pip', characterId: character.id });
  assert.equal(sidecar.voice.characterId, character.id);
  assert.equal(pkg.voice.voice, 'am_michael');

  // A landed take is the only thing timeline review needs to compare against.
  // This synthetic take records the still's gen exactly as the first build did.
  const takeSource = join(runtimeDir, 'synthetic-take.png');
  writeFileSync(takeSource, PNG);
  const take = app.takeStore.addTake(pkg.id, stillId, {
    srcPath: takeSource,
    gen: still.gen,
    media: still.media,
    correction: { note: 'synthetic take for the character e2e', by: 'initial' },
  });
  assert.equal(take.n, 1);

  const beforeUpdate = await client.json(`/api/package/${pkg.id}/clips`, 'GET');
  assert.equal(beforeUpdate.status, 200, JSON.stringify(beforeUpdate.body));
  const beforeClip = beforeUpdate.body.clips.find(clip => clip.sceneId === CAST_SCENE);
  assert.ok(beforeClip, 'the cast scene is a reviewable clip');
  assert.equal(beforeClip.assetId, stillId);
  assert.equal(beforeClip.state, 'review');

  const updatedCharacter = await client.json(`/api/characters/${character.id}`, 'PATCH', {
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown, big white eyes, tiny arms, copper scoop',
      negative: 'human face, text, extra limbs, watermark',
    },
    bible: { catchphrases: ['Fresh is best.', 'Scoop first.'] },
  });
  assert.equal(updatedCharacter.status, 200, JSON.stringify(updatedCharacter.body));
  assert.equal(updatedCharacter.body.revision, 3);

  const updatedCast = await client.json(`/api/chat/${chatId}/cast/c_pip`, 'PATCH', { update: true });
  assert.equal(updatedCast.status, 200, JSON.stringify(updatedCast.body));
  assert.equal(updatedCast.body.changed, true);
  assert.equal(updatedCast.body.entry.pinnedRevision, 3);

  const rebuilt = await chat({ message: 'Rebuild with the updated Pip.', action: 'build' });
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
  assert.equal(rebuilt.body.built, true);
  const nextPkg = rebuilt.body.project.package;
  assert.equal(nextPkg.id, pkg.id);
  assert.equal(validatePackage(nextPkg).valid, true);

  const nextCastMember = nextPkg.cast.find(member => member.id === 'c_pip');
  assert.equal(nextCastMember.ref_asset, refAsset);
  const nextScene = nextPkg.scenes.find(scene => scene.id === CAST_SCENE);
  assert.deepEqual(nextScene.cast, ['c_pip']);
  assert.equal(nextScene.foreground[0].asset, stillId);
  assert.match(nextPkg.assets[stillId].gen.inputs.prompt, /copper scoop/);
  assert.match(nextPkg.assets[stillId].gen.inputs.prompt, /watermark/);

  const afterUpdate = await client.json(`/api/package/${nextPkg.id}/clips`, 'GET');
  assert.equal(afterUpdate.status, 200, JSON.stringify(afterUpdate.body));
  const afterClip = afterUpdate.body.clips.find(clip => clip.sceneId === CAST_SCENE);
  assert.ok(afterClip, 'the cast scene is still a reviewable clip');
  assert.equal(afterClip.state, 'stale', 'the library update makes the cast clip stale');
  assert.equal(afterClip.selected, take.takeId);
  for (const clip of afterUpdate.body.clips.filter(item => item.sceneId !== CAST_SCENE)) {
    assert.notEqual(clip.state, 'stale', `${clip.sceneId} is not affected by the cast update`);
  }

  const nextSidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  assert.equal(nextSidecar.schema, 'comfyrizz.characters/v1');
  assert.equal(nextSidecar.cast[0].revision, 3);
  assert.match(nextSidecar.cast[0].snapshot.visual.identityPrompt, /copper scoop/);

  const outputs = [JSON.stringify(pkg), JSON.stringify(nextPkg), sidecarText, readFileSync(sessionPath, 'utf8')];
  for (const text of outputs) {
    assert.equal(text.includes(runtimeDir), false, 'outputs store ids, not absolute runtime paths');
    assert.equal(text.includes(token), false, 'the app token never reaches stored output');
    assert.doesNotMatch(text, /\bsk-[A-Za-z0-9_-]{6,}\b/);
  }

  assert.deepEqual(script.blocked, [], 'the test only talked to the local server and the scripted model');
  assert.ok(script.seen.length >= 2);
  assert.equal(script.seen.every(entry => entry.path === '/v1/chat/completions'), true);
});
