import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  agentRequestTimeoutMs,
  configureServerTimeouts,
} from '../src/index.mjs';
import { LIMITS, workerEnv } from '../../../qa/planning-stress/run.mjs';

function fakeServer(overrides = {}) {
  return {
    requestTimeout: 300_000,
    headersTimeout: 60_000,
    keepAliveTimeout: 5_000,
    ...overrides,
  };
}

test('PS11: the default request timeout outlives a long planning turn', () => {
  assert.ok(DEFAULT_REQUEST_TIMEOUT_MS > 300_000, 'default must not stay at the Node 300 s cutoff');
  assert.equal(agentRequestTimeoutMs({}), DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(agentRequestTimeoutMs({ COMFYRIZZ_REQUEST_TIMEOUT_MS: '' }), DEFAULT_REQUEST_TIMEOUT_MS);
});

test('PS11: configureServerTimeouts raises the socket deadline without touching keep-alive', () => {
  const server = fakeServer();
  assert.equal(configureServerTimeouts(server, {}), server);
  assert.equal(server.requestTimeout, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.ok(server.headersTimeout <= server.requestTimeout);
  assert.equal(server.keepAliveTimeout, 5_000);
});

test('PS11: COMFYRIZZ_REQUEST_TIMEOUT_MS overrides the deadline and 0 disables it', () => {
  assert.equal(agentRequestTimeoutMs({ COMFYRIZZ_REQUEST_TIMEOUT_MS: '600000' }), 600_000);
  const tuned = fakeServer();
  configureServerTimeouts(tuned, { COMFYRIZZ_REQUEST_TIMEOUT_MS: '600000' });
  assert.equal(tuned.requestTimeout, 600_000);
  assert.ok(tuned.headersTimeout <= tuned.requestTimeout);

  const disabled = fakeServer();
  configureServerTimeouts(disabled, { COMFYRIZZ_REQUEST_TIMEOUT_MS: '0' });
  assert.equal(disabled.requestTimeout, 0);
  assert.equal(disabled.headersTimeout, 60_000);
});

test('PS11: invalid timeout overrides fall back instead of silently disabling the guard', () => {
  for (const raw of ['-1', 'abc', '1.5', 'Infinity']) {
    assert.equal(agentRequestTimeoutMs({ COMFYRIZZ_REQUEST_TIMEOUT_MS: raw }), DEFAULT_REQUEST_TIMEOUT_MS, raw);
  }
});

test('PS11: planning-stress attempt budget stays inside the worker socket budget', () => {
  assert.ok(LIMITS.attemptTimeoutMs >= 8 * 60 * 1000);
  assert.ok(
    LIMITS.serverRequestTimeoutMs >= LIMITS.attemptTimeoutMs,
    'the server must not cut a live plan before the harness attempt timeout',
  );
  assert.notEqual(LIMITS.serverRequestTimeoutMs, 300_000);

  const env = workerEnv({
    port: 4521,
    runtimeDir: '/tmp/opencode/comfyrizz-planning-stress/runtimes/unit/4521',
    token: 'local-server-token',
    baseEnv: { PATH: '/usr/bin' },
  });
  assert.equal(env.COMFYRIZZ_REQUEST_TIMEOUT_MS, String(LIMITS.serverRequestTimeoutMs));
});
