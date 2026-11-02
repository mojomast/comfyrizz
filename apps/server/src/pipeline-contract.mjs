import { createHash } from 'node:crypto';
import { plannedModelContribution, MODEL_CONTRIBUTION_MESSAGE } from '../../../packages/jobs/src/model-contribution.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { planJobs } from '../../../packages/jobs/src/index.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { normalizeRenderLocation, remoteRenderDecision } from '../../../packages/backends/src/colab-render-plan.mjs';
import { CHATTERBOX_ENGINE } from '../../../packages/tts/voices.mjs';

export const PIPELINE_VERSION = 1;
export const PIPELINE_STAGES = Object.freeze([
  ['preflight', 'Check project and inputs'],
  ['narration', 'Generate voice and align captions'],
  ['timing', 'Assemble narration and measure timing'],
  ['presenter_inputs', 'Prepare presenter audio'],
  ['media', 'Generate and collect visual media'],
  ['presenter_sync', 'Check and correct presenter timing'],
  ['render', 'Render video'],
  ['verify', 'Verify video and audio'],
  ['export', 'Package editable project'],
].map(([id, label]) => ({ id, label })));

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Plan and worker warning when presenter lip-sync cannot be checked. It never blocks a render. */
export const SYNCNET_SKIP_CODE = 'SYNCNET_UNAVAILABLE';
export const SYNCNET_RUNTIME_SKIP_CODE = 'SYNCNET_SKIPPED';
export const SYNCNET_SKIP_MESSAGE = 'SyncNet is not configured, so presenter lip-sync will not be checked. Talking-head clips can still render, and each clip still needs a Keep or Reject before export.';
export const SYNCNET_SKIP_ACTION = 'Configure COMFYRIZZ_SYNCNET_PYTHON and COMFYRIZZ_SYNCNET_DIR to enable the lip-sync check.';
export const MUSIC_SYNC_SKIP_CODE = 'MUSIC_AUDITION_SYNC_UNSUPPORTED';
export const MUSIC_SYNC_SKIP_MESSAGE = 'Automatic lip-sync diagnostics do not run for music performance background auditions; review synchronization manually.';

export function musicPerformanceScenes(pkg) {
  return (pkg.scenes ?? []).filter(scene => {
    const asset = pkg.assets?.[scene.background?.asset];
    return pkg.audio?.music?.trim && ['fasth3-omni', 'ltx25-a2v'].includes(asset?.gen?.generator) && asset?.gen?.inputs?.audio;
  });
}

/** True when the SyncNet interpreter and the pinned model file are both present. */
export function syncnetConfigured(env = process.env) {
  const python = typeof env?.COMFYRIZZ_SYNCNET_PYTHON === 'string' ? env.COMFYRIZZ_SYNCNET_PYTHON : '';
  const dir = typeof env?.COMFYRIZZ_SYNCNET_DIR === 'string' ? env.COMFYRIZZ_SYNCNET_DIR : '';
  if (!python || !dir) return false;
  return existsSync(python) && existsSync(join(dir, 'syncnet_v2.model'));
}

/** Read-only SyncNet status for Easy Studio. Paths and credentials are not included. */
export function syncnetDiagnostics(env = process.env) {
  if (syncnetConfigured(env)) return { syncnet: { configured: true } };
  return {
    syncnet: {
      configured: false,
      code: SYNCNET_SKIP_CODE,
      message: SYNCNET_SKIP_MESSAGE,
    },
  };
}

export function selectedPresenterScenes(pkg) {
  if (pkg.presenter?.enabled !== true) return [];
  const coverage = pkg.presenter.scenes ?? 'bookends';
  const ids = coverage === 'all' ? pkg.scenes.map(s => s.id) : Array.isArray(coverage) ? coverage : [pkg.scenes[0]?.id, pkg.scenes.at(-1)?.id];
  return pkg.scenes.filter(scene => scene.presenter !== 'off' && ids.includes(scene.id));
}
export function presenterPortrait(pkg) {
  const portrait = pkg.presenter?.portrait;
  return pkg.assets?.[portrait] ? portrait : pkg.cast?.find(member => member.id === portrait)?.ref_asset;
}

export function summarizeJobs(pkg, jobs) {
  const byId = new Map(jobs.map(job => [job.id, job]));
  const scenes = new Map(jobs.map(job => [job.id, new Set(job.scene ? [job.scene] : [])]));
  for (const scene of pkg.scenes) {
    const assets = new Set([scene.background?.asset, scene.presenter_asset, ...(scene.foreground ?? []).map(item => item.asset)]);
    const visit = (id, seen = new Set()) => {
      if (seen.has(id) || !byId.has(id)) return;
      seen.add(id); scenes.get(id).add(scene.id);
      for (const dependency of byId.get(id).deps ?? []) visit(dependency, seen);
    };
    for (const job of jobs) if (assets.has(job.asset)) visit(job.id);
  }
  return jobs.map(job => ({ id: job.id, assetId: job.asset, sceneId: job.scene, sceneIds: [...scenes.get(job.id)], batch: job.batch, dependencies: job.deps, generator: job.generator }));
}

export function pipelineOptions(input = {}) {
  const backendId = input.backendId ?? 'colab';
  if (!['cpu', 'colab', 'byo-comfyui'].includes(backendId)) throw new Error('Unknown pipeline backend');
  const budgetUnits = Number(input.budgetUnits ?? 0);
  if (!Number.isFinite(budgetUnits) || budgetUnits < 0) throw new Error('budgetUnits must be a finite non-negative number');
  const narrationRuntime = input.narrationRuntime ?? (backendId === 'colab' ? 'colab' : 'local');
  if (!['local', 'colab'].includes(narrationRuntime)) throw new Error('Unknown narration runtime');
  if (input.comfyuiUrl) {
    const url = new URL(input.comfyuiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('ComfyUI URL must be HTTP(S) without embedded credentials');
  }
  const narrationUnits = Number(input.narrationUnits ?? Math.min(2, budgetUnits / 2));
  if (!Number.isFinite(narrationUnits) || narrationUnits < 0 || narrationUnits > 4) throw new Error('narrationUnits must be between 0 and 4');
  const renderLocation = normalizeRenderLocation(input.renderLocation);
  return { backendId, budgetUnits, narrationRuntime, narrationUnits, comfyuiUrl: input.comfyuiUrl ?? null, renderLocation };
}

export const NARRATION_WORKER_SCRIPTS = Object.freeze({
  'qwen3-tts': 'qwen_narrate.py',
  [CHATTERBOX_ENGINE]: 'chatterbox_narrate.py',
});

export function narrationWorker(engine) {
  const script = NARRATION_WORKER_SCRIPTS[engine];
  return script ? { engine, script, path: `colab/${script}` } : null;
}

export function remoteNarrationPlan(pkg, { narrationRuntime = 'local' } = {}) {
  const engine = pkg?.voice?.engine ?? null;
  const worker = pkg?.voice?.enabled === true ? narrationWorker(engine) : null;
  const remoteVoice = Boolean(worker && narrationRuntime === 'colab');
  return {
    remoteVoice,
    engine,
    script: remoteVoice ? worker.script : null,
    path: remoteVoice ? worker.path : null,
  };
}

function packageForValidation(pkg) {
  if (pkg?.voice?.engine !== CHATTERBOX_ENGINE) return pkg;
  return { ...pkg, voice: { ...pkg.voice, engine: 'kokoro' } };
}

export function planPipeline(pkg, input = {}, { env = process.env } = {}) {
  const validation = validatePackage(packageForValidation(pkg));
  if (!validation.valid) throw new Error(`Invalid package: ${validation.errors.map(e => e.message).join('; ')}`);
  compileTimeline(pkg); // Reject invalid transitions before allocating narration compute.
  const options = pipelineOptions(input);
  const masterSong = Boolean(pkg.audio?.music?.trim);
  const voiced = !masterSong && pkg.voice?.enabled === true && pkg.voice?.engine !== 'none' && pkg.scenes.some(s => s.narration?.trim());
  const presenters = selectedPresenterScenes(pkg).length > 0;
  const jobs = planJobs(pkg).jobs;
  const finishedAudio = Boolean(
    (pkg.audio?.music && typeof pkg.audio.music === 'object' && pkg.audio.music.enabled !== false && pkg.audio.music.asset)
    || (pkg.audio?.ambience && typeof pkg.audio.ambience === 'object' && pkg.audio.ambience.enabled !== false)
    || (Array.isArray(pkg.audio?.sfx) && pkg.audio.sfx.length > 0)
  );
  const requiresAudio = voiced || finishedAudio || jobs.some(job => job.generator === 'fasth3-omni');
  const narrationRoute = remoteNarrationPlan(pkg, options);
  const remoteVoice = voiced && narrationRoute.remoteVoice;
  const gpuMedia = jobs.length > 0 || presenters;
  const issues = [];
  const warnings = [];
  const issue = (code, message, action) => issues.push({ code, message, action });
  const warn = (code, message, action) => warnings.push({ code, message, action });
  if (!plannedModelContribution(pkg).length) issue('COMFY_MODEL_CONTRIBUTION_REQUIRED', MODEL_CONTRIBUTION_MESSAGE, 'Revise the plan to visibly use one relevant supported ComfyUI-generated plate or still.');
  if (remoteVoice && pkg.voice.engine === 'qwen3-tts' && pkg.voice.strict !== true) issue('STRICT_QWEN_REQUIRED', 'Remote Qwen requires strict voice selection.', 'Set voice.strict to true.');
  if (remoteVoice && options.narrationUnits < 0.5) issue('VOICE_BUDGET_REQUIRED', `A ${pkg.voice.engine === 'qwen3-tts' ? 'Qwen' : 'Chatterbox'} allocation needs at least 0.5 units of headroom.`, 'Increase narrationUnits and the total budget.');
  const mediaUnits = options.budgetUnits - (remoteVoice ? options.narrationUnits : 0);
  if (remoteVoice && mediaUnits < 0) issue('TOTAL_BUDGET_EXCEEDED', 'Voice allocation exceeds the total budget.', 'Increase budgetUnits or reduce narrationUnits.');
  if (gpuMedia && options.backendId === 'cpu') issue('GPU_MEDIA_PENDING', 'This project needs generated media.', 'Select Colab or your ComfyUI backend.');
  if (gpuMedia && options.backendId === 'colab' && mediaUnits <= 0) issue('MEDIA_BUDGET_REQUIRED', 'No budget remains for visual media.', 'Reserve part of budgetUnits for media.');
  if (gpuMedia && options.backendId === 'colab' && !existsSync(env.COMFYRIZZ_HF_TOKEN_FILE ?? '')) issue('HF_TOKEN_UNAVAILABLE', 'The server has no configured model-access token file.', 'Configure COMFYRIZZ_HF_TOKEN_FILE on the server.');
  if (presenters && !voiced) issue('PRESENTER_VOICE_REQUIRED', 'Presenter generation needs measured narration.', 'Enable narration for presenter scenes.');
  if (presenters && selectedPresenterScenes(pkg).some(scene => !scene.narration?.trim())) issue('PRESENTER_SCENE_SILENT', 'A selected presenter scene has no narration.', 'Add narration or turn the presenter off for that scene.');
  if (presenters && !pkg.assets?.[presenterPortrait(pkg)]) issue('PRESENTER_PORTRAIT_REQUIRED', 'The presenter has no portrait asset.', 'Choose a portrait.');
  if (presenters && !syncnetConfigured(env)) {
    warn(SYNCNET_SKIP_CODE, SYNCNET_SKIP_MESSAGE, SYNCNET_SKIP_ACTION);
  }
  if (musicPerformanceScenes(pkg).length) {
    warn(MUSIC_SYNC_SKIP_CODE, MUSIC_SYNC_SKIP_MESSAGE, 'Review the audition against the master song before use.');
  }
  const remote = remoteRenderDecision({ renderLocation: options.renderLocation, backendId: options.backendId, gpuMedia });
  if (remote.issue) issue(remote.issue.code, remote.issue.message, remote.issue.action);
  const stages = PIPELINE_STAGES.map(stage => ({ ...stage, status: 'pending', progress: null }));
  const requiresApproval = remoteVoice || (gpuMedia && options.backendId === 'colab');
  const estimateNote = remote.remoteRender
    ? 'Allocation ceilings, not predicted charges. Media admission is re-estimated after measured narration. The Google Colab VM stays allocated through the final render and verification, then stops.'
    : 'Allocation ceilings, not predicted charges. Media admission is re-estimated after measured narration.';
  return {
    version: PIPELINE_VERSION, packageId: pkg.id, baseRevision: pkg.revision,
    inputHash: fingerprint(pkg), planHash: fingerprint({ pkg, options }), options,
    stages, voiced, requiresAudio, presenters, remoteVoice, narrationWorker: remoteVoice ? { engine: narrationRoute.engine, script: narrationRoute.script, path: narrationRoute.path } : null, gpuMedia, remoteRender: remote.remoteRender, remoteRenderNote: remote.note,
    jobs: summarizeJobs(pkg, jobs),
    reusableAssets: Object.entries(pkg.assets ?? {}).filter(([, asset]) => asset.file && ['ready', 'candidate'].includes(asset.status)).map(([assetId, asset]) => ({ assetId, kind: asset.kind, status: asset.status, verification: 'checked_when_staging' })),
    budget: { ceilingUnits: options.budgetUnits, narrationCeilingUnits: remoteVoice ? options.narrationUnits : 0, mediaCeilingUnits: options.backendId === 'colab' && gpuMedia ? Math.max(0, mediaUnits) : 0, estimateUnits: null, estimateNote },
    requiresApproval, issues, warnings, ready: issues.length === 0,
  };
}
