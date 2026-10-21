import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateLaunchHandler, issuePrivateLaunch } from './private-launch.mjs';

test('private launch requires an unexpired one-use grant and same-origin POST; previews reveal no token', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-launch-'));
  try {
    const tokenFile = join(root, 'token'), grantFile = join(root, 'grant');
    writeFileSync(tokenFile, 'test-only-secret');
    const origin = 'https://private.example:8451';
    let time = 1000;
    const args = { tokenFile, grantFile, origin };
    let url = new URL(issuePrivateLaunch({ ...args, now: time }));
    const handler = createPrivateLaunchHandler({ ...args, now: () => time });
    const call = (method, overrides = {}) => {
      const result = {};
      handler({ method, url: url.pathname, headers: { host: url.host, ...(method === 'POST' ? { origin } : {}), ...overrides } }, {
        writeHead(status, headers) { Object.assign(result, { status, headers }); },
        end(body) { result.body = body; },
      });
      return result;
    };
    assert.equal(call('HEAD').status, 200);
    const preview = call('GET');
    assert.equal(preview.status, 200);
    assert.ok(!JSON.stringify(preview).includes('test-only-secret'));
    assert.equal(call('POST', { origin: 'https://attacker.example' }).status, 403);
    assert.equal(call('POST', { origin: undefined }).status, 403);
    assert.equal(call('GET', { host: 'attacker.example' }).status, 403);
    const accepted = call('POST');
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.Location, '/#token=test-only-secret');
    assert.equal(call('POST').status, 404);
    url = new URL(issuePrivateLaunch({ ...args, now: time }));
    time += 3600001;
    assert.equal(call('POST').status, 404);
    url = new URL(issuePrivateLaunch({ ...args, now: time }));
    writeFileSync(tokenFile, 'rotated-test-secret');
    assert.equal(call('POST').status, 404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
