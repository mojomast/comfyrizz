// IP55: versioned delivery manifests, captions and the source/stem archive.
//
// A delivery is an append-only version directory (v1..vN). Every version is
// written to a sibling temporary directory and renamed into place while the
// store holds a single-writer lock, so an earlier version is never rewritten.
//
// The store, not the caller, reads and hashes every delivered file. A
// caller-supplied sha256 is an expectation: a mismatch is HASH_MISMATCH and a
// file supplied only as a hash is MISSING_BYTES. The manifest pins the
// revisions, selected takes, effective hashes, provenance, reviews, rights
// mode, actual output facts and the actual bytes of every file it lists.
//
// No network, no paid work, no secrets stored.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const DELIVERY_SCHEMA = 'comfyrizz.delivery/v1';

const ARCHIVE_MODES = new Set(['private', 'redistributable']);
const PIN_KEYS = ['packageRevision', 'editorRevision', 'productionRevision'];
const HASH_KEYS = ['composition', 'nativeAudio', 'captions', 'mix'];
const HASH_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const GENERAL_ID_RE = /^[^\s/\\\u0000-\u001f]{1,256}$/u;
const TRANSIENT_PARAM_RE = /^(ticket|ticketid|token|access[_-]?token|id[_-]?token|auth|authorization|signature|sig|key|api[_-]?key|apikey|x-amz-signature|x-amz-credential|x-amz-security-token)$/i;
const SECRET_KEY_RE = /^(authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|secret|client[_-]?secret|password|passwd|credential|credentials|signature|signed[_-]?url)$/i;
const CREDIT_KEYS = new Set(['name', 'license', 'attribution', 'url']);

export class DeliveryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    if (details !== undefined) Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new DeliveryError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^sha256[:=]/i, '').toLowerCase();
  return HASH_RE.test(trimmed) ? trimmed : null;
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    fail('INVALID_PRODUCTION_ID', `${label} must be a simple identifier`);
  }
  return value;
}

function assertGeneralId(value, label) {
  if (typeof value !== 'string' || !GENERAL_ID_RE.test(value)) {
    fail('INVALID_IDEMPOTENCY_KEY', `${label} must be a non-empty identifier without whitespace or path separators`);
  }
  return value;
}

function safeArchivePath(value, label = 'archive path') {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    fail('INVALID_PATH', `${label} must be a non-empty relative path`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    fail('INVALID_PATH', `${label} must not be absolute`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail('INVALID_PATH', `${label} must not contain empty, dot or traversal segments`);
  }
  return parts.join('/');
}

function safeFileName(value, label) {
  const name = safeArchivePath(value, label);
  if (name.includes('/')) fail('INVALID_PATH', `${label} must be a single file name`);
  return name;
}

function transientUrl(value) {
  const question = value.indexOf('?');
  if (question === -1) return false;
  const query = value.slice(question + 1).split('#')[0];
  for (const part of query.split('&')) {
    const rawKey = part.split('=')[0] ?? '';
    let key = rawKey.replace(/\+/g, ' ');
    try {
      key = decodeURIComponent(key);
    } catch {
      // A malformed escape is still compared literally.
    }
    if (TRANSIENT_PARAM_RE.test(key)) return true;
  }
  return false;
}

function assertNoTransient(value, path = '') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoTransient(entry, `${path}/${index}`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) {
        fail('DELIVERY_TRANSIENT_URL', `delivery input contains an authorization-like field at ${path || '/'}`, {
          path: `${path}/${key}`,
        });
      }
      assertNoTransient(entry, `${path}/${key}`);
    }
    return;
  }
  if (typeof value === 'string' && transientUrl(value)) {
    fail('DELIVERY_TRANSIENT_URL', `delivery input contains a transient ticket URL at ${path || '/'}`, {
      path: path || '/',
    });
  }
}

function bytesFrom(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return null;
}

function readBytes(spec, label) {
  if (Buffer.isBuffer(spec) || spec instanceof Uint8Array || spec instanceof ArrayBuffer) {
    return bytesFrom(spec);
  }
  if (typeof spec === 'string') {
    return readPath(spec, label);
  }
  if (!isPlainObject(spec)) fail('MISSING_BYTES', `${label} must be supplied as bytes or a local path`);
  if (spec.bytes !== undefined) {
    const bytes = bytesFrom(spec.bytes);
    if (bytes === null) fail('MISSING_BYTES', `${label}.bytes must be bytes`);
    return bytes;
  }
  if (spec.path !== undefined) {
    if (typeof spec.path !== 'string' || spec.path.trim() === '') {
      fail('MISSING_BYTES', `${label}.path must be a local file path`);
    }
    return readPath(spec.path, label);
  }
  fail('MISSING_BYTES', `${label} must be supplied as bytes or a local path`);
}

function readPath(path, label) {
  let stat;
  try {
    stat = fs.statSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      fail('MISSING_BYTES', `${label} file does not exist`);
    }
    fail('MISSING_BYTES', `${label} file cannot be read`);
  }
  if (!stat.isFile()) fail('MISSING_BYTES', `${label} must be a regular file`);
  try {
    return fs.readFileSync(path);
  } catch {
    fail('MISSING_BYTES', `${label} file cannot be read`);
  }
}

function materializeFile(spec, label) {
  const data = readBytes(spec, label);
  const sha256 = hashBytes(data);
  const expected = isPlainObject(spec) ? spec.sha256 : undefined;
  if (expected !== undefined && expected !== null) {
    const digest = normalizeDigest(expected);
    if (digest === null) fail('INVALID_HASH', `${label}.sha256 must be a sha256 hex digest`);
    if (digest !== sha256) fail('HASH_MISMATCH', `${label} bytes do not match the expected sha256`);
  }
  if (isPlainObject(spec) && spec.size !== undefined) {
    if (!Number.isSafeInteger(spec.size) || spec.size < 0) {
      fail('INVALID_HASH', `${label}.size must be a non-negative integer`);
    }
    if (spec.size !== data.length) fail('HASH_MISMATCH', `${label} bytes do not match the expected size`);
  }
  return { data, sha256, bytes: data.length };
}

function normalizePins(value) {
  if (!isPlainObject(value)) fail('DELIVERY_PIN_REQUIRED', 'pins with package/editor/production revisions are required');
  const pins = {};
  for (const key of PIN_KEYS) {
    if (!(key in value)) fail('DELIVERY_PIN_REQUIRED', `pins.${key} is required`);
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail('INVALID_PIN', `pins.${key} must be a non-negative integer`);
    }
    pins[key] = value[key];
  }
  return pins;
}

function normalizeSelections(value) {
  if (!Array.isArray(value)) fail('DELIVERY_PIN_REQUIRED', 'selections are required');
  const seen = new Set();
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) fail('INVALID_SELECTIONS', `selections[${index}] must be an object`);
    const shotId = entry.shotId;
    const takeId = entry.takeId;
    if (typeof shotId !== 'string' || shotId.trim() === '') {
      fail('INVALID_SELECTIONS', `selections[${index}].shotId is required`);
    }
    if (typeof takeId !== 'string' || takeId.trim() === '') {
      fail('INVALID_SELECTIONS', `selections[${index}].takeId is required`);
    }
    if (seen.has(shotId)) fail('INVALID_SELECTIONS', `selections[${index}].shotId is duplicated`);
    seen.add(shotId);
    const sha256 = normalizeDigest(entry.sha256);
    if (sha256 === null) fail('INVALID_SELECTIONS', `selections[${index}].sha256 must be a sha256 hex digest`);
    return { shotId, takeId, sha256 };
  });
}

// A pinned hash is exactly a sha256 hex digest, or { sha256: null, reason }
// when that layer does not exist for this delivery. There is no other form.
function normalizeHashes(value) {
  if (!isPlainObject(value)) fail('DELIVERY_PIN_REQUIRED', 'hashes are required');
  const hashes = {};
  const reasons = {};
  for (const key of HASH_KEYS) {
    if (!(key in value)) fail('DELIVERY_PIN_REQUIRED', `hashes.${key} is required`);
    const raw = value[key];
    if (isPlainObject(raw)) {
      if (raw.sha256 !== null || typeof raw.reason !== 'string' || raw.reason.trim() === '') {
        fail('DELIVERY_PIN_REQUIRED', `hashes.${key} must be a sha256 hex digest or { sha256: null, reason }`);
      }
      hashes[key] = null;
      reasons[key] = raw.reason.trim();
      continue;
    }
    const digest = typeof raw === 'string' ? normalizeDigest(raw) : null;
    if (digest === null) fail('INVALID_HASHES', `hashes.${key} must be a sha256 hex digest or { sha256: null, reason }`);
    hashes[key] = digest;
  }
  return { hashes, reasons };
}

function normalizeProvenance(value) {
  if (!Array.isArray(value)) fail('DELIVERY_PIN_REQUIRED', 'provenance is required');
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) fail('INVALID_PROVENANCE', `provenance[${index}] must be an object`);
    if (typeof entry.modelId !== 'string' || entry.modelId.trim() === '') {
      fail('INVALID_PROVENANCE', `provenance[${index}].modelId is required`);
    }
    const workflowRevision = entry.workflowRevision;
    const validRevision = (typeof workflowRevision === 'string' && workflowRevision.trim() !== '')
      || (Number.isSafeInteger(workflowRevision) && workflowRevision >= 0);
    if (!validRevision) fail('INVALID_PROVENANCE', `provenance[${index}].workflowRevision is required`);
    return { modelId: entry.modelId, workflowRevision };
  });
}

function normalizeReviews(value) {
  if (!Array.isArray(value)) fail('DELIVERY_PIN_REQUIRED', 'reviews are required');
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) fail('INVALID_REVIEWS', `reviews[${index}] must be an object`);
    if (typeof entry.decisionId !== 'string' || entry.decisionId.trim() === '') {
      fail('INVALID_REVIEWS', `reviews[${index}].decisionId is required`);
    }
    const hasVerdict = typeof entry.verdict === 'string' && entry.verdict.trim() !== '';
    const hasOverride = entry.override !== undefined && entry.override !== null;
    if (!hasVerdict && !hasOverride) {
      fail('INVALID_REVIEWS', `reviews[${index}] requires a verdict or override`);
    }
    const review = { decisionId: entry.decisionId };
    if (hasVerdict) review.verdict = entry.verdict;
    if (hasOverride) review.override = clone(entry.override);
    if (entry.reason !== undefined) {
      if (typeof entry.reason !== 'string') fail('INVALID_REVIEWS', `reviews[${index}].reason must be a string`);
      review.reason = entry.reason;
    }
    return review;
  });
}

function normalizeOutput(value) {
  if (!isPlainObject(value)) fail('DELIVERY_PIN_REQUIRED', 'output facts are required');
  const { frames, fps, durationSeconds } = value;
  if (!Number.isSafeInteger(frames) || frames < 0) fail('INVALID_OUTPUT', 'output.frames must be a non-negative integer');
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) fail('INVALID_OUTPUT', 'output.fps must be a positive number');
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    fail('INVALID_OUTPUT', 'output.durationSeconds must be a positive number');
  }
  return { frames, fps, durationSeconds };
}

function normalizeCredits(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('INVALID_CREDITS', 'credits must be an array of rows');
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) fail('INVALID_CREDITS', `credits[${index}] must be an object`);
    for (const key of Object.keys(entry)) {
      if (!CREDIT_KEYS.has(key)) fail('INVALID_CREDITS', `credits[${index}] has an unknown field: ${key}`);
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      fail('INVALID_CREDITS', `credits[${index}].name is required`);
    }
    const row = { name: entry.name };
    for (const key of ['license', 'attribution', 'url']) {
      if (entry[key] === undefined) continue;
      if (typeof entry[key] !== 'string') fail('INVALID_CREDITS', `credits[${index}].${key} must be a string`);
      row[key] = entry[key];
    }
    return row;
  });
}

function timestamp(seconds, comma) {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? ',' : '.'}${pad(ms, 3)}`;
}

function cueBounds(cue, fps) {
  const from = cue.from / fps;
  const to = Math.max(from + 0.2, cue.to / fps);
  return { from, to };
}

function validateCues(cues, fps, durationSeconds) {
  if (!Array.isArray(cues)) fail('INVALID_CUES', 'captions.cues must be an array');
  const limit = durationSeconds * fps;
  const epsilon = 1e-6;
  let previousStart = -Infinity;
  let previousEnd = -Infinity;
  cues.forEach((cue, index) => {
    if (!isPlainObject(cue)) fail('INVALID_CUES', `captions.cues[${index}] must be an object`);
    const { from, to, text } = cue;
    if (typeof from !== 'number' || !Number.isFinite(from) || from < 0) {
      fail('INVALID_CUES', `captions.cues[${index}].from must be a non-negative number`);
    }
    if (typeof to !== 'number' || !Number.isFinite(to) || to <= from) {
      fail('INVALID_CUES', `captions.cues[${index}].to must be after from`);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      fail('INVALID_CUES', `captions.cues[${index}].text is required`);
    }
    if (from < previousStart - epsilon) fail('INVALID_CUES', `captions.cues[${index}] is out of order`);
    if (from < previousEnd - epsilon) fail('INVALID_CUES', `captions.cues[${index}] overlaps the previous cue`);
    if (to > limit + epsilon) fail('INVALID_CUES', `captions.cues[${index}] is past output.durationSeconds`);

    if (cue.words !== undefined) {
      if (!Array.isArray(cue.words)) fail('INVALID_CUES', `captions.cues[${index}].words must be an array`);
      let wordStart = -Infinity;
      let wordEnd = -Infinity;
      cue.words.forEach((word, wordIndex) => {
        if (!isPlainObject(word) || typeof word.text !== 'string' || word.text.trim() === '') {
          fail('INVALID_CUES', `captions.cues[${index}].words[${wordIndex}].text is required`);
        }
        if (typeof word.from !== 'number' || !Number.isFinite(word.from) || word.from < 0) {
          fail('INVALID_CUES', `captions.cues[${index}].words[${wordIndex}].from is invalid`);
        }
        if (typeof word.to !== 'number' || !Number.isFinite(word.to) || word.to <= word.from) {
          fail('INVALID_CUES', `captions.cues[${index}].words[${wordIndex}].to is invalid`);
        }
        if (word.from < wordStart - epsilon || word.from < wordEnd - epsilon) {
          fail('INVALID_CUES', `captions.cues[${index}].words[${wordIndex}] is out of order or overlapping`);
        }
        if (word.from < from - epsilon || word.to > to + epsilon) {
          fail('INVALID_CUES', `captions.cues[${index}].words[${wordIndex}] is outside its cue`);
        }
        wordStart = word.from;
        wordEnd = word.to;
      });
    }

    previousStart = from;
    previousEnd = to;
  });
}

function renderSrt(cues, fps) {
  if (cues.length === 0) return '';
  return cues.map((cue, index) => {
    const { from, to } = cueBounds(cue, fps);
    return `${index + 1}\n${timestamp(from, true)} --> ${timestamp(to, true)}\n${cue.text.trim()}\n`;
  }).join('\n');
}

function renderVtt(cues, fps) {
  const body = cues.map((cue, index) => {
    const { from, to } = cueBounds(cue, fps);
    return `cue-${index + 1}\n${timestamp(from, false)} --> ${timestamp(to, false)}\n${cue.text.trim()}\n`;
  }).join('\n');
  return `WEBVTT\n\n${body}`;
}

function renderWordVtt(cues, fps) {
  const lines = [];
  let index = 0;
  for (const cue of cues) {
    for (const word of cue.words ?? []) {
      const from = word.from / fps;
      const to = Math.max(from + 0.05, word.to / fps);
      index += 1;
      lines.push(`word-${index}\n${timestamp(from, false)} --> ${timestamp(to, false)}\n${word.text.trim()}\n`);
    }
  }
  return `WEBVTT\n\n${lines.join('\n')}`;
}

/** Render SRT, VTT and the optional word VTT from one validated cue list. */
export function renderCaptions(cues, options = {}) {
  const fps = options.fps ?? 30;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) fail('INVALID_CUES', 'fps must be a positive number');
  const durationSeconds = options.durationSeconds;
  if (durationSeconds !== undefined) {
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      fail('INVALID_CUES', 'durationSeconds must be a positive number');
    }
    validateCues(cues, fps, durationSeconds);
  } else if (!Array.isArray(cues)) {
    fail('INVALID_CUES', 'captions.cues must be an array');
  }
  const srt = renderSrt(cues, fps);
  const vtt = renderVtt(cues, fps);
  const hasWords = cues.some((cue) => Array.isArray(cue.words) && cue.words.length > 0);
  const wordsVtt = hasWords ? renderWordVtt(cues, fps) : null;
  return {
    srt,
    vtt,
    wordsVtt,
    sha256: hashText(JSON.stringify({ srt, vtt, wordsVtt })),
  };
}

function normalizeCaptions(input, output) {
  const raw = input.captions;
  if (raw === undefined || raw === null) return null;
  let cues;
  if (Array.isArray(raw)) cues = raw;
  else if (isPlainObject(raw) && Array.isArray(raw.cues)) cues = raw.cues;
  else fail('INVALID_CUES', 'captions must be a cue array or { cues }');
  return renderCaptions(cues, { fps: output.fps, durationSeconds: output.durationSeconds });
}

function materializeVideo(input) {
  if (input.video === undefined || input.video === null) fail('MISSING_BYTES', 'video bytes or a local video path are required');
  const spec = input.video;
  const name = isPlainObject(spec) && spec.name !== undefined ? spec.name : 'video.mp4';
  const path = safeFileName(name, 'video.name');
  return { path, ...materializeFile(spec, 'video') };
}

function licenseId(license) {
  if (isPlainObject(license) && typeof license.id === 'string' && license.id.trim() !== '') return license.id;
  return null;
}

function exclusionReason(entry) {
  if (isPlainObject(entry) && typeof entry.reason === 'string' && entry.reason.trim() !== '') return entry.reason.trim();
  const license = isPlainObject(entry) ? entry.license : null;
  if (isPlainObject(license) && typeof license.blocked_reason === 'string' && license.blocked_reason.trim() !== '') {
    return license.blocked_reason.trim();
  }
  const id = licenseId(license);
  return id === null ? 'license does not permit redistribution' : `license ${id} does not permit redistribution`;
}

function materializeArchive(input, mode) {
  const entries = [];
  for (const [kind, values] of [['source', input.sources], ['stem', input.stems]]) {
    if (values === undefined) continue;
    if (!Array.isArray(values)) fail('INVALID_ARCHIVE', `${kind}s must be an array`);
    values.forEach((entry, index) => {
      if (!isPlainObject(entry)) fail('INVALID_ARCHIVE', `${kind}s[${index}] must be an object`);
      const path = safeArchivePath(entry.path, `${kind}s[${index}].path`);
      if (path === 'CREDITS.md' || path === 'manifest.json') {
        fail('INVALID_PATH', `${kind}s[${index}].path is reserved`);
      }
      const license = entry.license;
      const redistributable = isPlainObject(license) && license.redistributable === true;
      const excluded = mode === 'redistributable' && !redistributable;
      const file = excluded ? null : materializeFile(entry, `${kind} ${path}`);
      entries.push({
        kind,
        path,
        license: isPlainObject(license) ? clone(license) : (typeof license === 'string' ? { id: license } : null),
        ...(file ?? { data: null, sha256: null, bytes: 0 }),
        excluded,
        reason: excluded ? exclusionReason(entry) : null,
      });
    });
  }
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) fail('INVALID_PATH', `archive path is duplicated: ${entry.path}`);
    seen.add(entry.path);
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return entries;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

function renderCredits({ mode, credits, excluded }) {
  const lines = ['# Credits', ''];
  lines.push(mode === 'private'
    ? 'Archive mode: private. Authorized sources are retained for the owner.'
    : 'Archive mode: redistributable. Only sources whose license permits redistribution are included.');
  lines.push('');
  if (credits.length === 0) {
    lines.push('No third-party credits were supplied.');
  } else {
    lines.push('| Name | License | Attribution | URL |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of credits) {
      lines.push(`| ${escapeCell(row.name)} | ${escapeCell(row.license ?? '')} | ${escapeCell(row.attribution ?? '')} | ${escapeCell(row.url ?? '')} |`);
    }
  }
  if (excluded.length > 0) {
    lines.push('');
    lines.push('## Excluded from the redistributable archive');
    for (const entry of excluded) lines.push(`- ${entry.path}: ${entry.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deterministic store-only ZIP: no compression, fixed 1980-01-01 timestamp. */
function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  const seen = new Set();
  let offset = 0;
  for (const entry of entries) {
    const name = safeArchivePath(entry.path, 'zip entry');
    if (seen.has(name)) fail('INVALID_PATH', `duplicate zip entry: ${name}`);
    seen.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(seen.size, 8);
  end.writeUInt16LE(seen.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function clockIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', 'clock must return a valid date');
  return date.toISOString();
}

function insideOrEqual(root, target) {
  const rel = target.startsWith(root) ? target.slice(root.length) : null;
  return rel === '' || (rel !== null && (rel.startsWith('/') || rel.startsWith('\\')));
}

function versionNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_VERSION', 'version must be a positive integer');
  return value;
}

export function createDeliveryStore(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'createDeliveryStore options must be an object');
  if (typeof options.runtimeDir !== 'string' || options.runtimeDir.trim() === '') {
    fail('INVALID_RUNTIME_DIR', 'runtimeDir must be a non-empty path string');
  }
  const runtimeDir = resolve(options.runtimeDir);
  const clock = options.clock;
  let tempSequence = 0;

  function pathsFor(productionId) {
    const id = assertSafeId(productionId, 'productionId');
    const root = runtimeDir;
    const productionDir = join(root, 'productions', id);
    const deliveriesDir = join(productionDir, 'deliveries');
    if (!insideOrEqual(root, deliveriesDir)) fail('PATH_ESCAPE', 'delivery path escapes the runtime directory');
    return {
      root,
      productionDir,
      deliveriesDir,
      lock: join(deliveriesDir, '.lock'),
      versionDir: (version) => join(deliveriesDir, `v${versionNumber(version)}`),
      manifest: (version) => join(deliveriesDir, `v${versionNumber(version)}`, 'manifest.json'),
    };
  }

  function readManifestAt(dir) {
    let raw;
    try {
      raw = fs.readFileSync(join(dir, 'manifest.json'), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      fail('INVALID_MANIFEST', 'delivery manifest cannot be read');
    }
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      fail('INVALID_MANIFEST', 'delivery manifest is not valid JSON');
    }
    if (!isPlainObject(manifest) || manifest.schema !== DELIVERY_SCHEMA || !Number.isSafeInteger(manifest.version)) {
      fail('INVALID_MANIFEST', 'delivery manifest is invalid');
    }
    return manifest;
  }

  function versionNumbers(paths) {
    let entries;
    try {
      entries = fs.readdirSync(paths.deliveriesDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const versions = [];
    for (const dirent of entries) {
      if (typeof dirent === 'string') {
        if (/^v[1-9][0-9]*$/.test(dirent)) versions.push(Number(dirent.slice(1)));
        continue;
      }
      if (!dirent.isDirectory()) continue;
      const match = /^v([1-9][0-9]*)$/.exec(dirent.name);
      if (match) versions.push(Number(match[1]));
    }
    versions.sort((left, right) => left - right);
    return versions;
  }

  function list(productionId) {
    const paths = pathsFor(productionId);
    const manifests = [];
    for (const version of versionNumbers(paths)) {
      const manifest = readManifestAt(paths.versionDir(version));
      if (manifest) manifests.push(manifest);
    }
    return manifests;
  }

  function read(productionId, version) {
    const paths = pathsFor(productionId);
    return readManifestAt(paths.versionDir(version));
  }

  function latest(productionId) {
    const manifests = list(productionId);
    return manifests.length === 0 ? null : manifests[manifests.length - 1];
  }

  function writeFileAt(root, path, data) {
    const target = join(root, path);
    if (!insideOrEqual(root, target)) fail('PATH_ESCAPE', 'delivery file escapes the version directory');
    fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, data, { mode: 0o600 });
  }

  function acquireLock(paths) {
    fs.mkdirSync(paths.deliveriesDir, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(paths.lock, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') fail('DELIVERY_BUSY', 'another delivery write holds the store lock');
      throw error;
    }
    return () => {
      try {
        fs.rmSync(paths.lock, { recursive: true, force: true });
      } catch {
        // The lock is best-effort cleanup; the rename commit is already durable.
      }
    };
  }

  // One call shape: publish(input). The production is exactly input.productionId.
  function publish(input) {
    if (!isPlainObject(input)) fail('INVALID_DELIVERY', 'publish takes one delivery input object');
    let productionId = input.productionId;
    assertNoTransient(input);

    let idempotencyKey = null;
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      idempotencyKey = assertGeneralId(input.idempotencyKey, 'idempotencyKey');
    }

    const pins = normalizePins(input.pins);
    const selections = normalizeSelections(input.selections);
    const normalizedHashes = normalizeHashes(input.hashes);
    const provenance = normalizeProvenance(input.provenance);
    const reviews = normalizeReviews(input.reviews);
    const output = normalizeOutput(input.output);
    const credits = normalizeCredits(input.credits);

    if (typeof input.archiveMode !== 'string' || !ARCHIVE_MODES.has(input.archiveMode)) {
      fail('INVALID_ARCHIVE_MODE', "archiveMode must be 'private' or 'redistributable'");
    }
    const archiveMode = input.archiveMode;

    let metadata;
    if (input.metadata !== undefined) {
      if (!isPlainObject(input.metadata)) fail('INVALID_METADATA', 'metadata must be an object');
      metadata = clone(input.metadata);
    }

    const video = materializeVideo(input);
    const captions = normalizeCaptions(input, output);
    const hashes = { ...normalizedHashes.hashes };
    const hashReasons = { ...normalizedHashes.reasons };

    if (captions !== null) {
      if (hashes.captions !== null && hashes.captions !== captions.sha256) {
        fail('HASH_MISMATCH', 'hashes.captions does not match the rendered captions');
      }
      hashes.captions = captions.sha256;
      delete hashReasons.captions;
    } else if (hashes.captions !== null) {
      fail('MISSING_BYTES', 'captions cues or bytes are required for a pinned caption hash');
    }

    productionId = assertSafeId(productionId, 'productionId');
    const archiveEntries = materializeArchive(input, archiveMode);
    const included = archiveEntries.filter((entry) => !entry.excluded);
    const excluded = archiveEntries.filter((entry) => entry.excluded)
      .map((entry) => ({ path: entry.path, reason: entry.reason }));

    const creditsText = renderCredits({ mode: archiveMode, credits, excluded });
    const archiveZip = createZip([
      ...included.map((entry) => ({ path: entry.path, data: entry.data })),
      { path: 'CREDITS.md', data: Buffer.from(creditsText, 'utf8') },
    ]);
    const archive = {
      mode: archiveMode,
      policy: archiveMode === 'private'
        ? 'authorized sources retained for the owner'
        : 'only redistributable sources are included',
      included: included.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        sha256: entry.sha256,
        bytes: entry.bytes,
      })),
      excluded,
      zip: { path: 'archive.zip', sha256: hashBytes(archiveZip), bytes: archiveZip.length },
    };

    const files = [
      { path: video.path, kind: 'video', sha256: video.sha256, bytes: video.bytes },
      ...(captions === null ? [] : [
        { path: 'captions.srt', kind: 'captions', sha256: hashText(captions.srt), bytes: Buffer.byteLength(captions.srt) },
        { path: 'captions.vtt', kind: 'captions', sha256: hashText(captions.vtt), bytes: Buffer.byteLength(captions.vtt) },
        ...(captions.wordsVtt === null ? [] : [{
          path: 'captions.words.vtt',
          kind: 'captions',
          sha256: hashText(captions.wordsVtt),
          bytes: Buffer.byteLength(captions.wordsVtt),
        }]),
      ]),
      { path: 'CREDITS.md', kind: 'credits', sha256: hashText(creditsText), bytes: Buffer.byteLength(creditsText) },
      { path: 'archive.zip', kind: 'archive', sha256: archive.zip.sha256, bytes: archive.zip.bytes },
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    const content = {
      schema: DELIVERY_SCHEMA,
      productionId,
      pins,
      selections,
      hashes,
      ...(Object.keys(hashReasons).length === 0 ? {} : { hashReasons }),
      provenance,
      reviews,
      output,
      archiveMode,
      archive,
      credits,
      ...(metadata === undefined ? {} : { metadata }),
      files,
      filePaths: files.map((file) => file.path),
    };
    const contentHash = hashText(canonicalJson(content));

    const paths = pathsFor(productionId);
    const release = acquireLock(paths);
    try {
      const existing = list(productionId);
      if (idempotencyKey !== null) {
        const prior = existing.find((manifest) => manifest.idempotencyKey === idempotencyKey);
        if (prior) {
          if (prior.contentHash !== contentHash) {
            fail('IDEMPOTENCY_CONFLICT', 'idempotencyKey was reused with different delivery content');
          }
          return {
            created: false,
            duplicate: true,
            version: prior.version,
            deliveryId: prior.deliveryId,
            dir: paths.versionDir(prior.version),
            manifest: clone(prior),
            contentHash: prior.contentHash,
            manifestHash: prior.manifestHash,
          };
        }
      }

      const current = existing.length === 0 ? 0 : existing[existing.length - 1].version;
      if (input.expectedVersion !== undefined) {
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
          fail('INVALID_VERSION', 'expectedVersion must be a non-negative integer');
        }
        if (input.expectedVersion !== current) {
          fail('REVISION_CONFLICT', 'expectedVersion does not match the latest committed delivery', {
            currentVersion: current,
            expectedVersion: input.expectedVersion,
          });
        }
      }

      const version = current + 1;
      const target = paths.versionDir(version);
      if (fs.existsSync(target)) fail('VERSION_EXISTS', 'delivery version already exists');
      const previousManifest = existing.length === 0 ? null : existing[existing.length - 1];
      const deliveryId = `dlv_${createHash('sha256')
        .update(`delivery\u0000${productionId}\u0000${version}\u0000${contentHash}`)
        .digest('hex')
        .slice(0, 24)}`;

      const base = {
        schema: DELIVERY_SCHEMA,
        version,
        deliveryId,
        productionId,
        createdAt: clockIso(clock),
        ...(idempotencyKey === null ? {} : { idempotencyKey }),
        pins,
        selections,
        hashes,
        ...(Object.keys(hashReasons).length === 0 ? {} : { hashReasons }),
        provenance,
        reviews,
        output,
        archiveMode,
        archive,
        credits,
        ...(metadata === undefined ? {} : { metadata }),
        files,
        filePaths: files.map((file) => file.path),
        previous: previousManifest === null ? null : {
          version: previousManifest.version,
          deliveryId: previousManifest.deliveryId,
          manifestHash: previousManifest.manifestHash,
          contentHash: previousManifest.contentHash,
        },
        contentHash,
      };
      const manifestHash = hashText(canonicalJson(base));
      const manifest = { ...base, manifestHash };

      tempSequence += 1;
      const temp = join(paths.deliveriesDir, `.tmp-${process.pid}-${tempSequence}`);
      fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
      try {
        writeFileAt(temp, video.path, video.data);
        if (captions !== null) {
          writeFileAt(temp, 'captions.srt', captions.srt);
          writeFileAt(temp, 'captions.vtt', captions.vtt);
          if (captions.wordsVtt !== null) writeFileAt(temp, 'captions.words.vtt', captions.wordsVtt);
        }
        writeFileAt(temp, 'CREDITS.md', creditsText);
        writeFileAt(temp, 'archive.zip', archiveZip);
        writeFileAt(temp, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
        fs.renameSync(temp, target);
      } catch (error) {
        try {
          fs.rmSync(temp, { recursive: true, force: true });
        } catch {
          // Preserve the original failure.
        }
        throw error;
      }

      return {
        created: true,
        duplicate: false,
        version,
        deliveryId,
        dir: target,
        manifest,
        contentHash,
        manifestHash,
      };
    } finally {
      release();
    }
  }

  return { pathsFor, publish, list, read, latest };
}

export default createDeliveryStore;
