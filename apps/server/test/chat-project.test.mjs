import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { conversationPlanSchema } from '../../../packages/agent/dist/src/index.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { buildChatProject } from '../src/chat-project.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><rect width="400" height="240" fill="#05070d"/><circle cx="200" cy="120" r="70" fill="#6d8cff"/></svg>';

function makePlan() {
  return conversationPlanSchema.parse({
    title: 'Solar explained', brief: 'Explain solar power.', audience: 'Homeowners', aspect: '16:9', stylePreset: 'cinematic-dark',
    scenes: [
      { id: 's_title', layout: 'title', headline: 'Solar power', sub: 'From sunlight to electricity', seconds: 4, narration: 'Sunlight can power your home.', visual: 'A dawn gradient' },
      { id: 's_hero', layout: 'hero', headline: 'Inside a solar cell', sub: 'Silicon captures photons', body: 'Moving electrons create current.', seconds: 8, narration: 'Photons release electrons in the cell.', visual: 'A solar cell diagram', mediaType: 'svg', svg: SVG },
      { id: 's_end', layout: 'title', headline: 'Power your home', seconds: 4, narration: 'An inverter converts the current.', visual: 'A dusk gradient' },
    ],
  });
}

async function setup(t) {
  const runtimeDir = mkdtempSync('/tmp/opencode/chat-project-');
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const previousPlan = makePlan();
  const previous = await buildChatProject({ plan: previousPlan, runtimeDir });
  const revise = (plan = previousPlan, extra = {}) => buildChatProject({ plan, previous, previousPlan, runtimeDir, ...extra });
  return { runtimeDir, previousPlan, previous, revise };
}

function attachAudio(pkg, scene) {
  pkg.assets.a_voice = { kind: 'audio', origin: 'upload', status: 'ready', file: 'assets/voice.wav', sha256: 'a'.repeat(64), license: { id: 'CC0-1.0' }, redistributable: true };
  scene.narration_asset = 'a_voice';
  scene.narration_duration_frames = 100;
}

test('a copy revision preserves field-level manual edits, audio, timing, format and scene payloads', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  previous.title = 'My manually titled film';
  previous.format = { width: 1280, height: 720, fps: 24 };
  previous.theme = { palette: ['#102030', '#abcdef'], font: 'Roboto' };
  const hero = previous.scenes[1];
  hero.copy.sub = 'A manually edited subtitle';
  hero.copy.body = 'My hand-written explanation.';
  hero.narration = 'My manually recorded narration.';
  attachAudio(previous, hero);
  hero.preferredFrames = 200;
  hero.transitionOut = { type: 'fade', frames: 8 };
  hero.motion = { entry: 'maskRise', stagger: 'word' };
  hero.background = { procedural: { pattern: 'mesh', seed: 97 } };
  hero.foreground[0].x = 0.6;
  hero.foreground[0].anim = 'parallax-in';
  hero.code = { language: 'js', code: 'const watts = 100;' };
  hero.data = null;
  hero.media = [{ procedural: { pattern: 'mesh', seed: 2 } }, { procedural: { pattern: 'mesh', seed: 3 } }];
  const snapshot = structuredClone(previous);
  const next = structuredClone(previousPlan);
  next.scenes[1].headline = 'A revised headline';
  const result = await revise(next);
  const expectedHero = { ...snapshot.scenes[1], copy: { ...snapshot.scenes[1].copy, headline: 'A revised headline' } };
  assert.deepEqual(result.scenes[1], expectedHero);
  assert.deepEqual(result.scenes[0], snapshot.scenes[0]);
  assert.deepEqual(result.scenes[2], snapshot.scenes[2]);
  assert.deepEqual(result.format, snapshot.format);
  assert.deepEqual(result.theme, snapshot.theme);
  assert.deepEqual(result.assets, snapshot.assets);
  assert.equal(result.title, snapshot.title);
  assert.equal(result.duration.targetFrames, 120 + 200 + 120 - 12 - 8);
  assert.equal(compileTimeline(result).scenes[1].durationInFrames, 200);
  assert.deepEqual(previous, snapshot, 'the input project is never mutated');
});

test('conflicting manual copy edits fail, while identical convergent edits are accepted', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  previous.scenes[1].copy.headline = 'Manual headline';
  const next = structuredClone(previousPlan);
  next.scenes[1].headline = 'Different model headline';
  await assert.rejects(revise(next), error => error.status === 409 && /copy.headline.*manually edited/.test(error.message));
  next.scenes[1].headline = 'Manual headline';
  assert.equal((await revise(next)).scenes[1].copy.headline, 'Manual headline');
});

test('layout changes preserve unchanged copy keys and manual code/media payloads', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  const hero = previous.scenes[1];
  hero.copy.body = 'Keep this manually edited body.';
  hero.code = { language: 'js', code: 'const sun = true;' };
  hero.media = [{ procedural: { pattern: 'mesh', seed: 2 } }, { procedural: { pattern: 'mesh', seed: 3 } }];
  const next = structuredClone(previousPlan);
  next.scenes[1].layout = 'title';
  const result = await revise(next);
  assert.equal(result.scenes[1].layout, 'title');
  assert.deepEqual(result.scenes[1].copy, hero.copy);
  assert.deepEqual(result.scenes[1].code, hero.code);
  assert.deepEqual(result.scenes[1].media, hero.media);
  assert.deepEqual(result.scenes[1].foreground, hero.foreground);
});

test('locked scenes are preserved verbatim and reject modifications or deletion', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  previous.scenes[1].locked = true;
  previous.scenes[1].copy.sub = 'Manual locked subtitle';
  const next = structuredClone(previousPlan);
  next.scenes[0].headline = 'A new opening';
  assert.deepEqual((await revise(next)).scenes[1], previous.scenes[1]);
  next.scenes[1].headline = 'Cannot change this';
  await assert.rejects(revise(next), /locked scene s_hero cannot be modified/);
  next.scenes.splice(1, 1);
  await assert.rejects(revise(next), /locked scene s_hero cannot be deleted/);
});

test('manual additions and order survive an unchanged plan; deliberate reorder retains manual scenes', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  const manual = { id: 's_manual', layout: 'title', variant: 'centered', preferredFrames: 90, copy: { headline: 'An extra scene' } };
  previous.scenes = [previous.scenes[1], manual, previous.scenes[0], previous.scenes[2]];
  const unchanged = await revise();
  assert.deepEqual(unchanged.scenes, previous.scenes);
  const reordered = structuredClone(previousPlan);
  reordered.scenes = [reordered.scenes[2], reordered.scenes[1], reordered.scenes[0]];
  const result = await revise(reordered);
  assert.deepEqual(result.scenes.map(scene => scene.id), ['s_end', 's_manual', 's_hero', 's_title']);
  assert.deepEqual(result.scenes[1], manual);
  assert.equal(result.scenes.at(-1).transitionOut, undefined, 'an automatic transition cannot point beyond the timeline');
  assert.equal(result.duration.targetFrames, compileTimeline(result).durationInFrames);
});

test('explicit omission deletes unlocked plan scenes, not manually added scenes', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  previous.scenes.splice(1, 0, { id: 's_manual', layout: 'title', preferredFrames: 90, copy: { headline: 'Extra' } });
  const next = structuredClone(previousPlan);
  next.scenes = [next.scenes[0]];
  const result = await revise(next);
  assert.deepEqual(result.scenes.map(scene => scene.id), ['s_title', 's_manual']);
  assert.equal(result.duration.targetFrames, 120 + 90 - 12);
});

test('manual deletion is retained unless the new plan conflicts with the deletion', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  previous.scenes.splice(1, 1);
  const unchanged = await revise();
  assert.deepEqual(unchanged.scenes.map(scene => scene.id), ['s_title', 's_end']);
  assert.equal(unchanged.duration.targetFrames, 228);
  const next = structuredClone(previousPlan);
  next.scenes[1].headline = 'A conflicting resurrection';
  await assert.rejects(revise(next), error => error.status === 409 && /s_hero was manually deleted/.test(error.message));
});

test('new scenes are inserted by plan neighbours without discarding manual scenes', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  previous.scenes.splice(1, 0, { id: 's_manual', layout: 'title', preferredFrames: 90, copy: { headline: 'Extra' } });
  const next = structuredClone(previousPlan);
  next.scenes.splice(1, 0, { ...next.scenes[0], id: 's_new', headline: 'New plan scene' });
  const result = await revise(next);
  assert.deepEqual(result.scenes.map(scene => scene.id), ['s_title', 's_manual', 's_new', 's_hero', 's_end']);
  next.scenes[1].id = 's_manual';
  await assert.rejects(revise(next), /collides with a manually added scene/);
});

test('only an actual narration edit invalidates audio and spoken-text overrides', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  const hero = previous.scenes[1];
  attachAudio(previous, hero);
  hero.narration_spoken = 'A pronunciation override.';
  hero.spoken_text = 'An alternate pronunciation.';
  assert.deepEqual((await revise()).scenes[1], hero);
  const next = structuredClone(previousPlan);
  next.scenes[1].narration = 'A new script for the same scene.';
  const result = await revise(next);
  assert.equal(result.scenes[1].narration, next.scenes[1].narration);
  for (const key of ['narration_asset', 'narration_duration_frames', 'narration_spoken', 'spoken_text']) assert.equal(result.scenes[1][key], undefined);
  assert.ok(result.assets.a_voice, 'old audio may still be used elsewhere');
  next.scenes[1].narration = '';
  assert.equal((await revise(next)).scenes[1].narration, undefined);
});

test('copy and timing updates reuse visual assets; SVG or visual changes regenerate them', async t => {
  const { previous, previousPlan, revise, runtimeDir } = await setup(t);
  const originalId = previous.scenes[1].foreground[0].asset;
  const originalFiles = readdirSync(join(runtimeDir, 'packages', 'assets'));
  const next = structuredClone(previousPlan);
  next.scenes[1].headline = 'New headline';
  next.scenes[1].seconds = 9;
  const reused = await revise(next);
  assert.equal(reused.scenes[1].foreground[0].asset, originalId);
  assert.deepEqual(reused.assets, previous.assets);
  assert.deepEqual(readdirSync(join(runtimeDir, 'packages', 'assets')), originalFiles);
  next.scenes[1].svg = SVG.replace('r="70"', 'r="80"');
  const changedSvg = await revise(next);
  assert.notEqual(changedSvg.scenes[1].foreground[0].asset, originalId);
  next.scenes[1].svg = SVG;
  next.scenes[1].visual = 'A different solar diagram';
  assert.notEqual((await revise(next)).scenes[1].foreground[0].asset, originalId);
  next.scenes[1].mediaType = 'procedural';
  delete next.scenes[1].svg;
  assert.deepEqual((await revise(next)).scenes[1].foreground, []);
});

test('style changes invalidate image plans and recheck SVG palettes', async t => {
  const { previousPlan, runtimeDir } = await setup(t);
  const plan = structuredClone(previousPlan);
  plan.scenes[1].mediaType = 'image';
  delete plan.scenes[1].svg;
  const previous = await buildChatProject({ plan, runtimeDir });
  const next = { ...plan, stylePreset: 'clay' };
  const result = await buildChatProject({ plan: next, previous, previousPlan: plan, runtimeDir });
  assert.notEqual(result.scenes[1].foreground[0].asset, previous.scenes[1].foreground[0].asset);
  assert.match(result.assets[result.scenes[1].foreground[0].asset].gen.inputs.prompt, /#f4e9dd/i);
  const svgPlan = structuredClone(previousPlan);
  svgPlan.scenes[1].svg = SVG.replace('#05070d', '#6d8cff');
  const svgProject = await buildChatProject({ plan: svgPlan, runtimeDir });
  await assert.rejects(buildChatProject({ plan: { ...svgPlan, stylePreset: 'clay' }, previous: svgProject, previousPlan: svgPlan, runtimeDir }), /SVG render check failed/);
});

test('custom fps is retained for new timing and new scenes', async t => {
  const { previous, previousPlan, revise } = await setup(t);
  previous.format.fps = 24;
  for (const scene of previous.scenes) scene.preferredFrames = previousPlan.scenes.find(item => item.id === scene.id).seconds * 24;
  const next = structuredClone(previousPlan);
  next.scenes[1].seconds = 9;
  next.scenes.push({ ...next.scenes[2], id: 's_new', seconds: 3 });
  next.aspect = '9:16';
  const result = await revise(next);
  assert.deepEqual(result.format, { width: 1080, height: 1920, fps: 24 });
  assert.equal(result.scenes[1].preferredFrames, 216);
  assert.equal(result.scenes[3].preferredFrames, 72);
});

test('new projects do not assert unverified compliance and aborted builds generate nothing', async t => {
  const { previous, runtimeDir, previousPlan } = await setup(t);
  assert.equal(previous.compliance.open_weights_only, false);
  const controller = new AbortController();
  controller.abort();
  const files = readdirSync(join(runtimeDir, 'packages', 'assets'));
  await assert.rejects(buildChatProject({ plan: previousPlan, runtimeDir, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(readdirSync(join(runtimeDir, 'packages', 'assets')), files);
});
