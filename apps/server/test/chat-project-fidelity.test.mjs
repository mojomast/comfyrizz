import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { conversationPlanSchema } from '../../../packages/agent/dist/src/index.js';
import { timingReportFor } from '../../../packages/agent/dist/src/timing-coverage.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { foregroundBox, textZones } from '../../../apps/renderer/src/layout-model.js';
import { buildChatProject, chatProjectResponse } from '../src/chat-project.mjs';
import { planFromPackage } from '../src/productions/plan-from-package.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><rect width="400" height="240" fill="#05070d"/><rect x="40" y="40" width="320" height="160" rx="18" fill="#10304a"/><circle cx="120" cy="120" r="42" fill="#2ec4b6"/><path d="M180 120h140" stroke="#e8ecef" stroke-width="10"/></svg>';

function fidelityPlan() {
  return conversationPlanSchema.parse({
    title: 'Receipt journey',
    brief: 'Follow one receipt through a project so the mechanism is clear.',
    audience: 'Freelancers',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [
      {
        id: 's_title',
        layout: 'title',
        headline: 'LedgerLeaf',
        sub: 'One receipt, one clear path',
        seconds: 4,
        narration: 'Every receipt starts somewhere.',
        visual: 'Original title composition with the recurring teal form.',
        mediaType: 'svg',
        svg: SVG,
      },
      {
        id: 's_setup',
        layout: 'list',
        headline: 'A receipt arrives',
        items: ['Snap the paper receipt', 'Choose the project'],
        seconds: 8,
        narration: 'The receipt arrives, and the user chooses a project.',
        visual: 'Original diagram of a receipt moving into a project.',
        mediaType: 'svg',
        svg: SVG,
      },
      {
        id: 's_reveal',
        layout: 'hero',
        headline: 'The project remembers',
        sub: 'The same receipt is inspectable later',
        body: 'The teal form marks the receipt inside the project.',
        seconds: 8,
        narration: 'Later, the project still holds that same receipt.',
        visual: 'Original diagram of the receipt resting inside the project.',
        mediaType: 'svg',
        svg: SVG,
      },
    ],
  });
}

async function build(t, extra = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-fidelity-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const pkg = await buildChatProject({ plan: fidelityPlan(), runtimeDir, ...extra });
  return { runtimeDir, pkg };
}

test('SVG storytelling is a legible visual role, never a 12% decorative thumbnail', async t => {
  const { pkg } = await build(t);
  const byId = Object.fromEntries(pkg.scenes.map(scene => [scene.id, scene]));
  for (const id of ['s_title', 's_setup', 's_reveal']) {
    const scene = byId[id];
    assert.ok(Array.isArray(scene.foreground) && scene.foreground.length === 1, `${id} keeps one generated visual`);
    const item = scene.foreground[0];
    assert.ok(item.w >= 0.34, `${id} visual width ${item.w} must stay legible`);
    const box = foregroundBox(item, pkg.assets[item.asset], undefined, '16:9');
    assert.ok(box.x0 >= 0 && box.y0 >= 0 && box.x1 <= 1 && box.y1 <= 1, `${id} visual stays inside the frame`);
  }
});

test('worked-example and comedy shapes keep a readable visual area through a copy revision', async t => {
  const { runtimeDir, pkg } = await build(t);
  const previousPlan = fidelityPlan();
  const next = structuredClone(previousPlan);
  next.scenes[1].headline = 'Give this receipt a home';
  const revised = await buildChatProject({ plan: next, previous: pkg, previousPlan, runtimeDir });
  for (const scene of revised.scenes) {
    const item = scene.foreground?.[0];
    if (!item) continue;
    assert.ok(item.w >= 0.34, `${scene.id} keeps its readable width after revision`);
  }
});

test('split/compare media assets are traversed and planned once each', () => {
  const pkg = {
    id: 'pkg_compare',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible' },
    scenes: [
      { id: 's_compare', layout: 'compare', media: [{ asset: 'a_old' }, { asset: 'a_new' }] },
      { id: 's_hero', layout: 'hero', foreground: [{ asset: 'a_hero' }] },
    ],
    assets: {
      a_old: { kind: 'image', status: 'pending', gen: { generator: 'flux3-klein', inputs: { prompt: 'old receipt' } } },
      a_new: { kind: 'image', status: 'pending', gen: { generator: 'flux3-klein', inputs: { prompt: 'new receipt' } } },
      a_hero: { kind: 'image', status: 'pending', gen: { generator: 'flux3-klein', inputs: { prompt: 'hero' } } },
    },
  };
  const plan = planFromPackage({ pkg, level: 'balanced', compute: 'colab' });
  assert.deepEqual(plan.actions.map(action => action.targetId), ['s_compare', 's_hero']);
  const compare = plan.actions[0];
  assert.equal(compare.takes, 2);
  assert.ok(compare.upperBound > 0);
  assert.equal(compare.effectiveInputHash.length, 64);
});

function durationPlan(firstTransition) {
  return conversationPlanSchema.parse({
    title: 'Timed story',
    brief: 'Two measured beats.',
    audience: 'Editors',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [
      {
        id: 's_one',
        layout: 'hero',
        headline: 'First beat',
        seconds: 5,
        narration: 'The first beat.',
        visual: 'A calm opening.',
        ...(firstTransition ? { transition: firstTransition } : {}),
      },
      {
        id: 's_two',
        layout: 'title',
        headline: 'Second beat',
        seconds: 5,
        narration: 'The second beat.',
        visual: 'A closing card.',
      },
    ],
  });
}

test('a typed requested duration meets tolerance for cut and fade timelines', async t => {
  for (const transition of [{ type: 'cut', frames: 0 }, { type: 'fade', frames: 12 }]) {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-duration-'));
    t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
    const pkg = await buildChatProject({
      plan: durationPlan(transition),
      runtimeDir,
      requestedDuration: { seconds: 10, toleranceSeconds: 0.5 },
    });
    assert.deepEqual(
      { mode: pkg.duration.mode, targetFrames: pkg.duration.targetFrames, minFrames: pkg.duration.minFrames, maxFrames: pkg.duration.maxFrames },
      { mode: 'target', targetFrames: 300, minFrames: 285, maxFrames: 315 },
      `${transition.type} persists the typed request`,
    );
    const timeline = compileTimeline(pkg);
    assert.equal(timeline.durationInFrames, 300, `${transition.type} compiles the requested runtime`);
    const report = timingReportFor(pkg, timeline);
    assert.equal(report.match, 'within-tolerance', transition.type);
    assert.equal(report.compiled.frames, 300);
  }
});

test('an impossible requested duration reports the mismatch instead of stretching silently', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-duration-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const plan = conversationPlanSchema.parse({
    title: 'Short card',
    brief: 'One card.',
    audience: 'Editors',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [{ id: 's_card', layout: 'title', headline: 'Short', seconds: 2, narration: '', visual: 'A short card.' }],
  });
  const pkg = await buildChatProject({ plan, runtimeDir, requestedDuration: { seconds: 30 } });
  const timeline = compileTimeline(pkg);
  const report = timingReportFor(pkg, timeline);
  assert.equal(pkg.duration.targetFrames, 900);
  assert.ok(timeline.durationInFrames < 900);
  assert.equal(report.match, 'mismatch');
  assert.equal(report.requiresAcceptance, true);
  assert.ok(Math.abs(report.deviationFrames) > report.requested.toleranceFrames);
});

test('the chat project response carries structured timing coverage', async t => {
  const { runtimeDir, pkg } = await build(t);
  const response = chatProjectResponse(pkg, runtimeDir);
  assert.ok(response.timing, 'timing report is part of the project response');
  assert.equal(response.timing.compiled.frames, response.timeline.durationInFrames);
  assert.ok(response.timing.scenes.length === pkg.scenes.length);
  assert.ok(['estimated', 'measured', 'stale'].includes(response.timing.scenes[0].state));
});
