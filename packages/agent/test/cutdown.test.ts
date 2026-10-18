import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createToolset } from '../src/tools.js';
import { runAgent } from '../src/agent.js';
import { createScriptedModel } from '../src/scripted-model.js';
import { cutdownPackage, stubVoice, targetFramesForSeconds, type VoiceInput } from '../src/cutdown.js';

const launch = JSON.parse(readFileSync(new URL('../../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));

function presenterPackage() {
  return {
    id: 'pkg_presenterdemo01',
    title: 'Presenter cut',
    schemaVersion: 1,
    revision: 1,
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible' },
    voice: { enabled: false, engine: 'none' },
    scenes: [
      {
        id: 's1',
        layout: 'title',
        preferredFrames: 150,
        copy: { headline: 'Hook' },
        narration: 'This narration is deliberately much too long for a single scene in a thirty second cutdown, so the tool has to drop words until the spoken estimate fits the slot, and that rewrite is what makes the presenter clip stale and planned rather than kept.',
        presenter_asset: 'a_clip1',
        presenter: 'pip',
        transitionOut: { type: 'fade', frames: 15 },
      },
      {
        id: 's2',
        layout: 'hero',
        preferredFrames: 180,
        copy: { headline: 'Point' },
        narration: 'Short line.',
        presenter_asset: 'a_clip2',
        presenter: 'pip',
        transitionOut: { type: 'none', frames: 0 },
      },
    ],
    assets: {},
    presenter: { enabled: true, portrait: 'a_portrait', scenes: 'all' },
    compliance: { open_weights_only: true, backends_used: [], closed_apis_used: [], warnings: [] },
  };
}

test('variant.cutdown via the scripted model re-voices with the stub and never runs presenter clips', async () => {
  const heard: string[] = [];
  const voice = (input: VoiceInput) => {
    heard.push(input.text);
    return stubVoice(input);
  };
  const tools = createToolset({ initialPackage: presenterPackage(), voice });
  const result = await runAgent({
    model: createScriptedModel([{ name: 'variant.cutdown', args: { target_s: 6 } }]),
    brief: 'Cut this explainer to a 6 second bumper.',
    tools,
    maxSteps: 4,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 'final');
  const call = result.toolCalls[0];
  assert.equal(call.name, 'variant.cutdown');
  assert.equal(call.ok, true);
  const body = call.result as {
    target_s: number;
    targetFrames: number;
    frames: number;
    voiced: Array<{ engine: string; text: string }>;
    presenter: { ran: boolean; plans: Array<{ sceneId: string; action: string; run: boolean }> };
    package: { scenes: Array<{ id: string; presenter_asset?: string }>; duration: { mode: string; targetFrames: number } };
  };
  assert.equal(body.target_s, 6);
  assert.equal(body.targetFrames, targetFramesForSeconds(6, 30));
  assert.equal(body.frames, body.targetFrames);
  assert.equal(body.package.duration.mode, 'target');
  assert.deepEqual(body.package.scenes.map(scene => scene.id), ['s1']);
  assert.equal(body.package.scenes[0].presenter_asset, undefined);
  assert.equal(body.voiced[0].engine, 'stub');
  assert.equal(heard.length, 1);
  assert.equal(body.presenter.ran, false);
  assert.ok(body.presenter.plans.every(plan => plan.run === false));
  const planned = body.presenter.plans.find(plan => plan.sceneId === 's1');
  const dropped = body.presenter.plans.find(plan => plan.sceneId === 's2');
  assert.equal(planned?.action, 'plan');
  assert.equal(dropped?.action, 'drop');
});

test('a 30 s cutdown keeps an unchanged presenter clip and only plans the rewritten line', () => {
  const cut = cutdownPackage(presenterPackage(), 30, { voice: stubVoice });
  assert.equal(cut.frames, targetFramesForSeconds(30, 30));
  assert.deepEqual(cut.sceneIds, ['s1', 's2']);
  assert.equal(cut.presenter.ran, false);
  const plans = Object.fromEntries(cut.presenter.plans.map(plan => [plan.sceneId, plan.action]));
  assert.equal(plans.s1, 'plan');
  assert.equal(plans.s2, 'keep');
  const kept = cut.package.scenes.find((scene: { id: string }) => scene.id === 's2');
  assert.equal(kept.presenter_asset, 'a_clip2');
  assert.equal(kept.narration, 'Short line.');
  const changed = cut.package.scenes.find((scene: { id: string }) => scene.id === 's1');
  assert.equal(changed.presenter_asset, undefined);
  assert.ok(cut.voiced.every(line => line.engine === 'stub'));
});

test('launch-demo cutdowns of 6, 15 and 30 seconds each land on the target frame count', () => {
  for (const target of [6, 15, 30] as const) {
    const cut = cutdownPackage(launch, target, { voice: stubVoice });
    assert.equal(cut.frames, targetFramesForSeconds(target, 30), `${target}s frames`);
    assert.equal(cut.package.duration.mode, 'target');
    assert.equal(cut.package.duration.targetFrames, cut.frames);
    assert.ok(cut.voiced.length >= 1);
    assert.ok(cut.voiced.every(line => line.engine === 'stub'));
    assert.equal(cut.presenter.ran, false);
    assert.ok(Math.abs(cut.frames / 30 - target) <= 0.5);
  }
});
