import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeResult, runChecks, summarize } from './checks.mjs';

function pass(id, title, detail = 'fine') {
  return { id, title, status: 'ok', detail };
}

function named(id, title, fn) {
  fn.id = id;
  fn.title = title;
  return fn;
}

test('makeResult accepts every valid status and fills defaults', () => {
  for (const status of ['ok', 'warn', 'fail', 'skip']) {
    const result = makeResult({ id: 'x', title: 'X', status });
    assert.deepEqual(result, { id: 'x', title: 'X', status, detail: '', fix: '' });
  }
});

test('makeResult rejects an invalid status', () => {
  assert.throws(() => makeResult({ id: 'x', title: 'X', status: 'error' }), /invalid status/);
  assert.throws(() => makeResult({ id: 'x', title: 'X' }), /invalid status/);
});

test('runChecks passes ctx and preserves result fields', async () => {
  const ctx = { root: '/repo' };
  const results = await runChecks([
    named('a', 'A', async (received) => pass('a', 'A', received.root)),
  ], ctx);
  assert.deepEqual(results, [{ id: 'a', title: 'A', status: 'ok', detail: '/repo', fix: '' }]);
});

test('runChecks turns a throwing check into fail with its message', async () => {
  const results = await runChecks([
    named('broken', 'Broken check', () => {
      throw new Error('boom happened');
    }),
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'broken');
  assert.equal(results[0].title, 'Broken check');
  assert.equal(results[0].status, 'fail');
  assert.equal(results[0].detail, 'boom happened');
  assert.equal(results[0].fix, '');
});

test('runChecks turns an async rejection into fail with its message', async () => {
  const results = await runChecks([
    named('rejects', 'Rejects', async () => {
      throw new Error('async boom');
    }),
  ]);
  assert.equal(results[0].status, 'fail');
  assert.equal(results[0].detail, 'async boom');
});

test('runChecks turns a non-Error throw into fail', async () => {
  const results = await runChecks([
    named('string', 'String throw', () => {
      throw 'plain failure';
    }),
  ]);
  assert.equal(results[0].status, 'fail');
  assert.equal(results[0].detail, 'plain failure');
});

test('runChecks times out a slow check and keeps going', async () => {
  const results = await runChecks([
    named('slow', 'Slow check', () => new Promise((resolve) => {
      setTimeout(() => resolve(pass('slow', 'Slow check')), 200);
    })),
    named('after', 'After', async () => pass('after', 'After')),
  ], {}, { timeoutMs: 20 });
  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'fail');
  assert.equal(results[0].detail, 'timed out after 20ms');
  assert.equal(results[1].status, 'ok');
  assert.equal(results[1].id, 'after');
});

test('runChecks completes fast checks without waiting for the timeout', async () => {
  const started = Date.now();
  const results = await runChecks([
    named('fast', 'Fast', async () => pass('fast', 'Fast')),
  ], {}, { timeoutMs: 1000 });
  assert.equal(results[0].status, 'ok');
  assert.ok(Date.now() - started < 500);
});

test('runChecks preserves check order even when later checks finish first', async () => {
  const order = [];
  const delayed = (id, ms) => named(id, id, async () => {
    order.push(`start:${id}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`end:${id}`);
    return pass(id, id);
  });
  const results = await runChecks([
    delayed('one', 15),
    delayed('two', 0),
    delayed('three', 5),
  ], {}, { timeoutMs: 500 });
  assert.deepEqual(results.map((result) => result.id), ['one', 'two', 'three']);
  assert.deepEqual(order, [
    'start:one', 'end:one',
    'start:two', 'end:two',
    'start:three', 'end:three',
  ]);
});

test('runChecks supports check objects with id, title and run', async () => {
  const results = await runChecks([
    { id: 'obj', title: 'Object check', run: async () => ({ status: 'warn', detail: 'careful' }) },
  ]);
  assert.deepEqual(results[0], {
    id: 'obj',
    title: 'Object check',
    status: 'warn',
    detail: 'careful',
    fix: '',
  });
});

test('runChecks falls back to positional ids for unnamed checks', async () => {
  const results = await runChecks([async () => pass('real', 'Real')]);
  assert.equal(results[0].id, 'real');
  assert.equal(results[0].title, 'Real');
});

test('runChecks reports an invalid returned status as fail', async () => {
  const results = await runChecks([
    named('bad', 'Bad', async () => ({ id: 'bad', title: 'Bad', status: 'nope' })),
  ]);
  assert.equal(results[0].status, 'fail');
  assert.match(results[0].detail, /invalid status/);
});

test('runChecks rejects a non-positive timeout', async () => {
  await assert.rejects(() => runChecks([], {}, { timeoutMs: 0 }), /timeoutMs/);
});

test('summarize counts statuses and exits 1 only when a fail exists', () => {
  const clean = summarize([
    pass('a', 'A'),
    { id: 'b', title: 'B', status: 'warn', detail: '', fix: 'do it' },
    { id: 'c', title: 'C', status: 'skip', detail: '', fix: '' },
  ]);
  assert.deepEqual(clean, { ok: 1, warn: 1, fail: 0, skip: 1, exitCode: 0 });

  const failing = summarize([
    ...[
      pass('a', 'A'),
      { id: 'b', title: 'B', status: 'warn', detail: '', fix: 'do it' },
      { id: 'c', title: 'C', status: 'skip', detail: '', fix: '' },
      { id: 'd', title: 'D', status: 'fail', detail: 'bad', fix: 'fix it' },
    ],
  ]);
  assert.deepEqual(failing, { ok: 1, warn: 1, fail: 1, skip: 1, exitCode: 1 });
});

test('summarize handles an empty result list', () => {
  assert.deepEqual(summarize([]), { ok: 0, warn: 0, fail: 0, skip: 0, exitCode: 0 });
});
