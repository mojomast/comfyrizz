import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from './uuid.ts';

test('uses native randomUUID when available', () => {
  assert.equal(randomUUID({ randomUUID: () => 'native-id' }), 'native-id');
});

test('getRandomValues produces RFC-compatible IDs in non-secure contexts', () => {
  const id = randomUUID({ getRandomValues: array => { new Uint8Array(array.buffer).fill(7); return array; } });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('last-resort IDs remain unique without browser crypto', () => {
  const first = randomUUID(undefined);
  const second = randomUUID(undefined);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});
