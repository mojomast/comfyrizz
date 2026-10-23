import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createThumbRoutes } from '../../src/thumbs/routes.mjs';
import { createApp } from '../../src/app.mjs';

const PACKAGE_ID = 'pkg_thumbs0001';
const ASSET_ID = 'a_background';
const CLIP_ID = 'a_clip';
const TAKE_ID = 'tk_0123456789ab';
const TOKEN = 'test-token-0123456789abcdef';
const IMMUTABLE = 'private, max-age=31536000, immutable';

const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const VIDEO_BYTES = Buffer.from('fake-video-bytes');
const TAKE_BYTES = Buffer.from('fake-take-bytes');
const THUMB_BYTES = Buffer.from('not-a-real-thumbnail');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.status = null;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = { ...headers };
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get body() {
    return Buffer.concat(this.chunks);
  }
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-thumb-routes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    runtimeDir: join(root, 'runtime'),
    packagesRoot: join(root, 'runtime', 'packages'),
  };
}

function packageStore(space, pkg) {
  return {
    path(id) {
      return join(space.packagesRoot, `${id}.json`);
    },
    read(id) {
      return id === pkg.id ? pkg : null;
    },
  };
}

function takeStore(space, doc) {
  return {
    packageRoot(id) {
      return join(space.packagesRoot, id);
    },
    read(id) {
      return doc && id === doc.packageId ? doc : null;
    },
  };
}

function fakeTickets() {
  const calls = [];
  let sequence = 0;
  return {
    calls,
    mint(file, options) {
      sequence += 1;
      const ticket = sequence.toString(16).padStart(32, '0');
      calls.push({ file, options });
      return {
        ticket,
        expiresAt: '2026-10-23T12:00:00.000Z',
        url: `/api/media/${ticket}`,
      };
    },
  };
}

function fakeThumbs(result) {
  const calls = [];
  return {
    calls,
    get(source, kind) {
      calls.push({ source, kind });
      return typeof result === 'function' ? result(source, kind) : result;
    },
  };
}

function routesFor(space, { pkg, doc = null, thumbs, tickets = fakeTickets() } = {}) {
  const routes = createThumbRoutes({
    store: packageStore(space, pkg),
    takeStore: takeStore(space, doc),
    runtimeDir: space.runtimeDir,
    mediaTickets: tickets,
    thumbs,
  });
  return { routes, tickets };
}

async function invoke(routes, { method = 'GET', path = '/api/thumbs', headers = {} } = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value);
  const request = Readable.from([]);
  request.method = method;
  request.headers = normalized;
  request.url = path;

  const response = new CaptureResponse();
  const finished = new Promise(resolve => response.on('finish', resolve));
  const matched = await routes.handle(request, response, new URL(path, 'http://127.0.0.1'));
  if (matched) await finished;
  return {
    matched,
    status: response.status,
    headers: response.headers,
    body: response.body,
    json: () => JSON.parse(response.body.toString('utf8')),
  };
}

function query(params) {
  return `/api/thumbs?${new URLSearchParams(params).toString()}`;
}

const AUTH = { 'x-comfyrizz-token': TOKEN };

function imagePackage(overrides = {}) {
  return {
    id: PACKAGE_ID,
    revision: 1,
    assets: {
      [ASSET_ID]: {
        kind: 'image',
        origin: 'generated',
        status: 'ready',
        file: `assets/${ASSET_ID}.png`,
        ...overrides,
      },
    },
  };
}

function writeAsset(space, relative, bytes = IMAGE_BYTES) {
  const file = join(space.packagesRoot, PACKAGE_ID, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

function writeThumb(space) {
  const file = join(space.runtimeDir, 'thumbs', `${'a'.repeat(64)}.png`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, THUMB_BYTES);
  return file;
}

function readyThumb(space, overrides = {}) {
  return {
    status: 'ready',
    key: 'a'.repeat(64),
    file: writeThumb(space),
    width: 320,
    height: 180,
    ...overrides,
  };
}

test('AV03: requires header auth and never accepts the session token in the URL', async (t) => {
  const space = workspace(t);
  writeAsset(space, `assets/${ASSET_ID}.png`);
  const thumbs = fakeThumbs(readyThumb(space));
  const { routes } = routesFor(space, { pkg: imagePackage(), thumbs });
  const path = query({ packageId: PACKAGE_ID, ref: ASSET_ID, kind: 'poster' });

  const missing = await invoke(routes, { path });
  assert.equal(missing.status, 401);
  assert.equal(thumbs.calls.length, 0);

  const queryToken = await invoke(routes, { path: `${path}&token=${TOKEN}` });
  assert.equal(queryToken.status, 401);
  assert.equal(thumbs.calls.length, 0);

  const header = await invoke(routes, { path, headers: AUTH });
  assert.equal(header.status, 200);
  assert.equal(header.json().status, 'ready');
});

test('AV03: rejects missing, unknown and malformed parameters', async (t) => {
  const space = workspace(t);
  writeAsset(space, `assets/${ASSET_ID}.png`);
  const thumbs = fakeThumbs(readyThumb(space));
  const { routes } = routesFor(space, { pkg: imagePackage(), thumbs });

  assert.equal((await invoke(routes, { path: '/api/thumbs', headers: AUTH })).status, 400);
  assert.equal((await invoke(routes, { path: query({ ref: ASSET_ID, kind: 'poster' }), headers: AUTH })).status, 400);
  assert.equal((await invoke(routes, { path: query({ packageId: PACKAGE_ID, kind: 'poster' }), headers: AUTH })).status, 400);
  assert.equal((await invoke(routes, { path: query({ packageId: PACKAGE_ID, ref: ASSET_ID }), headers: AUTH })).status, 400);
  assert.equal((await invoke(routes, { path: query({ packageId: PACKAGE_ID, ref: ASSET_ID, kind: 'gif' }), headers: AUTH })).status, 400);
  assert.equal((await invoke(routes, { path: query({ packageId: PACKAGE_ID, ref: 'a_missing', kind: 'poster' }), headers: AUTH })).status, 400);
  assert.equal((await invoke(routes, { path: query({ packageId: '../escape', ref: ASSET_ID, kind: 'poster' }), headers: AUTH })).status, 400);

  const post = await invoke(routes, {
    method: 'POST',
    path: query({ packageId: PACKAGE_ID, ref: ASSET_ID, kind: 'poster' }),
    headers: AUTH,
  });
  assert.equal(post.status, 405);
  assert.equal(thumbs.calls.length, 0);
});

test('AV03: traversal in a ref or a stored file is a 400', async (t) => {
  const space = workspace(t);
  writeAsset(space, `assets/${ASSET_ID}.png`);
  const thumbs = fakeThumbs(readyThumb(space));

  const assetTraversal = routesFor(space, {
    pkg: imagePackage({ file: '../outside.png' }),
    thumbs,
  });
  const badAsset = await invoke(assetTraversal.routes, {
    path: query({ packageId: PACKAGE_ID, ref: ASSET_ID, kind: 'poster' }),
    headers: AUTH,
  });
  assert.equal(badAsset.status, 400);

  const refTraversal = await invoke(assetTraversal.routes, {
    path: query({ packageId: PACKAGE_ID, ref: '../outside', kind: 'poster' }),
    headers: AUTH,
  });
  assert.equal(refTraversal.status, 400);

  const encodedTraversal = await invoke(assetTraversal.routes, {
    path: `/api/thumbs?packageId=${PACKAGE_ID}&ref=%2e%2e%2foutside&kind=poster`,
    headers: AUTH,
  });
  assert.equal(encodedTraversal.status, 400);

  const doc = {
    packageId: PACKAGE_ID,
    clips: {
      [CLIP_ID]: {
        selected: TAKE_ID,
        takes: [{
          takeId: TAKE_ID,
          assetId: CLIP_ID,
          n: 1,
          file: '../outside.png',
          sha256: digest(TAKE_BYTES),
          bytes: TAKE_BYTES.length,
          media: { width: 64, height: 36 },
        }],
      },
    },
  };
  const takeTraversal = routesFor(space, { pkg: imagePackage(), doc, thumbs });
  const badTake = await invoke(takeTraversal.routes, {
    path: query({ packageId: PACKAGE_ID, ref: `${CLIP_ID}:${TAKE_ID}`, kind: 'poster' }),
    headers: AUTH,
  });
  assert.equal(badTake.status, 400);
  assert.equal(thumbs.calls.length, 0);
});

test('AV03: a text asset is a 200 none and never runs ffmpeg', async (t) => {
  const space = workspace(t);
  writeAsset(space, 'assets/notes.txt', Buffer.from('plain text, not media'));
  const thumbs = fakeThumbs(readyThumb(space));
  const pkg = {
    id: PACKAGE_ID,
    revision: 1,
    assets: {
      a_notes: { kind: 'text', origin: 'generated', status: 'ready', file: 'assets/notes.txt' },
    },
  };
  const { routes } = routesFor(space, { pkg, thumbs });

  const response = await invoke(routes, {
    path: query({ packageId: PACKAGE_ID, ref: 'a_notes', kind: 'poster' }),
    headers: AUTH,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { status: 'none', reason: 'text' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(thumbs.calls.length, 0);
});

test('AV03: a ready thumb is content addressed, ticket only, immutable and 304s', async (t) => {
  const space = workspace(t);
  const sourceFile = writeAsset(space, `assets/${ASSET_ID}.png`);
  const thumbFile = writeThumb(space);
  const thumbs = fakeThumbs(readyThumb(space));
  const { routes, tickets } = routesFor(space, { pkg: imagePackage(), thumbs });
  const path = query({ packageId: PACKAGE_ID, ref: ASSET_ID, kind: 'poster' });

  const response = await invoke(routes, { path, headers: AUTH });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    status: 'ready',
    key: 'a'.repeat(64),
    ticketUrl: `/api/media/${'0'.repeat(31)}1`,
    width: 320,
    height: 180,
  });
  assert.equal(response.headers.etag, 'a'.repeat(64));
  assert.equal(response.headers['cache-control'], IMMUTABLE);
  assert.equal(response.body.toString('utf8').includes(TOKEN), false);
  assert.equal(response.json().ticketUrl.includes('token'), false);

  assert.equal(thumbs.calls.length, 1);
  assert.equal(thumbs.calls[0].kind, 'poster');
  assert.equal(thumbs.calls[0].source.file, sourceFile);
  assert.equal(thumbs.calls[0].source.sha256, digest(IMAGE_BYTES));

  assert.equal(tickets.calls.length, 1);
  assert.equal(tickets.calls[0].file, thumbFile);

  const notModified = await invoke(routes, {
    path,
    headers: { ...AUTH, 'if-none-match': 'a'.repeat(64) },
  });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.etag, 'a'.repeat(64));
  assert.equal(notModified.headers['cache-control'], IMMUTABLE);
  assert.equal(notModified.body.length, 0);
  assert.equal(tickets.calls.length, 1);
});

test('AV03: video metadata gives filmstrip durations, pending is 202, failed and none are 200', async (t) => {
  const space = workspace(t);
  const sourceFile = writeAsset(space, 'assets/clip.mp4', VIDEO_BYTES);
  const pkg = {
    id: PACKAGE_ID,
    revision: 1,
    assets: {
      a_clip_video: {
        kind: 'video',
        origin: 'generated',
        status: 'ready',
        file: 'assets/clip.mp4',
        media: { frames: 60, fps: 30 },
      },
    },
  };
  const path = kind => query({ packageId: PACKAGE_ID, ref: 'a_clip_video', kind });

  const ready = fakeThumbs(readyThumb(space, { width: 640, height: 90, tiles: [{ t: 0, x: 0, y: 0, w: 160, h: 90 }] }));
  const readyRoutes = routesFor(space, { pkg, thumbs: ready }).routes;
  const readyResponse = await invoke(readyRoutes, { path: path('filmstrip'), headers: AUTH });
  assert.equal(readyResponse.status, 200);
  assert.equal(ready.calls[0].source.file, sourceFile);
  assert.equal(ready.calls[0].source.kind, 'video');
  assert.equal(ready.calls[0].source.durationSec, 2);
  assert.deepEqual(readyResponse.json().tiles, [{ t: 0, x: 0, y: 0, w: 160, h: 90 }]);

  const pending = fakeThumbs({ status: 'pending' });
  const pendingResponse = await invoke(routesFor(space, { pkg, thumbs: pending }).routes, {
    path: path('poster'),
    headers: AUTH,
  });
  assert.equal(pendingResponse.status, 202);
  assert.deepEqual(pendingResponse.json(), { status: 'pending' });

  const failed = fakeThumbs({ status: 'failed', reason: 'ffmpeg-unavailable', retryAfter: 123 });
  const failedResponse = await invoke(routesFor(space, { pkg, thumbs: failed }).routes, {
    path: path('poster'),
    headers: AUTH,
  });
  assert.equal(failedResponse.status, 200);
  assert.deepEqual(failedResponse.json(), { status: 'failed', reason: 'ffmpeg-unavailable' });

  const none = fakeThumbs({ status: 'none', reason: 'unsupported-source' });
  const noneResponse = await invoke(routesFor(space, { pkg, thumbs: none }).routes, {
    path: path('filmstrip'),
    headers: AUTH,
  });
  assert.equal(noneResponse.status, 200);
  assert.deepEqual(noneResponse.json(), { status: 'none', reason: 'no-media' });
});

test('AV03: a missing source file is none, not an error', async (t) => {
  const space = workspace(t);
  const thumbs = fakeThumbs(readyThumb(space));
  const { routes } = routesFor(space, { pkg: imagePackage(), thumbs });

  const response = await invoke(routes, {
    path: query({ packageId: PACKAGE_ID, ref: ASSET_ID, kind: 'poster' }),
    headers: AUTH,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { status: 'none', reason: 'no-media' });
  assert.equal(thumbs.calls.length, 0);
});

test('AV03: a clip:take ref resolves the take from the take store', async (t) => {
  const space = workspace(t);
  const takeFile = writeAsset(space, `takes/${CLIP_ID}/${TAKE_ID}.png`, TAKE_BYTES);
  writeAsset(space, `assets/${CLIP_ID}.png`, IMAGE_BYTES);
  const doc = {
    packageId: PACKAGE_ID,
    clips: {
      [CLIP_ID]: {
        selected: TAKE_ID,
        takes: [{
          takeId: TAKE_ID,
          assetId: CLIP_ID,
          n: 1,
          file: `takes/${CLIP_ID}/${TAKE_ID}.png`,
          sha256: digest(TAKE_BYTES),
          bytes: TAKE_BYTES.length,
          media: { width: 64, height: 36 },
        }],
      },
    },
  };
  const pkg = {
    id: PACKAGE_ID,
    revision: 1,
    assets: {
      [CLIP_ID]: {
        kind: 'image',
        origin: 'generated',
        status: 'ready',
        file: `assets/${CLIP_ID}.png`,
      },
    },
  };
  const thumbs = fakeThumbs(readyThumb(space));
  const { routes } = routesFor(space, { pkg, doc, thumbs });

  const response = await invoke(routes, {
    path: query({ packageId: PACKAGE_ID, ref: `${CLIP_ID}:${TAKE_ID}`, kind: 'poster' }),
    headers: AUTH,
  });
  assert.equal(response.status, 200);
  assert.equal(response.json().status, 'ready');
  assert.equal(thumbs.calls.length, 1);
  assert.equal(thumbs.calls[0].source.file, takeFile);
  assert.equal(thumbs.calls[0].source.sha256, digest(TAKE_BYTES));
  assert.equal(thumbs.calls[0].source.kind, 'image');

  const unknownTake = await invoke(routes, {
    path: query({ packageId: PACKAGE_ID, ref: `${CLIP_ID}:tk_ffffffffffff`, kind: 'poster' }),
    headers: AUTH,
  });
  assert.equal(unknownTake.status, 400);
});

test('AV03: app.mjs mounts /api/thumbs behind header auth', async (t) => {
  const space = workspace(t);
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const app = createApp({ root, token: TOKEN, runtimeDir: space.runtimeDir });
  t.after(() => app.close());

  const call = async (path, token = TOKEN) => {
    const request = Readable.from([]);
    request.method = 'GET';
    request.headers = {
      host: '127.0.0.1',
      ...(token ? { 'x-comfyrizz-token': token } : {}),
    };
    request.url = path;
    const response = new CaptureResponse();
    const finished = new Promise(resolve => response.on('finish', resolve));
    app.handler(request, response);
    await finished;
    return response;
  };

  const unauthorized = await call('/api/thumbs', null);
  assert.equal(unauthorized.status, 401);

  const queryTokenOnly = await call(`/api/thumbs?packageId=${PACKAGE_ID}&ref=${ASSET_ID}&kind=poster&token=${TOKEN}`, null);
  assert.equal(queryTokenOnly.status, 401);

  const mounted = await call('/api/thumbs?packageId=' + PACKAGE_ID);
  assert.equal(mounted.status, 400);
  assert.equal(existsSync(join(space.runtimeDir, 'thumbs')), true);
});
