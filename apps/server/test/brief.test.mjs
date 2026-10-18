import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

const TOKEN = 'brief-token-0123456789abcdef';
let runtime;
let app;
let server;
let port;

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-brief-'));
  app = createApp({
    root: new URL('../../..', import.meta.url).pathname,
    token: TOKEN,
    runtimeDir: runtime,
    render: async (packagePath, output) => ({ output, bytes: 0, frames: 0, hash: 'none' }),
    agentRunner: async () => {
      throw new Error('not used by brief tests');
    },
  });
  server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  app.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(runtime, { recursive: true, force: true });
});

function request({ method = 'GET', path = '/', token = TOKEN, origin = `http://127.0.0.1:${port}`, host = `127.0.0.1:${port}`, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (token) headers['x-comfyrizz-token'] = token;
    if (origin) headers.origin = origin;
    headers.host = host;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const RICH = 'A 45 second launch video for developers, calm and confident, ending with a star-the-repo CTA.';

test('POST /api/brief is authenticated and requires a prompt', async () => {
  assert.equal((await request({ method: 'POST', path: '/api/brief', token: null, body: { prompt: 'hi' } })).status, 401);
  assert.equal((await request({ method: 'POST', path: '/api/brief', body: {} })).status, 400);
  assert.equal((await request({ method: 'POST', path: '/api/brief', body: { prompt: '   ' } })).status, 400);
});

test('plan mode returns a draft plus at most three chip questions', async () => {
  const response = await request({ method: 'POST', path: '/api/brief', body: { prompt: RICH } });
  assert.equal(response.status, 200);
  assert.equal(response.json.mode, 'plan');
  assert.equal(response.json.complete, false);
  assert.deepEqual(response.json.questions.map(question => question.id), ['look', 'data']);
  for (const question of response.json.questions) {
    assert.ok(Array.isArray(question.chips) && question.chips.length > 0);
    assert.equal(typeof question.prompt, 'string');
  }
  assert.equal(response.json.brief.key_message, RICH);
  assert.equal(response.json.brief.audience.who, 'developers');
  assert.equal(response.json.brief.length_s, 45);
  assert.equal(response.json.brief.cta, 'star the repo');
  assert.equal(response.json.brief.mode, 'plan');
  // The SSE log records the plan, not the package.
  assert.equal(app.events.replay(0).at(-1).type, 'brief.planned');
});

test('plan mode never asks more than three questions', async () => {
  const response = await request({ method: 'POST', path: '/api/brief', body: { prompt: 'Make a video about our app.' } });
  assert.equal(response.json.complete, false);
  assert.deepEqual(response.json.questions.map(question => question.id), ['audience', 'length', 'look']);
});

test('plan mode completes once the chips are answered, and records decided_by_agent', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/brief',
    body: { prompt: 'Make a video about our app.', decisions: { audience: 'customers', length: '30 s social', look: 'clay', key_message: undefined } },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.complete, true);
  assert.deepEqual(response.json.questions, []);
  assert.equal(response.json.brief.audience.who, 'customers');
  assert.equal(response.json.brief.length_s, 30);
  assert.equal(response.json.brief.style.preset, 'clay');
  assert.equal(response.json.brief.key_message, 'Make a video about our app.');
  for (const id of ['audience', 'length', 'look']) {
    assert.ok(response.json.brief.decided_by_agent.includes(id), `${id} is recorded`);
  }
  // The completed brief is schema-shaped: exactly three tones and a preset palette.
  assert.equal(response.json.brief.tone.length, 3);
  assert.equal(response.json.brief.style.palette.length, 4);
});

test('Ask-more keeps the remaining questions instead of deciding', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/brief',
    body: { prompt: 'Make a video about our app.', decisions: { audience: 'customers', length: '30 s social', look: 'clay', key_message: undefined }, askMore: true },
  });
  assert.equal(response.json.complete, false);
  assert.deepEqual(response.json.questions.map(question => question.id), ['data', 'cta']);
});

test('express mode skips the questions and returns a validated brief', async () => {
  const response = await request({ method: 'POST', path: '/api/brief', body: { prompt: RICH, mode: 'express' } });
  assert.equal(response.status, 200);
  assert.equal(response.json.mode, 'express');
  assert.equal(response.json.complete, true);
  assert.deepEqual(response.json.questions, []);
  assert.equal(response.json.brief.key_message, RICH);
  assert.equal(response.json.brief.style.preset, 'cinematic-dark');
  assert.equal(response.json.brief.style.font, 'Inter');
  // French detection flows into the brief and the narration estimate.
  const french = await request({ method: 'POST', path: '/api/brief', body: { prompt: 'Explique comment ça marche for customers, en français', mode: 'express' } });
  assert.equal(french.json.brief.audience.language, 'fr');
  assert.equal(french.json.brief.voice.lang, 'fr');
});
