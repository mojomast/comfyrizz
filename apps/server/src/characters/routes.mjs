import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import {
  CHARACTER_ID_RE,
  MAX_IMAGE_BYTES,
  primaryImage,
} from './model.mjs';
import {
  addToProject,
  detachCast,
  findCastEntry,
  reattachCast,
  removeFromProject,
  setCastOverrides,
  updateCast,
} from './cast.mjs';
import { IMAGE_EXTENSIONS, createCharacterStore } from './store.mjs';
import { CHAT_ID_PATTERN } from '../references/store.mjs';
import { serveStaticFile } from '../static-file.mjs';

export const CHARACTER_ROUTE_PATTERN = /^\/api\/characters(?:\/(.*))?$/;
export const CAST_ROUTE_PATTERN = /^\/api\/chat\/([^/]+)\/cast(?:\/(.*))?$/;
export const CHARACTER_ROUTE_PREFIX = '/api/characters';
export const CAST_ROUTE_SUFFIX = '/cast';
export const JSON_BODY_MAX_BYTES = 1024 * 1024;
export const UPLOAD_MAX_BYTES = MAX_IMAGE_BYTES;

const IMAGE_ID_RE = /^img_[0-9a-f]{16}$/;
const REVISION_RE = /^[0-9]{1,9}$/;
const DEFAULT_FILENAME = 'upload';
const MAX_FILENAME_CHARS = 512;
const IMAGE_EXTENSIONS_SET = new Set(IMAGE_EXTENSIONS.map(extension => `.${extension}`));
const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});
const OVERRIDE_KEYS = Object.freeze(['wardrobeId', 'expressionId', 'role']);
const OVERRIDE_KEY_SET = new Set(OVERRIDE_KEYS);
const CAST_PATCH_KEYS = new Set([
  'update',
  'refresh',
  'action',
  'characterId',
  'overrides',
  'replace',
  'detached',
  ...OVERRIDE_KEYS,
]);

const STATUS_BY_CODE = Object.freeze({
  NOT_FOUND: 404,
  INVALID_ID: 400,
  INVALID_INPUT: 400,
  INVALID_JSON: 400,
  INVALID_BODY: 400,
  INVALID_REVISION: 400,
  INVALID_CHAT_ID: 400,
  INVALID_FILENAME: 400,
  INVALID_BYTES: 400,
  EMPTY: 400,
  PATH_ESCAPE: 400,
  RIGHTS_REQUIRED: 400,
  METHOD_NOT_ALLOWED: 405,
  ID_EXISTS: 409,
  LIMIT: 409,
  CAST_LIMIT: 409,
  CAST_NOT_FOUND: 404,
  CAST_DUPLICATE_ID: 409,
  CAST_DUPLICATE_CHARACTER: 409,
  TOO_LARGE: 413,
  UNSUPPORTED_TYPE: 415,
  SVG_USE_BRAND: 415,
  NO_VIDEO_STREAM: 415,
  CORRUPT_STATE: 500,
});

class RouteError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
    this.status = status ?? statusForCode(code);
  }
}

function fail(code, message, status) {
  throw new RouteError(code, message, status);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendError(response, status, code, message) {
  return sendJson(response, status, { error: message, code });
}

function statusForCode(code) {
  if (STATUS_BY_CODE[code] !== undefined) return STATUS_BY_CODE[code];
  if (typeof code !== 'string') return 500;
  if (code.endsWith('_TOO_LONG') || code.endsWith('_TOO_LARGE')) return 400;
  if (code.startsWith('CHAR_')) return 400;
  if (code.startsWith('CAST_')) return 400;
  if (code.startsWith('IMAGE_')) return 400;
  return 500;
}

function errorBody(error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
  const status = Number.isSafeInteger(error?.status) ? error.status : statusForCode(code);
  const message = code === 'INTERNAL'
    ? 'character request failed'
    : typeof error?.message === 'string' && error.message
      ? error.message
      : 'character request failed';
  return { code, message, status };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function normalizeMime(value) {
  if (typeof value !== 'string') return '';
  return value.split(';')[0].trim().toLowerCase();
}

function isImageMime(mime) {
  return mime.startsWith('image/') || mime === 'application/octet-stream';
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.from(chunk);
}

function readLimited(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      request.off?.('data', onData);
      request.off?.('end', onEnd);
      request.off?.('error', onError);
    };
    const settle = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onData = chunk => {
      if (settled) return;
      const bytes = toBuffer(chunk);
      size += bytes.length;
      if (size > limit) {
        chunks.length = 0;
        settle({ ok: false, tooLarge: true, limit });
        request.pause?.();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => settle({ ok: true, bytes: Buffer.concat(chunks, size) });
    const onError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

function abortRequestAfterResponse(request, response) {
  const destroy = () => {
    try {
      request.destroy?.();
    } catch {
      // the response is already written
    }
  };
  if (typeof response.once === 'function') response.once('finish', destroy);
  else destroy();
}

function publish(events, payload) {
  const target = typeof events === 'function' ? events : events?.publish;
  if (typeof target !== 'function') return;
  try {
    target.call(events, payload);
  } catch {
    // observability must not fail the request
  }
}

function booleanParam(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function uploadFilename(request) {
  const raw = headerValue(request.headers ?? {}, 'x-filename');
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_FILENAME;
  if (raw.length > MAX_FILENAME_CHARS * 3) {
    fail('INVALID_FILENAME', 'X-Filename is too long');
  }
  const decoded = safeDecode(raw);
  if (decoded === null) fail('INVALID_FILENAME', 'X-Filename must be percent-encoded text');
  const leaf = decoded.replace(/\\/g, '/').split('/').pop() ?? '';
  return leaf.trim().slice(0, MAX_FILENAME_CHARS) || DEFAULT_FILENAME;
}

function resolveStore(options) {
  const direct = options.store ?? options.characterStore ?? options.characters;
  if (typeof direct === 'function') {
    let cached = null;
    return () => {
      if (!cached) {
        cached = direct();
      }
      if (!cached || typeof cached.create !== 'function') {
        throw new TypeError('store factory did not return a character store');
      }
      return cached;
    };
  }
  if (direct && typeof direct.create === 'function') {
    return () => direct;
  }
  const factory = options.storeFactory ?? options.createStore;
  if (typeof factory === 'function') {
    let cached = null;
    return () => {
      if (!cached) {
        cached = factory(options.rootDir ?? options.runtimeDir);
      }
      if (!cached || typeof cached.create !== 'function') {
        throw new TypeError('store factory did not return a character store');
      }
      return cached;
    };
  }
  const rootDir = options.rootDir ?? options.runtimeDir;
  if (typeof rootDir === 'string' && rootDir.length > 0) {
    let cached = null;
    return () => {
      if (!cached) {
        cached = createCharacterStore({
          rootDir,
          ...(options.fs ? { fs: options.fs } : {}),
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.randomId ? { randomId: options.randomId } : {}),
        });
      }
      return cached;
    };
  }
  throw new TypeError('createCharacterRoutes requires a store or rootDir');
}

function fileSessionStore(dir, fs) {
  let sequence = 0;
  const fileFor = chatId => join(dir, `${chatId}.json`);

  function read(chatId) {
    let body;
    try {
      body = fs.readFileSync(fileFor(chatId), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      fail('CORRUPT_STATE', `conversation ${chatId} is not valid JSON`, 500);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('CORRUPT_STATE', `conversation ${chatId} is malformed`, 500);
    }
    return parsed;
  }

  function write(chatId, session) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = fileFor(chatId);
    sequence += 1;
    const temp = `${target}.${process.pid}.${sequence}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
      if (typeof fs.chmodSync === 'function') fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, target);
      if (typeof fs.chmodSync === 'function') fs.chmodSync(target, 0o600);
    } catch (error) {
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        // best effort cleanup
      }
      throw error;
    }
  }

  return { read, write };
}

function resolveSessions(options) {
  const provided = options.sessionStore ?? options.sessions ?? options.castStore;
  if (provided) {
    const source = typeof provided === 'function' ? provided() : provided;
    const read = source.read ?? source.get ?? source.load;
    const write = source.write ?? source.save ?? source.set ?? source.update;
    if (typeof read !== 'function' || typeof write !== 'function') {
      throw new TypeError('session store must provide read and write');
    }
    return { read: read.bind(source), write: write.bind(source) };
  }
  if (typeof options.readSession === 'function' && typeof options.writeSession === 'function') {
    return { read: options.readSession, write: options.writeSession };
  }
  const runtimeDir = options.sessionDir
    ?? options.conversationDir
    ?? (typeof (options.runtimeDir ?? options.rootDir) === 'string'
      ? join(options.runtimeDir ?? options.rootDir, 'conversations')
      : null);
  if (!runtimeDir) return null;
  const fs = { ...nodeFs, ...(options.fs && typeof options.fs === 'object' ? options.fs : {}) };
  return fileSessionStore(runtimeDir, fs);
}

function readJsonBody(request) {
  return readLimited(request, JSON_BODY_MAX_BYTES).then(body => {
    if (!body.ok) {
      fail('TOO_LARGE', 'request body is too large', 413);
    }
    const text = body.bytes.toString('utf8');
    if (text.trim() === '') throw new RouteError('INVALID_JSON', 'request body must be JSON');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RouteError('INVALID_JSON', 'request body must be JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RouteError('INVALID_JSON', 'request body must be a JSON object');
    }
    return parsed;
  });
}

function characterIdInRoute(value) {
  if (typeof value !== 'string' || !CHARACTER_ID_RE.test(value)) {
    fail('INVALID_ID', 'character id must match chr_ followed by 16 lowercase hex characters');
  }
  return value;
}

function chatIdInRoute(value) {
  if (typeof value !== 'string' || !CHAT_ID_PATTERN.test(value)) {
    fail('INVALID_CHAT_ID', 'chat id must match chat_[A-Za-z0-9_-]{8,80}');
  }
  return value;
}

function imageIdInRoute(value) {
  if (typeof value !== 'string' || !IMAGE_ID_RE.test(value)) {
    fail('INVALID_ID', 'image id must match img_ followed by 16 lowercase hex characters');
  }
  return value;
}

function castIdInRoute(value) {
  if (typeof value !== 'string' || !/^c[A-Za-z0-9_-]{0,63}$/.test(value)) {
    fail('INVALID_ID', 'cast id must start with c and use letters, digits, _ or -');
  }
  return value;
}

function castOptionsFromBody(body) {
  const options = {};
  if (body.castId !== undefined) options.castId = body.castId;
  if (body.overrides !== undefined) options.overrides = body.overrides;
  for (const key of OVERRIDE_KEYS) {
    if (body[key] !== undefined) options[key] = body[key];
  }
  return options;
}

function overridePatchFromBody(body) {
  const patch = {};
  let present = false;
  if (body.overrides !== undefined) {
    if (!body.overrides || typeof body.overrides !== 'object' || Array.isArray(body.overrides)) {
      fail('INVALID_INPUT', 'overrides must be an object');
    }
    for (const key of Object.keys(body.overrides)) {
      if (!OVERRIDE_KEY_SET.has(key)) {
        fail('CAST_UNKNOWN_OVERRIDE', `unknown cast override ${key}`);
      }
    }
    for (const key of OVERRIDE_KEYS) {
      if (body.overrides[key] !== undefined) {
        patch[key] = body.overrides[key];
        present = true;
      }
    }
    if (body.replace === true) present = true;
  }
  for (const key of OVERRIDE_KEYS) {
    if (body[key] !== undefined) {
      patch[key] = body[key];
      present = true;
    }
  }
  return present ? patch : null;
}

function plainCast(cast) {
  return JSON.parse(JSON.stringify([...cast]));
}

function castForResponse(store, cast) {
  const library = new Set(store.list().map(character => character.id));
  return plainCast(cast).map(entry => ({
    ...entry,
    orphaned: entry.orphaned === true || !library.has(entry.characterId),
  }));
}

function findImage(character, imgId) {
  const images = Array.isArray(character?.visual?.images) ? character.visual.images : [];
  return images.find(image => image.imgId === imgId) ?? null;
}

function imageFile(store, id, imgId) {
  let names;
  try {
    names = nodeFs.readdirSync(store.imagesDir(id));
  } catch {
    return null;
  }
  const name = names.find(entry => {
    const ext = extname(entry).toLowerCase();
    return IMAGE_EXTENSIONS_SET.has(ext) && entry === `${imgId}${ext}`;
  });
  return name ? join(store.imagesDir(id), name) : null;
}

function mimeForFile(file) {
  return MIME_BY_EXTENSION[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function serveImage(request, response, file) {
  serveStaticFile(request, response, file, {
    'content-type': mimeForFile(file),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
}

function serveThumb(request, response, store, id, image) {
  const candidate = join(store.thumbsDir(id), `${image.imgId}.jpg`);
  if (nodeFs.existsSync(candidate) && nodeFs.statSync(candidate).isFile()) {
    serveStaticFile(request, response, candidate, {
      'content-type': 'image/jpeg',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    return;
  }
  const original = imageFile(store, id, image.imgId);
  if (!original) fail('NOT_FOUND', `image ${image.imgId} does not exist`);
  serveImage(request, response, original);
}

export function createCharacterRoutes(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createCharacterRoutes options must be an object');
  }
  const storeFor = resolveStore(options);
  const sessions = resolveSessions(options);
  const events = options.events;
  const thumbBuilder = options.thumbnail ?? options.thumb;

  function sessionStore() {
    if (!sessions) {
      fail('SESSION_UNAVAILABLE', 'the conversation store is not configured', 500);
    }
    return sessions;
  }

  async function readSession(chatId) {
    const session = await sessionStore().read(chatId);
    if (!session) fail('NOT_FOUND', `conversation ${chatId} does not exist`, 404);
    return session;
  }

  async function writeSessionCast(chatId, session, cast) {
    const next = {
      ...session,
      cast: plainCast(cast),
      revision: (Number.isSafeInteger(session.revision) ? session.revision : 0) + 1,
    };
    await sessionStore().write(chatId, next);
    return next;
  }

  function handleListCharacters(response) {
    sendJson(response, 200, { characters: storeFor().list() });
  }

  async function handleCreateCharacter(request, response) {
    const body = await readJsonBody(request);
    if (body.fictional === false || body.fictionalAcknowledged === false || body.fictionalConfirmed === false) {
      fail('CHAR_KIND_UNSUPPORTED', 'only fictional characters are supported');
    }
    const input = { ...body };
    delete input.fictional;
    delete input.fictionalAcknowledged;
    delete input.fictionalConfirmed;
    const store = storeFor();
    const character = store.create(input);
    publish(events, {
      type: 'character.created',
      characterId: character.id,
      name: character.name,
      revision: character.revision,
    });
    sendJson(response, 201, character);
  }

  function handleGetCharacter(response, id) {
    const character = storeFor().get(id);
    if (!character) fail('NOT_FOUND', `character ${id} does not exist`, 404);
    sendJson(response, 200, character);
  }

  async function handlePatchCharacter(request, response, id) {
    const body = await readJsonBody(request);
    const patch = { ...body };
    if (patch.fictional === false || patch.fictionalAcknowledged === false || patch.fictionalConfirmed === false) {
      fail('CHAR_KIND_UNSUPPORTED', 'only fictional characters are supported');
    }
    delete patch.fictional;
    delete patch.fictionalAcknowledged;
    delete patch.fictionalConfirmed;
    const store = storeFor();
    if (!store.get(id)) fail('NOT_FOUND', `character ${id} does not exist`, 404);
    const character = store.update(id, patch);
    publish(events, {
      type: 'character.updated',
      characterId: character.id,
      revision: character.revision,
    });
    sendJson(response, 200, character);
  }

  function handleDeleteCharacter(response, id) {
    const store = storeFor();
    const removed = store.remove(id);
    if (!removed) fail('NOT_FOUND', `character ${id} does not exist`, 404);
    publish(events, { type: 'character.removed', characterId: id });
    response.writeHead(204, {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end();
  }

  function handleListRevisions(response, id) {
    const store = storeFor();
    const character = store.get(id);
    if (!character) fail('NOT_FOUND', `character ${id} does not exist`, 404);
    sendJson(response, 200, {
      characterId: id,
      current: character.revision,
      revisions: store.listRevisions(id),
    });
  }

  function handleGetRevision(response, id, revision) {
    if (!REVISION_RE.test(revision)) {
      fail('INVALID_REVISION', 'revision must be a positive integer');
    }
    const number = Number(revision);
    if (number < 1) fail('INVALID_REVISION', 'revision must be a positive integer');
    const store = storeFor();
    if (!store.get(id)) fail('NOT_FOUND', `character ${id} does not exist`, 404);
    const snapshot = store.getRevision(id, number);
    if (!snapshot) fail('NOT_FOUND', `revision ${number} does not exist`, 404);
    sendJson(response, 200, snapshot);
  }

  function handleListImages(response, id) {
    const character = storeFor().get(id);
    if (!character) fail('NOT_FOUND', `character ${id} does not exist`, 404);
    sendJson(response, 200, { images: character.visual.images });
  }

  function handlePrimaryThumb(request, response, id) {
    const character = storeFor().get(id);
    if (!character) fail('NOT_FOUND', `character ${id} does not exist`, 404);
    const image = primaryImage(character);
    if (!image) fail('NOT_FOUND', `character ${id} has no primary image`, 404);
    serveThumb(request, response, storeFor(), id, image);
  }

  function handleGetImage(request, response, id, imgId) {
    const store = storeFor();
    const character = store.get(id);
    if (!character) fail('NOT_FOUND', `character ${id} does not exist`, 404);
    const image = findImage(character, imgId);
    if (!image) fail('NOT_FOUND', `image ${imgId} does not exist`, 404);
    const file = imageFile(store, id, imgId);
    if (!file) fail('NOT_FOUND', `image ${imgId} does not exist`, 404);
    serveImage(request, response, file);
  }

  function handleGetThumb(request, response, id, imgId) {
    const store = storeFor();
    const character = store.get(id);
    if (!character) fail('NOT_FOUND', `character ${id} does not exist`, 404);
    const image = findImage(character, imgId);
    if (!image) fail('NOT_FOUND', `image ${imgId} does not exist`, 404);
    serveThumb(request, response, store, id, image);
  }

  async function handleUploadImage(request, response, id, searchParams) {
    const rights = headerValue(request.headers ?? {}, 'x-rights-asserted');
    if (typeof rights !== 'string' || rights.trim() !== '1') {
      abortRequestAfterResponse(request, response);
      fail('RIGHTS_REQUIRED', 'X-Rights-Asserted: 1 is required');
    }

    const declared = normalizeMime(headerValue(request.headers ?? {}, 'content-type'));
    if (!declared) {
      abortRequestAfterResponse(request, response);
      fail('INVALID_BODY', 'Content-Type must be the image MIME type');
    }
    if (!isImageMime(declared)) {
      abortRequestAfterResponse(request, response);
      fail('UNSUPPORTED_TYPE', 'character images must be PNG, JPEG or WEBP', 415);
    }

    const declaredLength = Number(headerValue(request.headers ?? {}, 'content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > UPLOAD_MAX_BYTES) {
      abortRequestAfterResponse(request, response);
      fail('TOO_LARGE', `upload exceeds the ${UPLOAD_MAX_BYTES} byte limit`, 413);
    }

    const store = storeFor();
    if (!store.get(id)) {
      abortRequestAfterResponse(request, response);
      fail('NOT_FOUND', `character ${id} does not exist`, 404);
    }

    let body;
    try {
      body = await readLimited(request, UPLOAD_MAX_BYTES);
    } catch {
      fail('INVALID_BODY', 'could not read the upload stream');
    }
    if (!body.ok) {
      abortRequestAfterResponse(request, response);
      fail('TOO_LARGE', `upload exceeds the ${UPLOAD_MAX_BYTES} byte limit`, 413);
    }
    if (body.bytes.length === 0) fail('EMPTY', 'file is empty');

    const view = searchParams?.get('view') ?? headerValue(request.headers ?? {}, 'x-image-view') ?? undefined;
    const primary = booleanParam(searchParams?.get('primary')
      ?? headerValue(request.headers ?? {}, 'x-image-primary'));
    const filename = uploadFilename(request);
    const sha256 = createHash('sha256').update(body.bytes).digest('hex');
    const before = store.get(id);
    const duplicate = (before.visual.images ?? []).some(image => image.sha256 === sha256);

    let thumb = null;
    if (typeof thumbBuilder === 'function' && !duplicate) {
      try {
        const built = await thumbBuilder({
          bytes: body.bytes,
          mime: declared,
          filename,
          view,
        });
        if (built) thumb = Buffer.isBuffer(built) ? built : toBuffer(built);
      } catch {
        thumb = null;
      }
    }

    const image = store.addImage(id, {
      bytes: body.bytes,
      filename,
      ...(view !== undefined ? { view } : {}),
      ...(primary !== undefined ? { primary } : {}),
      source: 'upload',
      ...(thumb ? { thumb } : {}),
    }, {});
    const character = storeFor().get(id);
    if (!duplicate) {
      publish(events, {
        type: 'character.image.added',
        characterId: id,
        imgId: image.imgId,
        revision: character.revision,
      });
    }
    sendJson(response, duplicate ? 200 : 201, { image, character });
  }

  function handleListCast(response, session) {
    const cast = Array.isArray(session.cast) ? session.cast : [];
    sendJson(response, 200, { cast: castForResponse(storeFor(), cast) });
  }

  async function handleAddCast(request, response, chatId) {
    const body = await readJsonBody(request);
    const characterId = body.characterId ?? body.id;
    if (typeof characterId !== 'string') {
      fail('INVALID_INPUT', 'characterId is required');
    }
    const character = storeFor().get(characterId.trim());
    if (!character) fail('NOT_FOUND', `character ${characterId} does not exist`, 404);
    const session = await readSession(chatId);
    const current = Array.isArray(session.cast) ? session.cast : [];
    const result = addToProject(current, character, castOptionsFromBody(body));
    const entry = result.entry;
    if (result.added !== true) {
      sendJson(response, 200, {
        cast: castForResponse(storeFor(), result),
        entry,
        castId: entry.castId,
        added: false,
      });
      return;
    }
    const next = await writeSessionCast(chatId, session, result);
    publish(events, {
      type: 'character.cast.added',
      chatId,
      castId: entry.castId,
      characterId: entry.characterId,
      revision: entry.pinnedRevision,
      added: true,
      sessionRevision: next.revision,
    });
    sendJson(response, 201, {
      cast: castForResponse(storeFor(), result),
      entry,
      castId: entry.castId,
      added: true,
    });
  }

  async function handlePatchCast(request, response, chatId, castId) {
    const body = await readJsonBody(request);
    for (const key of Object.keys(body)) {
      if (!CAST_PATCH_KEYS.has(key)) {
        fail('CAST_UNKNOWN_FIELD', `unknown cast field ${key}`);
      }
    }
    const session = await readSession(chatId);
    let cast = Array.isArray(session.cast) ? session.cast : [];
    if (!findCastEntry(cast, castId)) {
      fail('NOT_FOUND', `cast member ${castId} does not exist`, 404);
    }

    let entry = null;
    let type = 'character.cast.updated';
    let changed = false;

    const wantsUpdate = body.update === true
      || body.refresh === true
      || body.action === 'update'
      || body.characterId !== undefined;
    if (wantsUpdate) {
      const current = findCastEntry(cast, castId);
      const characterId = body.characterId === undefined
        ? current.characterId
        : String(body.characterId).trim();
      if (characterId !== current.characterId) {
        fail('INVALID_INPUT', 'characterId must match the cast entry');
      }
      const character = storeFor().get(characterId);
      if (!character) fail('NOT_FOUND', `character ${characterId} does not exist`, 404);
      const result = updateCast(cast, castId, character);
      cast = result;
      entry = result.entry;
      changed = changed || result.updated === true;
      type = 'character.cast.updated';
    }

    const overrides = overridePatchFromBody(body);
    if (overrides) {
      const result = setCastOverrides(cast, castId, overrides, { replace: body.replace === true });
      cast = result;
      entry = result.entry;
      changed = true;
      type = 'character.cast.updated';
    }

    const detach = body.action === 'detach' || body.detached === true;
    const attach = body.action === 'attach' || body.detached === false;
    if (detach) {
      const result = detachCast(cast, castId);
      cast = result;
      entry = result.entry;
      changed = changed || result.changed === true;
      type = 'character.cast.detached';
    } else if (attach) {
      const result = reattachCast(cast, castId);
      cast = result;
      entry = result.entry;
      changed = changed || result.changed === true;
      type = 'character.cast.attached';
    }

    if (!entry) entry = findCastEntry(cast, castId);
    if (!changed) {
      sendJson(response, 200, { cast: castForResponse(storeFor(), cast), entry, changed: false });
      return;
    }

    const next = await writeSessionCast(chatId, session, cast);
    publish(events, {
      type,
      chatId,
      castId: entry.castId,
      characterId: entry.characterId,
      revision: entry.pinnedRevision,
      sessionRevision: next.revision,
    });
    sendJson(response, 200, { cast: castForResponse(storeFor(), cast), entry, changed: true });
  }

  async function handleCastAction(request, response, chatId, castId, action) {
    request.resume?.();
    const session = await readSession(chatId);
    let cast = Array.isArray(session.cast) ? session.cast : [];
    if (!findCastEntry(cast, castId)) {
      fail('NOT_FOUND', `cast member ${castId} does not exist`, 404);
    }

    let entry;
    let type;
    let changed;
    if (action === 'update') {
      const current = findCastEntry(cast, castId);
      const character = storeFor().get(current.characterId);
      if (!character) fail('NOT_FOUND', `character ${current.characterId} does not exist`, 404);
      const result = updateCast(cast, castId, character);
      cast = result;
      entry = result.entry;
      changed = result.updated === true;
      type = 'character.cast.updated';
    } else if (action === 'detach') {
      const result = detachCast(cast, castId);
      cast = result;
      entry = result.entry;
      changed = result.changed === true;
      type = 'character.cast.detached';
    } else {
      const result = reattachCast(cast, castId);
      cast = result;
      entry = result.entry;
      changed = result.changed === true;
      type = 'character.cast.attached';
    }

    if (changed) {
      const next = await writeSessionCast(chatId, session, cast);
      publish(events, {
        type,
        chatId,
        castId: entry.castId,
        characterId: entry.characterId,
        revision: entry.pinnedRevision,
        sessionRevision: next.revision,
      });
    }
    sendJson(response, 200, { cast: castForResponse(storeFor(), cast), entry, changed });
  }

  async function handleRemoveCast(response, chatId, castId) {
    const session = await readSession(chatId);
    const cast = Array.isArray(session.cast) ? session.cast : [];
    const result = removeFromProject(cast, castId);
    const next = await writeSessionCast(chatId, session, result);
    publish(events, {
      type: 'character.cast.removed',
      chatId,
      castId: result.entry.castId,
      characterId: result.entry.characterId,
      sessionRevision: next.revision,
    });
    sendJson(response, 200, { cast: castForResponse(storeFor(), result), removed: result.entry.castId });
  }

  async function handleCharacters(request, response, rest, searchParams) {
    const method = String(request.method ?? 'GET').toUpperCase();
    const decoded = rest === '' ? [] : rest.split('/').map(safeDecode);
    if (decoded.some(part => part === null)) {
      sendError(response, 400, 'INVALID_ID', 'path contains malformed percent encoding');
      return true;
    }

    if (decoded.length === 0) {
      if (method === 'GET') handleListCharacters(response);
      else if (method === 'POST') await handleCreateCharacter(request, response);
      else sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      return true;
    }

    const id = characterIdInRoute(decoded[0]);

    if (decoded.length === 1) {
      if (method === 'GET') handleGetCharacter(response, id);
      else if (method === 'PATCH' || method === 'PUT') await handlePatchCharacter(request, response, id);
      else if (method === 'DELETE') handleDeleteCharacter(response, id);
      else sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      return true;
    }

    if (decoded.length === 2 && decoded[1] === 'revisions') {
      if (method !== 'GET') {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
        return true;
      }
      handleListRevisions(response, id);
      return true;
    }

    if (decoded.length === 3 && decoded[1] === 'revisions') {
      if (method !== 'GET') {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
        return true;
      }
      handleGetRevision(response, id, decoded[2]);
      return true;
    }

    if (decoded.length === 2 && decoded[1] === 'images') {
      if (method === 'GET') handleListImages(response, id);
      else if (method === 'POST') await handleUploadImage(request, response, id, searchParams);
      else sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      return true;
    }

    if (decoded.length === 2 && decoded[1] === 'thumb') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
        return true;
      }
      handlePrimaryThumb(request, response, id);
      return true;
    }

    if (decoded.length === 3 && decoded[1] === 'thumbs') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
        return true;
      }
      handleGetThumb(request, response, id, imageIdInRoute(decoded[2]));
      return true;
    }

    if (decoded.length >= 3 && decoded[1] === 'images') {
      const imgId = imageIdInRoute(decoded[2]);
      if (decoded.length === 3) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        handleGetImage(request, response, id, imgId);
        return true;
      }
      if (decoded.length === 4 && (decoded[3] === 'thumb' || decoded[3] === 'file')) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        if (decoded[3] === 'thumb') handleGetThumb(request, response, id, imgId);
        else handleGetImage(request, response, id, imgId);
        return true;
      }
    }

    sendError(response, 404, 'NOT_FOUND', 'not found');
    return true;
  }

  async function handleCast(request, response, chatIdRaw, rest) {
    const method = String(request.method ?? 'GET').toUpperCase();
    const chatId = chatIdInRoute(safeDecode(chatIdRaw));
    const decoded = rest === '' ? [] : rest.split('/').map(safeDecode);
    if (decoded.some(part => part === null)) {
      sendError(response, 400, 'INVALID_ID', 'path contains malformed percent encoding');
      return true;
    }

    if (decoded.length === 0) {
      if (method === 'GET') {
        const session = await readSession(chatId);
        handleListCast(response, session);
      } else if (method === 'POST') {
        await handleAddCast(request, response, chatId);
      } else {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      }
      return true;
    }

    const castId = castIdInRoute(decoded[0]);

    if (decoded.length === 1) {
      if (method === 'PATCH' || method === 'PUT' || method === 'POST') {
        await handlePatchCast(request, response, chatId, castId);
      } else if (method === 'DELETE') {
        await handleRemoveCast(response, chatId, castId);
      } else if (method === 'GET') {
        const session = await readSession(chatId);
        const cast = Array.isArray(session.cast) ? session.cast : [];
        const entry = findCastEntry(cast, castId);
        if (!entry) fail('NOT_FOUND', `cast member ${castId} does not exist`, 404);
        sendJson(response, 200, {
          ...entry,
          orphaned: castForResponse(storeFor(), [entry])[0].orphaned,
        });
      } else {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      }
      return true;
    }

    if (decoded.length === 2 && ['update', 'detach', 'attach'].includes(decoded[1])) {
      if (method !== 'POST' && method !== 'PATCH') {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
        return true;
      }
      await handleCastAction(request, response, chatId, castId, decoded[1]);
      return true;
    }

    sendError(response, 404, 'NOT_FOUND', 'not found');
    return true;
  }

  async function handle(request, response, url) {
    let parsed;
    try {
      parsed = typeof url === 'string' ? new URL(url, 'http://127.0.0.1') : url;
    } catch {
      return false;
    }
    const pathname = parsed?.pathname;
    if (typeof pathname !== 'string') return false;

    const characterMatch = CHARACTER_ROUTE_PATTERN.exec(pathname);
    const castMatch = CHARACTER_ROUTE_PATTERN.test(pathname) ? null : CAST_ROUTE_PATTERN.exec(pathname);
    if (!characterMatch && !castMatch) return false;

    try {
      if (characterMatch) {
        return await handleCharacters(request, response, characterMatch[1] ?? '', parsed.searchParams);
      }
      return await handleCast(request, response, castMatch[1], castMatch[2] ?? '');
    } catch (error) {
      if (response.headersSent) {
        response.destroy?.(error);
        return true;
      }
      const { code, message, status } = errorBody(error);
      if (code === 'TOO_LARGE') abortRequestAfterResponse(request, response);
      sendError(response, status, code, message);
      return true;
    }
  }

  return Object.freeze({ handle });
}

export const createRoutes = createCharacterRoutes;
export const createCharacterHttpRoutes = createCharacterRoutes;
export default createCharacterRoutes;
