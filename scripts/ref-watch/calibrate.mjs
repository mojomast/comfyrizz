#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REF_DIMENSIONS,
  validateRefVerdict,
} from '../../packages/schema/src/ref-review.mjs';

export const RELIABILITY_SCHEMA = 'comfyrizz.ref-review.reliability/v1';
export const DEFAULT_MIN_ACCURACY = 0.8;
export const MIN_TRUSTED_N = 5;
export const MAX_FALSE_PASS_RATE = 0.1;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isPassFail = (value) => value === 'pass' || value === 'fail';

function pairKey(jobId, keyframeSha256) {
  return `${jobId}\u0000${keyframeSha256}`;
}

function expectedDimensions(label) {
  const expected = isObject(label.expected) ? label.expected : {};
  return REF_DIMENSIONS.filter((dimension) => isPassFail(expected[dimension]));
}

export function dimensionPass(verdict, dimension) {
  const checks = verdict.checks.filter((check) => check.dimension === dimension);
  if (checks.length === 0) return null;
  return checks.every((check) => check.pass === true);
}

function emptyStats() {
  return { n: 0, correct: 0, falsePass: 0, falseFail: 0 };
}

export function calibrate({ labels, verdicts, minAccuracy = DEFAULT_MIN_ACCURACY }) {
  if (!Array.isArray(labels)) throw new TypeError('labels must be an array');
  if (!Array.isArray(verdicts)) throw new TypeError('verdicts must be an array');
  if (typeof minAccuracy !== 'number' || !Number.isFinite(minAccuracy)
    || minAccuracy < 0 || minAccuracy > 1) {
    throw new RangeError('minAccuracy must be a number between 0 and 1');
  }

  const labelsByKey = new Map();
  const orderedDimensions = [];
  const seenDimensions = new Set();
  const unmatchedLabels = [];

  labels.forEach((label, index) => {
    if (!isObject(label) || !isNonEmptyString(label.jobId) || !isNonEmptyString(label.keyframeSha256)) {
      return;
    }
    const dimensions = expectedDimensions(label);
    for (const dimension of dimensions) {
      if (!seenDimensions.has(dimension)) {
        seenDimensions.add(dimension);
        orderedDimensions.push(dimension);
      }
    }
    const key = pairKey(label.jobId, label.keyframeSha256);
    if (!labelsByKey.has(key)) labelsByKey.set(key, []);
    labelsByKey.get(key).push({ index, label, dimensions });
  });

  const stats = new Map(orderedDimensions.map((dimension) => [dimension, emptyStats()]));
  const errors = [];
  const unmatchedVerdicts = [];
  const matchedLabelKeys = new Set();
  let matchedVerdicts = 0;

  verdicts.forEach((verdict, index) => {
    const validation = validateRefVerdict(verdict);
    if (!validation.ok) {
      errors.push({
        kind: 'invalid',
        index,
        jobId: isObject(verdict) && typeof verdict.jobId === 'string' ? verdict.jobId : null,
        keyframeSha256: isObject(verdict) && typeof verdict.keyframeSha256 === 'string'
          ? verdict.keyframeSha256
          : null,
        errors: validation.errors,
      });
      return;
    }

    if (verdict.overall === 'error') {
      errors.push({
        kind: 'judge_error',
        index,
        jobId: verdict.jobId,
        keyframeSha256: verdict.keyframeSha256,
        errors: ['judge returned overall error'],
      });
      return;
    }

    const key = pairKey(verdict.jobId, verdict.keyframeSha256);
    const matchedLabels = labelsByKey.get(key);
    if (!matchedLabels) {
      unmatchedVerdicts.push({
        index,
        jobId: verdict.jobId,
        keyframeSha256: verdict.keyframeSha256,
      });
      return;
    }

    matchedVerdicts += 1;
    matchedLabelKeys.add(key);

    for (const { label, dimensions } of matchedLabels) {
      for (const dimension of dimensions) {
        const judgePass = dimensionPass(verdict, dimension);
        if (judgePass === null) continue;
        const humanPass = label.expected[dimension] === 'pass';
        const entry = stats.get(dimension);
        entry.n += 1;
        if (judgePass === humanPass) entry.correct += 1;
        if (judgePass && !humanPass) entry.falsePass += 1;
        if (!judgePass && humanPass) entry.falseFail += 1;
      }
    }
  });

  labels.forEach((label, index) => {
    if (!isObject(label) || !isNonEmptyString(label.jobId) || !isNonEmptyString(label.keyframeSha256)) {
      return;
    }
    if (!matchedLabelKeys.has(pairKey(label.jobId, label.keyframeSha256))) {
      unmatchedLabels.push({
        index,
        jobId: label.jobId,
        keyframeSha256: label.keyframeSha256,
      });
    }
  });

  const matrixDimensions = {};
  const reportDimensions = {};
  for (const dimension of orderedDimensions) {
    const entry = stats.get(dimension);
    const accuracy = entry.n === 0 ? 0 : entry.correct / entry.n;
    const falsePassRate = entry.n === 0 ? 0 : entry.falsePass / entry.n;
    const falseFailRate = entry.n === 0 ? 0 : entry.falseFail / entry.n;
    const trusted = entry.n >= MIN_TRUSTED_N
      && accuracy >= minAccuracy
      && falsePassRate <= MAX_FALSE_PASS_RATE;
    matrixDimensions[dimension] = { trusted, accuracy, falsePassRate, n: entry.n };
    reportDimensions[dimension] = {
      trusted,
      n: entry.n,
      accuracy,
      falsePassRate,
      falseFailRate,
      correct: entry.correct,
      falsePass: entry.falsePass,
      falseFail: entry.falseFail,
    };
  }

  return {
    matrix: { schema: RELIABILITY_SCHEMA, dimensions: matrixDimensions },
    report: { dimensions: reportDimensions },
    errors,
    unmatchedVerdicts,
    unmatchedLabels,
    matchedVerdicts,
    minAccuracy,
  };
}

export function parseArgs(argv) {
  const args = { labels: null, verdicts: null, out: null, minAccuracy: DEFAULT_MIN_ACCURACY };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? null : arg.slice(equals + 1);
    const value = () => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`${name} needs a value`);
      return argv[i];
    };
    if (name === '--labels') args.labels = value();
    else if (name === '--verdicts') args.verdicts = value();
    else if (name === '--out') args.out = value();
    else if (name === '--min-accuracy') {
      const parsed = Number(value());
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error('--min-accuracy must be a number between 0 and 1');
      }
      args.minAccuracy = parsed;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.labels) throw new Error('--labels is required');
  if (!args.verdicts) throw new Error('--verdicts is required');
  return args;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function formatRate(value) {
  return value.toFixed(4);
}

function writeReport(result) {
  for (const [dimension, entry] of Object.entries(result.report.dimensions)) {
    process.stderr.write(
      `${dimension}: n=${entry.n} accuracy=${formatRate(entry.accuracy)} `
      + `falsePassRate=${formatRate(entry.falsePassRate)} `
      + `falseFailRate=${formatRate(entry.falseFailRate)} trusted=${entry.trusted}\n`,
    );
  }
  for (const error of result.errors) {
    const label = error.kind === 'invalid' ? 'invalid verdict' : 'judge error verdict';
    process.stderr.write(`${label} ${error.index}: ${error.errors.join('; ')}\n`);
  }
  for (const verdict of result.unmatchedVerdicts) {
    process.stderr.write(`unmatched verdict ${verdict.index}: ${verdict.jobId} ${verdict.keyframeSha256}\n`);
  }
  for (const label of result.unmatchedLabels) {
    process.stderr.write(`unmatched label ${label.index}: ${label.jobId} ${label.keyframeSha256}\n`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  let labels;
  let verdicts;
  try {
    labels = readJson(args.labels);
    verdicts = readJson(args.verdicts);
  } catch (error) {
    process.stderr.write(`cannot read input: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = calibrate({ labels, verdicts, minAccuracy: args.minAccuracy });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  writeReport(result);
  const serialized = `${JSON.stringify(result.matrix, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, serialized);
  else process.stdout.write(serialized);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
