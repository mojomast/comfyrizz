// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The editor's global `main` rule is a three-column grid. Easy uses a <main>
// too, so its own rule must reset that or each step is squeezed into the
// first column and leaves the rest of the page empty.
test('.easy-main resets the editor main grid', () => {
  const css = readFileSync(new URL('../src/easy/easy.css', import.meta.url), 'utf8');
  const rule = css.match(/\n\.easy-main\s*\{([^}]*)\}/);
  assert.ok(rule, '.easy-main rule exists');
  assert.match(rule[1], /display:\s*block/);
  assert.match(rule[1], /grid-template-columns:\s*none/);
  assert.match(rule[1], /background:\s*none/);
});
