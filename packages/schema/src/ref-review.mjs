// RW00: Reference Watch contracts. These are pure validators with no I/O, so every RW task shares one shape.
// A still that a video job uses as its keyframe is reviewed (Pi judge or T0 checks) before the LTX stage.
// Spec: docs/tasks/RW00_CONTRACTS.md.

export const REF_REVIEW_REQUEST_SCHEMA = 'comfyrizz.ref-review.request/v1';
export const REF_VERDICT_SCHEMA = 'comfyrizz.ref-review.verdict/v1';
export const REF_DECISION_SCHEMA = 'comfyrizz.ref-review.decision/v1';

export const REF_DIMENSIONS = Object.freeze(['technical', 'identity', 'anatomy', 'framing', 'prompt', 'text_artifact']);
export const REF_SEVERITIES = Object.freeze(['hard', 'soft']);
export const REF_REVIEWERS = Object.freeze(['t0', 'pi', 'fake']);
export const REF_OVERALL = Object.freeze(['pass', 'fail', 'error']);
export const REF_ACTIONS = Object.freeze(['accept', 'reprompt', 'replace_ref', 'escalate', 'override']);
export const REF_GATE_STATES = Object.freeze(['pending', 'reviewing', 'accepted', 'regenerating', 'held', 'overridden']);
export const REF_EVENTS = Object.freeze([
  'ref_review_started', 'ref_review_verdict', 'ref_review_error',
  'ref_regen_queued', 'ref_gate_open', 'ref_gate_held',
]);

/** Kyle-approved caps (2026-10-30). */
export const REF_POLICY_DEFAULTS = Object.freeze({ maxRegensPerStill: 2, maxRegenJobs: 6, maxRegenFraction: 0.25 });

const SHA = /^[a-f0-9]{64}$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v.length > 0;
const isPosInt = v => Number.isSafeInteger(v) && v > 0;
const relPath = v => isStr(v) && !v.startsWith('/') && !/^[a-zA-Z]:/.test(v) && !v.split(/[\\/]/).some(p => p === '..' || p === '');

function result(errors) { return { ok: errors.length === 0, errors }; }
function need(errors, cond, msg) { if (!cond) errors.push(msg); }

export function validateRefReviewRequest(r) {
  const e = [];
  if (!isObj(r)) return result(['request must be an object']);
  need(e, r.schema === REF_REVIEW_REQUEST_SCHEMA, `schema must be ${REF_REVIEW_REQUEST_SCHEMA}`);
  for (const k of ['productionId', 'runId', 'jobId', 'shotId', 'prompt']) need(e, isStr(r[k]), `${k} must be a non-empty string`);
  need(e, SHA.test(r.keyframeSha256 ?? ''), 'keyframeSha256 must be 64 lowercase hex');
  need(e, relPath(r.imagePath), 'imagePath must be a relative path without ..');
  for (const k of ['width', 'height', 'plannedWidth', 'plannedHeight']) need(e, isPosInt(r[k]), `${k} must be a positive integer`);
  need(e, Number.isSafeInteger(r.attempt) && r.attempt >= 0 && r.attempt <= REF_POLICY_DEFAULTS.maxRegensPerStill, 'attempt must be an integer 0..maxRegensPerStill');
  need(e, Array.isArray(r.characters), 'characters must be an array');
  for (const [i, c] of (Array.isArray(r.characters) ? r.characters : []).entries()) {
    need(e, isObj(c) && isStr(c.characterId) && isStr(c.identityLock), `characters[${i}] needs characterId and identityLock`);
    if (isObj(c) && c.wardrobeState !== undefined) need(e, isStr(c.wardrobeState), `characters[${i}].wardrobeState must be a non-empty string`);
  }
  return result(e);
}

export function validateRefVerdict(v) {
  const e = [];
  if (!isObj(v)) return result(['verdict must be an object']);
  need(e, v.schema === REF_VERDICT_SCHEMA, `schema must be ${REF_VERDICT_SCHEMA}`);
  need(e, isStr(v.jobId), 'jobId must be a non-empty string');
  need(e, SHA.test(v.keyframeSha256 ?? ''), 'keyframeSha256 must be 64 lowercase hex');
  need(e, REF_REVIEWERS.includes(v.reviewer), `reviewer must be one of ${REF_REVIEWERS.join('|')}`);
  need(e, REF_OVERALL.includes(v.overall), `overall must be one of ${REF_OVERALL.join('|')}`);
  need(e, Array.isArray(v.checks), 'checks must be an array');
  const checks = Array.isArray(v.checks) ? v.checks : [];
  for (const [i, c] of checks.entries()) {
    if (!isObj(c)) { e.push(`checks[${i}] must be an object`); continue; }
    need(e, REF_DIMENSIONS.includes(c.dimension), `checks[${i}].dimension invalid`);
    need(e, typeof c.pass === 'boolean', `checks[${i}].pass must be boolean`);
    need(e, REF_SEVERITIES.includes(c.severity), `checks[${i}].severity must be hard|soft`);
    need(e, typeof c.evidence === 'string' && c.evidence.length <= 400, `checks[${i}].evidence must be a string <= 400 chars`);
  }
  need(e, Array.isArray(v.fixHints) && v.fixHints.every(h => typeof h === 'string'), 'fixHints must be an array of strings');
  if (v.overall === 'pass') need(e, !checks.some(c => isObj(c) && c.pass === false && c.severity === 'hard'), 'overall pass contradicts a failed hard check');
  if (v.overall === 'fail') need(e, checks.some(c => isObj(c) && c.pass === false), 'overall fail needs at least one failed check');
  return result(e);
}

export function validateRefDecision(d) {
  const e = [];
  if (!isObj(d)) return result(['decision must be an object']);
  need(e, d.schema === REF_DECISION_SCHEMA, `schema must be ${REF_DECISION_SCHEMA}`);
  need(e, isStr(d.jobId), 'jobId must be a non-empty string');
  need(e, SHA.test(d.keyframeSha256 ?? ''), 'keyframeSha256 must be 64 lowercase hex');
  need(e, REF_ACTIONS.includes(d.action), `action must be one of ${REF_ACTIONS.join('|')}`);
  need(e, isStr(d.reason), 'reason must be a non-empty string');
  need(e, Number.isSafeInteger(d.attempt) && d.attempt >= 0, 'attempt must be a non-negative integer');
  if (d.action === 'reprompt') need(e, isStr(d.nextPrompt), 'reprompt needs nextPrompt');
  if (d.action === 'replace_ref') need(e, isStr(d.replaceRef), 'replace_ref needs replaceRef');
  if (d.action === 'override') need(e, isStr(d.receiptId), 'override needs receiptId');
  return result(e);
}

/** Production-wide regen job cap: min(maxRegenJobs, floor(stills * fraction)), and at least 1 when there is a still. */
export function refRegenJobCap(stillCount, policy = REF_POLICY_DEFAULTS) {
  if (!Number.isSafeInteger(stillCount) || stillCount <= 0) return 0;
  return Math.min(policy.maxRegenJobs, Math.max(1, Math.floor(stillCount * policy.maxRegenFraction)));
}

/** The LTX gate opens only for these states. Everything else holds the video job (fail-closed). */
export function refGateOpen(state) { return state === 'accepted' || state === 'overridden'; }
