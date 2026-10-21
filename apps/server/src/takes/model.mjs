// TR01: the pure data model for the takes sidecar (TIMELINE_REVIEW.md section 7).
//
// Nothing here touches disk, the clock or the network: the store, ingest and route
// layers inject those. `validateTakes` reports every problem with a JSON path so the
// HTTP layer can name the exact field, `deriveClipState` is the single source of truth
// for the eight timeline states, and `genFingerprint` is the stable comparison used by
// the `stale` state.

import { createHash } from 'node:crypto';

export const TAKES_SCHEMA = 'comfyrizz.takes/v1';

export const VERDICTS = Object.freeze(['unreviewed', 'approved', 'rejected']);

export const CLIP_STATES = Object.freeze([
  'planned',
  'queued',
  'generating',
  'review',
  'approved',
  'rejected',
  'failed',
  'stale',
]);

export const TAKE_EXTENSIONS = Object.freeze(['png', 'jpg', 'webp', 'mp4', 'webm']);

export const MAX_TAKES_PER_ASSET = 12;
export const MAX_NOTE_CHARS = 1000;

const TAKE_ID_RE = /^tk_[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const PACKAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PLAN_HASH_RE = /^[0-9a-f]{64}$/i;
const EXT_RE = /\.([A-Za-z0-9]+)$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const ACTIVE_JOB_STATES = new Set(['active', 'generating', 'in_progress', 'rendering', 'running']);
const WAITING_JOB_STATES = new Set(['pending', 'queued', 'starting']);
const FAILED_JOB_STATES = new Set(['error', 'failed']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapePathSegment(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function push(errors, path, code, message) {
  errors.push({ path, code, message });
}

function text(value) {
  return typeof value === 'string' ? value : null;
}

function validIsoDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(Date.parse(value));
}

function validateText(errors, value, path, { required = false, max = null } = {}) {
  if (value === undefined || value === null) {
    if (required) push(errors, path, 'REQUIRED', `${path} is required`);
    return;
  }
  if (typeof value !== 'string') {
    push(errors, path, 'INVALID_TEXT', `${path} must be a string`);
    return;
  }
  if (CONTROL_RE.test(value)) {
    push(errors, path, 'INVALID_TEXT', `${path} must not contain control characters`);
    return;
  }
  if (required && value.trim() === '') {
    push(errors, path, 'INVALID_TEXT', `${path} must not be empty`);
    return;
  }
  if (max !== null && value.length > max) {
    push(errors, path, 'TEXT_TOO_LONG', `${path} must be at most ${max} characters`);
  }
}

function validateCorrection(errors, correction, path) {
  if (correction === undefined || correction === null) return;
  if (!isPlainObject(correction)) {
    push(errors, path, 'INVALID_CORRECTION', `${path} must be an object`);
    return;
  }
  validateText(errors, correction.note, `${path}/note`, { max: MAX_NOTE_CHARS });
  if (correction.by !== undefined) {
    if (!['user', 'agent', 'initial'].includes(correction.by)) {
      push(errors, `${path}/by`, 'INVALID_BY', `${path}/by must be one of: user, agent, initial`);
    }
  }
  if (correction.diff !== undefined) {
    if (!Array.isArray(correction.diff)) {
      push(errors, `${path}/diff`, 'INVALID_DIFF', `${path}/diff must be an array`);
    } else {
      correction.diff.forEach((entry, index) => {
        const at = `${path}/diff/${index}`;
        if (!isPlainObject(entry)) {
          push(errors, at, 'INVALID_DIFF', `${at} must be an object`);
          return;
        }
        validateText(errors, entry.path, `${at}/path`, { required: true });
      });
    }
  }
}

function validateTake(errors, take, path, assetId) {
  if (!isPlainObject(take)) {
    push(errors, path, 'INVALID_TAKE', `${path} must be an object`);
    return;
  }

  if (typeof take.takeId !== 'string' || !TAKE_ID_RE.test(take.takeId)) {
    push(errors, `${path}/takeId`, 'INVALID_TAKE_ID', `${path}/takeId must match tk_ followed by 12 lowercase hex characters`);
  }

  if (typeof take.assetId !== 'string' || !ASSET_ID_RE.test(take.assetId)) {
    push(errors, `${path}/assetId`, 'INVALID_ASSET_ID', `${path}/assetId must be a simple asset id`);
  } else if (take.assetId !== assetId) {
    push(errors, `${path}/assetId`, 'ASSET_ID_MISMATCH', `${path}/assetId must equal the clip key ${assetId}`);
  }

  if (!Number.isSafeInteger(take.n) || take.n < 1) {
    push(errors, `${path}/n`, 'INVALID_TAKE_NUMBER', `${path}/n must be an integer greater than or equal to 1`);
  }

  if (typeof take.file !== 'string' || take.file.trim() === '') {
    push(errors, `${path}/file`, 'INVALID_FILE', `${path}/file must be a non-empty path`);
  } else if (CONTROL_RE.test(take.file)
    || take.file.startsWith('/')
    || take.file.startsWith('\\')
    || /^[A-Za-z]:/.test(take.file)
    || take.file.split(/[\\/]+/).includes('..')) {
    push(errors, `${path}/file`, 'INVALID_FILE', `${path}/file must be a relative path inside takes/`);
  } else {
    const match = EXT_RE.exec(take.file);
    const ext = match ? match[1].toLowerCase() : '';
    if (!TAKE_EXTENSIONS.includes(ext)) {
      push(errors, `${path}/file`, 'INVALID_EXT', `${path}/file extension must be one of: ${TAKE_EXTENSIONS.join(', ')}`);
    }
  }

  if (typeof take.sha256 !== 'string' || !SHA256_RE.test(take.sha256)) {
    push(errors, `${path}/sha256`, 'INVALID_SHA256', `${path}/sha256 must be a 64-character hexadecimal digest`);
  }
  if (take.sourceGenFingerprint !== undefined && (typeof take.sourceGenFingerprint !== 'string' || !SHA256_RE.test(take.sourceGenFingerprint))) {
    push(errors, `${path}/sourceGenFingerprint`, 'INVALID_SHA256', `${path}/sourceGenFingerprint must be a sha256 digest`);
  }

  if (!Number.isSafeInteger(take.bytes) || take.bytes < 0) {
    push(errors, `${path}/bytes`, 'INVALID_BYTES', `${path}/bytes must be a non-negative integer`);
  }

  if (!isPlainObject(take.media)) {
    push(errors, `${path}/media`, 'INVALID_MEDIA', `${path}/media must be an object`);
  }

  if (!isPlainObject(take.gen)) {
    push(errors, `${path}/gen`, 'INVALID_GEN', `${path}/gen must be an object`);
  } else {
    if (take.gen.prompt !== undefined && take.gen.prompt !== null) validateText(errors, take.gen.prompt, `${path}/gen/prompt`);
    if (take.gen.negative !== undefined && take.gen.negative !== null) validateText(errors, take.gen.negative, `${path}/gen/negative`);
    if (take.gen.inputs !== undefined && take.gen.inputs !== null && !isPlainObject(take.gen.inputs)) {
      push(errors, `${path}/gen/inputs`, 'INVALID_INPUTS', `${path}/gen/inputs must be an object`);
    }
    if (take.gen.workflow_sha256 !== undefined && take.gen.workflow_sha256 !== null
      && (typeof take.gen.workflow_sha256 !== 'string' || !SHA256_RE.test(take.gen.workflow_sha256))) {
      push(errors, `${path}/gen/workflow_sha256`, 'INVALID_SHA256', `${path}/gen/workflow_sha256 must be a 64-character hexadecimal digest`);
    }
  }

  validateCorrection(errors, take.correction, `${path}/correction`);

  if (take.runId !== undefined && take.runId !== null) validateText(errors, take.runId, `${path}/runId`);
  if (!validIsoDate(take.createdAt)) {
    push(errors, `${path}/createdAt`, 'INVALID_CREATED_AT', `${path}/createdAt must be an ISO date string`);
  }
  if (!VERDICTS.includes(take.verdict)) {
    push(errors, `${path}/verdict`, 'INVALID_VERDICT', `${path}/verdict must be one of: ${VERDICTS.join(', ')}`);
  }
  validateText(errors, take.verdictNote, `${path}/verdictNote`, { max: MAX_NOTE_CHARS });
  if (take.purged !== undefined && typeof take.purged !== 'boolean') {
    push(errors, `${path}/purged`, 'INVALID_PURGED', `${path}/purged must be a boolean`);
  }
}

function validateLastJob(errors, lastJob, path) {
  if (lastJob === undefined || lastJob === null) return;
  if (!isPlainObject(lastJob)) {
    push(errors, path, 'INVALID_LAST_JOB', `${path} must be an object`);
    return;
  }
  validateText(errors, lastJob.runId, `${path}/runId`, { required: true });
  validateText(errors, lastJob.state, `${path}/state`, { required: true });
  validateText(errors, lastJob.error, `${path}/error`, { max: 2000 });
}

function validateQueued(errors, queued, path) {
  if (queued === undefined || queued === null) return;
  if (!isPlainObject(queued)) {
    push(errors, path, 'INVALID_QUEUED', `${path} must be an object`);
    return;
  }
  if (queued.planHash !== undefined && queued.planHash !== null
    && (typeof queued.planHash !== 'string' || !PLAN_HASH_RE.test(queued.planHash))) {
    push(errors, `${path}/planHash`, 'INVALID_PLAN_HASH', `${path}/planHash must be a 64-character hexadecimal digest`);
  }
  validateCorrection(errors, queued.correction, `${path}/correction`);
}

function validateClipEntry(errors, entry, path, assetId) {
  if (!isPlainObject(entry)) {
    push(errors, path, 'INVALID_CLIP', `${path} must be an object`);
    return;
  }

  if (!Array.isArray(entry.takes)) {
    push(errors, `${path}/takes`, 'INVALID_TAKES', `${path}/takes must be an array`);
  } else {
    if (entry.takes.length > MAX_TAKES_PER_ASSET * 4) {
      push(errors, `${path}/takes`, 'TOO_MANY_TAKES', `${path}/takes has too many entries`);
    }
    const seen = new Set();
    entry.takes.forEach((take, index) => {
      const at = `${path}/takes/${index}`;
      validateTake(errors, take, at, assetId);
      if (isPlainObject(take) && typeof take.takeId === 'string') {
        if (seen.has(take.takeId)) {
          push(errors, `${at}/takeId`, 'DUPLICATE_TAKE_ID', `${at}/takeId duplicates an earlier take`);
        }
        seen.add(take.takeId);
      }
    });
    if (entry.selected === undefined) {
      push(errors, `${path}/selected`, 'REQUIRED', `${path}/selected is required`);
    } else if (entry.selected !== null) {
      if (typeof entry.selected !== 'string' || !TAKE_ID_RE.test(entry.selected)) {
        push(errors, `${path}/selected`, 'INVALID_TAKE_ID', `${path}/selected must be null or a take id`);
      } else if (!seen.has(entry.selected)) {
        push(errors, `${path}/selected`, 'UNKNOWN_TAKE', `${path}/selected must name a take in ${path}/takes`);
      }
    }
  }

  validateLastJob(errors, entry.lastJob, `${path}/lastJob`);
  validateQueued(errors, entry.queued, `${path}/queued`);
}

function validateOverride(errors, override, path) {
  if (!isPlainObject(override)) {
    push(errors, path, 'INVALID_OVERRIDE', `${path} must be an object`);
    return;
  }
  if (!validIsoDate(override.at)) {
    push(errors, `${path}/at`, 'INVALID_CREATED_AT', `${path}/at must be an ISO date string`);
  }
  validateText(errors, override.reason, `${path}/reason`, { required: true, max: 500 });
  if (!Number.isSafeInteger(override.revision) || override.revision < 0) {
    push(errors, `${path}/revision`, 'INVALID_REVISION', `${path}/revision must be a non-negative integer`);
  }
}

/**
 * Validate a `comfyrizz.takes/v1` sidecar without mutating it.
 *
 * @param {unknown} doc
 * @returns {{ok: boolean, errors: Array<{path: string, code: string, message: string}>}}
 */
export function validateTakes(doc) {
  const errors = [];

  if (!isPlainObject(doc)) {
    push(errors, '', 'INVALID_DOC', 'takes sidecar must be an object');
    return { ok: false, errors };
  }

  if (doc.schema !== TAKES_SCHEMA) {
    push(errors, '/schema', 'INVALID_SCHEMA', `/schema must be ${TAKES_SCHEMA}`);
  }

  if (typeof doc.packageId !== 'string' || !PACKAGE_ID_RE.test(doc.packageId)) {
    push(errors, '/packageId', 'INVALID_PACKAGE_ID', '/packageId must be a simple package id');
  }

  if (!isPlainObject(doc.clips)) {
    push(errors, '/clips', 'INVALID_CLIPS', '/clips must be an object keyed by asset id');
  } else {
    for (const [assetId, entry] of Object.entries(doc.clips)) {
      const path = `/clips/${escapePathSegment(assetId)}`;
      if (!ASSET_ID_RE.test(assetId)) {
        push(errors, path, 'INVALID_ASSET_ID', `${path} key must be a simple asset id`);
      }
      validateClipEntry(errors, entry, path, assetId);
    }
  }

  if (doc.overrides !== undefined) {
    if (!Array.isArray(doc.overrides)) {
      push(errors, '/overrides', 'INVALID_OVERRIDES', '/overrides must be an array');
    } else {
      doc.overrides.forEach((override, index) => {
        validateOverride(errors, override, `/overrides/${index}`);
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function canonical(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonical(value[key]);
    }
    return out;
  }
  return null;
}

/**
 * Stable sha256 over the fields that decide whether a take still matches the asset.
 * Object key order never changes the digest; arrays keep their order.
 *
 * @param {object|null|undefined} gen
 * @returns {string} lowercase hex sha256
 */
export function genFingerprint(gen) {
  const source = isPlainObject(gen) ? gen : {};
  const payload = {
    prompt: source.prompt ?? null,
    negative: source.negative ?? null,
    seed: source.seed ?? null,
    inputs: source.inputs ?? null,
    workflow_sha256: source.workflow_sha256 ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

function takeOrder(take, index) {
  if (!isPlainObject(take)) return { n: -1, at: -1, index };
  const n = Number.isSafeInteger(take.n) ? take.n : -1;
  const at = typeof take.createdAt === 'string' && Number.isFinite(Date.parse(take.createdAt))
    ? Date.parse(take.createdAt)
    : -1;
  return { n, at, index };
}

function newestTake(takes) {
  let best = null;
  takes.forEach((take, index) => {
    if (!isPlainObject(take)) return;
    const order = takeOrder(take, index);
    if (!best || order.n > best.order.n
      || (order.n === best.order.n && order.at > best.order.at)
      || (order.n === best.order.n && order.at === best.order.at && order.index > best.order.index)) {
      best = { take, order };
    }
  });
  return best?.take ?? null;
}

function isNewer(candidate, selected) {
  const a = takeOrder(candidate, 0);
  const b = takeOrder(selected, 0);
  return a.n > b.n || (a.n === b.n && a.at > b.at);
}

function verdictState(take, takes, assetGen) {
  const selected = take;
  if (!selected) return 'planned';

  if (isPlainObject(selected.gen) && isPlainObject(assetGen)
    && genFingerprint(selected.gen) !== genFingerprint(assetGen)
    && selected.sourceGenFingerprint !== genFingerprint(assetGen)) {
    return 'stale';
  }

  if (selected.verdict === 'approved') return 'approved';
  if (selected.verdict === 'rejected') {
    const newer = Array.isArray(takes) ? takes.find((candidate) => isNewer(candidate, selected)) : null;
    if (newer) return verdictState(newer, takes, assetGen);
    return 'rejected';
  }
  return 'review';
}

/**
 * Derive the one timeline state for a clip. Never mutates the entry, so a failed job
 * leaves the previous selected take exactly where it was.
 *
 * `takes` is the sidecar entry for the clip (`{selected, takes, lastJob, queued}`) or a
 * bare take array. Explicit `lastJob`/`queued`/`assetGen` win; `assetGen` falls back to
 * `clip.gen` so a package asset can be passed directly.
 *
 * @param {{clip?: object|null, takes?: object|Array|null, lastJob?: object|null, queued?: object|null, assetGen?: object|null}} input
 * @returns {'planned'|'queued'|'generating'|'review'|'approved'|'rejected'|'failed'|'stale'}
 */
export function deriveClipState(input = {}) {
  const { clip } = input;
  const entry = Array.isArray(input.takes)
    ? { takes: input.takes }
    : (isPlainObject(input.takes) ? input.takes : {});

  const takes = Array.isArray(entry.takes) ? entry.takes : [];
  const lastJob = input.lastJob !== undefined ? input.lastJob : entry.lastJob;
  const queued = input.queued !== undefined ? input.queued : entry.queued;
  const assetGen = input.assetGen !== undefined ? input.assetGen : (isPlainObject(clip) ? clip.gen : undefined);

  const jobState = isPlainObject(lastJob) && typeof lastJob.state === 'string'
    ? lastJob.state.trim().toLowerCase()
    : null;

  if (jobState && ACTIVE_JOB_STATES.has(jobState)) return 'generating';
  if (queued) return 'queued';
  if (jobState && WAITING_JOB_STATES.has(jobState)) return 'queued';

  if (jobState && FAILED_JOB_STATES.has(jobState)) {
    const landed = typeof lastJob.runId === 'string'
      && takes.some((take) => isPlainObject(take) && take.runId === lastJob.runId);
    if (!landed) return 'failed';
  }

  const selectedId = typeof entry.selected === 'string' ? entry.selected : null;
  const selected = (selectedId ? takes.find((take) => isPlainObject(take) && take.takeId === selectedId) : null)
    ?? newestTake(takes);
  if (!selected) return 'planned';

  return verdictState(selected, takes, assetGen);
}

/**
 * Auto-selection rule from SPEC 6.4: a new take may become current unless an approved
 * take already is. It never overrides approval; the new take still lands as unreviewed
 * beside it.
 *
 * @param {{selected?: string|null, takes?: Array}|null} entry
 * @param {object|null} [newTake] accepted for call-site clarity; selection depends on the entry
 * @returns {boolean}
 */
export function shouldAutoSelect(entry, newTake) {
  if (!isPlainObject(entry) || !Array.isArray(entry.takes) || entry.takes.length === 0) return true;
  const selectedId = typeof entry.selected === 'string'
    ? entry.selected
    : (isPlainObject(entry.selected) ? entry.selected.takeId : null);
  const selected = selectedId
    ? entry.takes.find((take) => isPlainObject(take) && take.takeId === selectedId)
    : newestTake(entry.takes);
  return selected?.verdict !== 'approved';
}
