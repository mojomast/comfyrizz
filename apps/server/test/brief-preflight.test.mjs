// PS03: the brief preflight must refuse the six known-unsatisfiable brief
// classes before any tool loop starts, with a typed 400/422 response whose
// detail is actionable. A solvable brief must reach the agent runner untouched.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.mjs';
import { preflightBrief } from '../src/brief-preflight.mjs';
import { fixtureById } from '../../../qa/planning-stress/fixtures.mjs';

const TOKEN = 'ps03-brief-preflight-token';
const FAILURE_IDS = ['X31', 'X32', 'X33', 'X34', 'X35', 'X36'];
const SOLVABLE_IDS = ['S01', 'S02', 'T29'];

function detailOf(verdict) {
  return [verdict.message, ...(Array.isArray(verdict.details) ? verdict.details : [])].join('\n');
}

for (const id of FAILURE_IDS) {
  test(`${id} is refused with a typed actionable detail`, () => {
    const fixture = fixtureById(id);
    const verdict = preflightBrief({ brief: fixture.brief, motionModel: fixture.motionModel });
    assert.ok(verdict, `${id} must be refused`);
    assert.ok([400, 422].includes(verdict.status), `${id} status ${verdict.status}`);
    assert.ok(['BRIEF_UNSATISFIABLE', 'REFUSAL'].includes(verdict.code), `${id} code ${verdict.code}`);
    const detail = detailOf(verdict);
    assert.ok(detail.length >= 12, `${id} detail must be actionable`);
    assert.match(detail, new RegExp(fixture.oracle.detailPattern, 'i'), `${id} detail: ${detail}`);
  });
}

for (const id of SOLVABLE_IDS) {
  test(`${id} passes the preflight`, () => {
    const fixture = fixtureById(id);
    assert.equal(preflightBrief({ brief: fixture.brief, motionModel: fixture.motionModel }), null);
  });
}

test('a terse solvable motion-graphics brief passes', () => {
  const brief = 'Create a 6-second one-scene motion-graphics title card. Headline: "Harbor Light". Draw one SVG underline. Plan one paper still. No narration.';
  assert.equal(preflightBrief({ brief, motionModel: 'auto' }), null);
});

test('an LTX dialogue brief that offers the H3 or wordless choice passes', () => {
  const brief = 'Create a 10-second generated film in 1 shot. The motion model must stay ltx. If the shot needs dialogue, choose H3 or wordless finishing.';
  assert.equal(preflightBrief({ brief, motionModel: 'ltx' }), null);
});

test('a 2.39-second shot is not mistaken for a 2.39:1 aspect', () => {
  const brief = 'Create a 4.78-second two-scene motion-graphics bumper. Each scene is 2.39 seconds. No narration.';
  assert.equal(preflightBrief({ brief, motionModel: 'auto' }), null);
});

test('a negated unsupported format does not trigger the format refusal', () => {
  const brief = 'Create a 6-second one-scene motion-graphics title card. Do not use 8K, 120 fps or aspect 2.39:1; use 1920x1080 at 30 fps and 16:9. No narration.';
  assert.equal(preflightBrief({ brief, motionModel: 'auto' }), null);
});

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function postAgent(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/agent',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-comfyrizz-token': TOKEN,
        origin: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
      },
    }, response => {
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
        resolve({ status: response.statusCode, json });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function startApp(t, agentRunner) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ps03-'));
  const app = createApp({
    root: new URL('../../..', import.meta.url).pathname,
    token: TOKEN,
    runtimeDir,
    render: async (packagePath, output) => ({ output, bytes: 0, frames: 0, hash: 'none' }),
    agentRunner,
  });
  const server = createServer(app.handler);
  t.after(() => {
    app.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return listen(t, server);
}

test('POST /api/agent refuses before the agent runner is called', async (t) => {
  let calls = 0;
  const port = await startApp(t, async () => {
    calls += 1;
    throw new Error('agent runner must not run for an unsatisfiable brief');
  });
  const fixture = fixtureById('X34');
  const response = await postAgent(port, { brief: fixture.brief, motionModel: fixture.motionModel });
  assert.equal(response.status, 422);
  assert.equal(response.json?.code, 'REFUSAL');
  assert.match(response.json?.error ?? '', /dialogue|H3|wordless|LTX|synchron/i);
  assert.ok(Array.isArray(response.json?.details));
  assert.equal(calls, 0);
});

test('POST /api/agent lets a solvable brief reach the agent runner', async (t) => {
  let calls = 0;
  const port = await startApp(t, async () => {
    calls += 1;
    throw Object.assign(new Error('preflight let the brief through'), { status: 500 });
  });
  const fixture = fixtureById('S01');
  const response = await postAgent(port, { brief: fixture.brief });
  assert.equal(calls, 1);
  assert.equal(response.status, 500);
  assert.match(response.json?.error ?? '', /preflight let the brief through/);
});
