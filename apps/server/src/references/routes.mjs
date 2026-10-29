/**
 * R08: HTTP routes for one conversation's reference library.
 *
 * The handler is deliberately transport-thin: it matches
 * `/api/chat/:chatId/references...`, validates request headers and the chat id,
 * streams uploads under their own cap and delegates persistence to an injected
 * store factory. No auth, runtime dir or app state is imported here so that
 * `app.mjs` can mount the routes without giving this module side effects.
 *
 * Upload order is validate -> probe -> thumbnail/frames -> store. Derivative
 * generation is best effort: a machine without ffmpeg can still upload an
 * image, and a video probe failure is reported as a client error instead of a
 * partial library record.
 */

import * as nodeFs from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_REFERENCES,
  MAX_TOTAL_BYTES,
  MAX_VIDEO_BYTES,
  validateUpload,
} from './validate.mjs';
import { probeAudio, probeImage, probeVideo } from './probe.mjs';
import { DEFAULT_KEYFRAME_COUNT, extractFrames, thumbArgs } from './frames.mjs';
import { CHAT_ID_PATTERN, REF_ID_PATTERN, createReferenceStore } from './store.mjs';
import { serveStaticFile } from '../static-file.mjs';

export const REFERENCE_ROUTE_PATTERN = /^\/api\/chat\/([^/]+)\/references(?:\/(.*))?$/;
export const PATCH_MAX_BYTES = 1024 * 1024;

const DEFAULT_FILENAME = 'upload';
const MAX_FILENAME_CHARS = 512;
const MAX_LABEL_CHARS = 80;

const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
});

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

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
  if (code === 'TOO_LARGE' || code === 'TOO_LONG' || code === 'TOO_MANY_REFERENCES' || code === 'TOTAL_TOO_LARGE') {
    return 413;
  }
  if (code === 'UNSUPPORTED_TYPE' || code === 'SVG_USE_BRAND' || code === 'NO_VIDEO_STREAM' || code === 'NO_AUDIO_STREAM') return 415;
  if (code === 'NOT_FOUND') return 404;
  return 400;
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

function isUploadMime(mime) {
  return mime.startsWith('image/')
    || mime.startsWith('video/')
    || mime.startsWith('audio/')
    || mime === 'application/octet-stream';
}

function uploadLimitFor(mime) {
  if (mime.startsWith('image/')) return MAX_IMAGE_BYTES;
  if (mime.startsWith('audio/')) return MAX_AUDIO_BYTES;
  return MAX_VIDEO_BYTES;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function displayLabel(value) {
  const decoded = safeDecode(String(value ?? ''));
  if (decoded === null) return null;
  const leaf = decoded.replace(/\\/g, '/').split('/').pop() ?? '';
  const text = leaf.replace(CONTROL_CHARS, '').trim();
  if (!text) return DEFAULT_FILENAME;
  return text.slice(0, MAX_LABEL_CHARS);
}

function recordMime(record) {
  if (typeof record?.mime === 'string' && record.mime) return record.mime;
  return MIME_BY_EXTENSION[extname(record?.file ?? '').toLowerCase()] ?? 'application/octet-stream';
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.from(chunk);
}

function defaultExec(command, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

/** Read a stream without ever retaining more than `limit` bytes. */
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
      if (settled) return false;
      settled = true;
      cleanup();
      resolve(value);
      return true;
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
      // best effort; the response is already written
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
    // Events are observability; a broken listener must not fail the request.
  }
}

function resolveStoreFactory(options) {
  const factory = options.createStore ?? options.storeFactory ?? options.store;
  if (typeof factory === 'function') return factory;
  if (factory && typeof factory.create === 'function') return chatId => factory.create(chatId);
  if (typeof options.rootDir === 'string' && options.rootDir) {
    return chatId => createReferenceStore({
      rootDir: options.rootDir,
      chatId,
      fs: options.fs,
      clock: options.clock,
    });
  }
  throw new TypeError('createReferenceRoutes requires a store factory');
}

function errorBody(error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
  const message = code === 'INTERNAL'
    ? 'reference request failed'
    : typeof error?.message === 'string' && error.message
      ? error.message
      : 'reference request failed';
  return { code, message };
}

/**
 * @param {object} options
 * @param {(chatId: string) => object} options.store store factory, one library per chat
 * @param {Function} [options.exec] exec(cmd, args, {timeoutMs}) used by ffprobe/ffmpeg
 * @param {{publish: Function}|Function} [options.events] event sink
 * @param {object} [options.fs] fs-like object (tests)
 * @param {Function} [options.clock] clock for stores created from options.rootDir
 */
export function createReferenceRoutes(options = {}) {
  const factory = resolveStoreFactory(options);
  const exec = typeof options.exec === 'function' ? options.exec : defaultExec;
  const events = options.events;
  const fs = { ...nodeFs, ...(options.fs && typeof options.fs === 'object' ? options.fs : {}) };
  const probeVideoImpl = typeof options.probeVideo === 'function' ? options.probeVideo : probeVideo;
  const probeAudioImpl = typeof options.probeAudio === 'function' ? options.probeAudio : probeAudio;
  const extractFramesImpl = typeof options.extractFrames === 'function' ? options.extractFrames : extractFrames;

  async function storeFor(chatId) {
    const store = await factory(chatId);
    if (!store || typeof store.add !== 'function') {
      throw new TypeError('store factory did not return a reference store');
    }
    return store;
  }

  function stagingRoot(store) {
    if (typeof store.dir === 'string' && store.dir) {
      try {
        fs.mkdirSync(store.dir, { recursive: true, mode: 0o700 });
        return store.dir;
      } catch {
        // fall through to the OS temp dir
      }
    }
    return tmpdir();
  }

  function readPatch(request) {
    return readLimited(request, PATCH_MAX_BYTES);
  }

  async function handleUpload(request, response, chatId) {
    const headers = request.headers ?? {};
    const rights = headerValue(headers, 'x-rights-asserted');
    if (typeof rights !== 'string' || rights.trim() !== '1') {
      sendError(response, 400, 'RIGHTS_REQUIRED', 'X-Rights-Asserted: 1 is required');
      return true;
    }

    const declared = normalizeMime(headerValue(headers, 'content-type'));
    if (!declared) {
      sendError(response, 400, 'MISSING_CONTENT_TYPE', 'Content-Type must be the file MIME type');
      return true;
    }
    if (!isUploadMime(declared)) {
      sendError(response, 415, 'UNSUPPORTED_TYPE', 'unsupported Content-Type');
      return true;
    }

    let filename = DEFAULT_FILENAME;
    const rawFilename = headerValue(headers, 'x-filename');
    if (typeof rawFilename === 'string' && rawFilename.length > 0) {
      if (rawFilename.length > MAX_FILENAME_CHARS * 3) {
        sendError(response, 400, 'INVALID_FILENAME', 'X-Filename is too long');
        return true;
      }
      const decoded = displayLabel(rawFilename);
      if (decoded === null) {
        sendError(response, 400, 'INVALID_FILENAME', 'X-Filename must be percent-encoded text');
        return true;
      }
      filename = decoded;
    }

    const limit = uploadLimitFor(declared);
    const declaredLength = Number(headerValue(headers, 'content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      abortRequestAfterResponse(request, response);
      sendError(response, 413, 'TOO_LARGE', `upload exceeds the ${limit} byte limit`);
      return true;
    }

    let body;
    try {
      body = await readLimited(request, limit);
    } catch {
      sendError(response, 400, 'INVALID_BODY', 'could not read the upload stream');
      return true;
    }
    if (!body.ok) {
      abortRequestAfterResponse(request, response);
      sendError(response, 413, 'TOO_LARGE', `upload exceeds the ${limit} byte limit`);
      return true;
    }
    if (body.bytes.length === 0) {
      sendError(response, 400, 'EMPTY', 'file is empty');
      return true;
    }

    const validated = validateUpload({
      bytes: body.bytes,
      filename,
      declaredMime: declared,
    });
    if (!validated.ok) {
      sendError(response, statusForCode(validated.code), validated.code, validated.message);
      return true;
    }

    let store;
    try {
      store = await storeFor(chatId);
    } catch (error) {
      const { code, message } = errorBody(error);
      sendError(response, statusForCode(code), code, message);
      return true;
    }

    const sha256 = createHash('sha256').update(body.bytes).digest('hex');
    let existing;
    try {
      existing = store.list().find(reference => reference.sha256 === sha256);
    } catch (error) {
      const { code, message } = errorBody(error);
      sendError(response, 500, code, message);
      return true;
    }
    if (existing) {
      sendJson(response, 200, { ...existing, ...(validated.warning ? { warnings: validated.warnings } : {}) });
      return true;
    }

    let refs;
    try {
      refs = store.list();
    } catch (error) {
      const { code, message } = errorBody(error);
      sendError(response, 500, code, message);
      return true;
    }
    if (refs.length >= MAX_REFERENCES) {
      sendError(response, 413, 'TOO_MANY_REFERENCES', `a conversation can hold at most ${MAX_REFERENCES} references`);
      return true;
    }
    const totalBytes = refs.reduce((sum, reference) => sum + (Number(reference.bytes) || 0), 0);
    if (totalBytes + body.bytes.length > MAX_TOTAL_BYTES) {
      sendError(response, 413, 'TOTAL_TOO_LARGE', 'the conversation reference library is full');
      return true;
    }

    const root = stagingRoot(store);
    let staging;
    try {
      staging = fs.mkdtempSync(join(root, '.upload-'));
    } catch (error) {
      const { code, message } = errorBody(error);
      sendError(response, 500, code, message);
      return true;
    }

    try {
      const meta = {
        mime: validated.mime,
        label: filename,
      };
      const source = join(staging, `source.${validated.ext}`);
      fs.writeFileSync(source, body.bytes, { mode: 0o600 });

      if (validated.kind === 'image') {
        try {
          const size = probeImage(body.bytes);
          meta.width = size.width;
          meta.height = size.height;
        } catch {
          // The store falls back to a conservative size for header fixtures.
        }
        try {
          const thumb = join(staging, 'thumb.jpg');
          await exec('ffmpeg', thumbArgs(source, thumb), { timeoutMs: 30_000 });
          if (fs.existsSync(thumb)) meta.thumbFile = thumb;
        } catch {
          // A thumbnail is a convenience; the original is still usable.
        }
      } else if (validated.kind === 'video') {
        let probed;
        try {
          probed = await probeVideoImpl(source, { exec });
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'PROBE_FAILED';
          sendError(response, statusForCode(code), code, error?.message ?? 'could not probe the video');
          return true;
        }
        meta.width = probed.width;
        meta.height = probed.height;
        meta.durationSec = probed.durationSec;
        if (probed.fps !== undefined && probed.fps !== null) meta.fps = probed.fps;
        if (probed.frames !== undefined && probed.frames !== null) meta.frameCount = probed.frames;
        if (probed.audio !== undefined && probed.audio !== null) meta.audio = probed.audio;

        let frames = [];
        try {
          const extracted = await extractFramesImpl(source, join(staging, 'frames'), {
            exec,
            durationSec: probed.durationSec,
            count: DEFAULT_KEYFRAME_COUNT,
          });
          frames = extracted.filter(frame => frame && fs.existsSync(frame.file));
        } catch {
          frames = [];
        }
        if (frames.length > 0) {
          meta.frames = frames.map(frame => ({ index: frame.index, atSec: frame.atSec, file: frame.file }));
          try {
            const thumb = join(staging, 'thumb.jpg');
            await exec('ffmpeg', thumbArgs(frames[0].file, thumb), { timeoutMs: 30_000 });
            if (fs.existsSync(thumb)) meta.thumbFile = thumb;
          } catch {
            // no poster thumbnail; frames are still available
          }
        }
      } else if (validated.kind === 'audio') {
        let probed;
        try {
          probed = await probeAudioImpl(source, { exec });
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'PROBE_FAILED';
          sendError(response, statusForCode(code), code, error?.message ?? 'could not probe the audio');
          return true;
        }
        meta.durationSec = probed.durationSec;
        meta.codec = probed.codec;
        meta.sampleRate = probed.sampleRate;
        meta.channels = probed.channels;
      }

      let record;
      try {
        record = store.add({ bytes: body.bytes, filename, meta });
      } catch (error) {
        const { code, message } = errorBody(error);
        sendError(response, statusForCode(code), code, message);
        return true;
      }

      publish(events, {
        type: 'reference.added',
        chatId,
        refId: record.id,
        kind: record.kind,
        role: record.role,
        usage: record.usage,
        bytes: record.bytes,
      });
      sendJson(response, 201, {
        ...record,
        ...(validated.warning ? { warnings: validated.warnings } : {}),
      });
      return true;
    } finally {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  }

  function handleList(response, store) {
    let references;
    let assignments;
    try {
      references = store.list();
      assignments = typeof store.assignments === 'function' ? store.assignments() : [];
    } catch (error) {
      const { code, message } = errorBody(error);
      sendError(response, 500, code, message);
      return;
    }
    sendJson(response, 200, { references, assignments });
  }

  function handleGet(response, store, id) {
    let record;
    try {
      record = store.get(id);
    } catch (error) {
      const { code, message } = errorBody(error);
      sendError(response, statusForCode(code), code, message);
      return;
    }
    if (!record) {
      sendError(response, 404, 'NOT_FOUND', `reference ${id} does not exist`);
      return;
    }
    sendJson(response, 200, record);
  }

  async function handlePatch(request, response, store, chatId, id) {
    let body;
    try {
      body = await readPatch(request);
    } catch {
      sendError(response, 400, 'INVALID_BODY', 'could not read the request body');
      return;
    }
    if (!body.ok) {
      abortRequestAfterResponse(request, response);
      sendError(response, 413, 'TOO_LARGE', 'patch body is too large');
      return;
    }

    let patch;
    try {
      patch = JSON.parse(body.bytes.toString('utf8') || '{}');
    } catch {
      sendError(response, 400, 'INVALID_JSON', 'patch body must be JSON');
      return;
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      sendError(response, 400, 'INVALID_JSON', 'patch body must be a JSON object');
      return;
    }

    let record;
    try {
      record = store.update(id, patch);
    } catch (error) {
      const { code, message } = errorBody(error);
      sendError(response, statusForCode(code), code, message);
      return;
    }

    publish(events, {
      type: 'reference.updated',
      chatId,
      refId: record.id,
      revision: record.revision,
    });
    sendJson(response, 200, record);
  }

  function handleDelete(response, store, chatId, id) {
    let removed;
    try {
      removed = store.remove(id);
    } catch (error) {
      const { code, message } = errorBody(error);
      sendError(response, statusForCode(code), code, message);
      return;
    }
    if (!removed) {
      sendError(response, 404, 'NOT_FOUND', `reference ${id} does not exist`);
      return;
    }
    publish(events, { type: 'reference.removed', chatId, refId: id });
    response.writeHead(204, {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end();
  }

  function handleMedia(request, response, store, id, kind, frameNumber) {
    let record;
    try {
      record = store.get(id);
    } catch (error) {
      const { code, message } = errorBody(error);
      sendError(response, statusForCode(code), code, message);
      return;
    }
    if (!record) {
      sendError(response, 404, 'NOT_FOUND', `reference ${id} does not exist`);
      return;
    }

    let file;
    let contentType;
    if (kind === 'file') {
      if (typeof store.filesDir !== 'string') {
        sendError(response, 500, 'STORE_UNAVAILABLE', 'reference files are not available');
        return;
      }
      file = join(store.filesDir, record.file);
      contentType = recordMime(record);
    } else if (kind === 'thumb') {
      if (typeof store.thumbsDir !== 'string') {
        sendError(response, 404, 'NOT_FOUND', 'no thumbnail for this reference');
        return;
      }
      file = join(store.thumbsDir, `${record.id}.jpg`);
      contentType = 'image/jpeg';
    } else {
      if (!/^\d{1,6}$/.test(frameNumber)) {
        sendError(response, 400, 'INVALID_FRAME', 'frame number must be a non-negative integer');
        return;
      }
      const index = Number(frameNumber);
      if (Array.isArray(record.frames) && record.frames.length > 0
        && !record.frames.some(frame => frame.index === index)) {
        sendError(response, 404, 'NOT_FOUND', `frame ${frameNumber} does not exist`);
        return;
      }
      if (typeof store.framesDir !== 'string') {
        sendError(response, 404, 'NOT_FOUND', 'no frames for this reference');
        return;
      }
      file = join(store.framesDir, record.id, `${index}.png`);
      contentType = 'image/png';
    }

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      sendError(response, 404, 'NOT_FOUND', 'referenced file does not exist');
      return;
    }
    if (!stat.isFile()) {
      sendError(response, 404, 'NOT_FOUND', 'referenced file does not exist');
      return;
    }

    serveStaticFile(request, response, file, {
      'content-type': contentType,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
  }

  async function handleMatched(request, response, match) {
    const chatId = safeDecode(match[1]);
    if (chatId === null || !CHAT_ID_PATTERN.test(chatId)) {
      sendError(response, 400, 'INVALID_CHAT_ID', 'chat id must match chat_[A-Za-z0-9_-]{8,80}');
      return true;
    }

    const rest = match[2] ?? '';
    const parts = rest === '' ? [] : rest.split('/');
    const method = String(request.method ?? 'GET').toUpperCase();

    if (parts.length === 0) {
      if (method === 'POST') return handleUpload(request, response, chatId);
      if (method === 'GET') {
        let store;
        try {
          store = await storeFor(chatId);
        } catch (error) {
          const { code, message } = errorBody(error);
          sendError(response, statusForCode(code), code, message);
          return true;
        }
        handleList(response, store);
        return true;
      }
      sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      return true;
    }

    const id = safeDecode(parts[0]);
    if (id === null || !REF_ID_PATTERN.test(id)) {
      sendError(response, 400, 'INVALID_ID', 'reference id must match ref_ followed by 16 lowercase hex characters');
      return true;
    }

    if (parts.length === 1) {
      if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
        return true;
      }
      let store;
      try {
        store = await storeFor(chatId);
      } catch (error) {
        const { code, message } = errorBody(error);
        sendError(response, statusForCode(code), code, message);
        return true;
      }
      if (method === 'GET') handleGet(response, store, id);
      else if (method === 'PATCH') await handlePatch(request, response, store, chatId, id);
      else handleDelete(response, store, chatId, id);
      return true;
    }

    if (parts.length === 2 && (parts[1] === 'file' || parts[1] === 'thumb')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
        return true;
      }
      let store;
      try {
        store = await storeFor(chatId);
      } catch (error) {
        const { code, message } = errorBody(error);
        sendError(response, statusForCode(code), code, message);
        return true;
      }
      handleMedia(request, response, store, id, parts[1]);
      return true;
    }

    if (parts.length === 3 && parts[1] === 'frames') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
        return true;
      }
      let store;
      try {
        store = await storeFor(chatId);
      } catch (error) {
        const { code, message } = errorBody(error);
        sendError(response, statusForCode(code), code, message);
        return true;
      }
      handleMedia(request, response, store, id, 'frames', parts[2]);
      return true;
    }

    return false;
  }

  function handle(request, response, url) {
    let pathname;
    try {
      pathname = typeof url === 'string'
        ? new URL(url, 'http://127.0.0.1').pathname
        : url?.pathname;
    } catch {
      return false;
    }
    if (typeof pathname !== 'string') return false;
    const match = REFERENCE_ROUTE_PATTERN.exec(pathname);
    if (!match) return false;
    return handleMatched(request, response, match);
  }

  return Object.freeze({ handle });
}

export default createReferenceRoutes;
