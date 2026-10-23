// C-pres: the web storyboard exposes the presenter controls (off by default).
// The vocabulary must match packages/agent presenter.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { presenterChips } from '../../../packages/agent/dist/src/index.js';

const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');

function ids(constName) {
  const block = new RegExp(`const ${constName}[^=]*= \\[([\\s\\S]*?)\\n\\];`).exec(source);
  assert.ok(block, `${constName} is declared`);
  return [...block[1].matchAll(/id: '([^']+)'/g)].map(match => match[1]);
}

test('C-pres: the presenter controls match the agent vocabulary', () => {
  assert.deepEqual(ids('WEB_PRESENTER_COVERAGES'), presenterChips().map(chip => chip.id));
  for (const hook of ['data-presenter-scene', 'data-presenter-coverage', 'data-presenter-placement', 'data-presenter-label']) {
    assert.ok(source.includes(hook), `storyboard wires ${hook}`);
  }
  assert.ok(source.includes("'/api/presenter/set'"), 'the toolbar posts to /api/presenter/set');
});
