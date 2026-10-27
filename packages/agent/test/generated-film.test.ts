import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolset, SILENT_CONDITIONING_ASSET_ID } from '../src/tools.js';
import { classifyProductionIntent } from '../src/production-intent.js';
import { autoMotionModel, parseMotionModel } from '../src/motion-model.js';

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

async function filmTools(motionModel: 'auto' | 'h3' | 'ltx' | 'klein', scenes = [shot('shot1')], persistAudio?: (id: string, wav: Uint8Array) => void) {
  let draft: any;
  const tools = createToolset({
    motionModel,
    generateSvg: () => ({ svg: SVG }),
    ...(persistAudio ? { persistAudio: (id, wav) => { persistAudio(id, wav); return `assets/${id}.wav`; } } : {}),
    onPackageChange: pkg => { draft = pkg; },
  });
  await tools['storyboard.propose'].run({ brief: RETAINED_FILM_BRIEF, title: 'The Lamp at Dusk', proposal, scenes });
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
  assert.equal(classifyProductionIntent('No SVG or charts. Create a generated film in 4 shots with a felt mascot and coastal sound.').kind, 'generated-film');
  assert.equal(parseMotionModel(undefined), 'auto');
  assert.throws(() => parseMotionModel('flux'), /motionModel/);
});

test('wordless H3 reuses real silent conditioning, preserves native soundscape and scene.media', async () => {
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
  assert.equal(pkg.scenes[0].media[0].asset, first.asset.id);
  assert.equal(pkg.scenes[1].media[0].asset, second.asset.id);
  assert.ok(pkg.scenes.every((scene: any) => scene.background.asset === scene.media[0].asset && scene.media_only));
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
  assert.ok(!Object.values(pkg.assets).some((asset: any) => asset.gen?.generator === 'fasth3-omni'));
  const { jobs, schema } = await jobsAndSchema();
  assert.equal(schema.validatePackage(pkg).valid, true, JSON.stringify(schema.validatePackage(pkg).errors));
  const plan = jobs.planJobs(pkg);
  const video = plan.jobs.find((job: any) => job.asset === result.asset.id);
  assert.equal(video.frames, 145);
  assert.equal(video.frames % 8, 1);
  assert.ok(video.deps.includes(`${start.id ?? result.asset.gen.inputs.image}.still`));
  assert.ok(plan.jobs.some((job: any) => job.asset === identity));
  assert.ok(plan.jobs.some((job: any) => job.asset === composition));
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
  assert.equal(pkg.scenes[0].media[0].asset, establishing.asset.id);
  assert.equal(pkg.scenes[1].media[0].asset, acting.asset.id);
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
  assert.equal(pkg.scenes[0].media[0].asset, result.asset.id);
  assert.ok(!Object.values(pkg.assets).some((asset: any) => ['fasth3-omni', 'ltx25'].includes(asset.gen?.generator)));
  const { jobs, schema } = await jobsAndSchema();
  assert.equal(schema.validatePackage(pkg).valid, true, JSON.stringify(schema.validatePackage(pkg).errors));
  const plan = jobs.planJobs(pkg);
  assert.ok(plan.jobs.length > 0);
  assert.ok(plan.jobs.every((job: any) => job.generator === 'flux3-klein'));
  assert.ok(plan.jobs.some((job: any) => job.asset === result.asset.id));
});

test('auto route is deterministic and explicit non-auto conflicts are refused', async () => {
  const base = direction('a', 'b');
  assert.equal(autoMotionModel(base as any), 'h3');
  assert.equal(autoMotionModel({ ...base, subject: 'A lighthouse', action: 'Waves move.', characterCount: 0 } as any), 'ltx');
  assert.equal(autoMotionModel({ ...base, subject: 'A deaf percussionist', action: 'Feels the floor and guides the runaway piano.', characterCount: 1 } as any), 'h3');
  const { tools } = await filmTools('h3');
  assert.throws(() => tools['assets.generate_video'].run(direction('missing', 'also-missing', { motion_model: 'ltx' })), /conflicts/);
});
