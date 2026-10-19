/**
 * Typed editor commands and their inverses. Pure: applyCommand clones the
 * document and does not touch the session.
 *
 * CA-1 commands (MoveScene, TrimScene, SetSceneCopy, SetMediaRange, SetCaptionText,
 * DuplicateScene, DeleteScene) are implemented here only because CA-1 has not
 * landed on integ/editor. TEMPORARY — when CA-1's commands.ts arrives, keep the
 * CA-3 commands (SplitScene, SetNarrationText, SetVoice) and drop this stand-in
 * if the landed module already owns the CA-1 set.
 */
import {
  narrationFromChunks,
  narrationInputFingerprint,
  placeScenes,
  sampleCut,
  sentenceCues,
  snapSplitFrame,
  splitAlignmentAtFrame,
  textFingerprint,
} from './audio/speech.ts';
import type {
  AlignmentChunk,
  CaptionEdit,
  EditorScene,
  NarrationTake,
  PresenterClip,
  ProjectDoc,
  SceneAlignment,
  VoiceSettings,
} from './types.ts';

export type Command =
  | { type: 'MoveScene'; sceneId: string; toIndex: number }
  | { type: 'TrimScene'; sceneId: string; preferredFrames: number | null }
  | { type: 'SetSceneCopy'; sceneId: string; copy: Record<string, unknown> }
  | { type: 'SetMediaRange'; sceneId: string; inSample: number; outSample: number }
  | { type: 'SetCaptionText'; sceneId: string; chunkIndex: number; text: string }
  | { type: 'DuplicateScene'; sceneId: string; newSceneId: string }
  | { type: 'DeleteScene'; sceneId: string }
  | { type: 'SplitScene'; sceneId: string; frame: number; newSceneId: string; snapFrames?: number }
  | { type: 'SetNarrationText'; sceneId: string; text: string }
  | { type: 'SetVoice'; voice: VoiceSettings | null }
  | { type: 'SetCaptionEdits'; sceneId: string; edits: CaptionEdit[] }
  | { type: 'JoinScenes'; leftId: string; rightId: string; leftScene: EditorScene; leftTake: NarrationTake | null; leftAlignment: SceneAlignment | null; leftCaptions: CaptionEdit[]; leftPresenter: PresenterClip | null }
  | { type: 'InsertScene'; index: number; scene: EditorScene; take: NarrationTake | null; alignment: SceneAlignment | null; captions: CaptionEdit[]; presenter: PresenterClip | null };

export type Applied = { ok: true; doc: ProjectDoc; inverse: Command[] } | { ok: false; reason: string };

const SCENE_ID = /^s[A-Za-z0-9_-]{0,63}$/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fail(reason: string): Applied {
  return { ok: false, reason };
}

function sceneIndex(doc: ProjectDoc, sceneId: string): number {
  return doc.pkg.scenes.findIndex(scene => scene.id === sceneId);
}

function requireScene(doc: ProjectDoc, sceneId: string, lockedBlocks: boolean): Applied | EditorScene {
  const scene = doc.pkg.scenes.find(item => item.id === sceneId);
  if (!scene) return fail(`Scene ${sceneId} was not found.`);
  if (lockedBlocks && scene.locked) return fail(`Scene ${sceneId} is locked.`);
  return scene;
}

function chunksFor(doc: ProjectDoc, sceneId: string): AlignmentChunk[] | undefined {
  return doc.alignment[sceneId]?.chunks;
}

function chunkMap(doc: ProjectDoc): Record<string, AlignmentChunk[] | undefined> {
  const out: Record<string, AlignmentChunk[]> = {};
  for (const [id, align] of Object.entries(doc.alignment)) out[id] = align.chunks;
  return out;
}

function bakeEdits(chunks: AlignmentChunk[], edits: CaptionEdit[] | undefined): AlignmentChunk[] {
  if (!edits?.length) return chunks.map(chunk => clone(chunk));
  return chunks.map((chunk, index) => {
    const edit = edits.find(item => item.index === index);
    return edit ? { ...clone(chunk), text: edit.text } : clone(chunk);
  });
}

export function applyCommand(doc: ProjectDoc, cmd: Command): Applied {
  const next = clone(doc);
  next.editSeq += 1;
  switch (cmd.type) {
    case 'MoveScene':
      return moveScene(next, cmd);
    case 'TrimScene':
      return trimScene(next, cmd);
    case 'SetSceneCopy':
      return setCopy(next, cmd);
    case 'SetMediaRange':
      return setMediaRange(next, cmd);
    case 'SetCaptionText':
      return setCaption(next, cmd);
    case 'SetCaptionEdits':
      return setCaptionEdits(next, cmd);
    case 'DuplicateScene':
      return duplicateScene(next, cmd);
    case 'DeleteScene':
      return deleteScene(next, cmd);
    case 'InsertScene':
      return insertScene(next, cmd);
    case 'SplitScene':
      return splitScene(next, cmd);
    case 'JoinScenes':
      return joinScenes(next, cmd);
    case 'SetNarrationText':
      return setNarration(next, cmd);
    case 'SetVoice':
      return setVoice(next, cmd);
    default:
      return fail('Unknown command.');
  }
}

function moveScene(doc: ProjectDoc, cmd: Extract<Command, { type: 'MoveScene' }>): Applied {
  const scene = requireScene(doc, cmd.sceneId, true);
  if (!('id' in scene)) return scene;
  const from = sceneIndex(doc, cmd.sceneId);
  if (!Number.isInteger(cmd.toIndex)) return fail('Move needs an integer index.');
  const to = Math.max(0, Math.min(doc.pkg.scenes.length - 1, cmd.toIndex));
  const [item] = doc.pkg.scenes.splice(from, 1);
  doc.pkg.scenes.splice(to, 0, item);
  return { ok: true, doc, inverse: [{ type: 'MoveScene', sceneId: cmd.sceneId, toIndex: from }] };
}

function trimScene(doc: ProjectDoc, cmd: Extract<Command, { type: 'TrimScene' }>): Applied {
  const scene = requireScene(doc, cmd.sceneId, true);
  if (!('id' in scene)) return scene;
  if (cmd.preferredFrames !== null && (!Number.isInteger(cmd.preferredFrames) || cmd.preferredFrames < 1 || cmd.preferredFrames > 108000)) {
    return fail('Duration needs a whole number of frames from 1 to 108000.');
  }
  const previous = scene.preferredFrames ?? null;
  const target = doc.pkg.scenes[sceneIndex(doc, cmd.sceneId)];
  if (cmd.preferredFrames === null) delete target.preferredFrames;
  else target.preferredFrames = cmd.preferredFrames;
  return { ok: true, doc, inverse: [{ type: 'TrimScene', sceneId: cmd.sceneId, preferredFrames: previous }] };
}

function setCopy(doc: ProjectDoc, cmd: Extract<Command, { type: 'SetSceneCopy' }>): Applied {
  const scene = requireScene(doc, cmd.sceneId, false);
  if (!('id' in scene)) return scene;
  const previous = clone(scene.copy ?? {});
  doc.pkg.scenes[sceneIndex(doc, cmd.sceneId)].copy = clone(cmd.copy);
  return { ok: true, doc, inverse: [{ type: 'SetSceneCopy', sceneId: cmd.sceneId, copy: previous }] };
}

function setMediaRange(doc: ProjectDoc, cmd: Extract<Command, { type: 'SetMediaRange' }>): Applied {
  const scene = requireScene(doc, cmd.sceneId, true);
  if (!('id' in scene)) return scene;
  const take = doc.takes[cmd.sceneId];
  if (!take) return fail(`Scene ${cmd.sceneId} has no narration take.`);
  if (!Number.isInteger(cmd.inSample) || !Number.isInteger(cmd.outSample)) return fail('Source range needs integer samples.');
  if (cmd.inSample < 0 || cmd.outSample > take.sampleCount || cmd.inSample >= cmd.outSample) {
    return fail(`Source range ${cmd.inSample}–${cmd.outSample} is outside 0–${take.sampleCount}.`);
  }
  const previous = { ...take.range };
  take.range = { inSample: cmd.inSample, outSample: cmd.outSample };
  return { ok: true, doc, inverse: [{ type: 'SetMediaRange', sceneId: cmd.sceneId, inSample: previous.inSample, outSample: previous.outSample }] };
}

function setCaption(doc: ProjectDoc, cmd: Extract<Command, { type: 'SetCaptionText' }>): Applied {
  const scene = requireScene(doc, cmd.sceneId, false);
  if (!('id' in scene)) return scene;
  const chunks = chunksFor(doc, cmd.sceneId);
  if (!chunks || cmd.chunkIndex < 0 || cmd.chunkIndex >= chunks.length) return fail('That caption is not in this scene.');
  if (cmd.text.length > 600) return fail('Caption text is longer than 600 characters.');
  const edits = doc.captions[cmd.sceneId] ? [...doc.captions[cmd.sceneId]] : [];
  const previous = edits.find(edit => edit.index === cmd.chunkIndex)?.text ?? chunks[cmd.chunkIndex].text;
  const without = edits.filter(edit => edit.index !== cmd.chunkIndex);
  without.push({ index: cmd.chunkIndex, text: cmd.text });
  doc.captions[cmd.sceneId] = without;
  return { ok: true, doc, inverse: [{ type: 'SetCaptionText', sceneId: cmd.sceneId, chunkIndex: cmd.chunkIndex, text: previous }] };
}

function setCaptionEdits(doc: ProjectDoc, cmd: Extract<Command, { type: 'SetCaptionEdits' }>): Applied {
  const previous = clone(doc.captions[cmd.sceneId] ?? []);
  if (cmd.edits.length === 0) delete doc.captions[cmd.sceneId];
  else doc.captions[cmd.sceneId] = clone(cmd.edits);
  return { ok: true, doc, inverse: [{ type: 'SetCaptionEdits', sceneId: cmd.sceneId, edits: previous }] };
}

function duplicateScene(doc: ProjectDoc, cmd: Extract<Command, { type: 'DuplicateScene' }>): Applied {
  const scene = requireScene(doc, cmd.sceneId, false);
  if (!('id' in scene)) return scene;
  if (!SCENE_ID.test(cmd.newSceneId) || doc.pkg.scenes.some(item => item.id === cmd.newSceneId)) {
    return fail('Duplicate needs a new scene id that is not already used.');
  }
  const copy = clone(scene);
  copy.id = cmd.newSceneId;
  copy.locked = false;
  const index = sceneIndex(doc, cmd.sceneId);
  doc.pkg.scenes.splice(index + 1, 0, copy);
  const take = doc.takes[cmd.sceneId];
  if (take) doc.takes[cmd.newSceneId] = { ...clone(take), takeId: `${take.takeId}-copy` };
  if (doc.alignment[cmd.sceneId]) doc.alignment[cmd.newSceneId] = clone(doc.alignment[cmd.sceneId]);
  if (doc.captions[cmd.sceneId]) doc.captions[cmd.newSceneId] = clone(doc.captions[cmd.sceneId]);
  if (doc.presenterClips[cmd.sceneId]) doc.presenterClips[cmd.newSceneId] = clone(doc.presenterClips[cmd.sceneId]);
  return { ok: true, doc, inverse: [{ type: 'DeleteScene', sceneId: cmd.newSceneId }] };
}

function deleteScene(doc: ProjectDoc, cmd: Extract<Command, { type: 'DeleteScene' }>): Applied {
  const scene = requireScene(doc, cmd.sceneId, true);
  if (!('id' in scene)) return scene;
  if (doc.pkg.scenes.length < 2) return fail('A package needs at least one scene.');
  const index = sceneIndex(doc, cmd.sceneId);
  const inverse: Command = {
    type: 'InsertScene',
    index,
    scene: clone(scene),
    take: doc.takes[cmd.sceneId] ? clone(doc.takes[cmd.sceneId]) : null,
    alignment: doc.alignment[cmd.sceneId] ? clone(doc.alignment[cmd.sceneId]) : null,
    captions: clone(doc.captions[cmd.sceneId] ?? []),
    presenter: doc.presenterClips[cmd.sceneId] ? clone(doc.presenterClips[cmd.sceneId]) : null,
  };
  doc.pkg.scenes.splice(index, 1);
  delete doc.takes[cmd.sceneId];
  delete doc.alignment[cmd.sceneId];
  delete doc.captions[cmd.sceneId];
  delete doc.presenterClips[cmd.sceneId];
  return { ok: true, doc, inverse: [inverse] };
}

function insertScene(doc: ProjectDoc, cmd: Extract<Command, { type: 'InsertScene' }>): Applied {
  if (doc.pkg.scenes.some(scene => scene.id === cmd.scene.id)) return fail(`Scene ${cmd.scene.id} already exists.`);
  const index = Math.max(0, Math.min(doc.pkg.scenes.length, cmd.index));
  doc.pkg.scenes.splice(index, 0, clone(cmd.scene));
  if (cmd.take) doc.takes[cmd.scene.id] = clone(cmd.take);
  if (cmd.alignment) doc.alignment[cmd.scene.id] = clone(cmd.alignment);
  if (cmd.captions.length) doc.captions[cmd.scene.id] = clone(cmd.captions);
  if (cmd.presenter) doc.presenterClips[cmd.scene.id] = clone(cmd.presenter);
  return { ok: true, doc, inverse: [{ type: 'DeleteScene', sceneId: cmd.scene.id }] };
}

function splitScene(doc: ProjectDoc, cmd: Extract<Command, { type: 'SplitScene' }>): Applied {
  const scene = requireScene(doc, cmd.sceneId, true);
  if (!('id' in scene)) return scene;
  if (!SCENE_ID.test(cmd.newSceneId) || doc.pkg.scenes.some(item => item.id === cmd.newSceneId)) {
    return fail('Split needs a new scene id that is not already used.');
  }
  const take = doc.takes[cmd.sceneId];
  const align = doc.alignment[cmd.sceneId];
  if (!take || !align?.chunks?.length) return fail(`Scene ${cmd.sceneId} has no measured narration take to split.`);
  if (take.range.outSample - take.range.inSample < 2) return fail('The source range is too short to split.');
  const placed = placeScenes(doc.pkg, chunkMap(doc));
  if (!placed.ok) return fail(placed.reason);
  const slot = placed.scenes.find(item => item.id === cmd.sceneId);
  if (!slot) return fail(`Scene ${cmd.sceneId} is not on the timeline.`);
  if (!Number.isInteger(cmd.frame) || cmd.frame <= slot.from || cmd.frame >= slot.from + slot.duration) {
    return fail('The playhead is outside this scene.');
  }
  const cues = sentenceCues(align.chunks, slot.from, cmd.sceneId, placed.fps, doc.captions[cmd.sceneId]);
  const snap = cmd.snapFrames ?? 8;
  const cutFrame = snapSplitFrame(cues, cmd.frame, slot.from, slot.from + slot.duration, snap);
  const baked = bakeEdits(align.chunks, doc.captions[cmd.sceneId]);
  const bakedCues = sentenceCues(baked, slot.from, cmd.sceneId, placed.fps);
  const split = splitAlignmentAtFrame(baked, bakedCues, cutFrame);
  if (split.left.length === 0 || split.right.length === 0) {
    return fail('Split needs speech on both sides. Move onto a sentence or closer to its boundary.');
  }
  const totalSeconds = baked.reduce((sum, chunk) => sum + chunk.seconds, 0);
  const cutSample = sampleCut(take, split.cutSeconds, totalSeconds);
  const leftText = narrationFromChunks(split.left);
  const rightText = narrationFromChunks(split.right);
  const leftScene = doc.pkg.scenes[sceneIndex(doc, cmd.sceneId)];
  const snapshot = {
    type: 'JoinScenes' as const,
    leftId: cmd.sceneId,
    rightId: cmd.newSceneId,
    leftScene: clone(leftScene),
    leftTake: clone(take),
    leftAlignment: clone(align),
    leftCaptions: clone(doc.captions[cmd.sceneId] ?? []),
    leftPresenter: doc.presenterClips[cmd.sceneId] ? clone(doc.presenterClips[cmd.sceneId]) : null,
  };
  const local = cutFrame - slot.from;
  leftScene.narration = leftText;
  leftScene.preferredFrames = Math.max(1, local);
  leftScene.narration_duration_frames = Math.max(1, Math.round(((cutSample - take.range.inSample) / take.sampleRate) * placed.fps));
  leftScene.transitionOut = { type: 'cut', frames: 0 };
  const rightScene = clone(leftScene);
  rightScene.id = cmd.newSceneId;
  rightScene.narration = rightText;
  rightScene.preferredFrames = Math.max(1, slot.duration - local);
  rightScene.narration_duration_frames = Math.max(1, Math.round(((take.range.outSample - cutSample) / take.sampleRate) * placed.fps));
  rightScene.transitionOut = snapshot.leftScene.transitionOut ? clone(snapshot.leftScene.transitionOut) : undefined;
  rightScene.locked = false;
  doc.pkg.scenes.splice(sceneIndex(doc, cmd.sceneId) + 1, 0, rightScene);
  const voice = doc.pkg.voice;
  take.range = { inSample: take.range.inSample, outSample: cutSample };
  take.inputFingerprint = narrationInputFingerprint(leftScene, voice);
  doc.takes[cmd.newSceneId] = {
    ...clone(take),
    takeId: `${take.takeId}-b`,
    range: { inSample: cutSample, outSample: snapshot.leftTake!.range.outSample },
    inputFingerprint: narrationInputFingerprint(rightScene, voice),
  };
  doc.alignment[cmd.sceneId] = { sourceHash: take.sourceHash, textFingerprint: textFingerprint(leftText), chunks: split.left };
  doc.alignment[cmd.newSceneId] = { sourceHash: take.sourceHash, textFingerprint: textFingerprint(rightText), chunks: split.right };
  delete doc.captions[cmd.sceneId];
  // Presenter conditioning stays on the pre-split range, so the clip is stale.
  const check = placeScenes(doc.pkg, chunkMap(doc));
  if (!check.ok) return fail(check.reason);
  return { ok: true, doc, inverse: [snapshot] };
}

function joinScenes(doc: ProjectDoc, cmd: Extract<Command, { type: 'JoinScenes' }>): Applied {
  const left = sceneIndex(doc, cmd.leftId);
  const right = sceneIndex(doc, cmd.rightId);
  if (left < 0 || right < 0) return fail('Join could not find both halves.');
  if (right > left) doc.pkg.scenes.splice(right, 1);
  doc.pkg.scenes[left] = clone(cmd.leftScene);
  if (right < left) doc.pkg.scenes.splice(right, 1);
  if (cmd.leftTake) doc.takes[cmd.leftId] = clone(cmd.leftTake);
  else delete doc.takes[cmd.leftId];
  if (cmd.leftAlignment) doc.alignment[cmd.leftId] = clone(cmd.leftAlignment);
  else delete doc.alignment[cmd.leftId];
  if (cmd.leftCaptions.length) doc.captions[cmd.leftId] = clone(cmd.leftCaptions);
  else delete doc.captions[cmd.leftId];
  if (cmd.leftPresenter) doc.presenterClips[cmd.leftId] = clone(cmd.leftPresenter);
  else delete doc.presenterClips[cmd.leftId];
  delete doc.takes[cmd.rightId];
  delete doc.alignment[cmd.rightId];
  delete doc.captions[cmd.rightId];
  delete doc.presenterClips[cmd.rightId];
  return { ok: true, doc, inverse: [{ type: 'DeleteScene', sceneId: cmd.rightId }] };
}

function setNarration(doc: ProjectDoc, cmd: Extract<Command, { type: 'SetNarrationText' }>): Applied {
  const scene = requireScene(doc, cmd.sceneId, false);
  if (!('id' in scene)) return scene;
  if (cmd.text.length > 600) return fail('Narration is longer than 600 characters.');
  const target = doc.pkg.scenes[sceneIndex(doc, cmd.sceneId)];
  const previous = target.narration ?? '';
  const previousEdits = clone(doc.captions[cmd.sceneId] ?? []);
  target.narration = cmd.text;
  delete doc.captions[cmd.sceneId];
  return {
    ok: true,
    doc,
    inverse: [
      { type: 'SetNarrationText', sceneId: cmd.sceneId, text: previous },
      { type: 'SetCaptionEdits', sceneId: cmd.sceneId, edits: previousEdits },
    ],
  };
}

function setVoice(doc: ProjectDoc, cmd: Extract<Command, { type: 'SetVoice' }>): Applied {
  const previous = doc.pkg.voice ? clone(doc.pkg.voice) : null;
  if (cmd.voice === null) {
    delete doc.pkg.voice;
    return { ok: true, doc, inverse: [{ type: 'SetVoice', voice: previous }] };
  }
  const voice = cmd.voice;
  if (typeof voice.enabled !== 'boolean') return fail('Voice needs an enabled flag.');
  if (voice.engine && voice.engine !== 'kokoro' && voice.engine !== 'qwen3-tts' && voice.engine !== 'none') {
    return fail('Voice engine must be kokoro, qwen3-tts or none.');
  }
  if (voice.speed !== undefined && (typeof voice.speed !== 'number' || voice.speed < 0.5 || voice.speed > 2)) {
    return fail('Voice speed must be between 0.5 and 2.');
  }
  if (voice.voice !== undefined && (voice.voice.length < 1 || voice.voice.length > 64)) return fail('Voice id must be 1–64 characters.');
  if (voice.persona !== undefined && voice.persona.length > 400) return fail('Persona is longer than 400 characters.');
  doc.pkg.voice = clone(voice);
  return { ok: true, doc, inverse: [{ type: 'SetVoice', voice: previous }] };
}
