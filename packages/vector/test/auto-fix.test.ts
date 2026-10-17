import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoFix, createStubGenerator, renderCheck, type GenerateContext, type SvgIntent } from '../src/index.js';

const intent: SvgIntent = {
  kind: 'icon',
  prompt: 'A check mark in a circle',
  palette: ['#0d0f14', '#6d8cff', '#e6e8ee'],
  width: 256,
};

test('stub generator repairs a sanitizer/render failure within 2 tries', async () => {
  const contexts: GenerateContext[] = [];
  const stub = createStubGenerator({ brokenFirstAttempt: true });
  const result = await autoFix(context => {
    contexts.push(context);
    return stub(context);
  }, intent, 2);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.repairs, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sanitizerVersion, '1.0.0');
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].errors.length, 0);
  assert.ok(contexts[1].errors.length > 0, 'repair receives the previous structured errors');
  assert.match(contexts[1].errors.map(error => error.code).join(' '), /blank-output|near-invisible/);
  assert.equal(renderCheck(result.svg, { width: 256, palette: intent.palette }).ok, true);
});

test('a generator that never fixes anything stops after maxRepairs with usable errors', async () => {
  let calls = 0;
  const result = await autoFix(() => {
    calls += 1;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>bad()</script></svg>`;
  }, intent, 2);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.repairs, 2);
  assert.equal(calls, 3);
  assert.equal(result.errors[0].code, 'blank-output');
});

test('a throwing generator is surfaced, not retried forever', async () => {
  const result = await autoFix(() => {
    throw new Error('model timed out');
  }, intent, 2);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.errors[0].code, 'generator-threw');
  assert.match(result.errors[0].detail ?? '', /model timed out/);
});

test('sanitizer errors are fed back before rasterising', async () => {
  const seen: GenerateContext[] = [];
  const result = await autoFix(context => {
    seen.push(context);
    if (context.attempt === 1) return '<svg><rect width="10" height="10"/></svg>';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#6d8cff"/></svg>';
  }, intent, 2);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(seen[1].errors[0].source, 'sanitize');
  assert.equal(seen[1].errors[0].code, 'missing-viewBox');
});
