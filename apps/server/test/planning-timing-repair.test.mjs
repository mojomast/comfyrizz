import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptedModel, createToolset } from '../../../packages/agent/dist/src/index.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { coverGeneratedFilmScenes, createCpuAgentRunner, repairPackageFacts } from '../src/agent-runner.mjs';
import { applyPlanningTimingRepair, planningTimingFacts, repairPlanningTiming, TIMING_REPAIR_TOOL } from '../src/planning-timing-repair.mjs';
import { replayProvider } from './fake-provider.mjs';

// Timing/copy/scene IDs transcribed from the frozen acceptance progress traces:
// character-and-credits-fixed/credits/evidence/progress-015.json and
// motion-type-effects-fixed/citrus/evidence/progress-012.json. No delivered
// footage is represented here: these exercise the real planning tools only.
const credits = {
  seconds: 45, title: 'THE LAST SIGNAL',
  brief: 'Create exactly 45 seconds of landscape opening credits for a fictional mystery television show called THE LAST SIGNAL. Build a coherent cinematic sequence of six distinct ComfyUI-generated LTX-2.5 motion shots with a photographic teal-and-amber night palette: an abandoned coastal radio tower with a rotating beacon and drifting fog; magnetic tape reels visibly turning beside warm instrument lights; a slow tracking view along an empty archive aisle with drifting dust; rain moving down a dark window with an eerie reflected amber light; a slow view across a radio tuning dial with no readable markings; and a slow move toward a softly glowing radio in an empty room overlooking the dark sea. All environments and credits are fictional. Overlay these exact native editable credits in this order, one per corresponding shot: STARRING MAYA REED; WITH JONAH VOSS; CASTING BY NINA QUILL; MUSIC BY ADRIAN FENN; CREATED BY ELLIS ROWE; THE LAST SIGNAL. Use elegant bold cinematic typography with generous spacing, mask-rise and spring-settled entrances, a coherent palette of restrained directional or shape-reveal transitions, and at least three seconds of fully readable settled credit on each shot. Keep generated moving footage visible beneath the credits throughout. Give the final show title the strongest reveal and a long settled ending. Account for transition overlaps so the complete export is exactly 45 seconds. Add an original instrumental mystery score with a low synthesizer pulse, sparse piano notes and a gradual swell into the final title. Sustain the musical arc across the full film and give it a deliberate ending. No recognizable existing tune. No speaking, narration, dialogue, lyrics, singing, whispered voices or vocal samples. No additional text, logos or baked-in lettering in generated imagery.',
  ids: ['s1-tower', 's2-reels', 's3-archive', 's4-rain', 's5-dial', 's6-title'],
  copy: ['STARRING MAYA REED', 'WITH JONAH VOSS', 'CASTING BY NINA QUILL', 'MUSIC BY ADRIAN FENN', 'CREATED BY ELLIS ROWE', 'THE LAST SIGNAL'],
  frames: [216, 216, 216, 216, 216, 306], overlaps: [0, 0, 0, 0, 0, 0],
  repaired: [228, 228, 228, 228, 228, 270], repairedOverlaps: [12, 12, 12, 12, 12, 0],
  shots: [
    ['an abandoned coastal radio tower on a rocky headland', "The tower's amber beacon turns steadily, sweeping a faint warm arc through the fog, while drifting fog slides slowly past the lattice legs."],
    ['a pair of magnetic tape reels on an old reel-to-reel machine', 'Both tape reels turn steadily, tape spooling from one to the other, warm lamp light flickering gently across the spinning hub spokes.'],
    ['an empty archival tape storage aisle', 'The camera tracks slowly along the aisle past the shelving, dust motes drifting and turning in the lamp beams as the racks slide by.'],
    ['rain running down a dark windowpane', 'Raindrops slide down the glass in slow wavering trails, merging and breaking, the reflected amber light shimmering and stretching across the wet pane.'],
    ['a vintage radio tuning dial', 'The tuning needle glides slowly along the blank glowing band, the amber backlight breathing faintly, dust glinting on the glass.'],
    ['a softly glowing tabletop radio in an empty room', "The radio's amber glow swells gently brighter as the camera inches toward it, the dark sea horizon steady behind the glass."],
  ],
};
const citrus = {
  seconds: 12, title: 'Citrus in Motion',
  brief: 'Create exactly 12 seconds of landscape cinematic video titled Citrus in Motion, composed of three distinct ComfyUI-generated LTX-2.5 macro motion shots. Shot 1: a whole orange rolling gently across a vivid cobalt-blue surface, hard studio light and a crisp shadow. Shot 2: a close-up orange slice dropping into clear sparkling water, with visible bubbles and splashes against a cobalt-blue background. Shot 3: an elegant rotating view of orange slices with fine water droplets on the same blue studio set. Photographic fruit texture and physical liquid motion, no people, packaging, logos or lettering in generated imagery. Overlay only these exact native editable headlines in order, once each: FRESH ENERGY; MAKE A SPLASH; STAY BRIGHT. Place one headline over each corresponding motion shot, bold warm-white typography with strong contrast and safe margins. Use fancy but readable native effects: a punchy spring-settled scale entrance, a clean mask-rise reveal, and short shape-reveal or iris transitions that suit the round fruit. Give each headline at least two seconds fully readable after its entrance. Keep generated moving footage visible beneath the overlays throughout, with no full-screen text-only cards. Let the final headline settle through the ending while the footage continues. Use three shots and account for transition overlaps to export exactly 12 seconds. No narration, music or sound; deliver a silent video.',
  ids: ['shot1', 'shot2', 'shot3'], copy: ['FRESH ENERGY', 'MAKE A SPLASH', 'STAY BRIGHT'],
  frames: [120, 120, 120], overlaps: [0, 12, 0], repaired: [124, 124, 124], repairedOverlaps: [0, 12, 0],
  shots: [
    ['a whole navel orange with dimpled glossy rind', 'the orange rolls gently to the right across the blue surface, its rind catching the hard studio highlight as the shadow slides with it'],
    ['a thick orange slice with glistening pulp and rind', 'the orange slice drops into the clear sparkling water, bursting into bubbles and a bright splash that rises around the rind while droplets scatter'],
    ['a fanned arc of thick orange slices beaded with fine water droplets', 'the arrangement of orange slices rotates elegantly in place, water droplets glinting as they travel across the pulp and rind'],
  ],
};
function scenesFor(film) {
  return film.ids.map((id, i) => ({ id, layout: 'title', copy: { headline: film.copy[i] }, preferredFrames: film.frames[i],
    headline_size: film === credits && i === 5 ? 132 : 88,
    motion: { entry: 'maskRise', spring: 'settle', stagger: 'word', emphasis: i === film.ids.length - 1 ? 'hero' : 'none' },
    ...(i < film.ids.length - 1 ? { transitionOut: { type: film === citrus && i === 1 ? 'iris' : 'shape-reveal', frames: film.overlaps[i] } } : {}),
  }));
}
function propose(film) { return { name: 'storyboard.propose', args: { brief: film.brief, title: film.title,
  proposal: { logline: film === credits ? 'Six remnants of a vanished broadcast carry the credits.' : 'Three macro studies of citrus on cobalt blue.', look: 'Photographic cinematic lighting.', soundtrack: film === credits ? 'Low synth pulse, sparse piano and a deliberate ending.' : 'Fully silent.' }, scenes: scenesFor(film) } }; }
function imageCall(film, id) { return { name: 'assets.generate_image', args: { scene_id: id, placement: 'conditioning', intent: `Photographic cinematic ${film.shots[film.ids.indexOf(id)][0]}, ${film === credits ? 'teal-and-amber night' : 'cobalt blue studio'}, no lettering, no logos.` } }; }
function videoCall(film, id, image, frames = 289) { return { name: 'assets.generate_video', args: {
  scene_id: id, motion_model: 'ltx', image, frames, subject: film.shots[film.ids.indexOf(id)][0],
  composition: 'Photographic environment with open space for the exact editable native credit.', action: film.shots[film.ids.indexOf(id)][1],
  camera: 'Slow steady tracking view.', soundscape: 'No voices.', characterCount: 0,
  finishing_sound: film === credits ? 'Original low synthesizer pulse, sparse piano, gradual swell and deliberate ending. No voices.' : 'Full silence.',
} }; }
function timingArgs(film) { return { scenes: film.ids.map((scene_id, i) => ({ scene_id, preferredFrames: film.repaired[i], transitionOutFrames: film.repairedOverlaps[i] })) }; }

async function plannedPackage(film) {
  let pkg;
  const tools = createToolset({ motionModel: 'ltx', onPackageChange: value => { pkg = value; } });
  await tools['storyboard.propose'].run(propose(film).args);
  for (const id of film.ids) {
    const image = await tools['assets.generate_image'].run(imageCall(film, id).args);
    await tools['assets.generate_video'].run(videoCall(film, id, image.asset.id).args);
  }
  // Preserve the captured failed authoring exactly; motion lint in propose may
  // normalize transition defaults before the provider's later edits.
  pkg.scenes.forEach((scene, i) => { scene.preferredFrames = film.frames[i]; if (scene.transitionOut) scene.transitionOut.frames = film.overlaps[i]; });
  pkg.duration = { mode: 'target', targetFrames: film.seconds * 30, exact: true };
  return pkg;
}

test('reproduces the actual credits 1374/1350 failure after legacy six-to-twelve splitting', async () => {
  const pkg = await plannedPackage(credits);
  for (const asset of Object.values(pkg.assets)) if (asset.kind === 'video') asset.gen.inputs.frames = 153; // captured frames:150 snapped to LTX lattice
  const split = coverGeneratedFilmScenes(pkg).package;
  assert.equal(split.scenes.length, 12);
  split.scenes.find(scene => scene.id === 's6-title__part2').preferredFrames = 141; // captured successful repair
  assert.throws(() => compileTimeline(split), /available 1374–1374/);
  const facts = planningTimingFacts(split);
  assert.equal(facts.currentFrames, 1374);
  assert.equal(facts.targetFrames, 1350);
});

test('Citrus feedback exposes 348, the 12-frame overlap, and required sum 372', async () => {
  const pkg = await plannedPackage(citrus);
  assert.throws(() => compileTimeline(pkg), /available 348–348/);
  const facts = repairPackageFacts(pkg, { requestedSeconds: 12 }, '16:9');
  assert.match(facts, /current total frames=348/);
  assert.match(facts, /"overlaps":12/);
  assert.match(facts, /summing to 372 frames/);
  const before = structuredClone(pkg);
  const repaired = applyPlanningTimingRepair(pkg, timingArgs(citrus), { brief: citrus.brief, requestedSeconds: 12 });
  assert.equal(repaired.timeline.durationInFrames, 360);
  assert.deepEqual(repaired.timeline, compileTimeline(repaired.package), 'review timeline hash belongs to the corrected package revision');
  assert.deepEqual(repaired.timeline.scenes.map(scene => scene.from), [0, 124, 236]);
  assert.deepEqual(pkg, before, 'input is never partially mutated');
  assert.deepEqual(repaired.package.assets, pkg.assets);
  repaired.package.scenes.forEach((scene, i) => {
    assert.deepEqual({ ...scene, preferredFrames: pkg.scenes[i].preferredFrames }, pkg.scenes[i]);
  });
  assert.equal(validatePackage(repaired.package).valid, true);
});

test('atomic repair rejects partial lists and arithmetic errors without mutation', async () => {
  const pkg = await plannedPackage(citrus);
  const before = structuredClone(pkg);
  assert.throws(() => applyPlanningTimingRepair(pkg, { scenes: timingArgs(citrus).scenes.slice(1) }, { brief: citrus.brief, requestedSeconds: 12 }), /every existing scene/);
  const args = timingArgs(citrus); args.scenes[0].preferredFrames++;
  assert.throws(() => applyPlanningTimingRepair(pkg, args, { brief: citrus.brief, requestedSeconds: 12 }), /required 360/);
  assert.deepEqual(pkg, before);
});

test('coverage honors ready measurement, trim, authored speed and simultaneous plates', async () => {
  const pkg = await plannedPackage(citrus);
  const asset = pkg.assets[pkg.scenes[0].background.asset];
  asset.status = 'ready'; asset.media.durationSeconds = 4;
  asset.file = 'assets/fixture.mp4'; asset.sha256 = '1'.repeat(64);
  const check = () => applyPlanningTimingRepair(pkg, timingArgs(citrus), { brief: citrus.brief, requestedSeconds: 12 });
  assert.throws(check, /covers 120 project frames/);
  asset.media.durationSeconds = 10;
  pkg.scenes[0].background.trim = { startSeconds: 1, endSeconds: 5 };
  assert.throws(check, /covers 120 project frames/);
  pkg.scenes[0].background.trim.endSeconds = 6;
  pkg.scenes[0].background.speed = 2;
  assert.throws(check, /covers 75 project frames/);
  pkg.scenes[0].background.speed = 1;
  assert.equal(check().timeline.durationInFrames, 360);
  const plate = structuredClone(pkg.scenes[0].background);
  pkg.scenes[0].layout = 'split'; delete pkg.scenes[0].headline_size;
  pkg.scenes[0].media = [plate, { ...plate, trim: { startSeconds: 0, endSeconds: 2 } }];
  assert.throws(check, /covers 60 project frames/);
});

test('explicit shot timing, locked content and measured narration cannot be silently shortened', async () => {
  const pkg = await plannedPackage(credits);
  const options = { brief: credits.brief, requestedSeconds: 45 };
  const check = () => applyPlanningTimingRepair(pkg, timingArgs(credits), options);
  options.brief += ' The last shot must last 10 seconds.';
  assert.throws(check, /explicit\/locked\/timed/);
  options.brief = credits.brief;
  pkg.scenes[5].locked = true;
  assert.throws(check, /explicit\/locked\/timed/);
  delete pkg.scenes[5].locked;
  pkg.scenes[5].narration = 'Preserve these exact words.';
  assert.throws(check, /unmeasured narration/);
  pkg.scenes[5].narration_duration_frames = 300;
  assert.throws(check, /cannot fit/);
});

test('measured voice assets, native dialogue and brief reading holds remain hard floors', async () => {
  const pkg = await plannedPackage(credits);
  const options = { brief: credits.brief, requestedSeconds: 45 };
  const check = () => applyPlanningTimingRepair(pkg, timingArgs(credits), options);
  pkg.scenes[5].narration_asset = 'a_voice'; pkg.scenes[5].narration = 'Exact measured words.';
  pkg.assets.a_voice = { kind: 'audio', status: 'ready', media: { durationSeconds: 9.1 } };
  assert.throws(check, /cannot fit/);
  delete pkg.scenes[5].narration_asset; delete pkg.scenes[5].narration;
  const video = pkg.assets[pkg.scenes[5].background.asset];
  video.gen.direction = { dialogue: { text: 'Exact measured words.' } }; video.gen.inputs.audio = 'a_voice';
  assert.throws(check, /measured dialogue/);
  const args = timingArgs(credits); args.scenes[0].preferredFrames = 70; args.scenes[5].preferredFrames += 158;
  assert.throws(() => applyPlanningTimingRepair(pkg, args, options), /fully settled reading hold/);
});

test('pending undercoverage cannot be hidden by changing scene windows or adding overlap', async () => {
  const pkg = await plannedPackage(credits);
  for (const scene of pkg.scenes) pkg.assets[scene.background.asset].gen.inputs.frames = 153;
  assert.throws(() => applyPlanningTimingRepair(pkg, timingArgs(credits), { brief: credits.brief, requestedSeconds: 45 }), /covers 191 project frames/);
});

test('nine measured natural-speed dialogue lines reallocate the long fifth line within exactly 45 seconds', async () => {
  // Parent's offline measured metadata only, not its private audio files/IDs or
  // hashes. No synthesis or asset import occurs in this pure timing regression.
  const lines = [
    ['Every night, this radio receives a message from tomorrow.', 3.278667],
    ['Tonight, it said my name.', 1.550667],
    ['At first, I thought someone was playing a trick.', 2.446667],
    ['Then it described a storm before the sky turned dark.', 3.129333],
    ['I started writing everything down: the times, the voices, the places nobody should have known.', 5.646667],
    ['Yesterday, the signal went silent.', 2.190667],
    ['For the first time in months, I slept.', 2.126667],
    ['But a minute ago, the radio switched itself on.', 2.745333],
    ['And this time, the voice on the other end sounded exactly like me.', 3.897333],
  ];
  const pkg = await plannedPackage(credits);
  const template = pkg.scenes[0];
  const templateVideo = pkg.assets[template.background.asset];
  pkg.scenes = lines.map(([text, seconds], i) => {
    const videoId = `a_video_fixture_${i}`;
    const audioId = `a_audio_fixture_${i}`;
    pkg.assets[audioId] = { kind: 'audio', origin: 'generated', status: 'ready', file: `assets/${audioId}.wav`, sha256: '0'.repeat(64),
      license: { id: 'CC0-1.0' }, redistributable: true, media: { durationSeconds: seconds },
      model_license: { id: 'Apache-2.0' },
      gen: { generator: 'kokoro', model: 'kokoro-v1.0.onnx', inputs: { text, voice: 'af_heart', speed: 1 } },
    };
    pkg.assets[videoId] = { ...structuredClone(templateVideo), gen: {
      ...structuredClone(templateVideo.gen), generator: 'fasth3-omni', workflow: 'workflows/fasth3_omni_ref2va.api.json',
      direction: { subject: 'Fictional radio archivist.', composition: 'Medium close view at the radio desk.',
        action: 'She speaks then listens.', camera: 'Static medium close view.', soundscape: 'Quiet room tone.', characterCount: 1,
        dialogue: { text, conditioningText: text, language: 'en-us', voice: 'af_heart', delivery: 'quietly' } },
      inputs: { ...templateVideo.gen.inputs, audio: audioId, reference: templateVideo.gen.inputs.image, frames: 294, fps: 24 },
    } };
    return { ...structuredClone(template), id: `s${i + 1}`, preferredFrames: 150,
      background: { ...template.background, asset: videoId }, transitionOut: { type: 'cut', frames: 0 },
    };
  });
  const minima = planningTimingFacts(pkg).scenes.map(scene => scene.sources[0].minimumDialogueFrames);
  assert.equal(validatePackage(pkg).valid, true, JSON.stringify(validatePackage(pkg).errors));
  assert.deepEqual(minima, [105, 53, 80, 100, 176, 72, 70, 89, 123]);
  assert.equal(minima.reduce((sum, frames) => sum + frames, 0), 868);
  assert.equal(compileTimeline(pkg).durationInFrames, 1350, 'total-only compilation misses the native speech overflow');
  assert.match(planningTimingFacts(pkg).error, /s5.*176 project frames/);
  const args = { scenes: pkg.scenes.map(scene => ({ scene_id: scene.id, preferredFrames: 150, transitionOutFrames: 0 })) };
  assert.throws(() => applyPlanningTimingRepair(pkg, args, { brief: 'Create exactly 45 seconds of native speaking character film.', requestedSeconds: 45 }), /required 176 frames/);
  args.scenes[1].preferredFrames = 124;
  args.scenes[4].preferredFrames = 176;
  const result = await repairPlanningTiming(pkg, {
    brief: 'Create exactly 45 seconds of native speaking character film.', requestedSeconds: 45,
    model: createScriptedModel([{ name: TIMING_REPAIR_TOOL, args }]),
  });
  assert.equal(result.result.ok, true);
  assert.equal(result.package.scenes[4].preferredFrames, 176, JSON.stringify(result.result.toolCalls));
  assert.equal(compileTimeline(result.package).durationInFrames, 1350);
  assert.equal(planningTimingFacts(result.package).error, undefined);
  assert.deepEqual(result.package.assets, pkg.assets, 'exact dialogue, natural speed, source footage and audio provenance stay untouched');
  assert.equal(validatePackage(result.package).valid, true);
});

test('bounded timing pass requires provider completion before publishing its candidate', async () => {
  const pkg = await plannedPackage(citrus);
  const call = { name: TIMING_REPAIR_TOOL, args: timingArgs(citrus) };
  const result = await repairPlanningTiming(pkg, { model: createScriptedModel([call, call, call, call]), brief: citrus.brief, requestedSeconds: 12 });
  assert.equal(result.result.stopped, 'max_steps');
  assert.equal(result.package, pkg);
  assert.equal(planningTimingFacts(pkg).currentFrames, 348);
});

async function providerCase(t, film, { shortSource = false } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'planning-timing-'));
  const provider = await replayProvider([]);
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const initial = propose(film);
  // The captured credits planner first generated 150-source-frame clips for
  // default 150-project-frame scenes, then extended the authored windows. The
  // repair must re-plan their coverage rather than silently cloning shots.
  if (film === credits) initial.args.scenes.forEach(scene => { scene.preferredFrames = 150; });
  const imageIds = new Map();
  const calls = [initial, ...film.ids.map(id => imageCall(film, id)), ...film.ids.map(id => request => {
    const image = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
      .map(body => body.result ?? body).findLast(body => body.scene_id === id && body.asset?.kind === 'image');
    imageIds.set(id, image.asset.id);
    return videoCall(film, id, image.asset.id, shortSource ? 97 : film === credits ? 150 : 180);
  })];
  provider.setCalls(calls);
  const events = [];
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  const run = () => runner({ brief: film.brief, provider: 'custom', motionModel: 'ltx', onEvent: event => {
    events.push(event);
    if (event.type === 'runner_phase' && event.status === 'started' && event.phase === 'repair') {
      // Replay the planner's last failed scene-window attempt. Source planning
      // has already happened through normal tools; no package is injected.
      provider.setCalls([...film.ids.map((id, i) => ({ name: 'storyboard.edit', args: { scene_id: id, patch: {
        preferredFrames: film.frames[i], ...(i < film.ids.length - 1 ? { transitionOut: { type: film === citrus && i === 1 ? 'iris' : 'shape-reveal', frames: film.overlaps[i] } } : {}),
      } } })), ...(film === credits ? film.ids.map(id => videoCall(film, id, imageIds.get(id))) : [])]);
    }
    if (event.type === 'done' && event.phase === 'repair' && !event.repairKind) provider.setCalls([{ name: TIMING_REPAIR_TOOL, args: timingArgs(film) }]);
  } });
  return { run, provider, events };
}

for (const film of [credits, citrus]) test(`real runner + fake SSE provider atomically completes ${film.title} before proposal review`, async t => {
  const { run, provider, events } = await providerCase(t, film);
  const result = await run();
  assert.equal(result.live, true); assert.equal(result.fallback, false);
  assert.equal(result.package.scenes.length, film.ids.length);
  assert.deepEqual(result.package.scenes.map(scene => scene.id), film.ids);
  assert.deepEqual(result.package.scenes.map(scene => scene.copy.headline), film.copy);
  assert.deepEqual(result.package.scenes.map(scene => scene.preferredFrames), film.repaired);
  assert.equal(result.timeline.durationInFrames, film.seconds * 30, 'preview/review receives the corrected compiled timeline');
  assert.equal(compileTimeline(result.package).durationInFrames, film.seconds * 30);
  assert.equal(validatePackage(result.package).valid, true);
  assert.equal(result.pendingGpu.filter(asset => asset.generator === 'ltx25').length, film.ids.length);
  result.package.scenes.forEach((scene, i) => {
    const video = result.package.assets[scene.background.asset];
    assert.match(video.gen.inputs.prompt, new RegExp(film.shots[i][0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(video.gen.inputs.frames / video.gen.inputs.fps >= scene.preferredFrames / 30);
    assert.equal(scene.background.speed, undefined);
    assert.equal(scene.background.holdFrames, undefined);
  });
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === TIMING_REPAIR_TOOL && event.ok));
  assert.equal(events.filter(event => event.type === 'step' && event.repairKind === 'exact_timing').length, 2, 'one atomic call and final completion, within the three-step bound');
  const request = provider.requests.find(request => request.tools?.some(tool => tool.function?.name === 'storyboard_repair_timing'));
  assert.match(JSON.stringify(request), /coverageFrames/);
  assert.ok(!events.some(event => event.status === 'coverage'), 'six-shot intent is not expanded into twelve shots');
});

test('insufficient source footage still refuses completion through the real runner', async t => {
  const { run, events } = await providerCase(t, citrus, { shortSource: true });
  await assert.rejects(run, error => error.status === 422 && error.code === 'GENERATED_FILM_INCOMPLETE');
  assert.ok(!events.some(event => event.type === 'tool_result' && event.name === TIMING_REPAIR_TOOL && event.ok));
});
