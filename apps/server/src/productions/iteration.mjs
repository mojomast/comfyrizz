// IL01: the iteration policy contract.
//
// The policy is the user's creative-iteration budget: how many script,
// voice, keyframe and video candidates a production may explore, how many
// rounds it may take, whether the next take is picked automatically or asks
// the user, and how deeply a take is reviewed.
//
// This module is pure data and pure functions. It has no filesystem, network,
// clock or randomness, and it never approves a spend. The server owns the
// policy revision and the command that sets it (IL02+); this contract only
// says what a valid policy is.
//
// A level is always derived from the policy content. Copying a preset verbatim
// derives that preset's level; editing any field, or adding a per-shot
// override, derives `custom`. The declared `level` is still validated as one of
// the four exact names, so a friendly alias can never become a second spelling
// of a level.

export const ITERATION_POLICY_SCHEMA = 'comfyrizz.iteration-policy/v1';

export const ITERATION_LEVELS = Object.freeze(['draft', 'balanced', 'director', 'custom']);
export const ITERATION_STAGES = Object.freeze(['script', 'voice', 'keyframe', 'video']);
export const ITERATION_PICKS = Object.freeze(['auto', 'ask']);
export const ITERATION_REVIEW_DEPTHS = Object.freeze(['light', 'standard', 'deep']);

// D4: the per-round, per-round-count and per-asset take limits. The same
// numbers bound every stage so one level cannot hide an unlimited stage.
export const MAX_TAKES_PER_ROUND = 4;
export const MAX_ROUNDS = 3;
export const MAX_TAKES_PER_ASSET = 12;
export const MAX_AUDITIONS = 4;

const ROOT_KEYS = new Set(['level', 'stages', 'reviewDepth', 'shotOverrides']);
const REQUIRED_ROOT_KEYS = Object.freeze(['level', 'stages', 'reviewDepth']);
const STAGE_KEYS = new Set(['takes', 'rounds', 'auditions', 'pick']);
const REQUIRED_STAGE_KEYS = Object.freeze(['takes', 'rounds', 'auditions', 'pick']);
const OVERRIDE_KEYS = new Set(['stages']);
const STAGE_NAMES = new Set(ITERATION_STAGES);

// Auditions are candidate voices (free local Kokoro auditions are not counted)
// and keyframe stills. Script alternatives are takes because drafts are free;
// a video slot has takes, not auditions.
const AUDITION_STAGES = new Set(['voice', 'keyframe']);

const SHOT_ID_RE = /^[^\s/\\\u0000-\u001f\u007f]+$/u;
const MAX_SHOT_ID_CHARS = 256;

export class IterationPolicyError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'IterationPolicyError';
    this.code = code;
    this.field = field;
    this.status = 400;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new IterationPolicyError(code, field, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stage(takes, rounds, auditions, pick) {
  return Object.freeze({ takes, rounds, auditions, pick });
}

function preset(level, stages, reviewDepth) {
  return deepFreeze({
    level,
    stages,
    reviewDepth,
    shotOverrides: Object.freeze({}),
  });
}

// PLAN 2.2. Balanced asks for hero shots through the video stage's pick; a
// hero is a video take, not a separate level or a second policy shape.
// Balanced's script is one draft plus a user-driven revision on request, so
// the revision is not a pre-generated take. Director offers two alternatives.
export const ITERATION_PRESETS = Object.freeze({
  draft: preset('draft', {
    script: stage(1, 1, 0, 'auto'),
    voice: stage(1, 1, 0, 'auto'),
    keyframe: stage(1, 1, 0, 'auto'),
    video: stage(1, 1, 0, 'auto'),
  }, 'light'),

  balanced: preset('balanced', {
    script: stage(1, 1, 0, 'auto'),
    voice: stage(1, 1, 2, 'auto'),
    keyframe: stage(1, 1, 2, 'auto'),
    video: stage(2, 1, 0, 'ask'),
  }, 'standard'),

  director: preset('director', {
    script: stage(2, 1, 0, 'ask'),
    voice: stage(1, 1, 3, 'ask'),
    keyframe: stage(1, 1, 3, 'ask'),
    video: stage(3, 2, 0, 'ask'),
  }, 'deep'),
});

function requireRecord(value, field, code = 'ITERATION_POLICY_INVALID') {
  if (!isPlainObject(value)) fail(code, field, `${field} must be an object`);
  return value;
}

function assertClosed(record, allowed, path) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail('ITERATION_POLICY_INVALID', `${path}.${key}`, `${path}.${key} is not a recognized field`);
    }
  }
}

function levelValue(value) {
  if (typeof value !== 'string' || !ITERATION_LEVELS.includes(value)) {
    fail('ITERATION_LEVEL_INVALID', 'level', `level must be one of ${ITERATION_LEVELS.join(', ')}`);
  }
  return value;
}

function integerField(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('ITERATION_POLICY_INVALID', field, `${field} must be an integer`);
  }
  if (value < min) {
    fail('ITERATION_POLICY_INVALID', field, `${field} must be at least ${min}`);
  }
  if (value > max) {
    fail('ITERATION_EXCEEDED', field, `${field} must be at most ${max}`);
  }
  return value;
}

function pickValue(value, field) {
  if (!ITERATION_PICKS.includes(value)) {
    fail('ITERATION_POLICY_INVALID', field, `${field} must be one of ${ITERATION_PICKS.join(', ')}`);
  }
  return value;
}

function reviewDepthValue(value, field) {
  if (!ITERATION_REVIEW_DEPTHS.includes(value)) {
    fail('ITERATION_POLICY_INVALID', field, `${field} must be one of ${ITERATION_REVIEW_DEPTHS.join(', ')}`);
  }
  return value;
}

function assertAuditionStage(name, path) {
  if (!AUDITION_STAGES.has(name)) {
    fail('ITERATION_POLICY_INVALID', `${path}.auditions`, `${path}.auditions is only available for voice and keyframe`);
  }
}

function normalizedStage(raw, path, name) {
  const record = requireRecord(raw, path);
  assertClosed(record, STAGE_KEYS, path);
  for (const key of REQUIRED_STAGE_KEYS) {
    if (!Object.hasOwn(record, key)) fail('ITERATION_POLICY_INVALID', `${path}.${key}`, `${path}.${key} is required`);
  }

  const takes = integerField(record.takes, `${path}.takes`, 1, MAX_TAKES_PER_ROUND);
  const rounds = integerField(record.rounds, `${path}.rounds`, 1, MAX_ROUNDS);
  const auditions = integerField(record.auditions, `${path}.auditions`, 0, MAX_AUDITIONS);
  if (auditions !== 0) assertAuditionStage(name, path);
  const pick = pickValue(record.pick, `${path}.pick`);

  if (takes * rounds > MAX_TAKES_PER_ASSET) {
    fail(
      'ITERATION_EXCEEDED',
      `${path}.takes`,
      `${path} may generate at most ${MAX_TAKES_PER_ASSET} takes per asset`,
    );
  }

  return { takes, rounds, auditions, pick };
}

function normalizedOverrideStage(raw, path, name) {
  const record = requireRecord(raw, path);
  assertClosed(record, STAGE_KEYS, path);

  const out = {};
  if (Object.hasOwn(record, 'takes')) {
    out.takes = integerField(record.takes, `${path}.takes`, 1, MAX_TAKES_PER_ROUND);
  }
  if (Object.hasOwn(record, 'rounds')) {
    out.rounds = integerField(record.rounds, `${path}.rounds`, 1, MAX_ROUNDS);
  }
  if (Object.hasOwn(record, 'auditions')) {
    out.auditions = integerField(record.auditions, `${path}.auditions`, 0, MAX_AUDITIONS);
    if (out.auditions !== 0) assertAuditionStage(name, path);
  }
  if (Object.hasOwn(record, 'pick')) {
    out.pick = pickValue(record.pick, `${path}.pick`);
  }
  if (out.takes !== undefined && out.rounds !== undefined && out.takes * out.rounds > MAX_TAKES_PER_ASSET) {
    fail(
      'ITERATION_EXCEEDED',
      `${path}.takes`,
      `${path} may generate at most ${MAX_TAKES_PER_ASSET} takes per asset`,
    );
  }
  return out;
}

function shotIdValue(value, field) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_SHOT_ID_CHARS
    || !SHOT_ID_RE.test(value)
  ) {
    fail('ITERATION_POLICY_INVALID', field, `${field} must be a shot identifier`);
  }
  return value;
}

function normalizedOverrides(raw) {
  if (raw === undefined) return {};

  const record = requireRecord(raw, 'shotOverrides');
  const entries = [];
  for (const [shotId, value] of Object.entries(record)) {
    const path = `shotOverrides.${shotId}`;
    shotIdValue(shotId, `shotOverrides.${shotId}`);

    const override = requireRecord(value, path);
    assertClosed(override, OVERRIDE_KEYS, path);

    const rawStages = override.stages === undefined
      ? {}
      : requireRecord(override.stages, `${path}.stages`);
    const overrideStages = {};
    for (const [name, rawStage] of Object.entries(rawStages)) {
      if (!STAGE_NAMES.has(name)) {
        fail('ITERATION_POLICY_INVALID', `${path}.stages.${name}`, `${path}.stages.${name} is not a recognized stage`);
      }
      overrideStages[name] = normalizedOverrideStage(rawStage, `${path}.stages.${name}`, name);
    }
    entries.push([shotId, { stages: overrideStages }]);
  }
  return Object.fromEntries(entries);
}

function normalizedPolicy(raw) {
  const record = requireRecord(raw, 'policy');
  assertClosed(record, ROOT_KEYS, 'policy');
  for (const key of REQUIRED_ROOT_KEYS) {
    if (!Object.hasOwn(record, key)) fail('ITERATION_POLICY_INVALID', `policy.${key}`, `policy.${key} is required`);
  }

  levelValue(record.level);

  const rawStages = requireRecord(record.stages, 'policy.stages');
  assertClosed(rawStages, STAGE_NAMES, 'policy.stages');
  const stages = {};
  for (const name of ITERATION_STAGES) {
    if (!Object.hasOwn(rawStages, name)) {
      fail('ITERATION_POLICY_INVALID', `policy.stages.${name}`, `policy.stages.${name} is required`);
    }
    stages[name] = normalizedStage(rawStages[name], `policy.stages.${name}`, name);
  }

  const reviewDepth = reviewDepthValue(record.reviewDepth, 'policy.reviewDepth');
  const shotOverrides = normalizedOverrides(record.shotOverrides);

  return { stages, reviewDepth, shotOverrides };
}

function sameStages(left, right) {
  for (const name of ITERATION_STAGES) {
    for (const field of REQUIRED_STAGE_KEYS) {
      if (left[name][field] !== right[name][field]) return false;
    }
  }
  return true;
}

function levelFor(policy) {
  // An override is an edit, so the policy is not an exact preset any more.
  if (Object.keys(policy.shotOverrides).length !== 0) return 'custom';

  for (const level of ['draft', 'balanced', 'director']) {
    const candidate = ITERATION_PRESETS[level];
    if (candidate.reviewDepth !== policy.reviewDepth) continue;
    if (sameStages(policy.stages, candidate.stages)) return level;
  }
  return 'custom';
}

/**
 * Validate one iteration policy and return a frozen normalized copy.
 *
 * The returned `level` is derived, never the caller's claim. Unknown keys,
 * alias level names, incomplete stages and out-of-range values are refused.
 * Exceeding a D4 limit is `ITERATION_EXCEEDED`; every other defect is
 * `ITERATION_POLICY_INVALID`; a bad level name is `ITERATION_LEVEL_INVALID`.
 *
 * @param {unknown} raw
 * @returns {Readonly<{level: string, stages: object, reviewDepth: string, shotOverrides: object}>}
 */
export function validateIterationPolicy(raw) {
  const policy = normalizedPolicy(raw);
  return deepFreeze({
    level: levelFor(policy),
    stages: policy.stages,
    reviewDepth: policy.reviewDepth,
    shotOverrides: policy.shotOverrides,
  });
}

/**
 * Derive the level from the policy content. A verbatim preset is that level;
 * anything else, including a non-empty shotOverrides map, is `custom`.
 *
 * @param {unknown} raw
 * @returns {'draft'|'balanced'|'director'|'custom'}
 */
export function deriveLevel(raw) {
  return levelFor(normalizedPolicy(raw));
}

/**
 * Resolve the policy for one shot. A matching `shotOverrides` entry merges
 * field by field over the base stages, so an override may change one video
 * take count without restating the rest of the stage. The returned level is
 * the policy's derived level; an override never changes the review depth.
 *
 * @param {unknown} raw
 * @param {string} shotId
 * @returns {Readonly<{level: string, stages: object, reviewDepth: string}>}
 */
export function effectivePolicyForShot(raw, shotId) {
  const policy = normalizedPolicy(raw);
  const id = shotIdValue(shotId, 'shotId');
  const override = Object.hasOwn(policy.shotOverrides, id) ? policy.shotOverrides[id] : undefined;

  const stages = {};
  for (const name of ITERATION_STAGES) {
    const merged = override && Object.hasOwn(override.stages, name)
      ? { ...policy.stages[name], ...override.stages[name] }
      : policy.stages[name];
    stages[name] = normalizedStage(merged, `stages.${name}`, name);
  }

  return deepFreeze({
    level: levelFor(policy),
    stages,
    reviewDepth: policy.reviewDepth,
  });
}
