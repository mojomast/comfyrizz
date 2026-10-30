// IP45W: mount the IP45 audition route in createApp.
//
// createApp owns one audition worker for the app's lifetime when the caller
// injects auditionSynth. Without it the route keeps answering 503 and nothing
// is synthesised. No admission is wired: a paid engine stays 403 until a
// production action can admit it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createCharacterRoutes } from '../../src/characters/routes.mjs';
import { createAuditionCache, createAuditionWorker } from '../../src/characters/audition.mjs';
import { createMediaTickets } from '../../src/media-range.mjs';

const TOKEN = 'audition-mount-token-0123456789';
const LINE = 'Morning! Let us grind.';
const KOKORO_VOICE = Object.freeze({ engine: 'kokoro', voice: 'am_michael', sampleLines: [LINE] });
const QWEN_VOICE = Object.freeze({
  engine: 'qwen3-tts',
  voice: 'Ryan',
  qwen_mode: 'custom',
  sampleLines: [LINE],
});
const NATIVE_MODEL = Object.freeze({
  id: 'minimax',
  capabilities: Object.freeze({
    supportsNativeVoice: true,
    nativeVoices: Object.freeze([Object.freeze({ id: 'minimax-narrator', language: 'en-us' })]),
    defaultNativeVoice: 'minimax-narrator',
  }),
});

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-audition-mount-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A tiny but structurally valid mono 24 kHz WAV. The cache writes these exact
// bytes, so the media-ticket round trip can compare them byte for byte.
function tinyWav(label) {
  const data = Buffer.from(label, 'utf8');
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

function serve(t, handler) {
  const server = createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(async () => {
        await new Promise(done => server.close(done));
      });
      resolve(server.address().port);
    });
  });
}

async function startApp(t, options = {}) {
  const runtimeDir = workspace(t);
  const app = createApp({ token: TOKEN, runtimeDir, ...options });
  t.after(() => app.close());
  const port = await serve(t, app.handler);
  return { app, runtimeDir, port };
}

function request(port, { method = 'GET', path = '/', token = TOKEN, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (method !== 'GET' && method !== 'HEAD') headers.origin = `http://127.0.0.1:${port}`;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, bytes, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function createCharacter(port, voice) {
  const response = await request(port, {
    method: 'POST',
    path: '/api/characters',
    body: { name: 'Pip', role: 'mascot', fictional: true, ...(voice ? { voice } : {}) },
  });
  assert.equal(response.status, 201, response.text);
  return response.json;
}

function audition(port, id, options = {}) {
  return request(port, {
    method: 'POST',
    path: `/api/characters/${id}/audition`,
    body: { line: LINE },
    ...options,
  });
}

test('IP45W: createApp mounts the audition worker and serves a Kokoro wave through a media ticket', async t => {
  const calls = [];
  const synth = async request => {
    calls.push(request);
    return tinyWav(`kokoro:${request.text}`);
  };
  const { port } = await startApp(t, { auditionSynth: synth });
  const character = await createCharacter(port, KOKORO_VOICE);

  const response = await audition(port, character.id);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.code, 'AUDITION_READY');
  assert.equal(response.json.engine, 'kokoro');
  assert.equal(response.json.voice, 'am_michael');
  assert.equal(response.json.line, LINE);
  assert.match(response.json.url, /^\/api\/media\/[a-f0-9]{32}$/);
  assert.equal(calls.length, 1, 'the injected Kokoro synthesizer is called once');

  const media = await request(port, { path: response.json.url, token: null });
  assert.equal(media.status, 200, media.text);
  assert.match(media.headers['content-type'], /^audio\/wav/);
  assert.deepEqual(media.bytes, tinyWav(`kokoro:${LINE}`));

  const cached = await audition(port, character.id);
  assert.equal(cached.status, 200, cached.text);
  assert.equal(cached.json.cached, true);
  assert.equal(calls.length, 1, 'a repeated audition is served from the cache');
  const cachedMedia = await request(port, { path: cached.json.url, token: null });
  assert.equal(cachedMedia.status, 200);
  assert.deepEqual(cachedMedia.bytes, tinyWav(`kokoro:${LINE}`));
});

test('IP45W: without auditionSynth the route stays unavailable and never synthesises', async t => {
  let calls = 0;
  const synth = async () => {
    calls += 1;
    return tinyWav('never');
  };
  // Hermetic: this machine may have kokoro_onnx installed, so prove the
  // unavailable path through the same injectable probe production uses.
  const { port } = await startApp(t, { auditionProbe: async () => false });
  const character = await createCharacter(port, KOKORO_VOICE);

  const response = await audition(port, character.id);
  assert.equal(response.status, 503, response.text);
  assert.equal(response.json.code, 'AUDITION_UNAVAILABLE');
  assert.equal(calls, 0, 'the synthesizer is not injected, so it cannot run');
  void synth;
});

test('IP45W: a paid engine is refused with AUDITION_ADMISSION_REQUIRED and never synthesises', async t => {
  const calls = [];
  const { port } = await startApp(t, {
    auditionSynth: async request => {
      calls.push(request);
      return tinyWav('paid');
    },
  });
  const character = await createCharacter(port, QWEN_VOICE);

  const response = await audition(port, character.id);
  assert.equal(response.status, 403, response.text);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.code, 'AUDITION_ADMISSION_REQUIRED');
  assert.equal(response.json.engine, 'qwen3-tts');
  assert.equal(calls.length, 0, 'no admission path exists, so the synthesizer is never touched');
});

test('IP45W: the audition route keeps the auth guard, so no token means 401 and no synthesis', async t => {
  const calls = [];
  const { port } = await startApp(t, {
    auditionSynth: async request => {
      calls.push(request);
      return tinyWav('auth');
    },
  });
  const character = await createCharacter(port, KOKORO_VOICE);

  const response = await audition(port, character.id, { token: null });
  assert.equal(response.status, 401, response.text);
  assert.equal(response.json.error, 'unauthorized');
  assert.equal(response.text.includes(TOKEN), false);
  assert.equal(calls.length, 0);
});

test('IP45W: a native-voice model answers 409 AUDITION_NATIVE_VOICE and never synthesises', async t => {
  const root = workspace(t);
  const calls = [];
  const cache = createAuditionCache({
    rootDir: root,
    synth: {
      kokoro: async request => {
        calls.push(request);
        return tinyWav('native');
      },
    },
  });
  const worker = createAuditionWorker({ cache, model: NATIVE_MODEL });
  const routes = createCharacterRoutes({
    rootDir: root,
    mediaTickets: createMediaTickets(),
    audition: { worker, model: NATIVE_MODEL },
  });
  const port = await serve(t, (request, response) => {
    Promise.resolve(routes.handle(request, response, new URL(request.url, `http://${request.headers.host}`)))
      .catch(error => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      });
  });
  const character = await createCharacter(port, KOKORO_VOICE);

  const response = await audition(port, character.id);
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.code, 'AUDITION_NATIVE_VOICE');
  assert.equal(response.json.voicePath, 'native');
  assert.equal(response.json.voice, 'minimax-narrator');
  assert.equal(response.json.language, 'en-us');
  assert.equal(calls.length, 0);
});
