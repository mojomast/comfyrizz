import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileTimeline as compileNode } from '../../../../packages/planner/dist/src/index.js';
import {
  compileInputHash,
  compileTimeline as compileBrowser,
  frameProjection,
  measuredFromReport,
  normalizeMeasured,
} from '../../../../packages/planner/dist/src/browser.js';
import { createEditorStore } from '../../src/editor/store.ts';
import { resolvePackageComposition } from '../../../renderer/src/composition-model.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/editor/${name}`, import.meta.url), 'utf8'));

function assertInteger(timeline: { durationInFrames: number; scenes: Array<{ from: number; durationInFrames: number }>; captions: Array<{ from: number; to: number }> }) {
  assert.equal(Number.isInteger(timeline.durationInFrames), true);
  for (const scene of timeline.scenes) {
    assert.equal(Number.isInteger(scene.from), true);
    assert.equal(Number.isInteger(scene.durationInFrames), true);
  }
  for (const cue of timeline.captions) {
    assert.equal(Number.isInteger(cue.from), true);
    assert.equal(Number.isInteger(cue.to), true);
  }
}

function sameFrames(pkg: unknown, measured = {}) {
  const browser = compileBrowser(pkg, measured);
  const node = compileNode(pkg, normalizeMeasured(measured));
  assert.deepEqual(frameProjection(browser), frameProjection(node));
  assert.equal(browser.hash, node.hash);
  assertInteger(browser);
  return browser;
}

test('browser and node compiles match on every editor fixture', () => {
  const short = sameFrames(fixture('short.json'));
  assert.equal(short.durationInFrames, 420);

  const hermes = sameFrames(fixture('hermes-standin.json'));
  assert.equal(hermes.scenes.length, 12);
  assert.equal(hermes.durationInFrames, 5700);
  assert.equal(hermes.fps, 30);

  const media = sameFrames(fixture('fps-media.json'));
  assert.deepEqual(media.plates.map(plate => plate.assetId), ['a_fps24', 'a_fps25']);
  assert.equal(media.plates.find(plate => plate.assetId === 'a_fps24')?.sourceFps, 24);
  assert.equal(media.plates.find(plate => plate.assetId === 'a_fps25')?.sourceFps, 25);

  for (const fps of [24, 25, 30]) {
    const copy = structuredClone(fixture('fps-media.json'));
    copy.format.fps = fps;
    const timeline = sameFrames(copy);
    assert.equal(timeline.fps, fps);
    assertInteger(timeline);
  }

  const durations = fixture('narration-durations.json');
  const measured = measuredFromReport(durations);
  const narrated = sameFrames(fixture('narration.json'), measured);
  assert.equal(narrated.captions[0]?.estimated, false);
  assert.equal(narrated.captions[0]?.words?.length, 2);
  assert.ok(narrated.scenes[0]!.durationInFrames > 90);
});

test('edit, save, reload and export composition keep the same frames and narration', () => {
  const measured = measuredFromReport(fixture('narration-durations.json'));
  const editor = createEditorStore({ package: fixture('narration.json'), measured });
  const result = editor.dispatch({ type: 'TrimScene', sceneId: 's_voice', preferredFrames: 200 });
  assert.equal(result.ok, true);
  const doc = editor.getState().doc;
  const timeline = editor.getState().derived.timeline!;
  const before = frameProjection(timeline);
  const composition = resolvePackageComposition(doc.package, timeline);
  assert.equal(composition.narration?.file, 'audio/narration.wav');
  assert.equal(composition.captions?.[0]?.text, 'Measured line.');

  const saved = { package: structuredClone(doc.package), editor: structuredClone(doc.editor) };
  const reloaded = createEditorStore({ package: saved.package, editor: saved.editor, measured });
  assert.deepEqual(frameProjection(reloaded.getState().derived.timeline), before);
  const again = resolvePackageComposition(reloaded.getState().doc.package, reloaded.getState().derived.timeline);
  assert.equal(again.narration?.file, composition.narration?.file);
  assert.equal(again.captions?.[0]?.from, composition.captions?.[0]?.from);
  assert.equal(compileInputHash(saved, measured), reloaded.getState().derived.inputHash);
});

test('a caption correction does not change the spoken line', () => {
  const measured = measuredFromReport(fixture('narration-durations.json'));
  const editor = createEditorStore({ package: fixture('narration.json'), measured });
  editor.dispatch({ type: 'SetCaptionText', sceneId: 's_voice', index: 0, text: 'Corrected line.' });
  const state = editor.getState();
  assert.equal(state.doc.package.scenes[0]?.narration, 'Measured line.');
  assert.equal(state.derived.timeline?.captions[0]?.text, 'Corrected line.');
  assert.equal(state.derived.timeline?.captions[0]?.from, compileBrowser(fixture('narration.json'), measured).captions[0]?.from);
});
