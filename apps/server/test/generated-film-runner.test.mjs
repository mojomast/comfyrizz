import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentProgress } from '../src/agent-progress.mjs';
import { coverGeneratedFilmScenes, createCpuAgentRunner, enforceLiveActionHumans, generatedFilmCompletionProblems, withInitialAdmissionRetry, withRepairAdmissionRetry } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';
import { createReferenceStore } from '../src/references/store.mjs';
import { createContextAttachmentStore } from '../src/context-attachments.mjs';

const BRIEF = 'Create a 24-second wordless handcrafted miniature film in 4 shots. A mustard felt jerboa and a cobalt wooden bird restore an island lighthouse at dusk as a small boat approaches. Recurring tactile characters, clear physical action, cinematic camera moves, warm golden payoff, gentle coastal sound. No dialogue, captions, logos or real people.';
const ONE_SHOT_BRIEF = BRIEF.replace('24-second', '6-second').replace('in 4 shots', 'in 1 shot');
const proposal = { logline: 'Two friends restore the lamp.', look: 'Handcrafted dusk miniatures.', soundtrack: 'Coastal sound without speech.' };
const scenes = [1, 2, 3, 4].map(n => ({ id: `shot${n}`, layout: 'hero', preferredFrames: 180, copy: { headline: 'Unwanted headline' } }));
const shotDirection = scene => ({
  scene_id: scene, subject: 'A mustard felt jerboa and cobalt wooden bird.',
  composition: 'Handcrafted island lighthouse at dusk.', action: 'The jerboa hauls the lens while the bird braces it.',
  camera: 'Slow cinematic push.', soundscape: 'Coastal wind and a soft lens click.', characterCount: 2,
  finishing_sound: 'Mix coastal wind and the lens click in finishing.',
});

async function setup(t, calls) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'generated-film-runner-'));
  const provider = await replayProvider(calls);
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { provider, runner, runtimeDir };
}

test('FLUX-only generated-film output is rejected with no scripted fallback', async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes } },
    ...scenes.map((scene, index) => ({ name: 'assets.generate_image', args: { scene_id: scene.id, kind: 'illustration', intent: `FLUX-only shot ${index + 1}`, seed: index + 1 } })),
  ];
  const { provider, runner } = await setup(t, calls);
  await assert.rejects(
    () => runner({ brief: BRIEF, provider: 'custom', motionModel: 'h3' }),
    error => {
      assert.equal(error.code, 'GENERATED_FILM_INCOMPLETE');
      assert.match(error.message, /scene\.media|FLUX stills/);
      return true;
    },
  );
  assert.equal(provider.calls, calls.length + 2, 'one live plan and one bounded repair, never the defaultCpuScript fallback');
});

test('explicit generated-film Music Video adopts the song and lyrics', async t => {
  const musicBrief = BRIEF.replace('miniature film', 'miniature generated film').replace('No dialogue, captions, logos', 'No dialogue, logos');
  const calls = [
    { name: 'storyboard.propose', args: { brief: musicBrief, title: 'The Lamp at Dusk', proposal, scenes } },
    ...scenes.map(scene => ({ name: 'assets.generate_video', args: { ...shotDirection(scene.id), motion_model: 'klein' } })),
  ];
  const { runner, runtimeDir } = await setup(t, calls);
  const samples = 24 * 24000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  const conversationId = 'chat_0123456789abcdef';
  const store = createReferenceStore({ rootDir: runtimeDir, chatId: conversationId });
  const song = store.add({ bytes: wav, filename: 'song.wav', meta: { mime: 'audio/wav', role: 'song', durationSec: 24 } });
  store.update(song.id, { usage: 'editorial' });
  const lyrics = [{ startSeconds: 1, text: 'A song' }];
  const result = await runner({ brief: musicBrief, provider: 'custom', motionModel: 'klein', videoType: 'music-video', conversationId, lyricsStyle: 'caption', lyrics });
  assert.equal(result.package.assets[result.package.audio.music.asset].source.id, song.id);
  assert.deepEqual(result.package.audio.lyrics, lyrics);
  assert.equal(result.package.audio.lyricsStyle, 'caption');
});

test('runner accepts real wordless H3 completion and persists silent conditioning', async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes: [scenes[0]] } },
    { name: 'assets.generate_image', args: { scene_id: 'shot1', kind: 'identity-reference', intent: 'Recurring jerboa and bird identity', seed: 11 } },
    { name: 'assets.generate_image', args: { scene_id: 'shot1', kind: 'composition-reference', intent: 'Island lighthouse composition', seed: 12 } },
  ];
  const { runner, runtimeDir, provider } = await setup(t, []);
  // Stable generated image ids are returned by the same deterministic tool. The
  // fake provider cannot discover them ahead of time, so obtain them from a
  // dry tool run through the model is unnecessary: use the IDs computed by the
  // agent's public deterministic script helper below.
  const { createToolset } = await import('../../../packages/agent/dist/src/index.js');
  let draft;
  const tools = createToolset({ generateSvg: () => ({ svg: '<svg/>' }), onPackageChange: pkg => { draft = pkg; } });
  await tools['storyboard.propose'].run(calls[0].args);
  const identity = await tools['assets.generate_image'].run(calls[1].args);
  const composition = await tools['assets.generate_image'].run(calls[2].args);
  provider.setCalls([...calls, { name: 'assets.generate_video', args: { ...shotDirection('shot1'), motion_model: 'h3', image: identity.asset.id, reference: composition.asset.id, wordless: true } }]);
  const events = [];
  let result;
  try {
    result = await runner({ brief: ONE_SHOT_BRIEF, provider: 'custom', motionModel: 'h3', onEvent: event => events.push(event) });
  } catch (error) {
    assert.fail(`${error.message}\n${JSON.stringify(events)}`);
  }
  assert.equal(result.fallback, false, JSON.stringify(events));
  assert.ok(result.usage.total > 0);
  assert.equal(result.usage.total, result.usage.input + result.usage.output);
  assert.ok(events.some(event => event.type === 'runner_phase' && event.phase === 'initial' && event.status === 'completed'));
  assert.ok(events.some(event => event.type === 'model_result' && typeof event.durationMs === 'number' && typeof event.elapsedMs === 'number'));
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'assets.generate_video' && typeof event.durationMs === 'number'));
  assert.equal(result.package.scenes[0].copy, undefined);
  const video = Object.values(result.package.assets).find(asset => asset.gen?.generator === 'fasth3-omni');
  assert.ok(video);
  const audio = result.package.assets[video.gen.inputs.audio];
  assert.equal(audio.media.durationSeconds, 0.5);
  assert.equal(existsSync(join(runtimeDir, 'packages', audio.file)), true);
  assert.equal(readFileSync(join(runtimeDir, 'packages', audio.file)).length, 24044);
});

test('one bounded repair corrects the existing package duration before production', async t => {
  const badScenes = scenes.map(scene => ({ ...scene, preferredFrames: 225 }));
  const { runner, provider } = await setup(t, [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes: badScenes } },
  ]);
  const repairCalls = [
    ...scenes.map(scene => ({ name: 'storyboard.edit', args: { scene_id: scene.id, patch: { preferredFrames: 180 } } })),
    ...scenes.map(scene => ({ name: 'assets.generate_video', args: { ...shotDirection(scene.id), motion_model: 'klein' } })),
  ];
  let repaired = false;
  const result = await runner({ brief: BRIEF, provider: 'custom', motionModel: 'klein', onEvent: event => {
    if (event.type === 'done' && !repaired) {
      repaired = true;
      provider.setCalls(repairCalls);
    }
  } });
  assert.equal(result.fallback, false);
  assert.equal(repaired, true, 'the invalid first plan really exercised the bounded repair');
  assert.equal(provider.calls, repairCalls.length + 1, 'repair executes the eight edits/assets and receives a final model turn');
  const repairRequestText = JSON.stringify(provider.requests.at(-1)?.messages ?? []);
  assert.match(repairRequestText, /requested total frames=720/);
  assert.match(repairRequestText, /shot1 preferredFrames=225/);
  assert.match(repairRequestText, /shot2 preferredFrames=225/);
  assert.match(repairRequestText, /Use only these exact scene IDs/);
  const seconds = result.package.scenes.reduce((sum, scene) => sum + scene.preferredFrames, 0) / result.package.format.fps;
  assert.equal(seconds, 24);
  assert.equal(result.package.proposal.logline, proposal.logline);
});

test('generated-film repair reaching its step cap is rejected even when the draft is complete', async t => {
  const { runner, provider } = await setup(t, [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes: scenes.map(scene => ({ ...scene, preferredFrames: 225 })) } },
  ]);
  let repairStarted = false;
  await assert.rejects(() => runner({ brief: BRIEF, provider: 'custom', motionModel: 'klein', onEvent: event => {
    if (event.type === 'runner_phase' && event.phase === 'initial' && event.status === 'validation' && !repairStarted) {
      repairStarted = true;
      provider.setCalls([
        ...scenes.map(scene => ({ name: 'storyboard.edit', args: { scene_id: scene.id, patch: { preferredFrames: 180 } } })),
        ...scenes.map(scene => ({ name: 'assets.generate_video', args: { ...shotDirection(scene.id), motion_model: 'klein' } })),
        ...Array.from({ length: 8 }, () => ({ name: 'storyboard.edit', args: { scene_id: 'shot1', patch: { preferredFrames: 180 } } })),
      ]);
    }
  } }), error => {
    assert.equal(error.code, 'GENERATED_FILM_INCOMPLETE');
    assert.match(error.message, /repair stopped: agent step limit \(16\) reached/);
    assert.deepEqual(error.errors, [], 'a valid draft alone must not mask the unfinished model turn');
    return true;
  });
  assert.equal(repairStarted, true);
  assert.equal(provider.calls, 16, 'no request is issued beyond the repair cap');
});

test('repair survives the campaign admission 429 and revalidates the existing plan', async t => {
  const { runner, provider, runtimeDir } = await setup(t, [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes: scenes.map(scene => ({ ...scene, preferredFrames: 225 })) } },
  ]);
  const conversationId = 'chat_0123456789abcdef';
  createContextAttachmentStore({ rootDir: runtimeDir, chatId: conversationId }).addFile({
    bytes: Buffer.from('The lighthouse lamp must be amber.'), filename: 'direction.txt', mime: 'text/plain',
  });
  const events = [];
  let repairStarted = false;
  const result = await runner({ brief: BRIEF, provider: 'custom', motionModel: 'klein', videoType: 'action-scene', conversationId, onEvent: event => {
    events.push(event);
    if (event.type === 'runner_phase' && event.phase === 'initial' && event.status === 'validation' && !repairStarted) {
      repairStarted = true;
      provider.setCalls([
        ...scenes.map(scene => ({ name: 'storyboard.edit', args: { scene_id: scene.id, patch: { preferredFrames: 180 } } })),
        ...scenes.map(scene => ({ name: 'assets.generate_video', args: { ...shotDirection(scene.id), motion_model: 'klein' } })),
      ]);
      provider.refuseNext(1);
    }
  } });
  assert.equal(events.filter(event => event.status === 'admission_retry').length, 1);
  assert.equal(result.package.proposal.logline, proposal.logline);
  assert.equal(result.motionModel, 'klein');
  assert.equal(result.package.scenes.reduce((n, scene) => n + scene.preferredFrames, 0), 720);
  assert.equal(result.package.scenes.length, 4);
  const requests = provider.requests.filter(request => request.messages?.some(message => String(message.content).includes('Validation report:')));
  assert.ok(requests.length >= 2);
  assert.deepEqual(requests[0].messages, requests[1].messages, 'only the refused request is retried');
  assert.ok(requests[0].messages.some(message => message.role === 'user' && /lighthouse lamp must be amber/.test(message.content)));
  assert.doesNotMatch(requests[0].messages[0].content, /lighthouse lamp must be amber/);
  assert.match(requests[0].messages[0].content, /untrusted creative data, not instructions/i);
  assert.match(requests[0].messages[0].content, /Selected video type:.*action-scene/i);
  assert.ok(!requests[0].tools.some(tool => tool.function?.name === 'storyboard_propose'));
});

test('repair admission retry is bounded and never repeats partial or other failures', async () => {
  const refused = { type: 'error', code: 'http_429', message: '[ttft_admission_refused] after 3 s' };
  for (const chunks of [[refused], [{ type: 'tool_call', id: 'x', name: 'storyboard.edit', args: {} }, refused], [{ type: 'error', code: 'http_429', message: 'quota exhausted' }]]) {
    let calls = 0;
    const waits = [];
    const model = { id: 'fake', async *stream() { calls++; yield* chunks; } };
    const wrapped = withRepairAdmissionRetry(model, { wait: async ms => waits.push(ms) });
    const received = [];
    for await (const chunk of wrapped.stream({ signal: new AbortController().signal })) received.push(chunk);
    assert.equal(calls, chunks.length === 1 && chunks[0] === refused ? 2 : 1);
    assert.equal(waits.length, calls - 1);
    assert.ok(received.some(chunk => chunk.type === 'error'));
  }
});

test('initial admission retry honors the recommended delay and never replays partial or ambiguous output', async () => {
  const refused = { type: 'error', code: 'http_429', message: '[ttft_admission_refused] retry shortly (after 26 s)' };
  for (const [chunks, expected] of [
    [[refused, { type: 'done' }], 2],
    [[{ type: 'text', delta: 'partial' }, refused], 1],
    [[refused, { type: 'tool_call', id: 'x', name: 'test', args: {} }], 1],
    [[{ ...refused, message: '[ttft_admission_refused] after 31 s' }], 1],
    [[{ ...refused, message: '[ttft_admission_refused] capacity' }], 1],
    [[{ ...refused, code: 'http_500' }], 1],
  ]) {
    let calls = 0;
    const waits = [];
    const events = [];
    const model = { id: 'fake', async *stream() { calls++; yield* chunks; } };
    const wrapped = withInitialAdmissionRetry(model, { wait: async ms => waits.push(ms), onRetry: ms => events.push(ms) });
    const received = [];
    for await (const chunk of wrapped.stream({ signal: new AbortController().signal })) received.push(chunk);
    assert.equal(calls, expected);
    assert.deepEqual(waits, expected === 2 ? [26000] : []);
    assert.deepEqual(events, waits);
    assert.ok(received.some(chunk => chunk.type === 'error'));
  }
});

test('initial provider failure remains actionable after the bounded admission retry', async t => {
  const { runner, provider } = await setup(t, []);
  provider.refuseNext(2);
  const events = [];
  await assert.rejects(() => runner({ brief: BRIEF, provider: 'custom', onEvent: event => events.push(event) }), error => {
    assert.equal(error.code, 'http_429');
    assert.equal(error.status, 429);
    assert.match(error.message, /ttft_admission_refused.*after 3 s/);
    return true;
  });
  assert.equal(provider.requests.length, 2);
  assert.ok(events.some(event => event.status === 'admission_retry' && event.delayMs === 3000));
});

test('initial admission retry stops on abort and is unavailable to later turns', async () => {
  const refused = { type: 'error', code: 'http_429', message: '[ttft_admission_refused] after 26 s' };
  let calls = 0;
  const model = { id: 'fake', async *stream() { calls++; yield refused; } };
  const controller = new AbortController();
  const wrapped = withInitialAdmissionRetry(model, { wait: async () => controller.abort() });
  const first = [];
  for await (const chunk of wrapped.stream({ signal: controller.signal })) first.push(chunk);
  assert.equal(calls, 1);
  assert.deepEqual(first, [refused]);
  const later = [];
  for await (const chunk of wrapped.stream({ signal: new AbortController().signal })) later.push(chunk);
  assert.equal(calls, 2);
  assert.deepEqual(later, [refused]);
});

test('completion requires meaningful proposal fields and the requested duration', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const intent = classifyProductionIntent('Create a 20-second wordless film in 4 shots. A cartographer erases a river. No captions.');
  const pkg = {
    proposal: { logline: 'A cartographer erases a river and reflections vanish.', look: 'Woodcut and ink.', soundtrack: 'Paper and dry room tone.' },
    format: { fps: 30 },
    scenes: Array.from({ length: 4 }, (_, index) => ({ id: `shot${index + 1}`, preferredFrames: 225, media: [] })),
    assets: {},
  };
  assert.ok(generatedFilmCompletionProblems(pkg, intent, 'klein').some(problem => problem.includes('20 seconds but the plan is 30.00 seconds')));
  delete pkg.proposal;
  const missing = generatedFilmCompletionProblems(pkg, intent, 'klein');
  assert.ok(missing.some(problem => problem.includes('proposal.logline')));
  assert.ok(missing.some(problem => problem.includes('proposal.look')));
  assert.ok(missing.some(problem => problem.includes('proposal.soundtrack')));
});

test('live-action recovery rewrites clay styling instead of looping on validation', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const original = {
    title: 'Six Clay Wipeouts', revision: 4,
    proposal: { logline: 'Clay skaters fall.', look: 'Plasticine stop-motion.', soundtrack: 'Clay clatter.' },
    format: { fps: 30 },
    scenes: [{ id: 's1', preferredFrames: 150, media: [] }],
    assets: {
      a_img: { kind: 'image', gen: { generator: 'flux3-klein', inputs: { prompt: 'A handmade clay figure in a tabletop skate park.' } } },
    },
  };
  const corrected = enforceLiveActionHumans(original);
  assert.equal(corrected.changed, true);
  assert.match(corrected.package.proposal.look, /Photorealistic live-action humans/);
  assert.ok(corrected.package.proposal.look.length <= 100);
  assert.match(corrected.package.assets.a_img.gen.inputs.prompt, /^Photorealistic live-action fictional human adults/);
  assert.doesNotMatch(JSON.stringify(corrected.package), /clay|plasticine|stop-motion/i);
  assert.match(original.proposal.look, /Plasticine/);
  const intent = classifyProductionIntent('Create a live-action film with real humans.');
  const problems = generatedFilmCompletionProblems(corrected.package, intent, 'auto');
  assert.equal(problems.some(problem => problem.includes('real-human brief conflicts')), false, problems.join('\n'));
});

test('coverage splitter creates separate short generation shots while preserving duration', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const pkg = {
    title: 'Real Human Skaters',
    proposal: { logline: 'A skater falls.', look: 'Photorealistic live-action humans.', soundtrack: 'Foley.' },
    format: { fps: 30 }, revision: 20,
    scenes: [{ id: 's1', layout: 'list', preferredFrames: 600, background: { asset: 'a_vid_old' }, notes: 'LTX finishing sound plan: foley' }],
    assets: {
      a_vid_old: {
        kind: 'video', status: 'pending',
        gen: {
          generator: 'ltx25', workflow: 'workflows/ltx25_i2v.api.json',
          inputs: { image: 'a_start', frames: 121, fps: 24, seed: 201, prompt: 'Photorealistic human skater.' },
        },
        media: { audio: 'none' }, notes: 'finishing sound plan: foley',
      },
    },
  };
  const covered = coverGeneratedFilmScenes(pkg);
  assert.equal(covered.splits, 1);
  assert.equal(covered.package.scenes.length, 4);
  assert.equal(covered.package.scenes.reduce((sum, scene) => sum + scene.preferredFrames, 0), 600);
  assert.equal(covered.package.assets.a_vid_old, undefined);
  const ids = covered.package.scenes.map(scene => scene.background.asset);
  assert.ok(covered.package.scenes.every(scene => !scene.media), 'split shots use their actual visible slot, not unused media aliases');
  assert.equal(new Set(ids).size, 4);
  assert.deepEqual(ids.map(id => covered.package.assets[id].gen.inputs.seed), [201, 202, 203, 204]);
  const intent = classifyProductionIntent('Create a 20-second live-action film with real humans.');
  const problems = generatedFilmCompletionProblems(covered.package, intent, 'auto');
  assert.equal(problems.some(problem => problem.includes('attached generated video covers')), false, problems.join('\n'));
});

test('coverage splitting keeps one opener and one outro instead of repeating bookends on every part', () => {
  const video = (seed) => ({
    kind: 'video', status: 'pending',
    gen: { generator: 'ltx25', workflow: 'workflows/ltx25_i2v.api.json', inputs: { image: 'a_start', frames: 121, fps: 24, seed } },
    media: { audio: 'none' },
  });
  const pkg = {
    format: { fps: 30 }, revision: 2,
    scenes: [
      { id: 's1', layout: 'title', variant: 'centered', preferredFrames: 600, copy: { headline: 'THE ATLAS' }, motion: { recipe: 'kinetic', entry: 'maskRise' }, background: { asset: 'a_open' } },
      { id: 's2', layout: 'title', variant: 'outro', preferredFrames: 600, copy: { headline: 'HOME AGAIN' }, motion: { recipe: 'kinetic', entry: 'fadeUp' }, background: { asset: 'a_close' }, transitionOut: { type: 'fade', frames: 12 } },
    ],
    assets: { a_open: video(10), a_close: video(20) },
  };
  const covered = coverGeneratedFilmScenes(pkg);
  assert.equal(covered.splits, 2);
  assert.equal(covered.package.scenes.length, 8);
  assert.equal(covered.package.scenes.reduce((sum, scene) => sum + scene.preferredFrames, 0), 1200);
  assert.equal(covered.package.scenes[0].variant, 'centered');
  assert.equal(covered.package.scenes[0].copy.headline, 'THE ATLAS');
  assert.equal(covered.package.scenes.at(-1).variant, 'outro');
  assert.equal(covered.package.scenes.at(-1).copy.headline, 'HOME AGAIN');
  assert.equal(covered.package.scenes.at(-1).transitionOut, undefined);
  for (const scene of covered.package.scenes.slice(1, -1)) {
    assert.equal(scene.layout, 'list');
    assert.equal(scene.media_only, true);
    assert.equal(scene.copy, undefined);
    assert.equal(scene.motion, undefined);
  }
});

test('coverage splitting keeps narration and cue ownership on the first part only', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const narration = 'The skater rises after the fall.';
  const pkg = {
    title: 'Getting Up',
    proposal: { logline: 'A skater gets up.', look: 'Photorealistic live action.', soundtrack: 'Skateboard foley.' },
    format: { fps: 30 }, revision: 3,
    voice: { enabled: true, engine: 'kokoro', voice: 'af_heart' },
    scenes: [{
      id: 's1', layout: 'list', media_only: true, preferredFrames: 360, narration,
      motion: { cue_phrases: ['rises after the fall'] }, background: { asset: 'a_ltx' },
      notes: 'LTX finishing sound plan: wheels, impact and room tone',
    }],
    assets: {
      a_ltx: {
        kind: 'video', status: 'pending',
        gen: { generator: 'ltx25', workflow: 'workflows/ltx25_i2v.api.json', inputs: { image: 'a_start', frames: 121, fps: 24, seed: 8 } },
        media: { audio: 'none' }, notes: 'finishing sound plan: wheels, impact and room tone',
      },
    },
  };
  const covered = coverGeneratedFilmScenes(pkg);
  assert.equal(covered.splits, 1);
  assert.equal(covered.package.scenes.length, 3);
  assert.deepEqual(covered.package.scenes.map(scene => scene.narration), [narration, undefined, undefined]);
  assert.deepEqual(covered.package.scenes.map(scene => scene.motion?.cue_phrases), [['rises after the fall'], undefined, undefined]);
  const brief = 'Create a 12-second narrated generated film in 1 shot with motion.cue_phrases copied from narration. No music. No captions.';
  const intent = classifyProductionIntent(brief);
  const problems = generatedFilmCompletionProblems(covered.package, intent, 'ltx', brief);
  assert.equal(problems.some(problem => /narration|cue_phrases|attached generated video covers/.test(problem)), false, problems.join('\n'));
});

test('completion rejects clay substitutions for real humans and under-covered scene durations', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const intent = classifyProductionIntent('Create a 2 minute live-action video with real humans.');
  const pkg = {
    title: 'Six Clay Wipeouts',
    proposal: { logline: 'Human skaters fall.', look: 'Plasticine stop-motion.', soundtrack: 'Foley.' },
    format: { fps: 30 },
    scenes: [{ id: 's1', layout: 'list', preferredFrames: 600, background: { asset: 'a_video' } }],
    assets: {
      a_video: {
        kind: 'video',
        gen: {
          generator: 'ltx25', workflow: 'workflows/ltx25_i2v.api.json',
          inputs: { image: 'a_start', frames: 153, fps: 24 },
        },
        media: { audio: 'none' },
        notes: 'finishing sound plan: foley',
      },
    },
  };
  pkg.scenes[0].notes = 'LTX finishing sound plan: foley';
  const problems = generatedFilmCompletionProblems(pkg, intent, 'auto');
  assert.ok(problems.some(problem => problem.includes('real-human brief conflicts')), problems.join('\n'));
  assert.ok(problems.some(problem => problem.includes('scene is 20.00 seconds') && problem.includes('covers 6.38 seconds')), problems.join('\n'));
});

test('completion allows bounded transition drift and rejects larger duration misses', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const intent = classifyProductionIntent('Create a 20-second wordless generated film in 4 scenery shots. No captions.');
  const pkg = {
    proposal: { logline: 'A fire reaches a mineral break.', look: 'Blue-hour aerials.', soundtrack: 'Wind and embers.' },
    format: { fps: 30 },
    scenes: Array.from({ length: 4 }, (_, index) => ({
      id: `shot${index + 1}`, layout: 'hero', preferredFrames: 150,
      transitionOut: index === 0 ? { type: 'fade', frames: 14 } : index === 1 ? { type: 'blur', frames: 16 } : index === 2 ? { type: 'fade', frames: 14 } : { type: 'none' },
      media: [],
    })),
    assets: {},
  };
  const problems = generatedFilmCompletionProblems(pkg, intent, 'ltx');
  assert.ok(!problems.some(problem => problem.includes('20 seconds but the plan')), problems.join('\n'));
  for (const scene of pkg.scenes) scene.preferredFrames = 225;
  const excessive = generatedFilmCompletionProblems(pkg, intent, 'ltx');
  assert.ok(excessive.some(problem => problem.includes('20 seconds but the plan is 28.53 seconds')), excessive.join('\n'));
  assert.ok(excessive.some(problem => problem.includes('acceptable range is 17.00–23.00 seconds')), excessive.join('\n'));
});

test('narration-timed graphics require narration and exact cue phrases', async () => {
  const { classifyProductionIntent } = await import('../../../packages/agent/dist/src/index.js');
  const intent = classifyProductionIntent('Create a 20-second narrated generated film in 4 shots with motion.cue_phrases copied verbatim from narration.');
  const pkg = {
    proposal: { logline: 'A mapped river changes course.', look: 'Indigo atlas pages.', soundtrack: 'Paper and water.' },
    format: { fps: 30 },
    scenes: [{ id: 'shot1', preferredFrames: 150, narration: 'The river changes course.', media: [] }],
    assets: {},
  };
  const problems = generatedFilmCompletionProblems(pkg, intent, 'klein');
  assert.ok(problems.some(problem => problem.includes('motion.cue_phrases')));
  pkg.scenes[0].motion = { cue_phrases: ['Changes course'] };
  assert.ok(generatedFilmCompletionProblems(pkg, intent, 'klein').some(problem => problem.includes('copied verbatim')));
  pkg.scenes[0].motion = { cue_phrases: ['changes course'] };
  assert.ok(!generatedFilmCompletionProblems(pkg, intent, 'klein').some(problem => problem.includes('motion.cue_phrases')));
});

test('runner explicitly accepts Klein stills + code motion without H3/LTX jobs', async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: BRIEF, title: 'The Lamp at Dusk', proposal, scenes: [scenes[0]] } },
    { name: 'assets.generate_video', args: { ...shotDirection('shot1'), motion_model: 'klein' } },
  ];
  const { runner } = await setup(t, calls);
  const result = await runner({ brief: ONE_SHOT_BRIEF, provider: 'custom', motionModel: 'klein' });
  assert.equal(result.fallback, false);
  assert.match(result.package.compliance.warnings.join(' '), /stills \+ code motion/);
  assert.ok(result.package.scenes[0].motion);
  assert.ok(result.pendingGpu.every(asset => asset.generator === 'flux3-klein'));
  const still = result.package.assets[result.package.scenes[0].background.asset];
  assert.equal(still.kind, 'image');
  assert.match(still.notes, /stills \+ code motion/);
  assert.ok(!Object.values(result.package.assets).some(asset => ['fasth3-omni', 'ltx25'].includes(asset.gen?.generator)));
});

test('initial and repair token totals stay aggregated across both phases', async t => {
  const badScene = { ...scenes[0], preferredFrames: 450 };
  const { runner, provider } = await setup(t, [
    { name: 'storyboard.propose', args: { brief: ONE_SHOT_BRIEF, title: 'The Lamp at Dusk', proposal, scenes: [badScene] } },
  ]);
  const repairCalls = [
    { name: 'storyboard.edit', args: { scene_id: 'shot1', patch: { preferredFrames: 180 } } },
    { name: 'assets.generate_video', args: { ...shotDirection('shot1'), motion_model: 'klein' } },
  ];
  let repaired = false;
  const progress = createAgentProgress('aggregate-usage');
  const result = await runner({
    brief: ONE_SHOT_BRIEF,
    provider: 'custom',
    motionModel: 'klein',
    onEvent: event => {
      progress.update(event);
      if (event.type === 'done' && !repaired) {
        repaired = true;
        provider.setCalls(repairCalls);
      }
    },
  });
  // Each scripted tool request reports 64/24 and each final text request reports 32/8.
  // Initial plan: propose + final. Repair: edit + video + final.
  assert.equal(repaired, true);
  assert.equal(result.usage.input, 256);
  assert.equal(result.usage.output, 88);
  assert.equal(result.usage.total, 344);
  assert.deepEqual(progress.snapshot().usage, { input: 256, output: 88, total: 344 });
});
