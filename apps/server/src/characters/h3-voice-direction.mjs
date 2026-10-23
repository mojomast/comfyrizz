/**
 * VX13: fill structured FastH3 direction voices from the cast.
 *
 * Pure module: no I/O, no clock, no random ids and no side effects at import.
 * The prompt voice reaches the planner only through the plate asset's
 * `gen.direction.voice` (VX02S); the package voice stays closed and clip mode is
 * absence, never `{ mode: 'clip' }`.
 */

import { resolveSpeakingVoice } from './voice.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniquePush(list, value) {
  if (typeof value === 'string' && value && !list.includes(value)) list.push(value);
}

/**
 * The deterministic scene -> plate link used by the job planner
 * (packages/jobs/src/plan.mjs sceneIndexOf): a scene names an asset through its
 * background, a foreground layer, a media plate or its narration asset. Only a
 * FastH3 Omni asset that already carries structured direction is a voice target;
 * no ordering or ownership is guessed.
 */
function sceneAssetIds(scene) {
  const ids = [];
  if (isObject(scene.background)) uniquePush(ids, scene.background.asset);
  if (Array.isArray(scene.foreground)) {
    for (const layer of scene.foreground) {
      if (isObject(layer)) uniquePush(ids, layer.asset);
    }
  }
  if (Array.isArray(scene.media)) {
    for (const layer of scene.media) {
      if (isObject(layer)) uniquePush(ids, layer.asset);
    }
  }
  uniquePush(ids, scene.narration_asset);
  return ids;
}

function directedPlates(scene, assets) {
  const plates = [];
  for (const assetId of sceneAssetIds(scene)) {
    const asset = assets[assetId];
    if (!isObject(asset) || !isObject(asset.gen)) continue;
    if (asset.gen.generator !== 'fasth3-omni') continue;
    if (!isObject(asset.gen.direction)) continue;
    plates.push(asset);
  }
  return plates;
}

function speakingOptions(character, h3VoiceMode, model) {
  const options = { model };
  if (h3VoiceMode !== undefined) options.h3VoiceMode = h3VoiceMode;
  if (character.id !== undefined) options.characterId = character.id;
  if (character.voice !== undefined) options.voice = character.voice;
  return options;
}

/**
 * Apply the character's prompt voice to every FastH3 plate a speaking scene
 * names. Returns a new package object; the input is never mutated. Resolver
 * errors are collected as `{ code, sceneId, castId }` and never fall back to
 * clip.
 */
export function applyH3VoiceDirection(pkg, { characters, h3VoiceMode, model } = {}) {
  const out = structuredClone(pkg);
  const errors = [];
  if (!model) return { pkg: out, errors };
  if (!(characters instanceof Map)) return { pkg: out, errors };

  const assets = isObject(out.assets) ? out.assets : {};
  const scenes = Array.isArray(out.scenes) ? out.scenes : [];

  for (const scene of scenes) {
    if (!isObject(scene) || typeof scene.speaker !== 'string') continue;
    const castId = scene.speaker;
    const character = characters.get(castId);
    if (!isObject(character)) continue;

    const plates = directedPlates(scene, assets);
    if (!plates.length) continue;

    let resolved;
    try {
      resolved = resolveSpeakingVoice(speakingOptions(character, h3VoiceMode, model));
    } catch (error) {
      if (typeof error?.code !== 'string') throw error;
      errors.push({ code: error.code, sceneId: scene.id, castId });
      continue;
    }

    if (resolved.voicePath === 'prompt') {
      const voice = {
        mode: 'prompt',
        description: resolved.voice.description,
        seed: resolved.voice.seed,
      };
      for (const asset of plates) asset.gen.direction.voice = { ...voice };
    } else {
      for (const asset of plates) delete asset.gen.direction.voice;
    }
  }

  return { pkg: out, errors };
}
