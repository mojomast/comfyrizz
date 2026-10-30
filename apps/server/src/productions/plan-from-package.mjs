// UR22: a deterministic Easy plan. One action per scene that still needs GPU
// work. Identity of the plan itself stays with the action-plans route; this
// function only describes the actions.
//
// IL has no level-to-actions expansion on this branch, so takes come from
// effectivePolicyForShot(ITERATION_PRESETS[level]). The unit figure is the
// same next-job upper bound /api/run admission uses, priced from the Google
// Colab measured minutes. Nothing here starts a backend.

import { createHash } from 'node:crypto';

import {
  BOOTSTRAP_OVERHEAD_MINUTES,
  MEASURED_JOB_MINUTES,
  PRESENTER_MEASURED_JOB_MINUTES,
} from '../../../../packages/backends/src/colab-backend.mjs';
import { nextJobUpperEstimate, rateForGpu, reserveUnitsFor } from '../../../../packages/backends/src/budget.mjs';
import { fasth3JobMinutes } from '../../../../packages/backends/src/fasth3-profile.mjs';
import { canonicalJson } from './commands.mjs';
import { sceneAssetIds } from '../../../../packages/agent/dist/src/scene-build.js';
import { ITERATION_PRESETS, effectivePolicyForShot } from './iteration.mjs';

// Generators that run without a GPU. The agent search `generator: '` finds
// llm-svg (CPU) and flux3-klein (GPU). Kokoro is a local voice engine, not a
// package generator string in packages/agent/src.
const CPU_GENERATORS = new Set(['llm-svg', 'procedural-audio']);

const GENERATOR_MINUTES = Object.freeze({
  'flux3-klein': MEASURED_JOB_MINUTES.still,
  ltx25: MEASURED_JOB_MINUTES.plate,
  'fasth3-omni': MEASURED_JOB_MINUTES.plate,
  'ltx25-a2v': PRESENTER_MEASURED_JOB_MINUTES,
  kokoro: MEASURED_JOB_MINUTES.audio,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNumber(value) {
  if (Object.is(value, -0)) return 0;
  return Number.isInteger(value) ? value : Number(value.toPrecision(12));
}

function gpuAssetsForScene(pkg, scene) {
  const assets = isPlainObject(pkg?.assets) ? pkg.assets : {};
  const found = [];
  for (const assetId of sceneAssetIds(scene)) {
    const asset = assets[assetId];
    const generator = asset?.gen?.generator;
    if (typeof generator !== 'string' || generator === '' || CPU_GENERATORS.has(generator)) continue;
    found.push({ assetId, gen: asset.gen });
  }
  found.sort((left, right) => left.assetId.localeCompare(right.assetId));
  return found;
}

export function hashFor(sceneId, assets) {
  return createHash('sha256')
    .update(canonicalJson({
      sceneId,
      assets: assets.map((asset) => ({ assetId: asset.assetId, gen: asset.gen })),
    }))
    .digest('hex');
}

function seedFor(hash) {
  return Number.parseInt(hash.slice(0, 8), 16);
}

function upperBoundFor(assets, takes, ratePerHour) {
  const minutes = assets.reduce((total, asset) => {
    const generator = asset.gen?.generator;
    const jobMinutes = generator === 'fasth3-omni'
      ? fasth3JobMinutes({ frames: asset.gen?.inputs?.frames, fps: asset.gen?.inputs?.fps })
      : GENERATOR_MINUTES[generator] ?? 1;
    return total + jobMinutes;
  }, 0) * takes;
  const upper = nextJobUpperEstimate({
    gpuMinutes: minutes,
    overheadMinutes: BOOTSTRAP_OVERHEAD_MINUTES,
    ratePerHour,
  });
  if (typeof upper !== 'number' || !Number.isFinite(upper)) return 0;
  // Run admission compares the whole increment: job upper estimate plus the
  // collect/stop reserve. The approved action slot must cover both.
  return normalizeNumber(upper + reserveUnitsFor(ratePerHour));
}

function takesFor(level, sceneId) {
  const preset = ITERATION_PRESETS[level];
  if (!preset) {
    const error = new Error(`unknown iteration level ${level}`);
    error.status = 400;
    error.code = 'INVALID_LEVEL';
    throw error;
  }
  const video = effectivePolicyForShot(preset, sceneId).stages.video;
  return video.takes * video.rounds;
}

/**
 * Pure Easy plan for one package.
 *
 * @param {{ pkg: object, level: string, compute: string, productionId?: string, revision?: number, onlyShotIds?: string[], chip?: string }} input
 * @returns {{ actions: object[], reservationCeiling: number, requiredDecisions: [], level: string, compute: string }}
 */
export function planFromPackage(input = {}) {
  const pkg = input.pkg;
  const level = input.level;
  const compute = input.compute;
  if (compute !== 'cpu' && compute !== 'colab') {
    const error = new Error('compute must be cpu or colab');
    error.status = 400;
    error.code = 'INVALID_COMPUTE';
    throw error;
  }

  if (compute === 'cpu') {
    return {
      actions: [],
      reservationCeiling: 0,
      requiredDecisions: [],
      level,
      compute,
    };
  }

  const only = Array.isArray(input.onlyShotIds) ? new Set(input.onlyShotIds) : null;
  const onlyAssets = Array.isArray(input.onlyAssetIds) ? new Set(input.onlyAssetIds) : null;
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const ratePerHour = rateForGpu('G4', { env: {} }).ratePerHour;
  const chip = typeof input.chip === 'string' && input.chip !== '' ? input.chip : null;
  const actions = [];
  let reservationCeiling = 0;

  for (const scene of scenes) {
    if (!isPlainObject(scene) || typeof scene.id !== 'string' || scene.id === '') continue;
    if (only && !only.has(scene.id)) continue;
    const assets = gpuAssetsForScene(pkg, scene).filter(asset => !onlyAssets || onlyAssets.has(asset.assetId));
    if (assets.length === 0) continue;
    const takes = takesFor(level, scene.id);
    const effectiveInputHash = hashFor(scene.id, assets);
    const upperBound = upperBoundFor(assets, takes, ratePerHour);
    reservationCeiling = normalizeNumber(reservationCeiling + upperBound);
    actions.push({
      id: `act_${scene.id}`,
      kind: 'shot.generate',
      targetId: scene.id,
      backendId: 'colab',
      takes,
      upperBound,
      assetIds: assets.map(asset => asset.assetId),
      reuse: false,
      effectiveInputHash,
      seed: seedFor(effectiveInputHash),
      ...(chip ? { note: chip } : {}),
    });
  }

  return {
    actions,
    reservationCeiling,
    requiredDecisions: [],
    level,
    compute,
  };
}
