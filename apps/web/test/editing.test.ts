import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { LAYOUT_LIMITS as PLANNER_LIMITS, compileTimeline } from '../../../packages/planner/src/timeline.ts';
import { LAYOUT_LIMITS, applyCommand, duplicateId, narrationFloorFrames } from '../src/editor/commands.ts';
import { createEditorStore, type StandInStore } from '../src/editor/store.ts';
import type { NarrationChunk, ProjectDoc, Timeline } from '../src/editor/types.ts';
import { keyboardAction, musicBlock, narrationBlocks, selectAdjacent, selectionAfterClick, snapFrame } from '../src/editor/timeline/model.ts';

function chunks(text: string, seconds: number): NarrationChunk[] {
  return [{ text, seconds }];
}

function roughCut(): ProjectDoc {
  return {
    revision: 1,
    mediaRanges: [],
    measured: {
      s_open: chunks('Welcome to the rough cut.', 1.2),
      s_point: [
        { text: 'The point lands here.', seconds: 0.8 },
        { text: 'Then the next sentence.', seconds: 0.7 },
      ],
      s_end: chunks('That is the end.', 0.9),
    },
    package: {
      schemaVersion: 1,
      id: 'pkg_rough',
      title: 'Rough cut',
      revision: 1,
      format: { width: 1920, height: 1080, fps: 30 },
      duration: { mode: 'flexible' },
      voice: { enabled: true, engine: 'none' },
      presenter: { enabled: true, portrait: 'a_face', scenes: 'all', placement: 'pip-br' },
      audio: { music: { asset: 'a_music' } },
      assets: {
        a_plate: { kind: 'video', origin: 'generated', status: 'ready', file: 'assets/a_plate.mp4', media: { fps: 24, frames: 48 } },
        a_music: { kind: 'audio', origin: 'generated', status: 'ready', file: 'assets/a_music.wav' },
        a_face: { kind: 'image', origin: 'generated', status: 'ready', file: 'assets/a_face.png' },
      },
      scenes: [
        { id: 's_open', layout: 'title', preferredFrames: 90, copy: { headline: 'Open' }, narration: 'Welcome to the rough cut.', transitionOut: { type: 'fade', frames: 12 } },
        { id: 's_point', layout: 'hero', preferredFrames: 40, copy: { headline: 'Point' }, narration: 'The point lands here. Then the next sentence.', transitionOut: { type: 'fade', frames: 12 } },
        { id: 's_plate', layout: 'stat', preferredFrames: 120, copy: { headline: 'Plate' }, background: { asset: 'a_plate', loop: false }, transitionOut: { type: 'fade', frames: 12 } },
        { id: 's_end', layout: 'list', preferredFrames: 80, copy: { headline: 'End' }, narration: 'That is the end.', transitionOut: { type: 'cut', frames: 0 } },
      ],
    } as ProjectDoc['package'],
  };
}

function speech(doc: ProjectDoc) {
  return Object.fromEntries(Object.entries(doc.measured).map(([id, list]) => [id, list.map(chunk => ({ text: chunk.text, seconds: chunk.seconds }))]));
}

function captionShape(timeline: Timeline) {
  return timeline.captions.map(caption => ({ sceneId: caption.sceneId, text: caption.text, frames: caption.to - caption.from }));
}

function order(doc: ProjectDoc) {
  return doc.package.scenes.map(scene => scene.id);
}

function compiledOf(store: StandInStore): Timeline {
  const timeline = store.getState().derived.compiled;
  assert.ok(timeline, store.getState().derived.error ?? 'missing compile');
  return timeline;
}

function assertInteger(timeline: Timeline) {
  for (const scene of timeline.scenes) {
    assert.equal(scene.from, Math.round(scene.from));
    assert.equal(scene.durationInFrames, Math.round(scene.durationInFrames));
  }
  for (const caption of timeline.captions) {
    assert.equal(caption.from, Math.round(caption.from));
    assert.equal(caption.to, Math.round(caption.to));
  }
}

test('layout floors match the planner table', () => {
  assert.deepEqual(LAYOUT_LIMITS, PLANNER_LIMITS);
});

test('reorder, duplicate, delete and undo keep narration and captions intact', () => {
  const store = createEditorStore(roughCut());
  const before = compiledOf(store);
  const beforeSpeech = speech(store.getState().doc);
  const beforeCaptions = captionShape(before);
  assertInteger(before);
  assert.deepEqual(before.captions.map(caption => caption.sceneId), ['s_open', 's_point', 's_point', 's_end']);
  assert.ok(musicBlock(before, 'a_music'));
  assert.equal(narrationBlocks(before).length, 3);
  assert.equal(before.presenters?.length, 4);

  const moved = store.dispatch({ type: 'MoveScene', sceneId: 's_end', toIndex: 0 });
  assert.equal(moved.ok, true);
  const after = compiledOf(store);
  assertInteger(after);
  assert.deepEqual(order(store.getState().doc), ['s_end', 's_open', 's_point', 's_plate']);
  assert.deepEqual(speech(store.getState().doc), beforeSpeech);
  assert.deepEqual(captionShape(after).map(item => `${item.sceneId}:${item.text}:${item.frames}`).sort(), beforeCaptions.map(item => `${item.sceneId}:${item.text}:${item.frames}`).sort());
  assert.equal(after.captions[0].sceneId, 's_end');
  assert.notEqual(after.scenes[0].from, before.scenes.find(scene => scene.id === 's_end')?.from);
  for (const caption of after.captions) {
    const prior = before.captions.find(item => item.sceneId === caption.sceneId && item.text === caption.text);
    assert.ok(prior);
    assert.equal(caption.to - caption.from, prior.to - prior.from);
  }

  const movedCaptions = captionShape(after);
  store.setSession({ selectedIds: ['s_open'], anchorId: 's_open' });
  assert.equal(store.dispatch({ type: 'DeleteScene', sceneId: 's_open' }).ok, true);
  const deleted = compiledOf(store);
  assert.equal(deleted.captions.some(caption => caption.sceneId === 's_open'), false);
  assert.equal(store.getState().doc.measured.s_open, undefined);
  assert.equal(store.getState().session.selectedIds.includes('s_open'), false);
  store.undo();
  assert.deepEqual(speech(store.getState().doc), beforeSpeech);
  assert.deepEqual(store.getState().session.selectedIds, ['s_open']);
  assert.deepEqual(captionShape(compiledOf(store)), movedCaptions);

  const newId = duplicateId(order(store.getState().doc), 's_open');
  assert.equal(store.dispatch({ type: 'DuplicateScene', sceneId: 's_open', newId }).ok, true);
  const copy = store.getState().doc.measured[newId];
  assert.ok(copy);
  assert.deepEqual(copy.map(chunk => chunk.seconds), beforeSpeech.s_open.map(chunk => chunk.seconds));
  assert.notEqual(copy, store.getState().doc.measured.s_open);
  assert.equal(compiledOf(store).captions.filter(caption => caption.text === 'Welcome to the rough cut.').length, 2);
  store.undo();
  assert.equal(store.getState().doc.measured[newId], undefined);
  assert.deepEqual(order(store.getState().doc), ['s_end', 's_open', 's_point', 's_plate']);
  store.undo();
  assert.deepEqual(order(store.getState().doc), ['s_open', 's_point', 's_plate', 's_end']);
  assert.deepEqual(compiledOf(store).scenes.map(scene => scene.from), before.scenes.map(scene => scene.from));
});

test('trim respects speech and source bounds and undo restores the preference', () => {
  const store = createEditorStore(roughCut());
  const seconds = store.getState().doc.measured.s_point.map(chunk => chunk.seconds);
  const trimmed = store.dispatch({ type: 'TrimScene', sceneId: 's_point', preferredFrames: 10 });
  assert.equal(trimmed.ok, true);
  if (trimmed.ok) assert.match(trimmed.note ?? '', /narration/);
  const point = store.getState().doc.package.scenes.find(scene => scene.id === 's_point');
  const floor = narrationFloorFrames(store.getState().doc.measured.s_point, 30);
  assert.equal(floor, 57);
  assert.equal(point?.preferredFrames, floor);
  const scene = compiledOf(store).scenes.find(item => item.id === 's_point');
  assert.equal(scene?.durationInFrames, floor);
  assert.deepEqual(store.getState().doc.measured.s_point.map(chunk => chunk.seconds), seconds);
  assert.equal(scene?.durationInFrames, Math.round(scene?.durationInFrames ?? 0));

  const plate = store.dispatch({ type: 'TrimScene', sceneId: 's_plate', preferredFrames: 200.9 });
  assert.equal(plate.ok, true);
  assert.equal(store.getState().doc.package.scenes.find(scene => scene.id === 's_plate')?.preferredFrames, 60);
  assert.equal(compiledOf(store).scenes.find(scene => scene.id === 's_plate')?.durationInFrames, 60);

  store.undo();
  store.undo();
  assert.equal(store.getState().doc.package.scenes.find(scene => scene.id === 's_point')?.preferredFrames, 40);
  assert.equal(compiledOf(store).scenes.find(scene => scene.id === 's_point')?.durationInFrames, 57);
});

test('caption text edits do not stretch speech and follow a reorder', () => {
  const store = createEditorStore(roughCut());
  const before = store.getState().doc.measured.s_point[0].seconds;
  assert.equal(store.dispatch({ type: 'SetCaptionText', sceneId: 's_point', index: 0, text: 'The point stays put.' }).ok, true);
  assert.equal(store.getState().doc.measured.s_point[0].seconds, before);
  assert.equal(store.dispatch({ type: 'MoveScene', sceneId: 's_point', toIndex: 0 }).ok, true);
  const caption = compiledOf(store).captions.find(item => item.text === 'The point stays put.');
  assert.equal(caption?.sceneId, 's_point');
  assert.equal(compiledOf(store).captions[0].sceneId, 's_point');
  store.undo();
  store.undo();
  assert.equal(store.getState().doc.measured.s_point[0].text, 'The point lands here.');
});

test('a batch is one undo step and preview does not compile', () => {
  const store = createEditorStore(roughCut());
  const compiled = compiledOf(store);
  store.preview({ type: 'TrimScene', sceneId: 's_open', preferredFrames: 200 });
  assert.equal(store.getState().derived.compiled, compiled);
  assert.equal(store.getState().doc.package.scenes[0].preferredFrames, 90);
  store.cancelPreview();
  assert.equal(store.getState().session.preview, null);
  assert.equal(store.dispatch([
    { type: 'TrimScene', sceneId: 's_open', preferredFrames: 120 },
    { type: 'MoveScene', sceneId: 's_open', toIndex: 2 },
  ]).ok, true);
  assert.equal(store.canUndo(), true);
  store.undo();
  assert.equal(store.getState().doc.package.scenes[0].id, 's_open');
  assert.equal(store.getState().doc.package.scenes[0].preferredFrames, 90);
  assert.equal(store.canRedo(), true);
  store.redo();
  assert.equal(store.getState().doc.package.scenes[2].id, 's_open');
  assert.equal(store.getState().doc.package.scenes[2].preferredFrames, 120);
});

test('locked scenes, bad transitions and source ranges are rejected', () => {
  const doc = roughCut();
  (doc.package.scenes[1] as { locked?: boolean }).locked = true;
  assert.equal(applyCommand(doc, { type: 'MoveScene', sceneId: 's_point', toIndex: 0 }).ok, false);
  assert.equal(applyCommand(doc, { type: 'DeleteScene', sceneId: 's_point' }).ok, false);
  const store = createEditorStore(roughCut());
  const last = store.dispatch({ type: 'SetTransition', sceneId: 's_end', transitionOut: { type: 'fade', frames: 10 } });
  assert.equal(last.ok, false);
  const wide = store.dispatch({ type: 'SetTransition', sceneId: 's_open', transitionOut: { type: 'fade', frames: 120 } });
  assert.equal(wide.ok, false);
  const range = store.dispatch({ type: 'SetMediaRange', sceneId: 's_plate', assetId: 'a_plate', inFrame: 0, outFrame: 80 });
  assert.equal(range.ok, false);
  if (!range.ok) assert.match(range.reason, /past the asset/);
  assert.equal(store.dispatch({ type: 'SetMediaRange', sceneId: 's_plate', assetId: 'a_plate', inFrame: 0, outFrame: 24 }).ok, true);
  const capped = store.dispatch({ type: 'TrimScene', sceneId: 's_plate', preferredFrames: 90 });
  assert.equal(capped.ok, true);
  assert.equal(store.getState().doc.package.scenes.find(scene => scene.id === 's_plate')?.preferredFrames, 30);
});

test('browser compile matches planner compile for the rough cut', () => {
  const doc = roughCut();
  const fromStore = compiledOf(createEditorStore(doc));
  const direct = compileTimeline(doc.package as unknown as Parameters<typeof compileTimeline>[0], { narration: doc.measured });
  assert.deepEqual(fromStore.scenes.map(scene => [scene.id, scene.from, scene.durationInFrames]), direct.scenes.map(scene => [scene.id, scene.from, scene.durationInFrames]));
  assert.deepEqual(fromStore.captions, direct.captions);
});

test('selection feedback on a 12-scene fixture stays under 100ms', () => {
  const doc = roughCut();
  const seed = doc.package.scenes[0];
  doc.package.scenes = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(seed),
    id: `s_beat${index}`,
    narration: `Beat ${index}.`,
    transitionOut: index === 11 ? { type: 'cut' as const, frames: 0 } : { type: 'fade' as const, frames: 8 },
  }));
  doc.measured = Object.fromEntries(doc.package.scenes.map(scene => [scene.id, chunks(scene.narration ?? '', 0.6)]));
  const store = createEditorStore(doc);
  const ids = order(doc);
  const started = performance.now();
  for (let index = 0; index < 12; index += 1) {
    const next = selectionAfterClick(ids, [], ids[0], ids[index], false);
    store.setSession(next);
  }
  const elapsed = performance.now() - started;
  const perSelection = elapsed / 12;
  console.log(JSON.stringify({ hardware: cpus()[0]?.model ?? 'unknown', perSelectionMs: Number(perSelection.toFixed(3)), samples: 12 }));
  assert.ok(perSelection < 100, `selection took ${perSelection}ms`);
  assert.deepEqual(store.getState().session.selectedIds, ['s_beat11']);
});

test('keyboard covers every edit and ignores typing', () => {
  const fps = 30;
  const base = { meta: false, ctrl: false, shift: false, alt: false, typing: false, onButton: false, fps };
  assert.equal(keyboardAction({ ...base, typing: true, key: 'Delete' }), null);
  assert.equal(keyboardAction({ ...base, onButton: true, key: ' ' }), null);
  assert.deepEqual(keyboardAction({ ...base, key: 'ArrowRight' }), { type: 'frame-step', delta: 1 });
  assert.deepEqual(keyboardAction({ ...base, key: 'ArrowLeft', shift: true }), { type: 'frame-step', delta: -fps });
  assert.deepEqual(keyboardAction({ ...base, key: 'ArrowRight', alt: true, shift: true }), { type: 'select-adjacent', delta: 1, extend: true });
  assert.deepEqual(keyboardAction({ ...base, key: 'ArrowUp', alt: true }), { type: 'nudge-order', delta: -1 });
  assert.deepEqual(keyboardAction({ ...base, key: ']' }), { type: 'nudge-trim', delta: 1 });
  assert.equal(keyboardAction({ ...base, key: 's' })?.type, 'toggle-snap');
  assert.equal(keyboardAction({ ...base, key: 'f' })?.type, 'fit');
  assert.equal(keyboardAction({ ...base, key: '+' })?.type, 'zoom');
  assert.equal(keyboardAction({ ...base, key: ' ', })?.type, 'play');
  assert.equal(keyboardAction({ ...base, key: 'Delete' })?.type, 'delete');
  assert.equal(keyboardAction({ ...base, key: 'd', meta: true })?.type, 'duplicate');
  assert.equal(keyboardAction({ ...base, key: 'z', ctrl: true })?.type, 'undo');
  assert.equal(keyboardAction({ ...base, key: 'z', ctrl: true, shift: true })?.type, 'redo');
  assert.equal(keyboardAction({ ...base, key: 'Escape' })?.type, 'cancel');
  const ids = ['s_open', 's_point', 's_plate', 's_end'];
  assert.deepEqual(selectionAfterClick(ids, ['s_open'], 's_open', 's_plate', true).selectedIds, ['s_open', 's_point', 's_plate']);
  assert.deepEqual(selectAdjacent(ids, ['s_open'], 's_open', 1, false)?.selectedIds, ['s_point']);
});

test('snap threshold stays in screen pixels', () => {
  const targets = [{ frame: 100, label: 's_open start' }];
  assert.equal(snapFrame(104, targets, 1, true).label, 's_open start');
  assert.equal(snapFrame(104, targets, 8, true).label, null);
  assert.equal(snapFrame(104, targets, 1, false).label, null);
});

test('save status text and the timeline shell are exposed', () => {
  const store = createEditorStore(roughCut());
  assert.equal(store.saveStatus(), 'saved');
  store.setSaveStatus('conflict');
  assert.equal(store.saveStatus(), 'conflict');
  const timeline = readFileSync(new URL('../src/editor/timeline/Timeline.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/editor/timeline/timeline.css', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(timeline, /requestAnimationFrame/);
  assert.doesNotMatch(timeline, /compileTimeline/);
  assert.match(timeline, /data-save-status/);
  assert.match(timeline, /aria-readonly="true"/);
  assert.match(timeline, /Move earlier/);
  assert.match(timeline, /Move later/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(main, /followFrame/);
  assert.match(main, /frameupdate/);
  assert.equal(store.dispatch({ type: 'DeleteScene', sceneId: 'missing' }).ok, false);
});
