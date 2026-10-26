import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createCharacterRoutes } from '../../src/characters/routes.mjs';
import {
  AUDITION_PROMPT_PLANNED,
  PROMPT_VOICE_UNSUPPORTED,
  createAuditionCache,
  createAuditionWorker,
} from '../../src/characters/audition.mjs';
import { createMediaTickets } from '../../src/media-range.mjs';

const NOW = '2026-10-26T12:00:00.000Z';
const LINE = 'Fresh is best.';
const PROMPT_MODEL = Object.freeze({
  id: 'prompt',
  capabilities: Object.freeze({ promptVoice: true }),
});
const DESCRIBE = Object.freeze({
  h3VoiceMode: 'prompt',
  description: 'Warm, low and unhurried.',
});

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

function harness(t, { model } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-character-audition-honest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const cache = createAuditionCache({
    rootDir: root,
    synth: {
      kokoro: async request => {
        calls.push(request);
        return wav(request.line);
      },
    },
  });
  const worker = createAuditionWorker({ cache });
  const routes = createCharacterRoutes({
    rootDir: root,
    clock: () => new Date(NOW),
    randomId: idSource(),
    mediaTickets: createMediaTickets(),
    audition: { worker, ...(model ? { model } : {}) },
  });
  return { routes, calls };
}

async function createCharacter(routes) {
  const response = await invoke(routes, {
    method: 'POST',
    path: '/api/characters',
    headers: { 'content-type': 'application/json' },
    body: {
      name: 'Pip',
      role: 'mascot',
      fictional: true,
      voice: { engine: 'kokoro', voice: 'af_heart', language: 'en-us', sampleLines: [LINE] },
    },
  });
  assert.equal(response.status, 201, response.body.toString('utf8'));
  return response.json();
}

async function audition(routes, id) {
  return invoke(routes, {
    method: 'POST',
    path: `/api/characters/${id}/audition`,
    headers: { 'content-type': 'application/json' },
    body: { line: LINE, ...DESCRIBE },
  });
}

test('UX13: a Describe audition without prompt capability is unsupported and never falls back to Kokoro', async (t) => {
  const { routes, calls } = harness(t);
  const character = await createCharacter(routes);

  const response = await audition(routes, character.id);

  assert.equal(response.status, 422, response.body.toString('utf8'));
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, PROMPT_VOICE_UNSUPPORTED);
  assert.equal(body.voicePath, 'prompt');
  assert.match(body.message, /does not support prompt voice/i);
  assert.equal(body.url, undefined);
  assert.equal(body.ticket, undefined);
  assert.equal(calls.length, 0, 'no stock synthesis path may run for a written voice');
});

test('UX13: a prompt-capable model returns a planned prompt audition with no synthesized audio', async (t) => {
  const { routes, calls } = harness(t, { model: PROMPT_MODEL });
  const character = await createCharacter(routes);

  const response = await audition(routes, character.id);

  assert.equal(response.status, 200, response.body.toString('utf8'));
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, AUDITION_PROMPT_PLANNED);
  assert.equal(body.voicePath, 'prompt');
  assert.equal(body.state, 'planned');
  assert.equal(body.approvalRequired, true);
  assert.equal(body.approved, false);
  assert.equal(body.autoDispatch, false);
  assert.equal(body.line, LINE);
  assert.equal(body.url, undefined);
  assert.equal(body.ticket, undefined);
  assert.equal(calls.length, 0, 'planning never synthesizes a substitute voice');
});
