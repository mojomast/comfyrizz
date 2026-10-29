import { createHash } from 'node:crypto';
import { applyGeneratedFilmPresentation, applyProductionIntentToScene } from '../../../packages/agent/dist/src/index.js';
import { applyProceduralFinishingAudio } from './procedural-audio.mjs';

const DEFAULT_NARRATION_VOICE = {
  enabled: true,
  engine: 'kokoro',
  language: 'en-us',
  speed: 0.98,
  voice: 'af_heart',
  chunking: 'paragraph',
};

function hasNarration(pkg) {
  return (pkg?.scenes ?? []).some(scene => typeof scene?.narration === 'string' && scene.narration.trim().length > 0);
}

function hasH3Footage(pkg) {
  const assets = pkg?.assets ?? {};
  return (pkg?.scenes ?? []).some(scene => {
    const ids = [scene?.background?.asset, ...(scene?.media ?? []).map(plate => plate?.asset)];
    return ids.some(id => assets[id]?.gen?.generator === 'fasth3-omni');
  });
}

function readyConfiguredMusic(pkg) {
  const id = pkg?.audio?.music?.asset;
  const asset = typeof id === 'string' ? pkg?.assets?.[id] : null;
  return Boolean(asset && asset.kind === 'audio' && asset.status === 'ready' && typeof asset.file === 'string' && typeof asset.sha256 === 'string');
}

function finishingDirection(pkg, brief) {
  const musicSetting = /\bMusic:\s*([^.!?]+)/i.exec(brief)?.[1]?.trim();
  const directions = [
    pkg?.proposal?.soundtrack,
    ...(pkg?.scenes ?? []).map(scene => scene?.notes),
    ...Object.values(pkg?.assets ?? {}).map(asset => asset?.notes),
    musicSetting || 'warm felt piano, soft bass, gentle bell arpeggio and a restrained brushed pulse instrumental bed',
  ].filter(value => typeof value === 'string' && value.trim());
  return [...new Set(directions.map(value => value.trim()))].join(' | ').slice(0, 4000);
}

/**
 * Deterministic generated-film finishing contract. This runs after model planning
 * and coverage splitting, before a package can be accepted for user approval.
 * It performs no media generation and never overrides wordless/no-text intent.
 */
export function finalizeGeneratedFilmEditorial(pkg, { intent, brief = '', assetsDir, seed = 1 } = {}) {
  if (!intent?.generatedFilm) return { package: pkg, musicAdded: false, narrationEnabled: false, ambienceEnabled: false };
  let next = structuredClone(pkg);
  const scenes = (Array.isArray(next.scenes) ? next.scenes : []).map(scene => applyProductionIntentToScene(scene, intent));
  next.scenes = applyGeneratedFilmPresentation(scenes, intent, next.title ?? 'Untitled film');

  if (intent.silent) {
    next.voice = { enabled: false, engine: 'none' };
    // An explicit empty mix also disables the renderer's legacy audio fallback.
    next.audio = { ambience: { enabled: false } };
    for (const asset of Object.values(next.assets ?? {})) {
      if (asset?.kind === 'video') asset.media = { ...asset.media, audio: 'muted' };
    }
  }

  let narrationEnabled = false;
  if (!intent.wordless && hasNarration(next) && (next.voice?.enabled !== true || next.voice?.engine === 'none' || !next.voice?.engine)) {
    next.voice = { ...DEFAULT_NARRATION_VOICE };
    narrationEnabled = true;
  }

  let ambienceEnabled = false;
  if (!intent.silent && hasH3Footage(next) && next.audio?.ambience === undefined) {
    next.audio = { ...(next.audio ?? {}), ambience: { gain_db: -8 } };
    ambienceEnabled = true;
  }

  let musicAdded = false;
  if (!intent.silent && intent.musicRequested && !readyConfiguredMusic(next) && typeof next.audio?.music?.asset !== 'string') {
    if (!assetsDir) throw new Error('assetsDir is required to finalize requested music');
    const audioIdentity = createHash('sha256').update(`${next.id ?? ''}:${brief}`).digest('hex').slice(0, 12);
    next = applyProceduralFinishingAudio(next, {
      plan: finishingDirection(next, brief),
      assetsDir,
      seed,
      assetId: `a_finishing_${audioIdentity}`,
    }).package;
    next.audio.music.gain_db = -16;
    musicAdded = true;
  }

  return { package: next, musicAdded, narrationEnabled, ambienceEnabled };
}
