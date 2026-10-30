import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { REF_VERDICT_SCHEMA } from '../../packages/schema/src/ref-review.mjs';
import { RELIABILITY_SCHEMA, calibrate } from './calibrate.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(SCRIPT_DIR, 'calibrate.mjs');

const sha = (n) => String(n).padStart(64, '0');

function verdict(jobId, key, dimensionPasses) {
  const checks = Object.entries(dimensionPasses).map(([dimension, passes]) => ({
    dimension,
    pass: passes,
    severity: 'hard',
    evidence: `${dimension} ${passes ? 'looks right' : 'is wrong'}`,
  }));
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId,
    keyframeSha256: key,
    reviewer: 'fake',
    overall: checks.every((check) => check.pass) ? 'pass' : 'fail',
    checks,
    fixHints: [],
  };
}

// Three calibrated dimensions:
//   identity  n=6, all correct ........................ trusted
//   anatomy   n=6, one dangerous false pass ........... untrusted (false-pass rate)
//   framing   n=4, all correct ........................ untrusted (n < 5)
function fixture() {
  const labels = [];
  for (let i = 1; i <= 6; i++) {
    const expected = { identity: 'pass', anatomy: i === 6 ? 'fail' : 'pass' };
    if (i <= 4) expected.framing = 'pass';
    labels.push({ jobId: `job_${i}`, keyframeSha256: sha(i), expected });
  }
  const verdicts = [];
  for (let i = 1; i <= 6; i++) {
    verdicts.push(verdict(`job_${i}`, sha(i), {
      identity: true,
      anatomy: true,
      ...(i <= 4 ? { framing: true } : {}),
    }));
  }
  return { labels, verdicts };
}

test('calibrate reports three dimensions with the expected trust split', () => {
  const { labels, verdicts } = fixture();
  const result = calibrate({ labels, verdicts, minAccuracy: 0.8 });
  const { dimensions } = result.matrix;

  assert.equal(result.matrix.schema, RELIABILITY_SCHEMA);
  assert.deepEqual(Object.keys(dimensions), ['identity', 'anatomy', 'framing']);

  assert.deepEqual(dimensions.identity, {
    trusted: true,
    accuracy: 1,
    falsePassRate: 0,
    n: 6,
  });

  const anatomy = dimensions.anatomy;
  assert.equal(anatomy.n, 6);
  assert.equal(anatomy.trusted, false);
  assert.ok(Math.abs(anatomy.accuracy - 5 / 6) < 1e-12);
  assert.ok(Math.abs(anatomy.falsePassRate - 1 / 6) < 1e-12);
  assert.ok(Math.abs(result.report.dimensions.anatomy.falseFailRate - 0) < 1e-12);

  assert.deepEqual(dimensions.framing, {
    trusted: false,
    accuracy: 1,
    falsePassRate: 0,
    n: 4,
  });
});

test('invalid verdicts are counted as errors and never as passes', () => {
  const { labels, verdicts } = fixture();
  const invalid = { ...verdict('job_1', sha(1), { identity: true }), schema: 'not-a-verdict' };
  verdicts.push(invalid);

  const result = calibrate({ labels, verdicts, minAccuracy: 0.8 });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].jobId, 'job_1');
  assert.ok(result.errors[0].errors.some((error) => /schema/.test(error)));
  assert.equal(result.matrix.dimensions.identity.n, 6);
  assert.equal(result.matrix.dimensions.identity.accuracy, 1);
});

test('verdicts without a matching label are reported', () => {
  const { labels, verdicts } = fixture();
  const ghost = verdict('job_ghost', 'f'.repeat(64), { identity: true });
  verdicts.push(ghost);

  const result = calibrate({ labels, verdicts, minAccuracy: 0.8 });

  assert.deepEqual(result.unmatchedVerdicts.map(({ jobId }) => jobId), ['job_ghost']);
  assert.equal(result.matrix.dimensions.identity.n, 6);
});

test('CLI writes the reliability matrix to --out', () => {
  const { labels, verdicts } = fixture();
  verdicts.push(verdict('job_ghost', 'f'.repeat(64), { identity: true }));
  verdicts.push({ ...verdict('job_1', sha(1), { identity: true }), schema: 'bad' });

  const root = mkdtempSync(join(tmpdir(), 'ref-watch-calibrate-'));
  try {
    const labelsPath = join(root, 'labels.json');
    const verdictsPath = join(root, 'verdicts.json');
    const outPath = join(root, 'matrix.json');
    writeFileSync(labelsPath, `${JSON.stringify(labels)}\n`);
    writeFileSync(verdictsPath, `${JSON.stringify(verdicts)}\n`);

    const run = spawnSync(process.execPath, [
      SCRIPT,
      '--labels', labelsPath,
      '--verdicts', verdictsPath,
      '--out', outPath,
      '--min-accuracy', '0.8',
    ], { encoding: 'utf8' });

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /unmatched verdict/i);
    assert.match(run.stderr, /invalid verdict/i);

    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(written.schema, RELIABILITY_SCHEMA);
    assert.equal(written.dimensions.identity.trusted, true);
    assert.equal(written.dimensions.anatomy.trusted, false);
    assert.equal(written.dimensions.framing.trusted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
