import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkProduction } from './pipeline.mjs';
test('final checks include story, action, continuity, edit, caption, sound and independent receipt', () => {
  const report = checkProduction(fileURLToPath(new URL('./fixtures', import.meta.url)));
  assert.deepEqual(report.checks.map(c => c.command), ['beats', 'takes', 'continuity', 'edit', 'captions', 'sound', 'receipt']);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some(c => c.report.findings.some(f => f.code === 'PROMPT_CONTRADICTS')));
});
test('missing production evidence does not turn into approval', () => {
  assert.equal(checkProduction('does-not-exist', 'plan').ok, false);
  assert.throws(() => checkProduction('.', 'unknown'), /Expected/);
});
