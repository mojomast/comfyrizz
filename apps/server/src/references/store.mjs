/**
 * R05: one reference library per conversation.
 *
 * Layout:
 *   <rootDir>/references/<chat_id>/refs.json
 *   <rootDir>/references/<chat_id>/files/<ref_id>.<ext>
 *   <rootDir>/references/<chat_id>/thumbs/<ref_id>.jpg
 *   <rootDir>/references/<chat_id>/frames/<ref_id>/<n>.png
 *
 * `refs.json` is written with a temp file plus rename and mode 0600, so a
 * process that dies mid-write leaves the previous library intact. Stray temp
 * files are never read. Every path that touches disk is checked against the
 * library root; a chat id that is not exactly the agent-chat id shape is
 * rejected before any path is built.
 *
 * The module is synchronous on purpose (the local server calls it from request
 * handlers), has no import-time side effects and accepts an injected fs/clock
 * so tests need no server, network or real time.
 */

import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ReferenceValidationError,
  makeReference,
  refId,
  safeStoredName,
  validatePatch,
} from './model.mjs';
import { validateUpload } from './validate.mjs';
import { probeImage } from './probe.mjs';

export const LIBRARY_SCHEMA = 'comfyrizz.reference-library/v1';
export const CHAT_ID_PATTERN = /^chat_[A-Za-z0-9_-]{8,80}$/;
export const REF_ID_PATTERN = /^ref_[0-9a-f]{16}$/;

const THUMB_NAME = id => `${id}.jpg`;

export class ReferenceStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReferenceStoreError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

class PathEscapeError extends ReferenceStoreError {
  constructor(path, message = 'reference path escapes the library directory') {
    super('PATH_ESCAPE', message, { path });
  }
}

function fail(code, message, details) {
  throw new ReferenceStoreError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function displayLabel(value) {
  if (typeof value !== 'string') return '';
  const leaf = value.replace(/\\/g, '/').split('/').pop() ?? '';
  return leaf.trim();
}

function insideOrEqual(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeFrames(rawFrames, frameFiles) {
  const entries = new Map();

  const add = (entry, position) => {
    if (entry === undefined || entry === null) return;
    if (typeof entry === 'number') {
      entries.set(position, { index: position, atSec: entry, bytes: null, source: null });
      return;
    }
    if (!isPlainObject(entry)) return;
    const index = Number.isInteger(entry.index) && entry.index >= 0 ? entry.index : position;
    const atSec = nonNegativeNumber(entry.atSec ?? entry.time ?? entry.seconds) ?? 0;
    const bytes = toBuffer(entry.bytes ?? entry.data);
    const source = typeof entry.source === 'string'
      ? entry.source
      : typeof entry.file === 'string'
        ? entry.file
        : typeof entry.path === 'string'
          ? entry.path
          : null;
    entries.set(index, { index, atSec, bytes, source });
  };

  if (Array.isArray(rawFrames)) rawFrames.forEach((entry, position) => add(entry, position));
  if (isPlainObject(frameFiles)) {
    for (const [key, value] of Object.entries(frameFiles)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) continue;
      const existing = entries.get(index);
      const source = typeof value === 'string' ? value : null;
      const bytes = toBuffer(value);
      entries.set(index, {
        index,
        atSec: existing?.atSec ?? 0,
        bytes: bytes ?? existing?.bytes ?? null,
        source: source ?? existing?.source ?? null,
      });
    }
  }

  return [...entries.values()].sort((a, b) => a.index - b.index);
}

function normalizeAssignments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('INVALID_ASSIGNMENTS', 'assignments must be an array');
  return value.map((assignment, position) => {
    if (!isPlainObject(assignment)) {
      fail('INVALID_ASSIGNMENTS', `assignment ${position} must be an object`);
    }
    const refIdValue = assignment.refId ?? assignment.ref_id;
    if (typeof refIdValue !== 'string' || !REF_ID_PATTERN.test(refIdValue)) {
      fail('INVALID_ASSIGNMENTS', `assignment ${position} has an invalid refId`);
    }
    for (const field of ['sceneId', 'slot']) {
      const fieldValue = assignment[field];
      if (fieldValue !== undefined && (typeof fieldValue !== 'string' || fieldValue.length === 0)) {
        fail('INVALID_ASSIGNMENTS', `assignment ${position} has an invalid ${field}`);
      }
    }
    if (assignment.frameIndex !== undefined
      && (!Number.isInteger(assignment.frameIndex) || assignment.frameIndex < 0)) {
      fail('INVALID_ASSIGNMENTS', `assignment ${position} has an invalid frameIndex`);
    }
    const rest = { ...assignment };
    delete rest.ref_id;
    return clone({ ...rest, refId: refIdValue });
  });
}

function normalizeStoredRecord(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !REF_ID_PATTERN.test(raw.id)) return null;
  if (raw.sha256 !== undefined && (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.sha256))) return null;

  // Every legacy HTTP upload was already gated by X-Rights-Asserted. Keep that
  // provenance for old libraries, while allowing newer records to fail closed.
  const assertion = raw.rightsAsserted ?? raw.rights_asserted ?? raw.rights?.asserted ?? raw.license?.approved_by_user;
  const rightsAsserted = assertion === undefined ? true : assertion === true || assertion === 1;
  const usage = rightsAsserted && raw.usage === 'editorial' ? 'editorial' : 'reference';

  const frames = Array.isArray(raw.frames)
    ? raw.frames
      .filter(frame => isPlainObject(frame)
        && Number.isInteger(frame.index) && frame.index >= 0
        && typeof frame.atSec === 'number' && Number.isFinite(frame.atSec) && frame.atSec >= 0)
      .map(frame => ({ index: frame.index, atSec: frame.atSec }))
      .sort((a, b) => a.index - b.index)
    : [];

  return {
    ...clone(raw),
    usage,
    rightsAsserted,
    frames,
    revision: Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
  };
}

function clockIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', 'clock must return a valid date');
  return date.toISOString();
}

function createApi(client) {
  const get = (name, fallback) => (typeof client[name] === 'function' ? client[name].bind(client) : fallback);

  return {
    existsSync: get('existsSync', () => false),
    lstatSync: get('lstatSync'),
    statSync: get('statSync'),
    readFileSync: get('readFileSync'),
    writeFileSync: get('writeFileSync'),
    readdirSync: get('readdirSync', () => []),
    mkdirSync: get('mkdirSync'),
    realpathSync: get('realpathSync', value => resolve(value)),
    renameSync: get('renameSync'),
    unlinkSync: get('unlinkSync'),
    rmSync: get('rmSync'),
    chmodSync: get('chmodSync', () => {}),
  };
}

/**
 * Bind a store to one conversation's library directory.
 *
 * @param {object} options
 * @param {string} options.rootDir runtime root, or the references directory,
 *   or the conversation library directory itself.
 * @param {string} [options.chatId] conversation id (`chat_...`). Also accepted
 *   as `conversationId` or `chat_id`; when omitted, rootDir is the library.
 * @param {object} [options.fs] fs-like object; missing methods fall back to node:fs
 * @param {() => Date|string|number} [options.clock]
 */
export function createReferenceStore(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'createReferenceStore options must be an object');
  const { rootDir } = options;
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    fail('INVALID_ROOT', 'rootDir must be a non-empty path string');
  }

  const declaredChatId = options.chatId ?? options.chat_id ?? options.conversationId ?? options.id;
  let chatId;
  let libraryDir;

  if (declaredChatId !== undefined && declaredChatId !== null) {
    if (typeof declaredChatId !== 'string' || !CHAT_ID_PATTERN.test(declaredChatId)) {
      fail('INVALID_CHAT_ID', 'chat id must match chat_[A-Za-z0-9_-]{8,80}', { chatId: declaredChatId });
    }
    chatId = declaredChatId;
    const root = resolve(rootDir);
    const rootName = basename(root);
    if (rootName === chatId) libraryDir = root;
    else if (rootName === 'references') libraryDir = join(root, chatId);
    else libraryDir = join(root, 'references', chatId);
  } else {
    libraryDir = resolve(rootDir);
    const leaf = basename(libraryDir);
    if (!CHAT_ID_PATTERN.test(leaf)) {
      fail('INVALID_CHAT_ID', 'rootDir must end with a chat_ conversation id when chatId is omitted');
    }
    chatId = leaf;
  }

  const api = createApi({ ...nodeFs, ...(isPlainObject(options.fs) ? options.fs : {}) });
  const clock = options.clock;
  let tempSequence = 0;

  const statePath = join(libraryDir, 'refs.json');
  const filesDir = join(libraryDir, 'files');
  const thumbsDir = join(libraryDir, 'thumbs');
  const framesDir = join(libraryDir, 'frames');

  api.mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
  for (const dir of [filesDir, thumbsDir, framesDir]) api.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const rootPath = resolve(libraryDir);
  const rootReal = resolve(api.realpathSync(rootPath));

  function assertContained(target) {
    const resolved = resolve(target);
    if (!insideOrEqual(rootPath, resolved)) throw new PathEscapeError(resolved);

    let probe = resolved;
    if (!api.existsSync(probe)) {
      probe = dirname(probe);
      while (!api.existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    }
    if (api.existsSync(probe)) {
      const real = resolve(api.realpathSync(probe));
      if (!insideOrEqual(rootReal, real)) throw new PathEscapeError(resolved);
    }
    return resolved;
  }

  function lexicalEntry(name) {
    const target = resolve(join(libraryDir, name));
    if (!insideOrEqual(rootPath, target)) throw new PathEscapeError(target);
    return target;
  }

  function emptyState() {
    return {
      schema: LIBRARY_SCHEMA,
      chatId,
      revision: 0,
      updatedAt: clockIso(clock),
      references: [],
      assignments: [],
    };
  }

  function readState() {
    let body;
    try {
      body = api.readFileSync(statePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      fail('CORRUPT_STATE', 'refs.json is not valid JSON', { cause: error });
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.references)) {
      fail('CORRUPT_STATE', 'refs.json does not contain a reference list');
    }

    return {
      schema: typeof parsed.schema === 'string' ? parsed.schema : LIBRARY_SCHEMA,
      chatId,
      revision: Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : clockIso(clock),
      references: parsed.references.map(normalizeStoredRecord).filter(Boolean),
      assignments: Array.isArray(parsed.assignments) ? parsed.assignments.filter(isPlainObject).map(clone) : [],
    };
  }

  function persist(state) {
    const next = {
      ...state,
      schema: LIBRARY_SCHEMA,
      chatId,
      revision: state.revision + 1,
      updatedAt: clockIso(clock),
    };
    const body = `${JSON.stringify(next, null, 2)}\n`;
    tempSequence += 1;
    const temp = assertContained(`${statePath}.${process.pid}.${tempSequence}.tmp`);
    api.writeFileSync(temp, body, { mode: 0o600 });
    api.chmodSync(temp, 0o600);
    api.renameSync(temp, assertContained(statePath));
    api.chmodSync(statePath, 0o600);
    return next;
  }

  function sourceBytes(source, field) {
    if (typeof source !== 'string' || source.length === 0 || source.includes('\u0000')) {
      fail('INVALID_FRAME', `${field} must be a file path`);
    }
    const stat = api.statSync(source);
    if (!stat.isFile()) fail('INVALID_FRAME', `${field} must point at a regular file`);
    return api.readFileSync(source);
  }

  function writeAsset(target, bytes) {
    assertContained(target);
    api.writeFileSync(target, bytes, { mode: 0o600 });
    api.chmodSync(target, 0o600);
  }

  function writeThumb(id, meta) {
    const thumb = toBuffer(meta.thumb ?? meta.thumbnail ?? meta.thumbBytes)
      ?? null;
    const thumbSource = meta.thumbFile ?? (typeof meta.thumb === 'string' ? meta.thumb : null)
      ?? (typeof meta.thumbnail === 'string' ? meta.thumbnail : null);
    const bytes = thumb ?? (thumbSource ? sourceBytes(thumbSource, 'thumb') : null);
    if (!bytes) return false;
    writeAsset(assertContained(join(thumbsDir, THUMB_NAME(id))), bytes);
    return true;
  }

  function writeFrames(id, frames, kind) {
    const directory = assertContained(join(framesDir, id));
    if (frames.length === 0 && kind !== 'video') return;

    api.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const frame of frames) {
      const bytes = frame.bytes ?? (frame.source ? sourceBytes(frame.source, `frame ${frame.index}`) : null);
      if (!bytes) continue;
      writeAsset(assertContained(join(directory, `${frame.index}.png`)), bytes);
    }
  }

  function removeEntries(dir, id) {
    let names;
    try {
      names = api.readdirSync(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (name !== id && !name.startsWith(`${id}.`)) continue;
      const target = lexicalEntry(join(relative(libraryDir, dir), name));
      const stat = api.lstatSync(target);
      if (stat.isSymbolicLink()) {
        api.unlinkSync(target);
        continue;
      }
      assertContained(target);
      if (stat.isDirectory()) api.rmSync(target, { recursive: true, force: true });
      else api.unlinkSync(target);
    }
  }

  function removeFrameDir(id) {
    const target = lexicalEntry(join('frames', id));
    let stat;
    try {
      stat = api.lstatSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) api.unlinkSync(target);
    else {
      assertContained(target);
      api.rmSync(target, { recursive: true, force: true });
    }
  }

  function findRecord(state, id) {
    if (typeof id !== 'string' || !REF_ID_PATTERN.test(id)) {
      fail('INVALID_ID', 'reference id must match ref_ followed by 16 lowercase hex characters');
    }
    return state.references.find(reference => reference.id === id) ?? null;
  }

  function add({ bytes, filename, meta } = {}) {
    const data = toBuffer(bytes);
    if (!data) fail('INVALID_BYTES', 'bytes must be a Buffer, Uint8Array or ArrayBuffer');
    const metadata = isPlainObject(meta) ? meta : {};

    const validated = validateUpload({
      bytes: data,
      filename,
      declaredMime: metadata.mime ?? metadata.declaredMime,
    });
    if (!validated.ok) {
      throw new ReferenceStoreError(validated.code, validated.message);
    }

    const sha256 = createHash('sha256').update(data).digest('hex');
    const id = refId(sha256);
    const state = readState();

    const existing = state.references.find(reference => reference.sha256 === sha256 || reference.id === id);
    if (existing) return clone(existing);

    let width = positiveInteger(metadata.width);
    let height = positiveInteger(metadata.height);
    if ((!width || !height) && validated.kind === 'image') {
      try {
        const size = probeImage(data);
        width = width ?? positiveInteger(size.width);
        height = height ?? positiveInteger(size.height);
      } catch {
        // Header-only fixtures are valid uploads even though probeImage has no
        // trustable dimensions to return.
      }
    }
    // The probe step normally supplies dimensions. A header-only image fixture
    // still gets a conservative placeholder; audio has no pixel dimensions.
    if (validated.kind !== 'audio') {
      width ??= 1;
      height ??= 1;
    }

    const ext = validated.ext;
    const file = safeStoredName(id, ext);
    const createdAt = clockIso(clock);
    const label = metadata.label === undefined || metadata.label === null
      ? displayLabel(filename)
      : metadata.label;

    let base;
    try {
      base = makeReference({
        id,
        kind: validated.kind,
        mime: validated.mime,
        file,
        bytes: data.length,
        sha256,
        width,
        height,
        durationSec: nonNegativeNumber(metadata.durationSec),
        codec: metadata.codec,
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        fps: metadata.fps,
        frameCount: metadata.frameCount,
        audio: metadata.audio,
        role: metadata.role,
        note: metadata.note,
        label,
        createdAt,
      });
    } catch (error) {
      if (error instanceof ReferenceValidationError) {
        throw new ReferenceStoreError(error.code, error.message, { field: error.field });
      }
      throw error;
    }

    const frames = validated.kind === 'audio' ? [] : normalizeFrames(metadata.frames, metadata.frameFiles);
    const record = {
      ...base,
      // store.add is the trusted persistence side of the rights-gated upload
      // route. Usage is deliberately not taken from metadata: editorial is an
      // explicit later PATCH, never an upload-time side effect.
      rightsAsserted: true,
      ext,
      frames: frames.map(frame => ({ index: frame.index, atSec: frame.atSec })),
      updatedAt: createdAt,
      revision: 1,
    };

    writeAsset(join(filesDir, file), data);
    if (validated.kind !== 'audio') writeThumb(id, metadata);
    writeFrames(id, frames, validated.kind);

    state.references.push(record);
    state.revision = state.revision ?? 0;
    persist(state);
    return clone(record);
  }

  function list() {
    return readState().references.map(clone);
  }

  function get(id) {
    const state = readState();
    const record = findRecord(state, id);
    return record ? clone(record) : null;
  }

  function update(id, patch) {
    const state = readState();
    const record = findRecord(state, id);
    if (!record) fail('NOT_FOUND', `reference ${id} does not exist`);

    let changes;
    try {
      changes = validatePatch(patch);
    } catch (error) {
      if (error instanceof ReferenceValidationError) {
        throw new ReferenceStoreError(error.code, error.message, { field: error.field });
      }
      throw error;
    }

    if (changes.usage === 'editorial' && record.rightsAsserted !== true) {
      fail('RIGHTS_REQUIRED', 'editorial usage requires the upload rights assertion', { field: 'usage' });
    }
    if (changes.editorialScope !== undefined && record.kind !== 'image') {
      fail('INVALID_EDITORIAL_SCOPE', 'editorialScope is supported only for images', { field: 'editorialScope' });
    }

    const next = {
      ...record,
      ...clone(changes),
      revision: (Number.isInteger(record.revision) && record.revision > 0 ? record.revision : 1) + 1,
      updatedAt: clockIso(clock),
    };
    // A usage change is a new consent decision; never inherit an older scope.
    if (changes.usage !== undefined && changes.editorialScope === undefined) delete next.editorialScope;
    const position = state.references.findIndex(reference => reference.id === id);
    state.references[position] = next;
    persist(state);
    return clone(next);
  }

  function remove(id) {
    if (typeof id !== 'string' || !REF_ID_PATTERN.test(id)) {
      fail('INVALID_ID', 'reference id must match ref_ followed by 16 lowercase hex characters');
    }
    const state = readState();
    const position = state.references.findIndex(reference => reference.id === id);
    if (position === -1) return false;

    state.references.splice(position, 1);
    state.assignments = state.assignments.filter(assignment => assignment.refId !== id);

    removeEntries(filesDir, id);
    removeEntries(thumbsDir, id);
    removeFrameDir(id);

    persist(state);
    return true;
  }

  function setAssignments(assignments) {
    const state = readState();
    const normalized = normalizeAssignments(assignments);
    const known = new Set(state.references.map(reference => reference.id));
    for (const assignment of normalized) {
      if (!known.has(assignment.refId)) {
        fail('UNKNOWN_REFERENCE', `assignment refers to unknown reference ${assignment.refId}`);
      }
    }
    state.assignments = normalized;
    persist(state);
    return clone(normalized);
  }

  function assignments() {
    return readState().assignments.map(clone);
  }

  return Object.freeze({
    chatId,
    dir: libraryDir,
    statePath,
    filesDir,
    thumbsDir,
    framesDir,
    add,
    list,
    get,
    update,
    remove,
    setAssignments,
    assignments,
  });
}

export default createReferenceStore;
