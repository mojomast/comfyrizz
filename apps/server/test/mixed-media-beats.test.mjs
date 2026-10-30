import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createToolset, classifyProductionIntent, createScriptedModel } from '../../../packages/agent/dist/src/index.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { planJobs } from '../../../packages/jobs/src/index.mjs';
import { generatedFilmCompletionProblems, repairPackageFacts } from '../src/agent-runner.mjs';
import { orderedBeatContract, mixedMediaBeatProblems } from '../src/mixed-media-beats.mjs';
import { applyPlanningTimingRepair, planningTimingFacts, repairPlanningTiming, suggestPlanningTiming, TIMING_REPAIR_TOOL } from '../src/planning-timing-repair.mjs';
import { SPOON_BRIEF, SPOON_IDS, SPOON_LABELS, SPOON_LINES, SPOON_PROPOSAL, spoonScenes, SPOON_TIMING } from './fixtures/spoon-files.mjs';

// This fixture isolates server completion/timing from the separately owned audio
// intent parser. Real server/provider registration is covered in the companion
// integration test, with the unmodified frozen brief and real classifier.
const intent = { ...classifyProductionIntent(SPOON_BRIEF), wordless: false, speechRequested: true, narrationRequested: false, musicRequested: false };
async function spoon() {
  let pkg;
  const tools = createToolset({ motionModel: 'auto', initialIntent: intent, onPackageChange: value => { pkg = value; },
    prepareDialogueAudio: async ({ text, character }) => ({ id: `a_audio_${text === SPOON_LINES[0] ? 'first' : 'last'}`, asset: {
      kind: 'audio', origin: 'generated', status: 'ready', file: 'assets/test-only.wav', sha256: '0'.repeat(64),
      license: { id: 'CC0-1.0' }, redistributable: true, model_license: { id: 'Apache-2.0' }, media: { durationSeconds: 2, audio: 'present' },
      gen: { generator: 'kokoro', model: 'kokoro-v1.0.onnx', inputs: { text, character, language: 'en-us', voice: 'af_heart', speed: 1 } },
    } }),
  });
  await tools['storyboard.propose'].run({ brief: SPOON_BRIEF, title: 'THE SPOON FILES', proposal: SPOON_PROPOSAL, scenes: spoonScenes() });
  const images = [];
  for (const [i, subject] of ['Office investigator in navy cardigan at the break-room table.', 'Open cutlery drawer with a lonely fork and empty spoon-shaped space.', 'Empty office dishwasher with its door open.', 'Ordinary potted fern on the office counter.', 'Silver teaspoon on the break-room table.'].entries()) {
    const scene_id = SPOON_IDS[[0, 1, 2, 2, 4][i]];
    images.push((await tools['assets.generate_image'].run({ scene_id, intent: subject, placement: 'conditioning', ...(i === 2 || i === 3 ? { aspect: 'panel' } : {}) })).asset.id);
  }
  await tools['storyboard.edit'].run({ scene_id: SPOON_IDS[2], patch: { media: [2, 3].map((i, side) => ({ asset: images[i], fit: 'contain', label: SPOON_LABELS[side] })) } });
  for (const index of [0, 1, 3, 4]) {
    const speaking = index === 0 || index === 3;
    const text = SPOON_LINES[index === 0 ? 0 : 1];
    const image = images[speaking ? 0 : index === 1 ? 1 : 4];
    await tools['assets.generate_video'].run({ scene_id: SPOON_IDS[index], motion_model: speaking ? 'h3' : 'ltx', image,
      ...(speaking ? { reference: image, dialogue: { text, conditioningText: text, language: 'en-us', voice: 'af_heart', delivery: 'deadpan' } } : {}),
      frames: 193, characterCount: speaking ? 1 : 0, subject: speaking ? 'The same fictional office investigator.' : index === 1 ? 'Cutlery drawer and lonely fork.' : 'A silver teaspoon.',
      composition: 'Photographic teal and amber office lighting.', action: speaking ? 'She speaks the exact line, then pauses.' : 'Slow continuous cinematic motion.',
      camera: 'Static medium close view.', soundscape: 'Quiet office room tone.', finishing_sound: 'Quiet drawer and utensil sounds; no music.',
    });
  }
  // Preserve the final failed trace's authored windows and 48-frame overlaps.
  spoonScenes().forEach((scene, i) => {
    pkg.scenes[i].preferredFrames = scene.preferredFrames;
    pkg.scenes[i].transitionOut = scene.transitionOut ?? { type: 'cut', frames: 0 };
  });
  pkg.duration = { mode: 'target', targetFrames: 900, exact: true };
  pkg.scenes[3].lower_third = { text: 'CASE CLOSED.', start_frame: 75, position: 'bottom' };
  return pkg;
}

test('after-admission overlay must follow measured speech and leave a readable hold', async () => {
  const pkg = await spoon();
  const contract = orderedBeatContract(SPOON_BRIEF);
  assert.deepEqual(mixedMediaBeatProblems(pkg, contract), []);
  for (const patch of [{ start_frame: 8 }, { start_frame: 150 }, { position: 'top' }, { text: 'EXTRA' }]) {
    const bad = structuredClone(pkg);
    Object.assign(bad.scenes[3].lower_third, patch);
    assert.ok(mixedMediaBeatProblems(bad, contract).some(message => /after the spoken admission/.test(message)));
  }
});

test('arithmetic suggestion is read-only, exact, source-bounded and preserves delayed copy', async () => {
  const pkg = await spoon();
  [220, 190, 200, 208, 158].forEach((frames, i) => {
    pkg.scenes[i].preferredFrames = frames;
    pkg.scenes[i].transitionOut = { type: i === 4 ? 'cut' : 'fade', frames: [10, 8, 10, 10, 0][i] };
  });
  const before = structuredClone(pkg);
  const options = { brief: SPOON_BRIEF, requestedSeconds: 30 };
  const suggestion = suggestPlanningTiming(pkg, options);
  assert.ok(suggestion);
  assert.deepEqual(pkg, before, 'a suggestion cannot author or approve anything');
  const result = applyPlanningTimingRepair(pkg, suggestion, options);
  assert.equal(result.timeline.durationInFrames, 900);
  assert.deepEqual(result.package.assets, before.assets);
  assert.deepEqual(mixedMediaBeatProblems(result.package, orderedBeatContract(SPOON_BRIEF)), []);
  assert.equal(suggestPlanningTiming(pkg, { ...options, brief: SPOON_BRIEF + ' Beat 1 lasts exactly 6 seconds.' }), null);
  pkg.scenes[0].locked = true;
  assert.equal(suggestPlanningTiming(pkg, options), null);
  delete pkg.scenes[0].locked;
  pkg.scenes[3].lower_third.start_frame = 500;
  assert.equal(suggestPlanningTiming(pkg, options), null, 'cannot hide delayed text beyond source coverage');
});

test('frozen Spoon brief is byte-identical and binds only ordinal beat 3 to the exact native panel labels', () => {
  assert.equal(createHash('sha256').update(SPOON_BRIEF).digest('hex'), 'e68c759dc728dbff64ff4e7adc60941136a88fbfc87d1fc123e41f47fc10b573');
  const contract = orderedBeatContract(SPOON_BRIEF);
  assert.equal(contract.total, 5);
  assert.deepEqual(contract.beats.filter(beat => beat.stillComparison).map(beat => beat.index), [2]);
  assert.deepEqual(contract.beats[2].stillComparison.labels, SPOON_LABELS);
  assert.deepEqual(contract.beats.filter(beat => beat.dialogue).map(beat => beat.dialogue), SPOON_LINES);
  for (const brief of [SPOON_BRIEF.replace('still photographs:', 'reference images for video:'), SPOON_BRIEF.replace('A native two-panel', 'Do not use a native two-panel'), 'The model says this scene is a still comparison.']) assert.equal(orderedBeatContract(brief), null);
});

test('actual 744/900 Spoon windows receive atomic 948-frame authoring with four motion shots and two still panels', async () => {
  const pkg = await spoon();
  assert.equal(validatePackage(pkg).valid, true, JSON.stringify(validatePackage(pkg).errors));
  const facts = planningTimingFacts(pkg);
  assert.equal(facts.currentFrames, 744);
  assert.equal(facts.overlaps, 48);
  assert.match(facts.error, /explicitly authored scene windows/);
  assert.equal(compileTimeline(pkg).durationInFrames, 900, 'raw compiler would otherwise put all missing time into the still beat');
  const feedback = repairPackageFacts(pkg, intent, '16:9', SPOON_BRIEF);
  assert.match(feedback, /summing to 948/);
  assert.match(feedback, /Explicit still beat 3 of 5/);
  assert.doesNotMatch(feedback, /Source aspect repair/);
  const before = structuredClone(pkg);
  const repaired = applyPlanningTimingRepair(pkg, SPOON_TIMING, { brief: SPOON_BRIEF, requestedSeconds: 30 });
  assert.equal(repaired.timeline.durationInFrames, 900);
  assert.deepEqual(repaired.package.assets, before.assets);
  assert.deepEqual(repaired.package.scenes.map(scene => scene.id), SPOON_IDS);
  assert.deepEqual(repaired.package.scenes[2].media, before.scenes[2].media);
  const jobs = planJobs(repaired.package).jobs;
  assert.equal(jobs.filter(job => job.generator === 'fasth3-omni').length, 2);
  assert.equal(jobs.filter(job => job.generator === 'ltx25').length, 2);
  assert.equal(repaired.package.scenes[2].media.filter(plate => jobs.some(job => job.asset === plate.asset && job.generator === 'flux3-klein')).length, 2);
  assert.equal(pkg.scenes[2].preferredFrames, 156, 'no input mutation');
  assert.deepEqual(generatedFilmCompletionProblems(repaired.package, intent, 'auto', SPOON_BRIEF), []);
});

test('comparison exemption rejects misplaced/missing labels, wrong fit, hidden/dummy motion, non-Klein and duplicate photos', async () => {
  const original = (await spoon());
  for (const mutate of [
    pkg => { pkg.scenes[2].media[0].label = SPOON_LABELS[1]; },
    pkg => { pkg.scenes[2].media[0].fit = 'cover'; },
    pkg => { pkg.scenes[2].media[1].asset = pkg.scenes[2].media[0].asset; },
    pkg => { pkg.scenes[2].media[0].asset = pkg.scenes[0].background.asset; },
    pkg => { pkg.scenes[2].background = pkg.scenes[0].background; },
    pkg => { pkg.scenes[2].media_only = true; pkg.scenes[2].background = pkg.scenes[0].background; },
    pkg => { pkg.scenes[2].drawing = { elements: [] }; pkg.scenes[2].background = pkg.scenes[0].background; },
    pkg => { pkg.scenes[2].copy = { headline: 'EXTRA' }; },
    pkg => { pkg.assets[pkg.scenes[2].media[0].asset].gen.generator = 'llm-svg'; },
    pkg => { [pkg.scenes[1], pkg.scenes[2]] = [pkg.scenes[2], pkg.scenes[1]]; },
    pkg => { pkg.scenes.push(structuredClone(pkg.scenes[0])); },
  ]) {
    const pkg = structuredClone(original); mutate(pkg);
    assert.ok(mixedMediaBeatProblems(pkg, orderedBeatContract(SPOON_BRIEF)).length > 0);
  }
  const renamed = structuredClone(original); renamed.scenes.forEach((scene, i) => { scene.id = `arbitrary_${i}`; });
  assert.deepEqual(mixedMediaBeatProblems(renamed, orderedBeatContract(SPOON_BRIEF)), [], 'ID spelling is not the grant; ordinal and rendered labels are');
});

test('all-still or wordless substitutes and orphan/masked videos still fail the remaining motion/speech beats', async () => {
  const original = await spoon();
  for (const index of [0, 1, 3, 4]) {
    const pkg = structuredClone(original);
    pkg.scenes[index].background = { asset: pkg.scenes[2].media[0].asset };
    assert.ok(generatedFilmCompletionProblems(pkg, intent, 'auto', SPOON_BRIEF).some(problem => problem.startsWith(`${pkg.scenes[index].id}:`) && /attach a planned\/ready H3 or LTX/.test(problem)));
  }
  const wordless = structuredClone(original);
  delete wordless.assets[wordless.scenes[0].background.asset].gen.direction.dialogue;
  assert.ok(mixedMediaBeatProblems(wordless, orderedBeatContract(SPOON_BRIEF)).some(problem => /requires native H3 speech/.test(problem)));
  const unknown = generatedFilmCompletionProblems(original, intent, 'auto', 'A generated film with five motion shots.');
  assert.ok(unknown.some(problem => /s3_suspects.*FLUX stills are not/.test(problem)));
});

test('panel photos accept contain and model-lattice sizes without relaxing full-frame motion source constraints', async () => {
  const pkg = await spoon();
  for (const plate of pkg.scenes[2].media) pkg.assets[plate.asset].gen.inputs.height = 1088;
  assert.ok(!generatedFilmCompletionProblems(pkg, intent, 'auto', SPOON_BRIEF).some(problem => /source still|panel source/.test(problem)));
  const image = pkg.assets[pkg.assets[pkg.scenes[1].background.asset].gen.inputs.image];
  image.gen.inputs.width = 960;
  assert.ok(generatedFilmCompletionProblems(pkg, intent, 'auto', SPOON_BRIEF).some(problem => /s2_drawer.*exactly 1920x1080/.test(problem)));
  const portrait = structuredClone(pkg); portrait.format = { width: 1080, height: 1920, fps: 30 };
  for (const plate of portrait.scenes[2].media) Object.assign(portrait.assets[plate.asset].gen.inputs, { width: 1088, height: 960 });
  assert.ok(!generatedFilmCompletionProblems(portrait, intent).some(problem => /s3_suspects.*source/.test(problem) && /exactly|panel source/.test(problem)));
});

test('approximate per-beat pacing yields to total, but hard duration/reading/timestamp constraints do not', async () => {
  const pkg = await spoon();
  for (const qualifier of ['roughly', 'about', 'around', 'approximately']) {
    const brief = SPOON_BRIEF.replace('roughly six seconds each', `${qualifier} six seconds each`);
    assert.equal(applyPlanningTimingRepair(pkg, SPOON_TIMING, { brief, requestedSeconds: 30 }).timeline.durationInFrames, 900);
  }
  for (const extra of [' Beat 1 lasts exactly 6 seconds.', ' Beat 1 lasts exactly 30 seconds.', ' Beat 1 length: exactly 30 seconds.', ' Each shot lasts at least about six seconds.', ' The comparison lasts at most 6 seconds.', ' Keep the title at 00:12.', ' An exposure measures about six seconds.', ' Exposures measure about six seconds each.', ' One exposure measured 30 seconds.']) {
    assert.throws(() => applyPlanningTimingRepair(pkg, SPOON_TIMING, { brief: SPOON_BRIEF + extra, requestedSeconds: 30 }), /explicit\/locked\/timed/);
  }
  const short = structuredClone(SPOON_TIMING); short.scenes[2].preferredFrames = 60;
  short.scenes[0].preferredFrames += 40; short.scenes[3].preferredFrames += 50; short.scenes[4].preferredFrames += 40;
  assert.throws(() => applyPlanningTimingRepair(pkg, short, { brief: SPOON_BRIEF + ' Give each label at least two seconds fully readable.', requestedSeconds: 30 }), /fully settled reading hold/);
});

test('prose-only timing response gets one controlled confirmation; real tool plus final reply fit three turns', async () => {
  const pkg = await spoon();
  const scripted = createScriptedModel([{ name: TIMING_REPAIR_TOOL, args: SPOON_TIMING }]);
  let calls = 0;
  const requests = [];
  const model = { id: 'text-first', async *stream(request) {
    requests.push(request);
    if (++calls === 1) { yield { type: 'text', delta: 'The timing is already fixed.' }; yield { type: 'usage', input: 5, output: 3 }; }
    else yield* scripted.stream(request);
  } };
  const result = await repairPlanningTiming(pkg, { model, brief: SPOON_BRIEF, requestedSeconds: 30 });
  assert.equal(calls, 3);
  assert.equal(result.result.ok, true);
  assert.equal(result.package.scenes[0].preferredFrames, 190);
  assert.match(requests[1].messages.at(-1).content, /previous prose response did not change/);
  assert.equal(result.result.usage.input, 37);
  let noops = 0;
  const unchanged = await repairPlanningTiming(pkg, { model: { id: 'only-text', async *stream() { noops++; yield { type: 'text', delta: 'Done.' }; } }, brief: SPOON_BRIEF, requestedSeconds: 30 });
  assert.ok(noops <= 3);
  assert.equal(unchanged.package, pkg);
  assert.equal(unchanged.result.ok, false);
  assert.equal(unchanged.result.errorCode, 'TIMING_REPAIR_NO_ACTION');
  assert.equal(unchanged.result.toolCalls.length, 0);
});
