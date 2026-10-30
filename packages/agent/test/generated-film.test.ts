import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolset, SILENT_CONDITIONING_ASSET_ID } from '../src/tools.js';
import { classifyProductionIntent } from '../src/production-intent.js';
import { autoMotionModel, parseMotionModel } from '../src/motion-model.js';
import { runCpuSlice } from '../src/cpu-slice.js';
import type { ChatModel, ChatRequest } from '../src/types.js';

export const RETAINED_FILM_BRIEF = 'Create a 24-second wordless handcrafted miniature film in 4 shots. A mustard felt jerboa and a cobalt wooden bird restore an island lighthouse at dusk as a small boat approaches. Recurring tactile characters, clear physical action, cinematic camera moves, warm golden payoff, gentle coastal sound. No dialogue, captions, logos or real people.';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#6d8cff"/></svg>';
const proposal = {
  logline: 'Two tactile friends restore a lighthouse before a boat arrives.',
  look: 'Handcrafted miniatures at dusk.',
  soundtrack: 'Gentle coastal sound, no speech.',
};

function shot(id: string) {
  return { id, layout: 'hero', preferredFrames: 180, copy: { headline: 'Unwanted caption' } };
}

async function filmTools(motionModel: 'auto' | 'h3' | 'ltx' | 'klein', scenes: Array<Record<string, any>> = [shot('shot1')], persistAudio?: (id: string, wav: Uint8Array) => void, brief = RETAINED_FILM_BRIEF) {
  let draft: any;
  const tools = createToolset({
    motionModel,
    generateSvg: () => ({ svg: SVG }),
    ...(persistAudio ? { persistAudio: (id, wav) => { persistAudio(id, wav); return `assets/${id}.wav`; } } : {}),
    onPackageChange: pkg => { draft = pkg; },
  });
  await tools['storyboard.propose'].run({ brief, title: 'The Lamp at Dusk', proposal, scenes });
  const identity = await tools['assets.generate_image'].run({
    scene_id: scenes[0].id, kind: 'identity-reference', intent: 'A mustard felt jerboa and a cobalt wooden bird, recurring handmade character identity.', seed: 11,
  }) as any;
  const composition = await tools['assets.generate_image'].run({
    scene_id: scenes[0].id, kind: 'composition-reference', intent: 'Wide handcrafted island lighthouse set at dusk, 16:9 composition.', seed: 12,
  }) as any;
  return { tools, getDraft: () => draft, identity: identity.asset.id as string, composition: composition.asset.id as string };
}

function direction(identity: string, composition: string, extra: Record<string, unknown> = {}) {
  return {
    scene_id: 'shot1', subject: 'A mustard felt jerboa and a cobalt wooden bird.',
    composition: 'The friends work at the island lighthouse lamp, tactile miniature set.',
    action: 'The jerboa hauls the lens into place while the bird braces the rail.',
    camera: 'Slow cinematic push toward the lamp.', soundscape: 'Gentle coastal wind, cloth movement and a soft lens click.',
    characterCount: 2, image: identity, reference: composition, finishing_sound: 'Mix coastal wind, cloth movement and the lens click in finishing.', ...extra,
  };
}

async function jobsAndSchema() {
  return {
    jobs: await import(new URL('../../../jobs/src/index.mjs', import.meta.url).href),
    schema: await import(new URL('../../../schema/src/index.mjs', import.meta.url).href),
  };
}

test('retained four-shot prompt is generated film; explicit procedural controls win', () => {
  const intent = classifyProductionIntent(RETAINED_FILM_BRIEF);
  assert.equal(intent.kind, 'generated-film');
  assert.equal(intent.wordless, true);
  assert.equal(intent.noCaptions, true);
  assert.equal(intent.evidence.generatedShots, true);
  assert.equal(intent.evidence.recurringPhysicalCharacters, true);
  assert.equal(intent.evidence.cinematicCameraOrAction, true);
  assert.equal(intent.evidence.nativeSoundscape, true);
  assert.equal(classifyProductionIntent('Create a cinematic 4-shot motion-graphics explainer with animated SVG charts, no narration.').kind, 'motion-graphics');
  const hybrid = classifyProductionIntent('Create a 20-second narrated generated film in 4 shots with Remotion motion graphics, kinetic typography and native foley.');
  assert.equal(hybrid.kind, 'generated-film');
  assert.equal(hybrid.wordless, false);
  assert.equal(hybrid.narrationRequested, true);
  assert.equal(classifyProductionIntent('Create a generated film. Music: instrumental bed. Narration: Kokoro voiceover.').musicRequested, true);
  assert.equal(classifyProductionIntent('Create a wordless generated film with native soundscape and no dialogue or music.').musicRequested, false);
  assert.equal(classifyProductionIntent('Create a generated film with no generated titles; use exact Remotion titles instead.').noCaptions, false);
  assert.equal(classifyProductionIntent('Create a narrated generated film in 4 shots with motion.cue_phrases copied from narration.').requiresNarrationCues, true);
  assert.equal(classifyProductionIntent('No SVG or charts. Create a generated film in 4 shots with a felt mascot and coastal sound.').kind, 'generated-film');
  const liveAction = classifyProductionIntent('A funny 2 minute video featuring people getting hurt falling over. Make it live action please.');
  assert.equal(liveAction.kind, 'generated-film');
  assert.equal(liveAction.evidence.generatedShots, true);
  assert.equal(liveAction.liveActionHumans, true);
  assert.equal(liveAction.requestedSeconds, 120);
  assert.equal(classifyProductionIntent('A 1 minute and 30 second live-action short.').requestedSeconds, 90);
  assert.equal(classifyProductionIntent('A 1.5-minute live-action short.').requestedSeconds, 90);
  const realisticHumans = classifyProductionIntent('A two minute skateboard film with realistic humans and a fisheye lens.');
  assert.equal(realisticHumans.kind, 'generated-film');
  assert.equal(realisticHumans.liveActionHumans, true);
  assert.equal(realisticHumans.requestedSeconds, 120);
  const skateboardFilm = classifyProductionIntent('A two minute skateboard film where people take massive slams.');
  assert.equal(skateboardFilm.kind, 'generated-film');
  assert.equal(skateboardFilm.requestedSeconds, 120);
  const photorealisticHumans = classifyProductionIntent('A skateboard video with photorealistic humans and a fisheye lens.');
  assert.equal(photorealisticHumans.kind, 'generated-film');
  assert.equal(photorealisticHumans.liveActionHumans, true);
  const explainer = classifyProductionIntent('An explainer video explaining our product with generated visuals.');
  assert.equal(explainer.kind, 'generated-film');
  const proceduralExplainer = classifyProductionIntent('An explainer video with animated charts and kinetic typography.');
  assert.equal(proceduralExplainer.kind, 'motion-graphics');
  assert.equal(classifyProductionIntent('Not live action: make a motion-graphics explainer with SVG charts.').kind, 'motion-graphics');
  assert.equal(parseMotionModel(undefined), 'auto');
  assert.throws(() => parseMotionModel('flux'), /motionModel/);
});

test('generated-film planning exposes only storyboard and generated-media tools', async () => {
  const requests: ChatRequest[] = [];
  let step = 0;
  const model: ChatModel = {
    id: 'capture',
    async *stream(request: ChatRequest) {
      requests.push(request);
      if (step++ === 0) {
        yield { type: 'tool_call' as const, id: 'propose', name: 'storyboard.propose', args: { brief: RETAINED_FILM_BRIEF, title: 'The Lamp at Dusk', proposal, scenes: [shot('shot1')] } };
      } else {
        yield { type: 'text' as const, delta: 'done' };
      }
    },
  };
  await runCpuSlice({ brief: RETAINED_FILM_BRIEF, model, motionModel: 'klein', generateSvg: () => ({ svg: SVG }) });
  assert.deepEqual(requests[0].tools.map(tool => tool.name).sort(), [
    'assets.generate_image', 'assets.generate_video', 'storyboard.edit', 'storyboard.propose',
  ]);
});

test('storyboard proposals and repairs retain narration-timed Remotion motion', async () => {
  let draft: any;
  const tools = createToolset({
    motionModel: 'klein',
    generateSvg: () => ({ svg: SVG }),
    onPackageChange: pkg => { draft = pkg; },
  });
  await tools['storyboard.propose'].run({
    brief: 'Create a narrated generated film with motion.cue_phrases copied verbatim from narration.',
    title: 'The Geometry of a Chord',
    proposal,
    scenes: [{
      ...shot('shot1'),
      copy: { headline: 'Octave' },
      narration: 'The string reveals an octave.',
      motion: { recipe: 'kinetic', seed: 17, intensity: 0.6, entry: 'waterfall', cue_phrases: ['reveals an octave'] },
    }],
  });
  assert.deepEqual(draft.scenes[0].motion, {
    recipe: 'kinetic', seed: 17, intensity: 0.6, entry: 'waterfall', cue_phrases: ['reveals an octave'],
  });
  await tools['storyboard.edit'].run({
    scene_id: 'shot1',
    patch: { motion: { cue_phrases: ['The string'], cue_seconds: [1.25], diagram: 'flow' } },
  });
  assert.deepEqual(draft.scenes[0].motion, {
    recipe: 'kinetic', seed: 17, intensity: 0.6, entry: 'waterfall', cue_phrases: ['The string'], cue_seconds: [1.25], diagram: 'flow',
  });
});

test('wordless H3 reuses real silent conditioning, preserves native soundscape and visible background', async () => {
  const writes: Uint8Array[] = [];
  const { tools, getDraft, identity, composition } = await filmTools('h3', [shot('shot1'), shot('shot2')], (_id, wav) => writes.push(wav));
  const first = await tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'h3', wordless: true })) as any;
  const second = await tools['assets.generate_video'].run({ ...direction(identity, composition), scene_id: 'shot2', wordless: true }) as any;
  const pkg = getDraft();
  assert.equal(first.asset.gen.generator, 'fasth3-omni');
  assert.equal(first.native_audio, true);
  assert.match(first.asset.notes, /wordless means no speech/);
  assert.match(first.asset.gen.direction.soundscape, /coastal wind/);
  assert.equal(first.asset.gen.workflow, 'workflows/fasth3_omni_ref2va.api.json');
  assert.equal(first.asset.gen.inputs.audio, SILENT_CONDITIONING_ASSET_ID);
  assert.equal(second.asset.gen.inputs.audio, SILENT_CONDITIONING_ASSET_ID);
  assert.equal(writes.length, 1, 'the deterministic WAV is written once and reused');
  const wav = Buffer.from(writes[0]);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 24044);
  assert.ok(wav.subarray(44).every(byte => byte === 0));
  assert.equal(pkg.assets[SILENT_CONDITIONING_ASSET_ID].media.durationSeconds, 0.5);
  assert.equal(pkg.scenes[0].background.asset, first.asset.id);
  assert.equal(pkg.scenes[1].background.asset, second.asset.id);
  assert.ok(pkg.scenes.every((scene: any) => !scene.media && scene.media_only));
  assert.ok(pkg.scenes.every((scene: any) => !scene.copy && !scene.narration));

  const { jobs, schema } = await jobsAndSchema();
  const valid = schema.validatePackage(pkg);
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  const plan = jobs.planJobs(pkg);
  assert.deepEqual(jobs.checkJobsDoc(plan), []);
  const h3 = plan.jobs.find((job: any) => job.asset === first.asset.id);
  assert.equal(h3.frames, 158);
  assert.equal(h3.frames % 17, 5);
  assert.match(h3.params.prompt, /overall_soundscape:[\s\S]*Gentle coastal wind/);
  assert.ok(h3.fileInputs.some((input: any) => input.param === 'audio' && input.path.endsWith(`${SILENT_CONDITIONING_ASSET_ID}.wav`)));
});

test('LTX uses pinned i2v, retains start-frame refs and requires finishing sound', async () => {
  const { tools, getDraft, identity, composition } = await filmTools('ltx');
  assert.throws(() => tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'ltx', finishing_sound: undefined })), /finishing_sound/);
  const result = await tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'ltx' })) as any;
  const pkg = getDraft();
  assert.equal(result.asset.gen.generator, 'ltx25');
  assert.equal(result.asset.gen.workflow, 'workflows/ltx25_i2v_2stage.api.json');
  assert.equal(result.asset.gen.direction, undefined);
  assert.equal(result.asset.gen.inputs.audio, undefined);
  assert.equal(result.asset.media.audio, 'none');
  assert.match(result.asset.notes, /Finishing sound plan/);
  const start = pkg.assets[result.asset.gen.inputs.image];
  assert.equal(start.gen.generator, 'flux3-klein');
  assert.equal(start.gen.inputs.reference, composition);
  assert.equal(start.gen.inputs.reference_2, identity);
  assert.match(start.gen.inputs.prompt, /composition follows <ref_image_0>/);
  assert.match(start.gen.inputs.prompt, /identity and materials of <ref_image_1>/);
  assert.doesNotMatch(start.gen.inputs.prompt, /Picture [12]|<ref_image_2>/);
  assert.ok(result.asset.gen.inputs.prompt.startsWith(direction(identity, composition).camera));
  assert.ok(result.asset.gen.inputs.prompt.includes(direction(identity, composition).action));
  assert.ok(!result.asset.gen.inputs.prompt.includes(direction(identity, composition).finishing_sound));
  assert.ok(!Object.values(pkg.assets).some((asset: any) => asset.gen?.generator === 'fasth3-omni'));
  const { jobs, schema } = await jobsAndSchema();
  assert.equal(schema.validatePackage(pkg).valid, true, JSON.stringify(schema.validatePackage(pkg).errors));
  const plan = jobs.planJobs(pkg);
  const startJob = plan.jobs.find((job: any) => job.asset === result.asset.gen.inputs.image);
  assert.equal(startJob.workflow, 'workflows/flux3_klein_ref2_edit.api.json');
  assert.equal(startJob.params.width, undefined);
  assert.equal(startJob.params.height, undefined);
  assert.ok(startJob.params.megapixels > 0);
  assert.deepEqual(startJob.fileInputs.map((input: any) => input.param), ['reference', '_reference_2']);
  const { readFileSync } = await import('node:fs');
  const graph = JSON.parse(readFileSync(new URL(`../../../../${startJob.workflow}`, import.meta.url), 'utf8'));
  assert.deepEqual(graph['12'].inputs['images.image0'], ['10', 0]);
  assert.deepEqual(graph['12'].inputs['images.image1'], ['11', 0]);
  assert.ok(startJob.deps.includes(`${identity}.still`));
  assert.ok(startJob.deps.includes(`${composition}.still`));
  const video = plan.jobs.find((job: any) => job.asset === result.asset.id);
  assert.equal(video.frames, 145);
  assert.equal(video.frames % 8, 1);
  assert.ok(video.deps.includes(`${start.id ?? result.asset.gen.inputs.image}.still`));
  assert.ok(plan.jobs.some((job: any) => job.asset === identity));
  assert.ok(plan.jobs.some((job: any) => job.asset === composition));
});

test('LTX start planning refuses a third implicit cast reference instead of claiming unconnected conditioning', async () => {
  const { tools, getDraft, identity, composition } = await filmTools('ltx', [shot('shot1')], undefined,
    RETAINED_FILM_BRIEF + ' Use the same mascot in every scene.');
  const before = structuredClone(getDraft());
  await assert.rejects(async () => tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'ltx' })), /PLAN_KLEIN_REFERENCE_UNSUPPORTED/);
  assert.deepEqual(getDraft(), before, 'refused reference conditioning must not append a start frame or video');
});

test('full silence creates no finishing stem for LTX/Klein and mutes H3 native audio', async () => {
  for (const model of ['ltx', 'klein', 'h3'] as const) {
    const writes: string[] = [];
    const { tools, getDraft, identity, composition } = await filmTools(model, undefined, id => writes.push(id), 'Create a silent generated film. No audio.');
    const result = await tools['assets.generate_video'].run(direction(identity, composition, { motion_model: model })) as any;
    const pkg = getDraft();
    assert.equal(pkg.audio?.music, undefined);
    assert.equal(pkg.assets.a_finishing_mix, undefined);
    assert.ok(!writes.includes('a_finishing_mix'));
    if (model === 'h3') {
      assert.equal(result.asset.media.audio, 'muted');
      assert.match(result.asset.gen.direction.soundscape, /Full silence/);
    } else assert.match(result.finishing_sound, /Full silence/);
    assert.throws(() => tools['assets.generate_video'].run(direction(identity, composition, { wordless: false, dialogue: { text: 'Hello', speaker: 'c1' } })), /brief prohibits speech/);
  }
});

test('auto mixes camera-led LTX and character-action H3 without model fallback', async () => {
  const { tools, getDraft, identity, composition } = await filmTools('auto', [shot('shot1'), shot('shot2')]);
  const establishing = await tools['assets.generate_video'].run(direction(identity, composition, {
    subject: 'An island lighthouse and an approaching boat.', action: 'Waves move around the rocks as the boat approaches.',
    camera: 'An establishing aerial shot slowly pushes toward the island.', characterCount: 0,
  })) as any;
  const acting = await tools['assets.generate_video'].run({ ...direction(identity, composition), scene_id: 'shot2' }) as any;
  assert.equal(establishing.motion_model, 'ltx');
  assert.equal(acting.motion_model, 'h3');
  const pkg = getDraft();
  assert.equal(pkg.scenes[0].background.asset, establishing.asset.id);
  assert.equal(pkg.scenes[1].background.asset, acting.asset.id);
  assert.equal(pkg.assets[establishing.asset.id].media.audio, 'none');
  assert.match(pkg.assets[establishing.asset.id].notes, /Finishing sound plan/);
  assert.equal(pkg.assets[acting.asset.id].gen.inputs.audio, SILENT_CONDITIONING_ASSET_ID);
  const { jobs } = await jobsAndSchema();
  const plan = jobs.planJobs(pkg);
  assert.ok(plan.jobs.some((job: any) => job.generator === 'ltx25'));
  assert.ok(plan.jobs.some((job: any) => job.generator === 'fasth3-omni'));
});

test('explicit Klein is stills + code motion only, with Remotion and finishing metadata', async () => {
  let stem: Uint8Array | undefined;
  const { tools, getDraft, identity, composition } = await filmTools('klein', undefined, (_id, wav) => { stem = wav; });
  assert.throws(() => tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'klein', finishing_sound: undefined })), /finishing_sound/);
  const result = await tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'klein' })) as any;
  const pkg = getDraft();
  assert.ok(stem && stem.length > 44, 'a real PCM finishing stem was written');
  assert.equal(pkg.audio.music.asset, 'a_finishing_mix');
  assert.equal(pkg.assets.a_finishing_mix.media.durationSeconds, 6);
  assert.equal(pkg.assets.a_finishing_mix.status, 'ready');
  assert.equal(result.asset.kind, 'image');
  assert.equal(result.asset.gen.generator, 'flux3-klein');
  assert.equal(result.medium, 'stills + code motion');
  assert.equal(result.generated_character_animation, false);
  assert.equal(result.native_audio, false);
  assert.match(result.asset.notes, /stills \+ code motion/);
  assert.match(result.proposal.look, /stills \+ code motion/);
  assert.match(pkg.compliance.warnings.join(' '), /stills \+ code motion/);
  assert.ok(pkg.scenes[0].motion);
  assert.equal(pkg.scenes[0].foreground[0].anim, 'ken-burns');
  assert.equal(pkg.scenes[0].background.asset, result.asset.id);
  assert.ok(!Object.values(pkg.assets).some((asset: any) => ['fasth3-omni', 'ltx25'].includes(asset.gen?.generator)));
  const { jobs, schema } = await jobsAndSchema();
  assert.equal(schema.validatePackage(pkg).valid, true, JSON.stringify(schema.validatePackage(pkg).errors));
  const plan = jobs.planJobs(pkg);
  assert.ok(plan.jobs.length > 0);
  assert.ok(plan.jobs.every((job: any) => job.generator === 'flux3-klein'));
  const keyframe = plan.jobs.find((job: any) => job.asset === result.asset.id);
  assert.ok(keyframe);
  assert.equal(keyframe.workflow, 'workflows/flux3_klein_ref2_edit.api.json');
  assert.equal(keyframe.params.width, undefined);
  assert.equal(keyframe.params.height, undefined);
  assert.ok(keyframe.params.megapixels > 0);
  assert.deepEqual(keyframe.fileInputs.map((input: any) => input.param), ['reference', '_reference_2']);
  assert.ok(keyframe.deps.includes(`${identity}.still`));
  assert.ok(keyframe.deps.includes(`${composition}.still`));
});

test('whole-film finishing stem accumulates every shot plan instead of freezing the first', async () => {
  const writes: Uint8Array[] = [];
  const { tools, getDraft, identity, composition } = await filmTools('ltx', [shot('shot1'), shot('shot2')], (_id, wav) => writes.push(wav));
  await tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'ltx' }));
  await tools['assets.generate_video'].run({
    ...direction(identity, composition), scene_id: 'shot2', motion_model: 'ltx',
    finishing_sound: 'Add two isolated brass bell answers after the lens click.',
  });
  const pkg = getDraft();
  assert.equal(writes.length, 2, 'the same whole-film stem is rebuilt as shot direction arrives');
  assert.notEqual(Buffer.from(writes[0]).toString('base64'), Buffer.from(writes[1]).toString('base64'));
  assert.match(pkg.assets.a_finishing_mix.gen.inputs.plan, /coastal wind/);
  assert.match(pkg.assets.a_finishing_mix.gen.inputs.plan, /brass bell answers/);
  assert.equal(pkg.assets.a_finishing_mix.gen.model, 'deterministic-pcm-v2');
  assert.equal(pkg.assets.a_finishing_mix.media.durationSeconds, 12);
  assert.ok(pkg.assets.a_finishing_mix.notes.length <= 512, 'whole-film notes stay within the package schema limit');
  assert.equal(pkg.audio.music.gain_db, -12);
});

test('requested Remotion typography survives generated-video planning', async () => {
  const brief = 'Create a 12-second wordless film in 2 shots about a cartographer erasing a river. Use exact Remotion chapter titles and documentary lower thirds with no dialogue or logos; generated footage stays clean of lettering.';
  const typographyScenes = [
    { id: 'shot1', layout: 'hero', preferredFrames: 180, media_only: true, lower_third: { kicker: '01 / THE MAP', text: 'RIVER: INTACT' } },
    { id: 'shot2', layout: 'hero', variant: 'full-bleed', preferredFrames: 180, copy: { kicker: '02 / ONE LINE BACK', headline: 'REDRAWN', sub: 'One reflection returns.' } },
  ];
  assert.equal(classifyProductionIntent(brief).noCaptions, false);
  const { tools, getDraft, identity, composition } = await filmTools('h3', typographyScenes, undefined, brief);
  await tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'h3', wordless: true }));
  await tools['assets.generate_video'].run({ ...direction(identity, composition), scene_id: 'shot2', motion_model: 'h3', wordless: true });
  const pkg = getDraft();
  assert.equal(pkg.scenes[0].media_only, true);
  assert.equal(pkg.scenes[0].lower_third.text, 'RIVER: INTACT');
  assert.equal(pkg.scenes[1].media_only, false);
  assert.equal(pkg.scenes[1].copy.headline, 'REDRAWN');
  assert.equal(pkg.scenes[1].copy.sub, 'One reflection returns.');
});

test('generated films gain editable Remotion bookends without changing shots, media or duration', async () => {
  const brief = 'Create an 18-second cinematic generated film in 3 shots about a cartographer restoring a river atlas, with native sound and a strong opening and closing.';
  const scenes = [
    { id: 'shot1', layout: 'hero', preferredFrames: 120, copy: { headline: 'THE ATLAS', sub: 'A river remembered.' } },
    { id: 'shot2', layout: 'hero', preferredFrames: 240, copy: { headline: 'THE CURRENT' } },
    { id: 'shot3', layout: 'hero', preferredFrames: 180, copy: { headline: 'HOME AGAIN' }, transitionOut: { type: 'fade', frames: 12 } },
  ];
  const intent = classifyProductionIntent(brief);
  assert.equal(intent.bookends, true);
  const { tools, getDraft, identity, composition } = await filmTools('h3', scenes, undefined, brief);
  const before = getDraft();
  assert.deepEqual(before.scenes.map((scene: any) => scene.id), ['shot1', 'shot2', 'shot3']);
  assert.deepEqual(before.scenes.map((scene: any) => scene.preferredFrames), [120, 240, 180]);
  assert.equal(before.scenes[0].layout, 'title');
  assert.equal(before.scenes[0].variant, 'centered');
  assert.equal(before.scenes[0].copy.headline, 'THE ATLAS');
  assert.equal(before.scenes[0].motion.recipe, 'kinetic');
  assert.equal(before.scenes[0].motion.entry, 'maskRise');
  assert.equal(before.scenes[1].layout, 'hero');
  assert.equal(before.scenes[2].layout, 'title');
  assert.equal(before.scenes[2].variant, 'outro');
  assert.equal(before.scenes[2].motion.entry, 'fadeUp');
  assert.equal(before.scenes[2].transitionOut, undefined);

  await tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'h3', wordless: true }));
  await tools['assets.generate_video'].run({ ...direction(identity, composition), scene_id: 'shot3', motion_model: 'h3', wordless: true });
  const pkg = getDraft();
  assert.equal(pkg.scenes[0].media_only, false);
  assert.equal(pkg.scenes[2].media_only, false);
  assert.equal(pkg.assets[pkg.scenes[0].background.asset].kind, 'video');
  assert.equal(pkg.assets[pkg.scenes[2].background.asset].kind, 'video');
  assert.equal(pkg.scenes[0].copy.headline, 'THE ATLAS');
  assert.equal(pkg.scenes[2].copy.headline, 'HOME AGAIN');
  assert.equal(pkg.scenes.reduce((sum: number, scene: any) => sum + scene.preferredFrames, 0), 540);
});

test('generated-video attachment preserves independent editable vector overlays', async () => {
  const brief = 'Create a 12-second generated film in 2 shots about an atlas, with editable Remotion titles and a vector compass overlay.';
  const { tools, getDraft, identity, composition } = await filmTools('h3', [shot('shot1'), shot('shot2')], undefined, brief);
  const vector = await tools['assets.generate_svg'].run({ scene_id: 'shot1', kind: 'icon', intent: 'A precise compass rose with no letters.' }) as any;
  await tools['storyboard.edit'].run({
    scene_id: 'shot1',
    patch: { foreground: [{ asset: vector.asset.id, x: 0.82, y: 0.24, w: 0.18, anim: 'fade-in' }] },
  });
  await tools['assets.generate_video'].run(direction(identity, composition, { motion_model: 'h3', wordless: true }));
  const scene = getDraft().scenes[0];
  assert.ok(scene.foreground.some((item: any) => item.asset === vector.asset.id));
  assert.ok(scene.foreground.every((item: any) => item.asset !== scene.background.asset));
  assert.equal(scene.media, undefined);
});

test('explicit no-text films stay free of automatic editorial copy', async () => {
  let draft: any;
  const tools = createToolset({ motionModel: 'h3', onPackageChange: pkg => { draft = pkg; } });
  await tools['storyboard.propose'].run({
    brief: RETAINED_FILM_BRIEF,
    title: 'The Lamp at Dusk', proposal,
    scenes: [shot('shot1'), { ...shot('shot2'), transitionOut: { type: 'fade', frames: 12 } }],
  });
  assert.ok(draft.scenes.every((scene: any) => !scene.copy && !scene.motion?.recipe));
  assert.ok(draft.scenes.every((scene: any) => scene.layout !== 'title'));
  assert.equal(draft.scenes[1].transitionOut, undefined);
});

test('structured editorial intent selects a purpose-matched middle-shot recipe', async () => {
  const brief = 'Create a generated film in 3 shots explaining a bicycle derailleur mechanism with sketch animation, clean generated footage and editable Remotion titles.';
  assert.equal(classifyProductionIntent(brief).structuredVisual, 'sketch');
  assert.equal(classifyProductionIntent('Create a generated film explaining a caching workflow and cause and effect.').structuredVisual, 'technical-flow');
  let draft: any;
  const tools = createToolset({ motionModel: 'h3', onPackageChange: pkg => { draft = pkg; } });
  await tools['storyboard.propose'].run({
    brief, title: 'The Derailleur', proposal,
    scenes: [
      { id: 'shot1', layout: 'hero', preferredFrames: 120, copy: { headline: 'SHIFT' } },
      { id: 'shot2', layout: 'hero', preferredFrames: 180, copy: { headline: 'GUIDE THE CHAIN', body: 'The cage moves the chain between cogs.' } },
      { id: 'shot3', layout: 'hero', preferredFrames: 120, copy: { headline: 'IN SYNC' } },
    ],
  });
  assert.equal(draft.scenes[0].motion.recipe, 'kinetic');
  assert.equal(draft.scenes[1].motion.recipe, 'sketch');
  assert.equal(draft.scenes[2].motion.recipe, 'kinetic');
});

test('auto route is deterministic and explicit non-auto conflicts are refused', async () => {
  const base = direction('a', 'b');
  assert.equal(autoMotionModel(base as any), 'h3');
  assert.equal(autoMotionModel({ ...base, subject: 'A lighthouse', action: 'Waves move.', characterCount: 0 } as any), 'ltx');
  assert.equal(autoMotionModel({ ...base, subject: 'A deaf percussionist', action: 'Feels the floor and guides the runaway piano.', characterCount: 1 } as any), 'h3');
  const { tools } = await filmTools('h3');
  assert.throws(() => tools['assets.generate_video'].run(direction('missing', 'also-missing', { motion_model: 'ltx' })), /conflicts/);
});
