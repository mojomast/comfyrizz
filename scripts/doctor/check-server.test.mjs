import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './checks.mjs';
import { fixHint } from './fix-hints.mjs';
import {
  DEFAULT_PORT,
  HEALTH_PATH,
  SERVER_CHECK_ID,
  SERVER_CHECK_TITLE,
  SERVER_START_HINT,
  checkServer,
  createServerCheck,
  healthUrl,
  isConnectionRefused,
  resolvePort,
} from './check-server.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const FAKE_TOKEN = 'fake-token-value-for-leak-test';

function refused() {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4319'), {
      code: 'ECONNREFUSED',
    }),
  });
}

function recordingFetch(result) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, fetchImpl };
}

function runWith(fetchImpl, env) {
  return runChecks([checkServer], { fetch: fetchImpl, env });
}

test('connection refused becomes a skip carrying the start hint', async () => {
  const { fetchImpl } = recordingFetch(refused());
  const [result] = await runWith(fetchImpl, {});
  assert.equal(result.id, SERVER_CHECK_ID);
  assert.equal(result.title, SERVER_CHECK_TITLE);
  assert.equal(result.status, 'skip');
  assert.match(result.detail, /not running/);
  assert.ok(
    result.detail.includes(SERVER_START_HINT),
    `detail must carry the start hint: ${result.detail}`,
  );
  assert.match(result.detail, /^not running \(start with pnpm --filter @comfyrizz\/server start\)$/);
});

test('a plain "connection refused" message also counts as a refusal', async () => {
  const { fetchImpl } = recordingFetch(new Error('connect ECONNREFUSED 127.0.0.1:4319'));
  const [result] = await runWith(fetchImpl, {});
  assert.equal(result.status, 'skip');
  assert.ok(isConnectionRefused(new Error('connect ECONNREFUSED 127.0.0.1:4319')));
  assert.ok(isConnectionRefused(Object.assign(new AggregateError([], 'fetch failed'), {
    errors: [refused().cause],
  })));
  assert.equal(isConnectionRefused(new Error('boom')), false);
  assert.equal(isConnectionRefused(undefined), false);
});

test('HTTP 200 is ok with the spec detail', async () => {
  const { fetchImpl, calls } = recordingFetch({ status: 200 });
  const [result] = await runWith(fetchImpl, {});
  assert.equal(result.status, 'ok');
  assert.equal(result.detail, 'server running');
  assert.equal(calls[0].url, 'http://127.0.0.1:4319/api/health');
});

test('HTTP 500 is a warn naming the status', async () => {
  const { fetchImpl } = recordingFetch({ status: 500 });
  const [result] = await runWith(fetchImpl, {});
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /500/);
});

test('any other non-200 status is a warn', async () => {
  for (const status of [401, 403, 404, 503]) {
    const { fetchImpl } = recordingFetch({ status });
    const [result] = await runWith(fetchImpl, {});
    assert.equal(result.status, 'warn', `status ${status}`);
    assert.ok(result.detail.includes(String(status)), result.detail);
  }
});

test('an unusable response object is a warn, not a crash', async () => {
  const { fetchImpl } = recordingFetch({});
  const [result] = await runWith(fetchImpl, {});
  assert.equal(result.status, 'warn');
  assert.ok(result.detail.length > 0);
});

test('a custom COMFYRIZZ_PORT is used for the health URL', async () => {
  const { fetchImpl, calls } = recordingFetch({ status: 200 });
  const [result] = await runWith(fetchImpl, { COMFYRIZZ_PORT: '9317' });
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9317/api/health');
});

test('resolvePort honours the env default and falls back on junk', () => {
  assert.equal(resolvePort({}), DEFAULT_PORT);
  assert.equal(resolvePort(undefined), DEFAULT_PORT);
  assert.equal(resolvePort({ COMFYRIZZ_PORT: '' }), DEFAULT_PORT);
  assert.equal(resolvePort({ COMFYRIZZ_PORT: 'not-a-port' }), DEFAULT_PORT);
  assert.equal(resolvePort({ COMFYRIZZ_PORT: '0' }), DEFAULT_PORT);
  assert.equal(resolvePort({ COMFYRIZZ_PORT: '70000' }), DEFAULT_PORT);
  assert.equal(resolvePort({ COMFYRIZZ_PORT: ' 9317 ' }), 9317);
  assert.equal(resolvePort({ COMFYRIZZ_PORT: 5055 }), 5055);
  assert.equal(healthUrl(), `http://127.0.0.1:${DEFAULT_PORT}${HEALTH_PATH}`);
  assert.equal(healthUrl(1234), 'http://127.0.0.1:1234/api/health');
});

test('the request sends no auth header, no token and no extra headers', async () => {
  const { fetchImpl, calls } = recordingFetch({ status: 200 });
  await runWith(fetchImpl, { COMFYRIZZ_TOKEN: FAKE_TOKEN });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(init.method, 'GET');
  assert.equal(init.headers, undefined, 'no headers may be set on the health request');
  assert.equal(url, 'http://127.0.0.1:4319/api/health');
  assert.ok(!/[?&#]token=/.test(url), `health URL must not carry a token: ${url}`);
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /authorization|x-comfyrizz-token|bearer/i);
});

test('an injected token value never reaches the request or the result', async () => {
  const { fetchImpl, calls } = recordingFetch({ status: 500 });
  const [result] = await runWith(fetchImpl, { COMFYRIZZ_TOKEN: FAKE_TOKEN });
  const output = JSON.stringify({ calls, result });
  assert.ok(!output.includes(FAKE_TOKEN), 'secret value leaked into request or result');
  assert.equal(result.status, 'warn');
});

test('a non-refused network error warns with the message', async () => {
  const { fetchImpl } = recordingFetch(new Error('socket hang up'));
  const [result] = await runWith(fetchImpl, {});
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /socket hang up/);
});

test('a missing fetch becomes a fail through runChecks', async () => {
  const results = await runChecks([checkServer], { fetch: null, env: {} });
  assert.equal(results[0].status, 'fail');
  assert.match(results[0].detail, /fetch/);
});

test('runChecks preserves order, ids and titles for the server check', async () => {
  const { fetchImpl } = recordingFetch({ status: 200 });
  const results = await runChecks(
    [
      async () => ({ id: 'node', title: 'Node', status: 'ok', detail: 'v22' }),
      checkServer,
    ],
    { fetch: fetchImpl, env: {} },
  );
  assert.deepEqual(results.map((r) => r.id), ['node', SERVER_CHECK_ID]);
  assert.equal(results[1].title, SERVER_CHECK_TITLE);
  assert.equal(results[1].status, 'ok');
});

test('createServerCheck binds injected deps and keeps id/title', async () => {
  const { fetchImpl, calls } = recordingFetch({ status: 200 });
  const check = createServerCheck({ fetch: fetchImpl, env: { COMFYRIZZ_PORT: '4455' } });
  assert.equal(check.id, SERVER_CHECK_ID);
  assert.equal(check.title, SERVER_CHECK_TITLE);
  const results = await runChecks([check], {});
  assert.equal(results[0].status, 'ok');
  assert.equal(calls[0].url, 'http://127.0.0.1:4455/api/health');
});

test('the start hint matches the shared fix hint table', () => {
  assert.equal(SERVER_START_HINT, fixHint('server'));
  assert.equal(SERVER_START_HINT, 'pnpm --filter @comfyrizz/server start');
});

test('defaults and health path match the server source', () => {
  const indexSource = readFileSync(join(repoRoot, 'apps', 'server', 'src', 'index.mjs'), 'utf8');
  const portMatch = /COMFYRIZZ_PORT\s*\?\?\s*(\d+)/.exec(indexSource);
  assert.ok(portMatch, 'expected a COMFYRIZZ_PORT default in apps/server/src/index.mjs');
  assert.equal(Number(portMatch[1]), DEFAULT_PORT);

  const appSource = readFileSync(join(repoRoot, 'apps', 'server', 'src', 'app.mjs'), 'utf8');
  assert.ok(
    appSource.includes(`url.pathname === '${HEALTH_PATH}'`),
    `apps/server/src/app.mjs must serve ${HEALTH_PATH}`,
  );
});

test('the module source holds no secrets and no machine-specific paths', () => {
  const source = readFileSync(fileURLToPath(new URL('./check-server.mjs', import.meta.url)), 'utf8');
  const secretPattern = /(sk-[A-Za-z0-9]{8,}|hf_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9])/;
  const homePattern = /(\/home\/|\/workspace\/|C:\\Users|tailnet|ts\.net)/i;
  assert.doesNotMatch(source, secretPattern, 'module looks like it contains a secret');
  assert.doesNotMatch(source, homePattern, 'module contains a machine-specific path');
  assert.ok(!source.includes(FAKE_TOKEN), 'module must not embed the fake token');
});
