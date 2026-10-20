import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from './checks.mjs';
import { createToolChecks, parseVersion, parseMinVersion } from './check-tools.mjs';

const VERSIONS = {
  node: 'v22.3.0',
  pnpm: '9.12.3',
  uv: 'uv 0.4.18',
  python3: 'Python 3.12.1',
  ffmpeg: 'ffmpeg version 6.1-static',
};

function fakeExec(overrides = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const value = Object.hasOwn(overrides, cmd) ? overrides[cmd] : VERSIONS[cmd];
    if (value === 'MISSING') {
      const error = new Error(`${cmd} not found`);
      error.code = 'ENOENT';
      throw error;
    }
    return { code: 0, stdout: value };
  };
  exec.calls = calls;
  return exec;
}

function byId(results, id) {
  return results.find((result) => result.id === id);
}

test('all tools present produces only ok results', async () => {
  const results = await runChecks(createToolChecks({ exec: fakeExec() }));
  assert.deepEqual(results.map((result) => result.id), ['node', 'pnpm', 'uv', 'python', 'ffmpeg']);
  assert.deepEqual(results.map((result) => result.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.match(byId(results, 'node').detail, /22\.3\.0/);
  assert.match(byId(results, 'python').detail, /3\.12\.1/);
  assert.match(byId(results, 'ffmpeg').detail, /6\.1\.0/);
});

test('node 18 fails with a fix hint', async () => {
  const results = await runChecks(createToolChecks({
    exec: fakeExec({ node: 'v18.19.0' }),
  }));
  const node = byId(results, 'node');
  assert.equal(node.status, 'fail');
  assert.match(node.detail, /18\.19\.0/);
  assert.match(node.detail, /older than required 20\.0\.0/);
  assert.match(node.fix, /Node\.js >= 20/);
});

test('node minimum follows the injected engines value', async () => {
  const results = await runChecks(createToolChecks({
    exec: fakeExec(),
    minNode: '>=23',
  }));
  assert.equal(byId(results, 'node').status, 'fail');
  assert.match(byId(results, 'node').detail, /older than required 23\.0\.0/);
});

test('ffmpeg missing is a warning, not a failure', async () => {
  const results = await runChecks(createToolChecks({
    exec: fakeExec({ ffmpeg: 'MISSING' }),
  }));
  const ffmpeg = byId(results, 'ffmpeg');
  assert.equal(ffmpeg.status, 'warn');
  assert.match(ffmpeg.detail, /ffmpeg not found/);
  assert.match(ffmpeg.fix, /ffmpeg/);
});

test('uv missing is a warning, not a failure', async () => {
  const results = await runChecks(createToolChecks({
    exec: fakeExec({ uv: 'MISSING' }),
  }));
  assert.equal(byId(results, 'uv').status, 'warn');
});

test('pnpm missing fails', async () => {
  const results = await runChecks(createToolChecks({
    exec: fakeExec({ pnpm: 'MISSING' }),
  }));
  const pnpm = byId(results, 'pnpm');
  assert.equal(pnpm.status, 'fail');
  assert.match(pnpm.fix, /pnpm/);
});

test('python older than 3.12 fails', async () => {
  const results = await runChecks(createToolChecks({
    exec: fakeExec({ python3: 'Python 3.11.9' }),
  }));
  const python = byId(results, 'python');
  assert.equal(python.status, 'fail');
  assert.match(python.detail, /3\.11\.9/);
  assert.match(python.fix, /3\.12/);
});

test('python missing fails', async () => {
  const results = await runChecks(createToolChecks({
    exec: fakeExec({ python3: 'MISSING' }),
  }));
  const python = byId(results, 'python');
  assert.equal(python.status, 'fail');
  assert.match(python.detail, /python3 not found/);
});

test('parseVersion handles node, python and ffmpeg output', () => {
  assert.deepEqual(parseVersion('v22.3.0'), { major: 22, minor: 3, patch: 0 });
  assert.deepEqual(parseVersion('Python 3.12.1'), { major: 3, minor: 12, patch: 1 });
  assert.deepEqual(parseVersion('ffmpeg version 6.1-static'), { major: 6, minor: 1, patch: 0 });
});

test('parseVersion fills missing minor and patch and rejects junk', () => {
  assert.deepEqual(parseVersion('v20'), { major: 20, minor: 0, patch: 0 });
  assert.deepEqual(parseVersion('3.12'), { major: 3, minor: 12, patch: 0 });
  assert.equal(parseVersion('no numbers here'), null);
  assert.equal(parseVersion(''), null);
});

test('parseMinVersion reads an engines range', () => {
  assert.deepEqual(parseMinVersion('>=20'), { major: 20, minor: 0, patch: 0 });
  assert.deepEqual(parseMinVersion('>=22.3.0'), { major: 22, minor: 3, patch: 0 });
  assert.deepEqual(parseMinVersion({ major: 22, minor: 1 }), { major: 22, minor: 1, patch: 0 });
  assert.equal(parseMinVersion('any'), null);
});

test('createToolChecks requires an exec function', () => {
  assert.throws(() => createToolChecks(), /exec/);
});

test('per-command probe failures do not leak command output', async () => {
  const exec = async (cmd) => {
    if (cmd === 'node') return { code: 1, stdout: '', stderr: 'SECRET_TOKEN=abc' };
    return { code: 0, stdout: VERSIONS[cmd] };
  };
  const results = await runChecks(createToolChecks({ exec }));
  const node = byId(results, 'node');
  assert.equal(node.status, 'fail');
  assert.equal(node.detail, 'node --version failed');
  assert.doesNotMatch(JSON.stringify(results), /SECRET_TOKEN|abc/);
});
