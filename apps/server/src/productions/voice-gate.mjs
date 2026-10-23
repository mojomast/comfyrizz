/**
 * VX15: the prompt-voice dispatch gate.
 *
 * Pure module: no I/O, no clock and no side effects at import. A FastH3 Omni
 * plate whose direction voice is `mode: 'prompt'` belongs to the scene that
 * names it. That scene's `speaker` is a package cast id, which resolves through
 * the project's character map to the character voice record. The plate is safe
 * only when the character's approved audition still pins the current
 * seed+description identity; anything else fails closed.
 *
 * The gate never approves an audition, never runs one and never spends.
 */

import { promptVoiceAuditionStatus } from '../characters/audition.mjs';

const VOICE_AUDITION_REQUIRED = 'VOICE_AUDITION_REQUIRED';
const VOICE_AUDITION_STALE = 'VOICE_AUDITION_STALE';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniquePush(list, value) {
  if (typeof value === 'string' && value !== '' && !list.includes(value)) list.push(value);
}

// The same scene -> plate link the VX13 direction pass uses: a scene names its
// plates through a background, a foreground layer, a media layer or narration.
// No ownership is guessed.
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

function characterFor(characters, castId) {
  if (characters instanceof Map) return characters.get(castId);
  if (isObject(characters)) return characters[castId];
  return undefined;
}

function statusFor(characterId, voice) {
  return promptVoiceAuditionStatus({ characterId, voice });
}

/**
 * Gate every FastH3 Omni prompt-mode plate in one package.
 *
 * @param {{ pkg?: object, characters?: Map|object }} input
 * @returns {{ blocked: Array<{assetId: string, castId: string|null, characterId: string|null, code: string}>, ok: boolean }}
 */
export function promptVoiceGate({ pkg, characters } = {}) {
  const blocked = [];
  const assets = isObject(pkg?.assets) ? pkg.assets : {};
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];

  for (const [assetId, asset] of Object.entries(assets)) {
    if (!isObject(asset) || !isObject(asset.gen)) continue;
    if (asset.gen.generator !== 'fasth3-omni') continue;
    const directed = asset.gen.direction;
    if (!isObject(directed) || !isObject(directed.voice)) continue;
    if (directed.voice.mode !== 'prompt') continue;

    const speakingScenes = scenes.filter((scene) => isObject(scene)
      && sceneAssetIds(scene).includes(assetId));

    // No scene names this plate: its speaking character is unknown, so the
    // plate cannot be dispatched.
    if (speakingScenes.length === 0) {
      blocked.push({
        assetId,
        castId: null,
        characterId: null,
        code: VOICE_AUDITION_REQUIRED,
      });
      continue;
    }

    let block = null;
    for (const scene of speakingScenes) {
      const castId = typeof scene.speaker === 'string' && scene.speaker !== ''
        ? scene.speaker
        : null;
      if (castId === null) {
        block ??= {
          assetId,
          castId: null,
          characterId: null,
          code: VOICE_AUDITION_REQUIRED,
        };
        continue;
      }

      const character = characterFor(characters, castId);
      if (!isObject(character)) {
        block ??= {
          assetId,
          castId,
          characterId: null,
          code: VOICE_AUDITION_REQUIRED,
        };
        continue;
      }

      const characterId = typeof character.id === 'string' && character.id !== ''
        ? character.id
        : null;
      if (!isObject(character.voice)) {
        block ??= {
          assetId,
          castId,
          characterId,
          code: VOICE_AUDITION_REQUIRED,
        };
        continue;
      }

      let status;
      try {
        status = statusFor(characterId ?? castId, character.voice);
      } catch {
        // A voice without a usable prompt identity has nothing an approval
        // could match; refuse rather than guessing a seed or description.
        block ??= {
          assetId,
          castId,
          characterId,
          code: VOICE_AUDITION_REQUIRED,
        };
        continue;
      }

      if (status.approved) continue;
      block ??= {
        assetId,
        castId,
        characterId,
        code: status.state === 'stale' ? VOICE_AUDITION_STALE : VOICE_AUDITION_REQUIRED,
      };
    }

    if (block) blocked.push(block);
  }

  return { blocked, ok: blocked.length === 0 };
}
