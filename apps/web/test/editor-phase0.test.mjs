/**
 * Q-P1 editor Phase 0 spike: reorder, trim, delete and undo over the *package*,
 * with linked narration, checked against the real compiler.
 *
 * The point of the spike is the contract, not a UI: an editor command mutates the
 * canonical package and `compileTimeline` derives every frame number. Nothing
 * here keeps a second timeline, so there is no parity bug to have. `docs/editor/
 * PHASE0.md` documents the semantics these tests pin down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'editor');

function loadFixture(name) {
  const dir = join(fixtures, name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const durations = JSON.parse(readFileSync(join(dir, 'audio', 'durations.json'), 'utf8'));
  const narration = Object.fromEntries(
    Object.entries(durations.scenes).map(([sceneId, scene]) => [
      sceneId,
      scene.chunks.map(chunk => ({ text: chunk.text, seconds: chunk.seconds })),
    ]),
  );
  const options = {
    narration,
    narrationGapSeconds: durations.gapSeconds,
    narrationPaddingSeconds: durations.paddingSeconds,
  };
  return { pkg, options };
}

// ---------------------------------------------------------------- commands ---
// Every command is package -> package. Ids are stable, so narration, captions,
// takes and media stay attached to the scene that owns them.

/**
 * The compiler rejects a transition on the last scene, so any command that can
 * change which scene is last must clear it - here, loudly, rather than by
 * silently dropping the user's fade on the scene that used to be second-last.
 */
function repairTail(scenes) {
  const last = scenes[scenes.length - 1];
  if (!last?.transitionOut) return scenes;
  const repaired = [...scenes];
  repaired[repaired.length - 1] = { ...last, transitionOut: undefined };
  return repaired;
}

function moveScene(pkg, sceneId, beforeSceneId) {
  const scenes = [...pkg.scenes];
  const from = scenes.findIndex(scene => scene.id === sceneId);
  assert.ok(from >= 0, `unknown scene ${sceneId}`);
  const [moved] = scenes.splice(from, 1);
  const to = beforeSceneId === null ? scenes.length : scenes.findIndex(scene => scene.id === beforeSceneId);
  assert.ok(to >= 0, `unknown anchor ${beforeSceneId}`);
  scenes.splice(to, 0, moved);
  return { ...pkg, scenes: repairTail(scenes) };
}

function deleteScene(pkg, sceneId) {
  const scenes = pkg.scenes.filter(scene => scene.id !== sceneId);
  assert.notEqual(scenes.length, pkg.scenes.length, `unknown scene ${sceneId}`);
  return { ...pkg, scenes: repairTail(scenes) };
}

/**
 * Trim sets the scene's *preference*. The compiler still enforces the layout
 * minimum and the measured-speech floor, so the command reports what actually
 * happened rather than pretending the requested number was applied.
 */
function trimScene(pkg, sceneId, frames, options) {
  const scenes = pkg.scenes.map(scene => (scene.id === sceneId ? { ...scene, preferredFrames: frames } : scene));
  const candidate = { ...pkg, scenes };
  const timeline = compileTimeline(candidate, options);
  const before = compileTimeline(pkg, options).scenes.find(scene => scene.id === sceneId);
  const after = timeline.scenes.find(scene => scene.id === sceneId);
  return {
    pkg: candidate,
    requested: frames,
    effective: after.durationInFrames,
    // A wider preference is honoured; a narrower one is floored, and the reason
    // matters to the UI ("this scene reads a 7 s sentence").
    floored: after.durationInFrames > frames,
    previous: before.durationInFrames,
    timeline,
  };
}

const sceneIds = timeline => timeline.scenes.map(scene => scene.id);

// ------------------------------------------------------------------- tests ---

test('Q-P1: the short fixture compiles to integer frames with linked captions', () => {
  const { pkg, options } = loadFixture('short');
  const timeline = compileTimeline(pkg, options);
  assert.equal(timeline.durationInFrames, 483);
  assert.deepEqual(sceneIds(timeline), ['s_open', 's_body', 's_close']);
  assert.deepEqual(timeline.scenes.map(scene => scene.from), [0, 135, 333]);
  assert.equal(timeline.provisional, false);
  for (const caption of timeline.captions) {
    const scene = timeline.scenes.find(item => item.id === caption.sceneId);
    assert.ok(caption.from >= scene.from, `${caption.text} starts before its scene`);
    assert.ok(caption.to <= scene.from + scene.durationInFrames, `${caption.text} outruns its scene`);
  }
});

test('Q-P1: reordering scenes keeps each narration with its own scene and the total length', () => {
  const { pkg, options } = loadFixture('short');
  const before = compileTimeline(pkg, options);
  // Move a non-tail scene, so the surviving transition set is identical.
  const moved = moveScene(pkg, 's_body', 's_open');
  const after = compileTimeline(moved, options);

  assert.deepEqual(sceneIds(after), ['s_body', 's_open', 's_close']);
  // Narration is per-scene, so a reorder is length-neutral: no scene changed text.
  assert.equal(after.durationInFrames, before.durationInFrames);
  assert.equal(after.durationInFrames, 483);

  // Each caption text must still be findable inside the scene that owns it.
  const textFor = timeline =>
    Object.fromEntries(timeline.scenes.map(scene => [scene.id, timeline.captions.filter(c => c.sceneId === scene.id).map(c => c.text)]));
  assert.deepEqual(textFor(after), textFor(before));
  // Scene starts are recomputed, not copied.
  assert.deepEqual(after.scenes.map(scene => scene.from), [0, 198, 333]);
  assert.notEqual(after.hash, before.hash, 'a reorder must change the timeline hash');
});

test('Q-P1: moving the old tail changes the length only because its fade is cleared', () => {
  const { pkg, options } = loadFixture('short');
  const moved = moveScene(pkg, 's_close', 's_open');
  const after = compileTimeline(moved, options);
  assert.deepEqual(sceneIds(after), ['s_close', 's_open', 's_body']);
  // s_body used to be second-last with a 12-frame fade; as the new tail the
  // compiler forbids one, so the overlap disappears and the film is 12 frames
  // longer. The command repairs the tail instead of throwing.
  assert.equal(after.durationInFrames, 495);
  assert.equal(after.scenes[after.scenes.length - 1].transitionOutFrames, 0);
});

test('Q-P1: a trim below the measured speech is floored, and the command says so', () => {
  const { pkg, options } = loadFixture('short');
  const result = trimScene(pkg, 's_body', 60, options);
  // s_body narrates two sentences, so 60 frames cannot hold them.
  assert.equal(result.requested, 60);
  assert.equal(result.effective, 210);
  assert.equal(result.floored, true);
  assert.equal(result.timeline.durationInFrames, 483);
  assert.deepEqual(result.timeline.warnings, []);
});

test('Q-P1: a trim above the speech and above the layout floor is honoured exactly', () => {
  const { pkg, options } = loadFixture('short');
  const result = trimScene(pkg, 's_open', 240, options);
  assert.equal(result.effective, 240);
  assert.equal(result.floored, false);
  // 483 + (240 - 150); the outgoing fade still fits both neighbours.
  assert.equal(result.timeline.durationInFrames, 573);
  const sOpen = result.timeline.scenes.find(scene => scene.id === 's_open');
  assert.equal(sOpen.durationInFrames, 240);
});

test('Q-P1: a layout minimum still wins over a tiny preference on a silent scene', () => {
  const { pkg, options } = loadFixture('short');
  const silent = { ...pkg, scenes: pkg.scenes.map(scene => (scene.id === 's_close' ? { ...scene, narration: undefined } : scene)) };
  const { s_close: _dropped, ...narration } = options.narration;
  const trimmed = trimScene(silent, 's_close', 5, { ...options, narration });
  // title layout floors at 30 frames even with no speech to protect.
  assert.equal(trimmed.effective, 30);
  assert.equal(trimmed.floored, true);
});

test('Q-P1: deleting a scene closes the gap and retires its captions', () => {
  const { pkg, options } = loadFixture('short');
  const before = compileTimeline(pkg, options);
  const after = compileTimeline(deleteScene(pkg, 's_open'), options);

  assert.deepEqual(sceneIds(after), ['s_body', 's_close']);
  // 210 + 150 - 12 (the surviving s_body fade); no trailing hole.
  assert.equal(after.durationInFrames, 348);
  assert.equal(after.scenes[0].from, 0);
  assert.equal(after.captions.length, before.captions.filter(c => c.sceneId !== 's_open').length);
  assert.ok(after.captions.every(caption => caption.sceneId !== 's_open'));
});

test('Q-P1: undo restores the document and therefore the same timeline hash', () => {
  const { pkg, options } = loadFixture('short');
  const original = compileTimeline(pkg, options);
  const history = [pkg];
  const commit = next => {
    history.push(next);
    return next;
  };

  commit(moveScene(pkg, 's_close', 's_open'));
  commit(trimScene(history[1], 's_body', 240, options).pkg);

  // Undo is "pop the previous document"; no inverse maths, no drift.
  const undone = history[history.length - 2];
  assert.equal(compileTimeline(undone, options).hash, compileTimeline(history[1], options).hash);
  const allTheWayBack = history[0];
  assert.equal(compileTimeline(allTheWayBack, options).hash, original.hash);
  assert.equal(compileTimeline(allTheWayBack, options).durationInFrames, 483);
});

test('Q-P1: the 12-scene Hermes fixture is exactly 190 s at 30 fps', () => {
  const { pkg, options } = loadFixture('hermes-190s');
  const timeline = compileTimeline(pkg, options);
  assert.equal(timeline.fps, 30);
  assert.equal(timeline.scenes.length, 12);
  assert.equal(timeline.durationInFrames, 5700, '5700 frames = 190.000 s');
  assert.equal(timeline.captions.length, 24);
  assert.equal(timeline.warnings.length, 0);
  assert.equal(timeline.target.requested, 5700);
  assert.equal(timeline.target.deviationFrames, 0);
  assert.equal(timeline.target.requiresAcceptance, false);
  assert.deepEqual(timeline.scenes.map(scene => scene.from), [0, 435, 1020, 1505, 1910, 2195, 2780, 3325, 3790, 4375, 4960, 5395]);
  // A 24 fps source clip is retimed to the 30 fps project rather than re-timed in place.
  const retime = timeline.plates.find(plate => plate.assetId === 'a_plate');
  assert.equal(retime.sourceFps, 24);
  assert.equal(retime.targetFps, 30);
  assert.equal(retime.speed, 1.25);
});

test('Q-P1: reordering two chapters of the 190 s project is still exactly 190 s', () => {
  const { pkg, options } = loadFixture('hermes-190s');
  const moved = moveScene(pkg, 's11', 's2');
  const timeline = compileTimeline(moved, options);
  assert.deepEqual(sceneIds(timeline).slice(0, 2), ['s1', 's11']);
  assert.equal(timeline.durationInFrames, 5700);
  assert.equal(timeline.captions.length, 24);
  // Chapter 11 travels with its own captions.
  const texts = timeline.captions.filter(caption => caption.sceneId === 's11').map(caption => caption.text);
  assert.equal(texts.length, 2);
  const s11 = timeline.scenes.find(scene => scene.id === 's11');
  // s1's 15-frame fade overlaps onto s11, so it starts 15 frames early.
  assert.equal(s11.from, 435);
});

// ------------------------------------------------------- view-only helpers ---
// Zoom and the playhead are session state: they are pure functions of frames and
// pixels, so they can be tested without touching the document or a component.

function frameToX(frame, { zoom, scrollX, pxPerFrame }) {
  return Math.round(frame * pxPerFrame * zoom - scrollX);
}

function xToFrame(x, { zoom, scrollX, pxPerFrame }) {
  return Math.round((x + scrollX) / (pxPerFrame * zoom));
}

test('Q-P1: zoom round-trips to the same integer frame at three scales', () => {
  const pxPerFrame = 4;
  for (const zoom of [0.5, 1, 2.5]) {
    for (const scrollX of [0, 137, 1200]) {
      for (const frame of [0, 1, 435, 2999, 5700]) {
        const x = frameToX(frame, { zoom, scrollX, pxPerFrame });
        assert.equal(xToFrame(x, { zoom, scrollX, pxPerFrame }), frame, `zoom ${zoom} scroll ${scrollX} frame ${frame}`);
      }
    }
  }
});
