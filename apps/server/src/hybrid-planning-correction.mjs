// Opt-in hybrid planning correction helpers. Production defaults do not load
// this path: POST /api/agent ignores planningCorrection unless the env flag is
// exactly "1". The module never starts a run, pipeline, or media job.
export const HYBRID_PLANNING_CORRECTION_ENV = 'COMFYRIZZ_HYBRID_PLANNING_CORRECTION';

export const HYBRID_CORRECTION_SYSTEM = [
  'You are Comfyrizz performing one bounded planning correction of an existing package. The package is already loaded.',
  'Hard rules: do not call storyboard.propose, rebuild the storyboard, replace the package id, or start production, a run, a pipeline, or media generation.',
  'Edit only the listed failure codes. Preserve unrelated scene ids, asset ids, previously passing requirements, and out-of-scope creative choices.',
  'If the listed failures cannot be fixed without a global replan, stop without editing.',
  'When the listed issues are fixed, stop calling tools and reply with one short sentence.',
].join('\n');

export const BOUNDED_FAILURE_CODES = new Set([
  'HEADLINE_MISSING',
  'NARRATION_MISSING',
  'NARRATION_FORBIDDEN',
  'CUE_PHRASE_INVALID',
  'DURATION_OUT_OF_RANGE',
  'SVG_FLOOR',
  'PENDING_STILL',
  'LAYOUT_MISSING',
  'DATASET_MISMATCH',
  'SHARED_MASCOT',
  'OPENING_TITLE',
  'SCENE_MEDIA_MISSING',
  'FORMAT_MISMATCH',
  'SOURCE_ASPECT',
  'PRESERVE_NUMBERS',
  'LIST_ITEMS',
  'COPY_FORBIDDEN',
  'LIVE_ACTION_HUMANS',
  'REMOTION_OPENER',
  'REMOTION_OUTRO',
  'MEDIA_ROUTE',
  'QUALITY_OTHER',
]);

export const GLOBAL_REPLAN_CODES = new Set([
  'SCHEMA_INVALID',
  'FALLBACK',
  'SCENE_COUNT',
  'NEEDS_GLOBAL_REPLAN',
  'COMPLETION_UNBOUNDED',
]);

export const SKIP_CORRECTION_CODES = new Set([
  'INFRASTRUCTURE',
  'NOT_LIVE',
  'PROVIDER_MISMATCH',
  'VOICE_ENABLE',
  'EXPECTED_REFUSAL',
]);

export const MAX_BOUNDED_FAILURES = 8;

export const FORBIDDEN_CORRECTION_TOOLS = new Set(['storyboard.propose']);

export const HARD_GENERATION_TOOLS = new Set([
  'clip_propose_correction',
  'clip_propose_finishing_audio',
  'project_build',
  'production.start',
  'pipeline.start',
]);

export const HARD_GENERATION_PATHS = ['/api/run', '/api/pipeline'];

export function hybridPlanningCorrectionEnabled(env = process.env) {
  return env[HYBRID_PLANNING_CORRECTION_ENV] === '1';
}

export function emptyUsage() {
  return { input: 0, output: 0, total: 0 };
}

export function addUsage(target, usage) {
  const input = Number(usage?.input) || 0;
  const output = Number(usage?.output) || 0;
  target.input += input;
  target.output += output;
  target.total = target.input + target.output;
  return target;
}

export function phaseUsageBundle() {
  return {
    initial: emptyUsage(),
    repair: emptyUsage(),
    correction: emptyUsage(),
  };
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeCorrectionFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    const error = new Error('planningCorrection.failures must be a non-empty array');
    error.status = 400;
    error.code = 'HYBRID_CORRECTION_INVALID';
    throw error;
  }
  return failures.slice(0, 12).map(item => {
    const code = text(item?.code, 64);
    const detail = text(item?.detail, 500);
    if (!code || !detail) {
      const error = new Error('each planningCorrection failure needs a code and detail');
      error.status = 400;
      error.code = 'HYBRID_CORRECTION_INVALID';
      throw error;
    }
    const out = { code, detail };
    const sceneId = text(item?.sceneId, 64);
    const assetId = text(item?.assetId, 64);
    if (sceneId) out.sceneId = sceneId;
    if (assetId) out.assetId = assetId;
    return out;
  });
}

/** HTTP gate. Missing field is a no-op. Present field is rejected unless the env flag is set. */
export function readPlanningCorrection(body, env = process.env) {
  if (!body || body.planningCorrection == null) return { value: null };
  if (!hybridPlanningCorrectionEnabled(env)) {
    return {
      status: 400,
      error: 'hybrid planning correction is disabled',
      code: 'HYBRID_CORRECTION_DISABLED',
    };
  }
  const raw = body.planningCorrection;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 400, error: 'planningCorrection must be an object', code: 'HYBRID_CORRECTION_INVALID' };
  }
  const packageId = text(raw.packageId, 128);
  if (!packageId) {
    return { status: 400, error: 'planningCorrection.packageId is required', code: 'HYBRID_CORRECTION_INVALID' };
  }
  try {
    return {
      value: {
        packageId,
        failures: normalizeCorrectionFailures(raw.failures),
      },
    };
  } catch (error) {
    return { status: error.status ?? 400, error: error.message, code: error.code ?? 'HYBRID_CORRECTION_INVALID' };
  }
}

export function extractPackageContext(pkg) {
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const assets = pkg?.assets && typeof pkg.assets === 'object' ? pkg.assets : {};
  return {
    packageId: typeof pkg?.id === 'string' ? pkg.id : null,
    sceneCount: scenes.length,
    format: {
      width: Number(pkg?.format?.width) || null,
      height: Number(pkg?.format?.height) || null,
      fps: Number(pkg?.format?.fps) || null,
    },
    scenes: scenes.map(scene => ({
      id: typeof scene?.id === 'string' ? scene.id : null,
      layout: typeof scene?.layout === 'string' ? scene.layout : null,
      variant: typeof scene?.variant === 'string' ? scene.variant : null,
      preferredFrames: Number(scene?.preferredFrames) || 0,
      hasNarration: typeof scene?.narration === 'string' && scene.narration.trim().length > 0,
      cueCount: Array.isArray(scene?.motion?.cue_phrases) ? scene.motion.cue_phrases.length : 0,
      mediaAssetIds: (Array.isArray(scene?.media) ? scene.media : [])
        .map(plate => plate?.asset)
        .filter(id => typeof id === 'string'),
      headlinePresent: typeof scene?.copy?.headline === 'string' && scene.copy.headline.trim().length > 0,
    })),
    assets: Object.entries(assets).map(([id, asset]) => ({
      id,
      kind: typeof asset?.kind === 'string' ? asset.kind : null,
      generator: typeof asset?.gen?.generator === 'string' ? asset.gen.generator : null,
      status: typeof asset?.status === 'string' ? asset.status : null,
    })),
  };
}

export function immutableIds(context) {
  return {
    packageId: context.packageId,
    sceneIds: context.scenes.map(scene => scene.id).filter(Boolean),
    assetIds: context.assets.map(asset => asset.id).filter(Boolean),
  };
}

const CORRECTION_TEMPLATE_HEADER = [
  'PLANNING CORRECTION (one bounded edit; thinking enabled)',
  'This prompt is machine-generated. It contains only the original brief, objective failure codes, relevant package context, immutable IDs, and the allowed-edit scope.',
  'Do not start production, a run, a pipeline, or media generation.',
  'Do not call storyboard.propose. If a global replan is required, stop without editing.',
].join('\n');

/** Fixed machine-generated user prompt. Callers must not append creative instructions. */
export function buildCorrectionPrompt({ brief, failures, context }) {
  const ids = immutableIds(context);
  const allowedScenes = [...new Set(failures.map(item => item.sceneId).filter(Boolean))];
  const allowedAssets = [...new Set(failures.map(item => item.assetId).filter(Boolean))];
  const failureLines = failures.map(item => {
    const where = [item.sceneId && `scene=${item.sceneId}`, item.assetId && `asset=${item.assetId}`].filter(Boolean).join(' ');
    return `- ${item.code}: ${item.detail}${where ? ` (${where})` : ''}`;
  });
  const sceneLines = context.scenes.map(scene => (
    `- scene ${scene.id}: layout=${scene.layout ?? 'none'} variant=${scene.variant ?? 'none'} frames=${scene.preferredFrames} narration=${scene.hasNarration ? 'yes' : 'no'} cues=${scene.cueCount} media=${scene.mediaAssetIds.join(',') || 'none'} headline=${scene.headlinePresent ? 'yes' : 'no'}`
  ));
  const assetLines = context.assets.map(asset => (
    `- asset ${asset.id}: kind=${asset.kind ?? 'none'} generator=${asset.generator ?? 'none'} status=${asset.status ?? 'none'}`
  ));
  return [
    CORRECTION_TEMPLATE_HEADER,
    '',
    'Original brief:',
    String(brief ?? '').trim(),
    '',
    'Objective failure codes/details:',
    failureLines.join('\n') || '- none',
    '',
    'Relevant package/scene/asset context:',
    `- packageId: ${context.packageId ?? 'missing'}`,
    `- sceneCount: ${context.sceneCount}`,
    `- format: ${context.format.width ?? '?'}x${context.format.height ?? '?'} @ ${context.format.fps ?? '?'}fps`,
    ...sceneLines,
    ...assetLines,
    '',
    'Immutable IDs (must preserve):',
    `- package id: ${ids.packageId ?? 'missing'}`,
    `- unrelated scene ids: ${ids.sceneIds.join(', ') || 'none'}`,
    `- unrelated asset ids: ${ids.assetIds.join(', ') || 'none'}`,
    '',
    'Explicit allowed-edit scope:',
    `- only these failure codes: ${failures.map(item => item.code).join(', ')}`,
    `- scene ids that may be edited: ${allowedScenes.join(', ') || 'none named; edit only what the codes require'}`,
    `- asset ids that may be edited: ${allowedAssets.join(', ') || 'none named; edit only what the codes require'}`,
    '- preserve previously passing requirements',
    '- preserve out-of-scope creative choices',
    '- preserve package id and unrelated scene/asset ids',
  ].join('\n');
}

export function decideCorrectionAction({ expect, infrastructure, failures }) {
  if (infrastructure) return { action: 'skip', reason: 'infrastructure' };
  if (expect === 'refusal') return { action: 'skip', reason: 'expected_refusal' };
  const codes = failures.map(item => item.code);
  if (codes.some(code => SKIP_CORRECTION_CODES.has(code))) {
    return { action: 'skip', reason: 'not_a_quality_trigger' };
  }
  if (failures.length === 0) return { action: 'skip', reason: 'all_passed' };
  if (codes.some(code => GLOBAL_REPLAN_CODES.has(code)) || failures.length > MAX_BOUNDED_FAILURES) {
    return { action: 'global_replan', reason: 'unbounded' };
  }
  if (failures.every(item => BOUNDED_FAILURE_CODES.has(item.code))) {
    return { action: 'correct', reason: 'bounded' };
  }
  return { action: 'global_replan', reason: 'unclassified' };
}

export function correctionInvokedGeneration(events, path = '') {
  const names = (Array.isArray(events) ? events : [])
    .map(event => event?.name)
    .filter(name => typeof name === 'string');
  const toolHit = names.find(name => HARD_GENERATION_TOOLS.has(name));
  if (toolHit) return { hit: true, kind: 'tool', name: toolHit };
  const normalized = String(path ?? '').split('?')[0];
  if (HARD_GENERATION_PATHS.includes(normalized)) return { hit: true, kind: 'path', name: normalized };
  return { hit: false, kind: null, name: null };
}

export function correctionCalledPropose(events) {
  return (Array.isArray(events) ? events : []).some(event => event?.name === 'storyboard.propose');
}
