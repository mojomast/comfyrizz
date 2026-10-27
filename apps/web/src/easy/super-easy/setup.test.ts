import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SUPER_EASY_SETUP, readSuperEasySetup, saveSuperEasySetup } from './setup.ts';

test('fresh setup defaults to CPU without claiming confirmation', () => {
  assert.deepEqual(readSuperEasySetup(), DEFAULT_SUPER_EASY_SETUP);
});

test('saved setup contains only backend, cap and explicit confirmation', () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  try {
    saveSuperEasySetup({ compute: 'colab', spendCap: 8.5, confirmed: true });
    assert.deepEqual(readSuperEasySetup(), { compute: 'colab', spendCap: 8.5, confirmed: true });
    const serialized = [...values.values()].join('');
    assert.doesNotMatch(serialized, /api.?key|token|secret|password/iu);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as any).localStorage;
  }
});
