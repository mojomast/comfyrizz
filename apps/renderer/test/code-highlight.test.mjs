// LP2: highlighting is local. A render must not fetch grammars, themes or WASM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('highlightTokens is deterministic and does not touch the network', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args[0]);
    throw new Error('network disabled');
  };
  try {
    const { highlightTokens } = await import('../src/code-highlight.mjs');
    const source = "export function hello() {\n  return 'ok';\n}\n";
    const first = await highlightTokens(source, 'typescript');
    const second = await highlightTokens(source, 'ts');
    assert.deepEqual(second, first);
    assert.ok(first.length >= 3);
    assert.ok(first.some(line => line.some(token => token.content.includes('export'))));
    const colored = first.flat().some(token => token.color && token.color.toLowerCase() !== '#e6e8ee');
    assert.equal(colored, true, 'a typescript keyword should take a theme colour');
    const plain = await highlightTokens('just text', 'text');
    assert.deepEqual(plain, [[{ content: 'just text', color: '#e6e8ee' }]]);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = original;
  }
});
