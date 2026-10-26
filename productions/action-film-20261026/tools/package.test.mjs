import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PRODUCTION_DIR, loadJson, onH3Grid, shotListMarkdown, validatePackage } from './validate-package.mjs';
import { bindReview, run, sha256File } from './quality-gate.mjs';

const input = () => ({ production: loadJson('production.json'), skeleton: loadJson('shots.skeleton.json') });

test('committed package validates', () => {
  const result = validatePackage(input());
  assert.deepEqual(result.errors, []);
  assert.equal(result.editFrames, 2880);
});

test('H3 grid is 17n+5 and 124 frames is 5.1667s', () => {
  assert.deepEqual([22, 39, 124, 158].map(onH3Grid), [true, true, true, true]);
  assert.deepEqual([24, 120, 125].map(onH3Grid), [false, false, false]);
  assert.equal((124 / 24).toFixed(4), '5.1667');
});

test('validator rejects grid, budget and pilot drift', () => {
  const bad = input();
  bad.skeleton.rows[1].generatedFrames = 120;
  bad.production.budget.envelopes.main = 11;
  bad.skeleton.rows[3].pilot = 'P1';
  const codes = validatePackage(bad).errors.map(e => e.code);
  for (const code of ['GRID', 'BUDGET_SUM', 'BUDGET_ENVELOPES', 'PILOT_COVERAGE']) assert.ok(codes.includes(code), code);
});

test('budget is recorded as approved with no unattended retry', () => {
  const { budget } = input().production;
  assert.equal(budget.status, 'APPROVED');
  assert.equal(budget.approvedTotal, 20);
  assert.equal(budget.retryPolicy, 'no-unattended-retry-loops');
});

test('SHOT_LIST.md is current', () => {
  assert.equal(readFileSync(join(PRODUCTION_DIR, 'SHOT_LIST.md'), 'utf8'), shotListMarkdown(input()));
});

test('plan check fails honestly while evidence files are absent', async () => {
  const { result, exitCode } = await run(['plan']);
  assert.equal(exitCode, 1);
  assert.equal(result.ok, false);
});

test('a review binds only to the matching renderFingerprint', () => {
  const fingerprint = 'a'.repeat(64);
  const review = { schema: 'comfyrizz.export-review/v1', renderFingerprint: fingerprint, inputs: {} };
  assert.equal(bindReview({ renderFingerprint: fingerprint }, review).reviewBinding, 'current');
  const stale = bindReview({ renderFingerprint: 'b'.repeat(64) }, review);
  assert.equal(stale.reviewBinding, 'stale_or_invalid');
  assert.equal(stale.findings[0].code, 'REVIEW_STALE');
});

test('hash reports sha256 and bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'film-hash-'));
  try {
    const file = join(dir, 'a.bin');
    writeFileSync(file, 'abc');
    const out = await sha256File(file);
    assert.equal(out.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(out.bytes, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
