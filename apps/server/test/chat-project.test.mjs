import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationPlanSchema, patchConversationPlan } from '../../../packages/agent/dist/src/index.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { buildChatProject } from '../src/chat-project.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><rect width="400" height="240" fill="#05070d"/><circle cx="200" cy="120" r="70" fill="#6d8cff"/></svg>';

function makePlan() {
  return conversationPlanSchema.parse({
    title: 'Solar explained', brief: 'Explain solar power.', audience: 'Homeowners', aspect: '16:9', stylePreset: 'cinematic-dark',
    scenes: [
      { id: 's_title', layout: 'title', headline: 'Solar power', sub: 'From sunlight to electricity', seconds: 4, narration: 'Sunlight can power your home.', visual: 'Sunlight over solar panels at dawn', mediaType: 'image' },
      { id: 's_hero', layout: 'hero', headline: 'Inside a solar cell', sub: 'Silicon captures photons', body: 'Moving electrons create current.', seconds: 8, narration: 'Photons release electrons in the cell.', visual: 'A solar cell diagram', mediaType: 'svg', svg: SVG },
      { id: 's_end', layout: 'title', headline: 'Power your home', seconds: 4, narration: 'An inverter converts the current.', visual: 'Solar panels at dusk', mediaType: 'image' },
    ],
  });
}

function richPlan() {
  return conversationPlanSchema.parse({
    title: 'Measured latency', brief: 'Explain a measured latency improvement without inventing data.', audience: 'Engineers',
    aspect: '16:9', stylePreset: 'cinematic-dark',
    datasets: {
      d_latency: {
        unit: 'ms', label: 'Median latency', values: [{ label: 'Before', value: 20 }, { label: 'After', value: 8 }],
        source: 'user', source_url: 'https://example.test/measurements', retrieved_at: '2026-10-19T00:00:00Z', note: 'Measured locally.',
      },
    },
    scenes: [
      {
        id: 's_title', layout: 'title', headline: 'Latency, measured', sub: 'A real before and after', seconds: 4,
        narration: 'This is a measured latency comparison.', visual: 'A datacenter rack behind the native title', mediaType: 'image',
        motion: { recipe: 'kinetic', seed: 11, intensity: 0.45, entry: 'waterfall', cue_phrases: ['measured'] },
        transition: { type: 'paper-reveal', frames: 18 },
      },
      {
        id: 's_stat', layout: 'stat', headline: '8 ms', sub: 'After the fix', body: '8 ms', footnote: 'Median of our runs.', seconds: 6,
        narration: 'The median latency fell to eight milliseconds.', visual: 'A focused stat card',
        data: { dataset: 'd_latency', display: 'number' },
        motion: { recipe: 'focus', seed: 12, intensity: 0.6, focus: { x: 0.2, y: 0.2, width: 0.55, height: 0.45 } },
      },
      {
        id: 's_chart', layout: 'chart', headline: 'Before and after', footnote: 'Median of our runs.', seconds: 6,
        narration: 'The chart shows the two measured values.', visual: 'A bar chart of the measured series',
        data: { dataset: 'd_latency' }, motion: { recipe: 'technical-flow', cue_seconds: [0.5, 2] },
        transition: { type: 'draw-reveal', frames: 20 },
      },
      {
        id: 's_split', layout: 'split', headline: 'Two states', seconds: 6,
        narration: 'The shape changes from one state to another.', visual: 'Two labeled plates',
        plates: [{ label: 'Before', pattern: 'grid', seed: 3 }, { label: 'After', pattern: 'dots', seed: 4 }],
        motion: { recipe: 'morph', seed: 13, intensity: 0.7, morph: { from: 'circle', to: 'blob' }, cue_phrases: ['shape'] },
        transition: { type: 'shape-reveal', frames: 14 },
      },
      {
        id: 's_compare', layout: 'compare', headline: 'Compare the detail', seconds: 6,
        narration: 'These are the two plates side by side.', visual: 'Two SVG plates',
        plates: [{ label: 'Old', svg: SVG }, { label: 'New', svg: SVG }],
      },
      {
        id: 's_code', layout: 'code', seconds: 6,
        narration: 'Here is the actual variable.', visual: 'A real terminal block',
        code: { language: 'js', code: 'const latency = 8;', highlights: [1], typing: { charsPerSecond: 20 } },
        motion: { recipe: 'technical-flow', seed: 14 },
      },
    ],
  });
}

async function setupRich(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-rich-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const previousPlan = richPlan();
  const previous = await buildChatProject({ plan: previousPlan, runtimeDir });
  const revise = (plan = previousPlan, extra = {}) => buildChatProject({ plan, previous, previousPlan, runtimeDir, ...extra });
  return { runtimeDir, previousPlan, previous, revise };
}

async function setup(t) {
  // Q-H1: os.tmpdir() rather than a path that only exists on the machine this was written on
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-'));
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

test('expanded layouts build a valid package with datasets, code, plates, recipe motion and transitions', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-expanded-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const plan = richPlan();
  const pkg = await buildChatProject({ plan, runtimeDir });
  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const timeline = compileTimeline(pkg);
  assert.equal(timeline.scenes.length, plan.scenes.length);
  assert.deepEqual(timeline.scenes.find(scene => scene.id === 's_split').motionCues.map(cue => cue.phrase), ['shape']);
  const byId = Object.fromEntries(pkg.scenes.map(scene => [scene.id, scene]));

  assert.deepEqual(pkg.datasets.d_latency, plan.datasets.d_latency);
  assert.equal(pkg.datasets.d_latency.source, 'user');
  assert.equal(pkg.datasets.d_latency.source_url, 'https://example.test/measurements');
  assert.equal(pkg.datasets.d_latency.note, 'Measured locally.');

  assert.equal(byId.s_stat.layout, 'stat');
  assert.equal(byId.s_stat.copy.headline, '8 ms');
  assert.equal(byId.s_stat.copy.sub, 'After the fix');
  assert.equal(byId.s_stat.copy.body, '8 ms');
  assert.equal(byId.s_stat.copy.footnote, 'Median of our runs.');
  assert.deepEqual(byId.s_stat.data, { dataset: 'd_latency', display: 'number' });
  assert.deepEqual(byId.s_stat.motion, { recipe: 'focus', seed: 12, intensity: 0.6, focus: { x: 0.2, y: 0.2, width: 0.55, height: 0.45 } });
  assert.deepEqual(byId.s_stat.preferredFrames, 180);

  assert.equal(byId.s_chart.layout, 'chart');
  assert.equal(byId.s_chart.variant, 'bar');
  assert.equal(byId.s_chart.copy.footnote, 'Median of our runs.');
  assert.deepEqual(byId.s_chart.data, { dataset: 'd_latency' });
  assert.deepEqual(byId.s_chart.motion.cue_seconds, [0.5, 2]);
  assert.deepEqual(byId.s_chart.transitionOut, { type: 'draw-reveal', frames: 20 });

  assert.equal(byId.s_split.layout, 'split');
  assert.deepEqual(byId.s_split.media, [
    { procedural: { pattern: 'grid', seed: 3 }, label: 'Before' },
    { procedural: { pattern: 'dots', seed: 4 }, label: 'After' },
  ]);
  assert.deepEqual(byId.s_split.motion, { recipe: 'morph', seed: 13, intensity: 0.7, morph: { from: 'circle', to: 'blob' }, cue_phrases: ['shape'] });
  assert.deepEqual(byId.s_split.transitionOut, { type: 'shape-reveal', frames: 14 });

  assert.equal(byId.s_compare.layout, 'compare');
  assert.equal(byId.s_compare.media.length, 2);
  assert.deepEqual(byId.s_compare.media.map(plate => plate.label), ['Old', 'New']);
  assert.notEqual(byId.s_compare.media[0].asset, byId.s_compare.media[1].asset);
  for (const plate of byId.s_compare.media) assert.equal(pkg.assets[plate.asset].kind, 'svg');
  assert.deepEqual(byId.s_compare.transitionOut, { type: 'fade', frames: 12 });

  assert.equal(byId.s_code.layout, 'code');
  assert.deepEqual(byId.s_code.code, { language: 'js', code: 'const latency = 8;', highlights: [1], typing: { charsPerSecond: 20 } });
  assert.deepEqual(byId.s_code.copy, {});
  assert.equal(byId.s_code.transitionOut, undefined);
  assert.deepEqual(byId.s_code.motion, { recipe: 'technical-flow', seed: 14 });
  assert.deepEqual(byId.s_title.transitionOut, { type: 'paper-reveal', frames: 18 });
  assert.equal(pkg.scenes.at(-1).id, 's_code');
  assert.equal(pkg.scenes.at(-1).transitionOut, undefined);
});

test('manual motion, transition, dataset and code edits survive an unrelated plan revision', async t => {
  const { previous, previousPlan, revise } = await setupRich(t);
  const stat = previous.scenes.find(scene => scene.id === 's_stat');
  const split = previous.scenes.find(scene => scene.id === 's_split');
  const compare = previous.scenes.find(scene => scene.id === 's_compare');
  const code = previous.scenes.find(scene => scene.id === 's_code');
  stat.motion.entry = 'maskRise';
  stat.motion.stagger = 'word';
  stat.data.display = 'counter';
  split.transitionOut = { type: 'fade', frames: 8 };
  split.motion.intensity = 0.2;
  compare.media[0].label = 'My own label';
  code.code.highlights = [1, 2];
  previous.datasets.d_latency.note = 'Verified on the local machine.';
  const snapshot = structuredClone(previous);

  const next = structuredClone(previousPlan);
  next.scenes.find(scene => scene.id === 's_stat').headline = 'Eight milliseconds';
  const result = await revise(next);
  const revisedStat = result.scenes.find(scene => scene.id === 's_stat');
  const revisedSplit = result.scenes.find(scene => scene.id === 's_split');
  const revisedCompare = result.scenes.find(scene => scene.id === 's_compare');
  const revisedCode = result.scenes.find(scene => scene.id === 's_code');
  assert.equal(revisedStat.copy.headline, 'Eight milliseconds');
  assert.equal(revisedStat.motion.entry, 'maskRise');
  assert.equal(revisedStat.motion.stagger, 'word');
  assert.equal(revisedStat.motion.recipe, 'focus');
  assert.equal(revisedStat.data.display, 'counter');
  assert.deepEqual(revisedSplit.transitionOut, { type: 'fade', frames: 8 });
  assert.equal(revisedSplit.motion.intensity, 0.2);
  assert.equal(revisedSplit.motion.recipe, 'morph');
  assert.equal(revisedCompare.media[0].label, 'My own label');
  assert.deepEqual(revisedCode.code.highlights, [1, 2]);
  assert.equal(result.datasets.d_latency.note, 'Verified on the local machine.');
  assert.deepEqual(previous, snapshot, 'the input project is never mutated');
});

test('plan changes update changed motion fields while preserving manual recipe details', async t => {
  const { previous, previousPlan, revise } = await setupRich(t);
  const stat = previous.scenes.find(scene => scene.id === 's_stat');
  stat.motion.entry = 'pop';
  const snapshot = structuredClone(previous);
  const next = structuredClone(previousPlan);
  next.scenes.find(scene => scene.id === 's_stat').motion.intensity = 0.9;
  const result = await revise(next);
  const revised = result.scenes.find(scene => scene.id === 's_stat');
  assert.equal(revised.motion.intensity, 0.9);
  assert.equal(revised.motion.entry, 'pop', 'a manual token not mentioned by the plan is retained');
  assert.equal(revised.motion.recipe, 'focus');
  assert.deepEqual(previous, snapshot);
});

test('a manual transition conflicts only when the plan changes that transition', async t => {
  const { previous, previousPlan, revise } = await setupRich(t);
  const split = previous.scenes.find(scene => scene.id === 's_split');
  split.transitionOut = { type: 'fade', frames: 8 };
  const next = structuredClone(previousPlan);
  next.scenes.find(scene => scene.id === 's_split').transition = { type: 'paper-reveal', frames: 18 };
  await assert.rejects(revise(next), error => error.status === 409 && /transitionOut was manually edited/.test(error.message));
  const unchanged = structuredClone(previousPlan);
  unchanged.scenes.find(scene => scene.id === 's_split').headline = 'Two clearly different states';
  assert.deepEqual((await revise(unchanged)).scenes.find(scene => scene.id === 's_split').transitionOut, { type: 'fade', frames: 8 });
});

test('locked expanded scenes keep motion, transitions and plates and reject plan changes', async t => {
  const { previous, previousPlan, revise } = await setupRich(t);
  const split = previous.scenes.find(scene => scene.id === 's_split');
  split.locked = true;
  split.transitionOut = { type: 'fade', frames: 8 };
  split.motion.entry = 'pop';
  const lockedSnapshot = structuredClone(split);
  const next = structuredClone(previousPlan);
  next.scenes.find(scene => scene.id === 's_title').headline = 'A revised opening';
  assert.deepEqual((await revise(next)).scenes.find(scene => scene.id === 's_split'), lockedSnapshot);
  next.scenes.find(scene => scene.id === 's_split').motion.intensity = 0.1;
  await assert.rejects(revise(next), /locked scene s_split cannot be modified/);
  next.scenes.find(scene => scene.id === 's_split').motion.intensity = previousPlan.scenes.find(scene => scene.id === 's_split').motion.intensity;
  next.scenes.find(scene => scene.id === 's_split').plates[0].label = 'Changed';
  await assert.rejects(revise(next), /locked scene s_split cannot be modified/);
});

test('a dataset is updated only when unchanged and a manual provenance edit conflicts', async t => {
  const { previous, previousPlan, revise } = await setupRich(t);
  previous.datasets.d_latency.note = 'Manually checked.';
  const next = structuredClone(previousPlan);
  next.scenes.find(scene => scene.id === 's_stat').headline = 'Eight milliseconds';
  assert.equal((await revise(next)).datasets.d_latency.note, 'Manually checked.');
  next.datasets.d_latency.label = 'A different label';
  await assert.rejects(revise(next), error => error.status === 409 && /dataset d_latency was manually edited/.test(error.message));
});

test('reordering scenes recalculates defaults, keeps explicit transitions and drops the final outgoing transition', async t => {
  const { previous, previousPlan, revise } = await setupRich(t);
  const next = structuredClone(previousPlan);
  next.scenes.reverse();
  const code = next.scenes.find(scene => scene.id === 's_code');
  code.transition = { type: 'fade', frames: 16 };
  const result = await revise(next);
  assert.deepEqual(result.scenes.map(scene => scene.id), ['s_code', 's_compare', 's_split', 's_chart', 's_stat', 's_title']);
  assert.deepEqual(result.scenes[0].transitionOut, { type: 'fade', frames: 16 });
  for (const scene of result.scenes.slice(1, -1)) assert.ok(scene.transitionOut, `${scene.id} keeps a transition`);
  assert.equal(result.scenes.at(-1).id, 's_title');
  assert.equal(result.scenes.at(-1).transitionOut, undefined);
  assert.equal(result.duration.targetFrames, compileTimeline(result).durationInFrames);
});

test('a final-scene transition authored by the plan is ignored without failing the build', async t => {
  const { previousPlan, runtimeDir } = await setupRich(t);
  const next = structuredClone(previousPlan);
  next.scenes.at(-1).transition = { type: 'shape-reveal', frames: 18 };
  // A new project has no previous revision to merge, so this exercises the same
  // post-order final-transition handling through a fresh build.
  const fresh = structuredClone(next);
  const pkg = await buildChatProject({ plan: fresh, runtimeDir });
  assert.equal(pkg.scenes.at(-1).transitionOut, undefined);
  const previous = await buildChatProject({ plan: previousPlan, runtimeDir });
  const result = await buildChatProject({ plan: next, previous, previousPlan, runtimeDir });
  assert.equal(result.scenes.at(-1).transitionOut, undefined);
});

test('a locked scene rejects a plan that changes the dataset it displays', async t => {
  const { previous, previousPlan, revise } = await setupRich(t);
  previous.scenes.find(scene => scene.id === 's_stat').locked = true;
  const next = structuredClone(previousPlan);
  next.scenes.find(scene => scene.id === 's_title').headline = 'A revised opening';
  assert.equal((await revise(next)).scenes.find(scene => scene.id === 's_stat').locked, true);
  next.datasets.d_latency.label = 'A changed label';
  await assert.rejects(revise(next), error => error.status === 409 && /locked scene s_stat cannot use a changed dataset d_latency/.test(error.message));
});

test('a divergent manual transition on the final scene is refused rather than left invalid', async t => {
  const { previous, previousPlan, revise } = await setupRich(t);
  previous.scenes.at(-1).transitionOut = { type: 'fade', frames: 8 };
  const next = structuredClone(previousPlan);
  next.scenes.find(scene => scene.id === 's_title').headline = 'A revised opening';
  await assert.rejects(revise(next), error => error.status === 409 && /transition that cannot be preserved at the end/.test(error.message));
});

test('layout switches add newly visible copy fields even when the plan value was hidden before', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-copy-switch-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const make = (layout, extra = {}) => conversationPlanSchema.parse({
    title: 'Copy switch', brief: 'Copy switch.', audience: 'Test', aspect: '16:9', stylePreset: 'cinematic-dark',
    datasets: { d_x: { unit: 'ms', values: [{ label: 'one', value: 1 }], source: 'user' } },
    scenes: [
      { id: 's_x', layout, headline: 'Head', sub: 'Sub', body: 'Body text', footnote: 'Footnote text', items: ['one', 'two'], seconds: 6, narration: 'Text.', visual: 'A card', ...extra },
      { id: 's_end', layout: 'title', headline: 'End', seconds: 4, narration: 'End.', visual: 'end', mediaType: 'image' },
    ],
  });

  const titlePlan = make('title');
  const titleProject = await buildChatProject({ plan: titlePlan, runtimeDir });
  assert.deepEqual(titleProject.scenes[0].copy, { headline: 'Head', sub: 'Sub' });
  const statPlan = make('stat', { data: { dataset: 'd_x' } });
  const statProject = await buildChatProject({ plan: statPlan, previous: titleProject, previousPlan: titlePlan, runtimeDir });
  assert.deepEqual(statProject.scenes[0].copy, { headline: 'Head', sub: 'Sub', body: 'Body text', footnote: 'Footnote text' });
  assert.equal(validatePackage(statProject).valid, true);

  const heroPlan = make('hero');
  const heroProject = await buildChatProject({ plan: heroPlan, runtimeDir });
  assert.deepEqual(heroProject.scenes[0].copy, { headline: 'Head', sub: 'Sub', body: 'Body text' });
  const listPlan = make('list');
  const listProject = await buildChatProject({ plan: listPlan, previous: heroProject, previousPlan: heroPlan, runtimeDir });
  assert.deepEqual(listProject.scenes[0].copy, { headline: 'Head', sub: 'Sub', items: ['one', 'two'] });
  assert.equal(validatePackage(listProject).valid, true);
});

test('a formerly-middle plan transition that becomes final is recognised as plan-owned', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-transition-reorder-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const basePlan = () => conversationPlanSchema.parse({
    title: 'Order', brief: 'Transition reorder.', audience: 'Test', aspect: '16:9', stylePreset: 'cinematic-dark',
    scenes: [
      { id: 's_a', layout: 'title', headline: 'A', seconds: 4, narration: 'A opening.', visual: 'A card', mediaType: 'image', transition: { type: 'paper-reveal', frames: 18 } },
      { id: 's_b', layout: 'hero', headline: 'B', seconds: 6, narration: 'B middle.', visual: 'B card' },
      { id: 's_c', layout: 'list', headline: 'C', items: ['one', 'two'], seconds: 6, narration: 'C list.', visual: 'C card' },
    ],
  });
  const previousPlan = basePlan();
  const previous = await buildChatProject({ plan: previousPlan, runtimeDir });

  const deleted = structuredClone(previousPlan);
  deleted.scenes.reverse();
  delete deleted.scenes.find(scene => scene.id === 's_a').transition;
  const deletedResult = await buildChatProject({ plan: deleted, previous, previousPlan, runtimeDir });
  assert.equal(deletedResult.scenes.at(-1).id, 's_a');
  assert.equal(deletedResult.scenes.at(-1).transitionOut, undefined);
  assert.ok(deletedResult.scenes[0].transitionOut && deletedResult.scenes[1].transitionOut);

  const changed = structuredClone(previousPlan);
  changed.scenes.reverse();
  changed.scenes.find(scene => scene.id === 's_a').transition = { type: 'draw-reveal', frames: 20 };
  const changedResult = await buildChatProject({ plan: changed, previous, previousPlan, runtimeDir });
  assert.equal(changedResult.scenes.at(-1).id, 's_a');
  assert.equal(changedResult.scenes.at(-1).transitionOut, undefined);
  assert.equal(validatePackage(changedResult).valid, true);
});

test('deep motion patches reach the built project without erasing manual recipe details', async t => {
  const { previous, previousPlan, runtimeDir } = await setupRich(t);
  const stat = previous.scenes.find(scene => scene.id === 's_stat');
  stat.motion.recipe = 'sketch';
  stat.motion.entry = 'pop';
  const next = patchConversationPlan(previousPlan, { scenePatches: [{ id: 's_stat', changes: { motion: { intensity: 0.9 } } }] });
  assert.equal(next.scenes.find(scene => scene.id === 's_stat').motion.recipe, 'focus');
  assert.equal(next.scenes.find(scene => scene.id === 's_stat').motion.seed, 12);
  assert.deepEqual(next.scenes.find(scene => scene.id === 's_stat').motion.focus, { x: 0.2, y: 0.2, width: 0.55, height: 0.45 });
  const result = await buildChatProject({ plan: next, previous, previousPlan, runtimeDir });
  const motion = result.scenes.find(scene => scene.id === 's_stat').motion;
  assert.equal(motion.recipe, 'sketch');
  assert.equal(motion.entry, 'pop');
  assert.equal(motion.intensity, 0.9);
  assert.equal(motion.seed, 12);
  assert.deepEqual(motion.focus, { x: 0.2, y: 0.2, width: 0.55, height: 0.45 });
  assert.equal(validatePackage(result).valid, true);
});

test('split/compare plate media types drive style and palette invalidation', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-plate-style-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const imagePlan = stylePreset => conversationPlanSchema.parse({
    title: 'Plate restyle', brief: 'Plate restyle.', audience: 'Test', aspect: '16:9', stylePreset,
    scenes: [
      { id: 's_a', layout: 'title', headline: 'A', seconds: 4, narration: 'A opening.', visual: 'A card' },
      { id: 's_b', layout: 'split', headline: 'B', seconds: 6, narration: 'B plates.', visual: 'Two plates',
        plates: [
          { label: 'Before', mediaType: 'image', visual: 'A weathered brick factory at dawn' },
          { label: 'After', mediaType: 'image', visual: 'A modern glass factory at dawn' },
        ] },
      { id: 's_c', layout: 'title', headline: 'C', seconds: 4, narration: 'C ending.', visual: 'C card' },
    ],
  });
  const darkPlan = imagePlan('cinematic-dark');
  const dark = await buildChatProject({ plan: darkPlan, runtimeDir });
  const before = dark.scenes.find(scene => scene.id === 's_b').media;
  const clayPlan = imagePlan('clay');
  const clay = await buildChatProject({ plan: clayPlan, previous: dark, previousPlan: darkPlan, runtimeDir });
  const after = clay.scenes.find(scene => scene.id === 's_b').media;
  assert.notDeepEqual(after, before);
  for (const plate of after) assert.match(clay.assets[plate.asset].gen.inputs.prompt, /clay; palette #f4e9dd/i);
  assert.equal(validatePackage(clay).valid, true);

  const paletteSvg = SVG.replace('#05070d', '#6d8cff');
  const svgPlan = stylePreset => conversationPlanSchema.parse({
    title: 'Plate palette', brief: 'Plate palette.', audience: 'Test', aspect: '16:9', stylePreset,
    scenes: [
      { id: 's_svg', layout: 'compare', headline: 'Compare', seconds: 6, narration: 'Compare.', visual: 'Two plates',
        plates: [{ label: 'Old', svg: paletteSvg }, { label: 'New', svg: paletteSvg }] },
      { id: 's_end', layout: 'title', headline: 'End', seconds: 4, narration: 'End.', visual: 'end', mediaType: 'image' },
    ],
  });
  const svgDarkPlan = svgPlan('cinematic-dark');
  const svgDark = await buildChatProject({ plan: svgDarkPlan, runtimeDir });
  await assert.rejects(
    buildChatProject({ plan: svgPlan('clay'), previous: svgDark, previousPlan: svgDarkPlan, runtimeDir }),
    /SVG render check failed/,
  );
});

test('removing a scene and dataset preserves manually edited unreferenced provenance', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-dataset-remove-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const plan = () => conversationPlanSchema.parse({
    title: 'Data', brief: 'Dataset removal.', audience: 'Test', aspect: '16:9', stylePreset: 'cinematic-dark',
    datasets: { d_x: { unit: 'ms', values: [{ label: 'one', value: 1 }], source: 'user', note: 'Plan note.' } },
    scenes: [
      { id: 's_stat', layout: 'stat', headline: '1 ms', seconds: 6, narration: 'One.', visual: 'stat', data: { dataset: 'd_x' } },
      { id: 's_end', layout: 'title', headline: 'End', seconds: 4, narration: 'End.', visual: 'end', mediaType: 'image' },
    ],
  });
  const previousPlan = plan();
  const previous = await buildChatProject({ plan: previousPlan, runtimeDir });
  previous.datasets.d_x.note = 'Verified manually.';
  const next = structuredClone(previousPlan);
  next.scenes = next.scenes.filter(scene => scene.id !== 's_stat');
  delete next.datasets.d_x;
  const preserved = await buildChatProject({ plan: next, previous, previousPlan, runtimeDir });
  assert.deepEqual(preserved.scenes.map(scene => scene.id), ['s_end']);
  assert.equal(preserved.datasets.d_x.note, 'Verified manually.');
  assert.equal(validatePackage(preserved).valid, true);

  previous.datasets.d_x = structuredClone(previousPlan.datasets.d_x);
  const dropped = await buildChatProject({ plan: next, previous, previousPlan, runtimeDir });
  assert.equal(dropped.datasets.d_x, undefined);
});
