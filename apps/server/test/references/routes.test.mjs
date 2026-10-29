import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createReferenceRoutes } from '../../src/references/routes.mjs';
import { createReferenceStore } from '../../src/references/store.mjs';
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_REFERENCES,
  MAX_TOTAL_BYTES,
} from '../../src/references/validate.mjs';

const MB = 1024 * 1024;
const CHAT_ID = 'chat_abcdefgh';
const CHAT_PATH = `/api/chat/${CHAT_ID}/references`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const MP4 = Buffer.from('00000018667479706d70343200000000', 'hex');
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
const WAV = (() => {
  const bytes = Buffer.alloc(52);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(176400, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(8, 40);
  return bytes;
})();

function pngVariant(suffix) {
  return Buffer.concat([PNG, Buffer.from(String(suffix), 'utf8')]);
}

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

  json() {
    return JSON.parse(this.body.toString('utf8'));
  }
}

async function invoke(routes, { method = 'GET', path = CHAT_PATH, headers = {}, body, chunks } = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value);
  const request = chunks !== undefined
    ? Readable.from(chunks)
    : Readable.from(body === undefined ? [] : [body]);
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

function uploadHeaders(extra = {}) {
  return {
    'content-type': 'image/png',
    'x-filename': encodeURIComponent('grain texture.png'),
    'x-rights-asserted': '1',
    ...extra,
  };
}

function fakeMediaExec({ calls = [] } = {}) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'ffprobe') {
      return {
        stdout: JSON.stringify({
          streams: [{ width: 64, height: 48, r_frame_rate: '30/1' }],
          format: { duration: '2.0' },
        }),
        stderr: '',
        code: 0,
      };
    }
    if (command === 'ffmpeg') {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        if (arg.endsWith('.png')) {
          mkdirSync(dirname(arg), { recursive: true });
          writeFileSync(arg, PNG);
        } else if (arg.endsWith('.jpg')) {
          mkdirSync(dirname(arg), { recursive: true });
          writeFileSync(arg, JPEG);
        }
      }
      return { stdout: '', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command ${command}`);
  };
}

function harness(t, { exec } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-ref-routes-'));
  const events = [];
  const routes = createReferenceRoutes({
    store: chatId => createReferenceStore({ rootDir: root, chatId }),
    exec: exec ?? (async () => { throw new Error('no media tools in this test'); }),
    events: { publish: event => events.push(event) },
  });
  const chatDir = join(root, 'references', CHAT_ID);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, chatDir, events, routes };
}

test('image editorial scopes round-trip through the API and invalid scope changes fail', async t => {
  const { routes } = harness(t);
  const upload = await invoke(routes, { method: 'POST', headers: uploadHeaders(), body: PNG });
  const id = upload.json().id;
  const patch = body => invoke(routes, {
    method: 'PATCH', path: `${CHAT_PATH}/${id}`,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const selected = await patch({ usage: 'editorial', editorialScope: 'music-video' });
  assert.equal(selected.status, 200);
  assert.equal(selected.json().editorialScope, 'music-video');
  const listed = await invoke(routes);
  assert.equal(listed.json().references[0].editorialScope, 'music-video');
  assert.equal((await patch({ editorialScope: 'custom' })).status, 400);
  assert.equal((await patch({ usage: 'editorial', editorialScope: 'invalid' })).status, 400);
  assert.equal((await invoke(routes)).json().references[0].editorialScope, 'music-video');
  assert.equal((await patch({ usage: 'reference' })).status, 200);
  assert.equal((await invoke(routes)).json().references[0].editorialScope, undefined);
});

test('upload -> list -> patch -> delete round trip', async t => {
  const { routes, events, chatDir } = harness(t);

  const created = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders(),
    body: PNG,
  });
  assert.equal(created.status, 201);
  const reference = created.json();
  assert.match(reference.id, /^ref_[0-9a-f]{16}$/);
  assert.equal(reference.kind, 'image');
  assert.equal(reference.mime, 'image/png');
  assert.equal(reference.role, 'other');
  assert.equal(reference.usage, 'reference');
  assert.equal(reference.rightsAsserted, true);
  assert.equal(reference.label, 'grain texture.png');
  assert.equal(reference.width, 1);
  assert.equal(reference.height, 1);
  assert.equal(events[0].type, 'reference.added');
  assert.equal(events[0].refId, reference.id);
  assert.equal(events[0].chatId, CHAT_ID);

  const listed = await invoke(routes, { method: 'GET' });
  assert.equal(listed.status, 200);
  const list = listed.json();
  assert.equal(list.references.length, 1);
  assert.equal(list.references[0].id, reference.id);
  assert.deepEqual(list.assignments, []);

  const one = await invoke(routes, { method: 'GET', path: `${CHAT_PATH}/${reference.id}` });
  assert.equal(one.status, 200);
  assert.equal(one.json().id, reference.id);

  const patched = await invoke(routes, {
    method: 'PATCH',
    path: `${CHAT_PATH}/${reference.id}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'style', usage: 'editorial', note: '  use the warm grain  ', label: 'Grain' }),
  });
  assert.equal(patched.status, 200);
  const updated = patched.json();
  assert.equal(updated.role, 'style');
  assert.equal(updated.usage, 'editorial');
  assert.equal(updated.note, 'use the warm grain');
  assert.equal(updated.label, 'Grain');
  assert.equal(updated.revision, 2);
  assert.equal(events.at(-1).type, 'reference.updated');
  assert.equal(events.at(-1).revision, 2);

  const file = await invoke(routes, { method: 'GET', path: `${CHAT_PATH}/${reference.id}/file` });
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'image/png');
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
  assert.equal(file.body.equals(PNG), true);

  const removed = await invoke(routes, { method: 'DELETE', path: `${CHAT_PATH}/${reference.id}` });
  assert.equal(removed.status, 204);
  assert.equal(removed.body.length, 0);
  assert.equal(events.at(-1).type, 'reference.removed');
  assert.equal(events.at(-1).refId, reference.id);

  const after = await invoke(routes, { method: 'GET' });
  assert.equal(after.json().references.length, 0);
  assert.equal(existsSync(join(chatDir, 'files', reference.file)), false);

  const gone = await invoke(routes, { method: 'GET', path: `${CHAT_PATH}/${reference.id}` });
  assert.equal(gone.status, 404);
  assert.equal(gone.json().code, 'NOT_FOUND');

  const removedAgain = await invoke(routes, { method: 'DELETE', path: `${CHAT_PATH}/${reference.id}` });
  assert.equal(removedAgain.status, 404);
});

test('missing or false rights assertion is a 400 before any library is created', async t => {
  const { routes, chatDir } = harness(t);

  const missing = await invoke(routes, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-filename': 'a.png' },
    body: PNG,
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json().code, 'RIGHTS_REQUIRED');
  assert.equal(existsSync(chatDir), false);

  const denied = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders({ 'x-rights-asserted': '0' }),
    body: PNG,
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.json().code, 'RIGHTS_REQUIRED');
  assert.equal(existsSync(chatDir), false);
});

test('an over-cap stream is rejected with 413 without consuming every chunk', async t => {
  const { routes } = harness(t);
  const totalChunks = 64;
  let produced = 0;

  async function* body() {
    for (let index = 0; index < totalChunks; index += 1) {
      produced += 1;
      yield Buffer.alloc(MB, 0x89);
    }
  }

  const response = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders(),
    chunks: body(),
  });

  assert.equal(response.status, 413);
  assert.equal(response.json().code, 'TOO_LARGE');
  assert.ok(produced < totalChunks, `stream was fully consumed (${produced}/${totalChunks} chunks)`);
  assert.ok(produced <= Math.ceil(MAX_IMAGE_BYTES / MB) + 3);
});

test('unknown chat id formats and unrelated paths are handled without side effects', async t => {
  const { routes, chatDir } = harness(t);

  const bad = await invoke(routes, { path: '/api/chat/not-a-chat/references' });
  assert.equal(bad.matched, true);
  assert.equal(bad.status, 400);
  assert.equal(bad.json().code, 'INVALID_CHAT_ID');

  const tooShort = await invoke(routes, { path: '/api/chat/chat_abc/references' });
  assert.equal(tooShort.status, 400);

  const other = await invoke(routes, { path: '/api/chat/chat_abcdefgh/messages' });
  assert.equal(other.matched, false);

  const plain = await invoke(routes, { path: '/api/health' });
  assert.equal(plain.matched, false);

  assert.equal(existsSync(chatDir), false);
});

test('duplicate bytes return the existing reference with 200 and one added event', async t => {
  const { routes, events } = harness(t);

  const first = await invoke(routes, { method: 'POST', headers: uploadHeaders(), body: PNG });
  const second = await invoke(routes, { method: 'POST', headers: uploadHeaders(), body: PNG });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json().id, first.json().id);

  const list = await invoke(routes, { method: 'GET' });
  assert.equal(list.json().references.length, 1);
  assert.equal(events.filter(event => event.type === 'reference.added').length, 1);
});

test('deleting one reference leaves the other files untouched', async t => {
  const { routes, chatDir } = harness(t);

  const first = await invoke(routes, { method: 'POST', headers: uploadHeaders(), body: PNG });
  const second = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders({ 'x-filename': encodeURIComponent('second.png') }),
    body: pngVariant('second'),
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const keep = second.json();
  const firstFile = join(chatDir, 'files', first.json().file);
  const keepFile = join(chatDir, 'files', keep.file);
  const keepBytes = readFileSync(keepFile);

  const removed = await invoke(routes, { method: 'DELETE', path: `${CHAT_PATH}/${first.json().id}` });
  assert.equal(removed.status, 204);

  assert.equal(existsSync(firstFile), false);
  assert.equal(existsSync(keepFile), true);
  assert.equal(readFileSync(keepFile).equals(keepBytes), true);

  const stillThere = await invoke(routes, { method: 'GET', path: `${CHAT_PATH}/${keep.id}/file` });
  assert.equal(stillThere.status, 200);
  assert.equal(stillThere.body.equals(keepBytes), true);
});

test('patch validation rejects unknown fields, bad roles and malformed JSON', async t => {
  const { routes } = harness(t);
  const created = await invoke(routes, { method: 'POST', headers: uploadHeaders(), body: PNG });
  const path = `${CHAT_PATH}/${created.json().id}`;

  const unknown = await invoke(routes, {
    method: 'PATCH',
    path,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ favorite: true }),
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json().code, 'UNKNOWN_FIELD');

  const role = await invoke(routes, {
    method: 'PATCH',
    path,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'hero' }),
  });
  assert.equal(role.status, 400);
  assert.equal(role.json().code, 'INVALID_ROLE');

  const malformed = await invoke(routes, {
    method: 'PATCH',
    path,
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json().code, 'INVALID_JSON');

  const missing = await invoke(routes, {
    method: 'PATCH',
    path: `${CHAT_PATH}/ref_0000000000000000`,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(missing.status, 404);
});

test('video upload probes metadata, extracts frames and serves range reads', async t => {
  const calls = [];
  const { routes } = harness(t, { exec: fakeMediaExec({ calls }) });

  const created = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders({ 'content-type': 'video/mp4', 'x-filename': encodeURIComponent('pour.mp4') }),
    body: MP4,
  });
  assert.equal(created.status, 201);
  const reference = created.json();
  assert.equal(reference.kind, 'video');
  assert.equal(reference.mime, 'video/mp4');
  assert.equal(reference.width, 64);
  assert.equal(reference.height, 48);
  assert.equal(reference.durationSec, 2);
  assert.equal(reference.frames.length, 4);
  assert.deepEqual(reference.frames.map(frame => frame.index), [0, 1, 2, 3]);
  assert.ok(reference.frames.every(frame => frame.atSec >= 0.2 - 1e-9 && frame.atSec <= 1.8 + 1e-9));

  const probe = calls.find(call => call.command === 'ffprobe');
  assert.ok(probe);
  assert.ok(Array.isArray(probe.args));
  assert.equal(probe.args.at(-1).endsWith('.mp4'), true);

  const thumb = await invoke(routes, { method: 'GET', path: `${CHAT_PATH}/${reference.id}/thumb` });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers['content-type'], 'image/jpeg');
  assert.equal(thumb.headers['x-content-type-options'], 'nosniff');
  assert.equal(thumb.body.equals(JPEG), true);

  const frame = await invoke(routes, { method: 'GET', path: `${CHAT_PATH}/${reference.id}/frames/2` });
  assert.equal(frame.status, 200);
  assert.equal(frame.headers['content-type'], 'image/png');
  assert.equal(frame.headers['x-content-type-options'], 'nosniff');
  assert.equal(frame.body.equals(PNG), true);

  const missingFrame = await invoke(routes, { method: 'GET', path: `${CHAT_PATH}/${reference.id}/frames/9` });
  assert.equal(missingFrame.status, 404);

  const ranged = await invoke(routes, {
    method: 'GET',
    path: `${CHAT_PATH}/${reference.id}/file`,
    headers: { range: 'bytes=0-3' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-type'], 'video/mp4');
  assert.equal(ranged.headers['x-content-type-options'], 'nosniff');
  assert.equal(ranged.headers['content-range'], `bytes 0-3/${MP4.length}`);
  assert.equal(ranged.body.length, 4);
});

test('audio upload probes a song, skips ffmpeg derivatives and serves audio ranges', async t => {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command !== 'ffprobe') throw new Error(`audio must not invoke ${command}`);
    return {
      stdout: JSON.stringify({
        streams: [{ codec_name: 'pcm_s16le', sample_rate: '44100', channels: 2 }],
        format: { duration: '185.25' },
      }),
    };
  };
  const { routes, events, chatDir } = harness(t, { exec });

  const created = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders({
      'content-type': 'audio/mpeg',
      'x-filename': encodeURIComponent('../theme.mp3'),
    }),
    body: WAV,
  });
  assert.equal(created.status, 201, created.body.toString());
  const reference = created.json();
  assert.equal(reference.kind, 'audio');
  assert.equal(reference.mime, 'audio/wav');
  assert.equal(reference.ext, 'wav');
  assert.equal(reference.file, `${reference.id}.wav`);
  assert.equal(reference.label, 'theme.mp3');
  assert.equal(reference.role, 'other');
  assert.equal(reference.usage, 'reference');
  assert.equal(reference.rightsAsserted, true);
  assert.equal(reference.durationSec, 185.25);
  assert.equal(reference.codec, 'pcm_s16le');
  assert.equal(reference.sampleRate, 44100);
  assert.equal(reference.channels, 2);
  assert.equal('width' in reference, false);
  assert.equal('height' in reference, false);
  assert.deepEqual(reference.frames, []);
  assert.equal(created.json().warnings.length, 2);
  assert.deepEqual(readFileSync(join(chatDir, 'files', reference.file)), WAV);
  assert.equal(existsSync(join(chatDir, 'thumbs', `${reference.id}.jpg`)), false);
  assert.equal(existsSync(join(chatDir, 'frames', reference.id)), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ffprobe');
  assert.ok(calls[0].args.includes('a:0'));
  assert.equal(calls[0].args.at(-1).endsWith('.wav'), true);
  assert.ok(calls.every(call => call.command === 'ffprobe'), 'no video keyframes or fake thumbnails');

  const duplicate = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders({ 'content-type': 'audio/wav', 'x-filename': 'copy.wav' }),
    body: WAV,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json().id, reference.id);
  assert.equal(calls.length, 1, 'dedupe happens before another probe');

  const head = await invoke(routes, { method: 'HEAD', path: `${CHAT_PATH}/${reference.id}/file` });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], 'audio/wav');
  assert.equal(head.headers['content-length'], WAV.length);
  assert.equal(head.body.length, 0);

  const ranged = await invoke(routes, {
    method: 'GET',
    path: `${CHAT_PATH}/${reference.id}/file`,
    headers: { range: 'bytes=4-11' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-type'], 'audio/wav');
  assert.equal(ranged.headers['content-range'], `bytes 4-11/${WAV.length}`);
  assert.deepEqual(ranged.body, WAV.subarray(4, 12));

  const thumb = await invoke(routes, { path: `${CHAT_PATH}/${reference.id}/thumb` });
  assert.equal(thumb.status, 404);

  const patched = await invoke(routes, {
    method: 'PATCH',
    path: `${CHAT_PATH}/${reference.id}`,
    body: JSON.stringify({ role: 'song', usage: 'editorial', note: 'Use as the main theme.' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json().role, 'song');
  assert.equal(patched.json().usage, 'editorial');
  assert.equal(events.filter(event => event.type === 'reference.added').length, 1);
});

test('audio routes reject unknown or excessive durations without storing a record', async t => {
  for (const [duration, status, code] of [['N/A', 400, 'UNKNOWN_DURATION'], ['300.01', 413, 'TOO_LONG']]) {
    const { routes } = harness(t, {
      exec: async () => ({
        stdout: JSON.stringify({
          streams: [{ codec_name: 'mp3', sample_rate: '48000', channels: 2 }],
          format: { duration },
        }),
      }),
    });
    const response = await invoke(routes, {
      method: 'POST',
      headers: uploadHeaders({ 'content-type': 'audio/mpeg', 'x-filename': 'song.mp3' }),
      body: MP3,
    });
    assert.equal(response.status, status);
    assert.equal(response.json().code, code);
    const list = await invoke(routes);
    assert.deepEqual(list.json().references, []);
  }
});

test('video upload also rejects unknown duration before keyframe extraction', async t => {
  const calls = [];
  const { routes } = harness(t, {
    exec: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: JSON.stringify({
          streams: [{ width: 64, height: 48, r_frame_rate: '30/1' }],
          format: { duration: 'N/A' },
        }),
      };
    },
  });
  const response = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders({ 'content-type': 'video/mp4', 'x-filename': 'unknown.mp4' }),
    body: MP4,
  });
  assert.equal(response.status, 400);
  assert.equal(response.json().code, 'UNKNOWN_DURATION');
  assert.ok(calls.every(call => call.command === 'ffprobe'));
  assert.deepEqual((await invoke(routes)).json().references, []);
});

test('audio streaming cap and existing library count/total caps remain enforced', async t => {
  const { routes } = harness(t);
  const oversized = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders({
      'content-type': 'audio/mpeg',
      'content-length': MAX_AUDIO_BYTES + 1,
      'x-filename': 'huge.mp3',
    }),
    body: MP3,
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json().code, 'TOO_LARGE');

  for (const [references, code] of [
    [Array.from({ length: MAX_REFERENCES }, () => ({ bytes: 1 })), 'TOO_MANY_REFERENCES'],
    [[{ bytes: MAX_TOTAL_BYTES }], 'TOTAL_TOO_LARGE'],
  ]) {
    const cappedRoutes = createReferenceRoutes({
      store: () => ({
        list: () => references,
        add: () => { throw new Error('capped upload must not reach store.add'); },
      }),
    });
    const response = await invoke(cappedRoutes, {
      method: 'POST',
      headers: uploadHeaders({ 'content-type': 'audio/mpeg', 'x-filename': 'song.mp3' }),
      body: MP3,
    });
    assert.equal(response.status, 413);
    assert.equal(response.json().code, code);
  }
});

test('sniffing wins over the declared type and the extension is never a path', async t => {
  const { routes } = harness(t);

  const created = await invoke(routes, {
    method: 'POST',
    headers: uploadHeaders({
      'content-type': 'image/jpeg',
      'x-filename': encodeURIComponent('../evil.jpg'),
    }),
    body: PNG,
  });
  assert.equal(created.status, 201);
  const reference = created.json();
  assert.equal(reference.mime, 'image/png');
  assert.equal(reference.file, `${reference.id}.png`);
  assert.equal(reference.label, 'evil.jpg');
  assert.equal(created.json().warnings?.[0]?.code, 'MISMATCH_WARNING');

  const patched = await invoke(routes, {
    method: 'PATCH',
    path: `${CHAT_PATH}/${reference.id}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'keep the logo colours' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json().note, 'keep the logo colours');
});
