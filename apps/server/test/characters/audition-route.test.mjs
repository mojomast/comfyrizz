// IP45: the audition HTTP route, the TTS worker and media delivery.
//
// The route has one job: load the character, call the injected audition worker
// and hand the Kokoro wave out through a short-lived media ticket. The worker
// owns synthesis and the Q4 capability decision: a model that declares a native
// voice is never synthesised here, and a paid engine is never synthesised
// without an admitted action.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createCharacterRoutes } from '../../src/characters/routes.mjs';
import {
  AUDITION_ADMISSION_REQUIRED,
  AUDITION_NATIVE_VOICE,
  AUDITION_READY,
  createAuditionCache,
  createAuditionWorker,
} from '../../src/characters/audition.mjs';
import { createMediaTickets } from '../../src/media-range.mjs';
import { auditionFile, auditionKey } from '../../src/characters/audition.mjs';

const NOW = '2026-10-23T12:00:00.000Z';
const LINE = 'Morning! Let us grind.';
const CPU_MODEL = Object.freeze({ id: 'cpu', capabilities: Object.freeze({ supportsNativeVoice: false }) });
const NATIVE_MODEL = Object.freeze({
  id: 'minimax',
  capabilities: Object.freeze({
    supportsNativeVoice: true,
    nativeVoices: Object.freeze([Object.freeze({ id: 'minimax-narrator', language: 'en-us' })]),
    defaultNativeVoice: 'minimax-narrator',
  }),
});
const QWEN_VOICE = Object.freeze({ engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom', sampleLines: [LINE] });

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

async function invoke(routes, { method = 'GET', path, headers = {}, body } = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value);
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  request.method = method;
  request.headers = normalized;
  request.url = path;

  const response = new CaptureResponse();
  const finished = new Promise(resolve => response.on('finish', resolve));
  const matched = await routes.handle(request, response, new URL(path, 'http://127.0.0.1'));
  if (matched) await finished;
  return { matched, status: response.status, headers: response.headers, body: response.body, json: () => response.json() };
}

function wav(label) {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WAVEfmt '),
    Buffer.from(String(label)),
  ]);
}

function idSource() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return sequence.toString(16).padStart(16, '0');
  };
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-character-audition-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function harness(t, { model = CPU_MODEL, admission, synth } = {}) {
  const root = workspace(t);
  const calls = [];
  const synthesize = async (request) => {
    calls.push(request);
    if (synth) return synth(request);
    return wav(request.line);
  };
  const cache = createAuditionCache({
    rootDir: root,
    synth: { kokoro: synthesize, 'qwen3-tts': synthesize },
  });
  const worker = createAuditionWorker({
    cache,
    ...(admission ? { admission } : {}),
  });
  const mediaTickets = createMediaTickets();
  const routes = createCharacterRoutes({
    rootDir: root,
    clock: () => new Date(NOW),
    randomId: idSource(),
    mediaTickets,
    audition: { worker, model },
  });
  return { root, routes, mediaTickets, calls, worker, cache };
}

async function createCharacter(routes, voice) {
  const response = await invoke(routes, {
    method: 'POST',
    path: '/api/characters',
    headers: { 'content-type': 'application/json' },
    body: { name: 'Pip', role: 'mascot', fictional: true, ...(voice ? { voice } : {}) },
  });
  assert.equal(response.status, 201, response.body.toString('utf8'));
  return response.json();
}

function auditionPath(id) {
  return `/api/characters/${id}/audition`;
}

test('IP45: POST /api/characters/:id/audition delivers a Kokoro wave through a media ticket', async (t) => {
  const { routes, mediaTickets, calls } = harness(t);
  const character = await createCharacter(routes, { engine: 'kokoro', voice: 'am_michael', sampleLines: [LINE] });

  const response = await invoke(routes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });

  assert.equal(response.status, 200, response.body.toString('utf8'));
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.code, AUDITION_READY);
  assert.equal(body.voicePath, 'kokoro');
  assert.equal(body.voice, 'am_michael');
  assert.equal(body.engine, 'kokoro');
  assert.equal(body.line, LINE);
  assert.equal(body.contentType, 'audio/wav');
  assert.equal(body.file, auditionFile(body.voiceHash, LINE));
  assert.equal(body.filename, `${auditionKey(body.voiceHash, LINE)}.wav`);
  assert.equal(body.path, undefined, 'the local path never reaches the response');
  assert.match(body.url, /^\/api\/media\/[a-f0-9]{32}$/);
  assert.match(body.ticket, /^[a-f0-9]{32}$/);
  assert.equal(typeof body.expiresAt, 'string');

  const served = mediaTickets.resolve(body.ticket);
  assert.ok(served, 'the ticket resolves to the audition file');
  assert.equal(existsSync(served), true);
  assert.deepEqual(readFileSync(served), wav(LINE));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].engine, 'kokoro');
  assert.equal(calls[0].text, LINE);

  const cached = await invoke(routes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });
  assert.equal(cached.status, 200);
  assert.equal(cached.json().cached, true);
  assert.equal(calls.length, 1, 'a cached audition never calls the synthesizer again');
  assert.ok(mediaTickets.resolve(cached.json().ticket));
});

test('IP45: a native-capable model answers AUDITION_NATIVE_VOICE and never synthesizes', async (t) => {
  const { routes, calls } = harness(t, { model: NATIVE_MODEL });
  const character = await createCharacter(routes, { engine: 'kokoro', voice: 'am_michael', sampleLines: [LINE] });

  const response = await invoke(routes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });

  assert.equal(response.status, 409, response.body.toString('utf8'));
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, AUDITION_NATIVE_VOICE);
  assert.equal(body.voicePath, 'native');
  assert.equal(body.voice, 'minimax-narrator');
  assert.equal(body.language, 'en-us');
  assert.match(body.message, /generated take/i);
  assert.equal(body.file, undefined);
  assert.equal(body.url, undefined);
  assert.equal(calls.length, 0, 'no TTS runtime was touched');
});

test('IP45: a paid engine is refused without an admitted action and synthesized once admitted', async (t) => {
  const denied = harness(t);
  const deniedCharacter = await createCharacter(denied.routes, QWEN_VOICE);

  const refused = await invoke(denied.routes, {
    method: 'POST',
    path: auditionPath(deniedCharacter.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });
  assert.equal(refused.status, 403, refused.body.toString('utf8'));
  assert.equal(refused.json().ok, false);
  assert.equal(refused.json().code, AUDITION_ADMISSION_REQUIRED);
  assert.equal(denied.calls.length, 0, 'paid synthesis is refused before the worker touches the runtime');

  const admissions = [];
  const admitted = harness(t, {
    admission: async (request) => {
      admissions.push(request);
      return true;
    },
  });
  const admittedCharacter = await createCharacter(admitted.routes, QWEN_VOICE);
  const ready = await invoke(admitted.routes, {
    method: 'POST',
    path: auditionPath(admittedCharacter.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });

  assert.equal(ready.status, 200, ready.body.toString('utf8'));
  assert.equal(ready.json().ok, true);
  assert.equal(ready.json().engine, 'qwen3-tts');
  assert.match(ready.json().url, /^\/api\/media\/[a-f0-9]{32}$/);
  assert.equal(admissions.length, 1);
  assert.deepEqual(admissions[0], {
    kind: 'audition',
    engine: 'qwen3-tts',
    voice: 'Ryan',
    line: LINE,
    characterId: admittedCharacter.id,
  });
  assert.equal(admitted.calls.length, 1);
});

test('IP45: the route keeps one audition option object and refuses aliases', async (t) => {
  const root = workspace(t);
  const mediaTickets = createMediaTickets();
  const worker = { run: async () => ({ ok: false, code: 'AUDITION_UNAVAILABLE', message: 'not configured' }) };

  assert.throws(
    () => createCharacterRoutes({ rootDir: root, audition: { worker, model: CPU_MODEL, synth: async () => wav(LINE) } }),
    /unknown audition option/i,
  );
  assert.throws(
    () => createCharacterRoutes({ rootDir: root, audition: { model: CPU_MODEL } }),
    /worker/i,
  );
  assert.throws(
    () => createCharacterRoutes({ rootDir: root, audition: { worker: {}, model: CPU_MODEL } }),
    /run/i,
  );

  const calls = [];
  const routes = createCharacterRoutes({
    rootDir: root,
    clock: () => new Date(NOW),
    randomId: idSource(),
    mediaTickets,
    auditionSynth: async (request) => {
      calls.push(request);
      return wav(request.line);
    },
  });
  const character = await createCharacter(routes, { engine: 'kokoro', voice: 'am_michael' });
  const response = await invoke(routes, {
    method: 'POST',
    path: auditionPath(character.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });
  assert.equal(response.status, 503);
  assert.equal(response.json().code, 'AUDITION_UNAVAILABLE');
  assert.equal(calls.length, 0, 'a removed alias cannot synthesize');
});

test('IP45: the route requires a worker, media tickets, a known character and POST', async (t) => {
  const { routes } = harness(t);
  const character = await createCharacter(routes, { engine: 'kokoro', voice: 'am_michael' });

  const missing = await invoke(routes, {
    method: 'POST',
    path: '/api/characters/chr_ffffffffffffffff/audition',
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().code, 'NOT_FOUND');

  const get = await invoke(routes, { method: 'GET', path: auditionPath(character.id) });
  assert.equal(get.status, 405);

  const noWorkerRoot = workspace(t);
  const noWorker = createCharacterRoutes({ rootDir: noWorkerRoot, clock: () => new Date(NOW), randomId: idSource() });
  const noWorkerCharacter = await createCharacter(noWorker, { engine: 'kokoro', voice: 'am_michael' });
  const unavailable = await invoke(noWorker, {
    method: 'POST',
    path: auditionPath(noWorkerCharacter.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json().code, 'AUDITION_UNAVAILABLE');

  const noTicketsRoot = workspace(t);
  const worker = { run: async () => ({ ok: true, code: AUDITION_READY, path: join(noTicketsRoot, 'nope.wav'), file: 'auditions/nope.wav' }) };
  const noTickets = createCharacterRoutes({
    rootDir: noTicketsRoot,
    clock: () => new Date(NOW),
    randomId: idSource(),
    audition: { worker, model: CPU_MODEL },
  });
  const noTicketsCharacter = await createCharacter(noTickets, { engine: 'kokoro', voice: 'am_michael' });
  const ticketless = await invoke(noTickets, {
    method: 'POST',
    path: auditionPath(noTicketsCharacter.id),
    headers: { 'content-type': 'application/json' },
    body: { line: LINE },
  });
  assert.equal(ticketless.status, 503);
  assert.equal(ticketless.json().code, 'AUDITION_UNAVAILABLE');
});
