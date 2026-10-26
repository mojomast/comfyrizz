#!/usr/bin/env node
// Explicit entry point for the PR #50 quality helpers. The bespoke film renderer
// does not call them automatically, so each step here is run by name and its JSON
// output is kept as evidence. CPU-only: no generation, network or Google Colab use.
//
//   plan     [dir]                       beat + continuity checks on the plan
//   final    [dir]                       all seven review areas on the connected cut
//   captions --timeline t.json --package p.json   caption dwell/speed/size diagnostics
//   bind     --quality quality.json --review quality-review.json
//                                        fingerprint binding and independent receipt
//   hash     <file...>                   sha256 + bytes for source/take media
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkProduction } from '../../../scripts/quality/pipeline.mjs';
import { buildReceipt } from '../../../scripts/quality/receipt.mjs';
import { checkCaptionQuality } from '../../../apps/renderer/scripts/caption-quality.mjs';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW_SCHEMA = 'comfyrizz.export-review/v1';
const FINGERPRINT = /^[a-f0-9]{64}$/;

const readJson = file => JSON.parse(readFileSync(resolve(file), 'utf8'));

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function sha256File(file) {
  return new Promise((ok, fail) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(file).on('data', chunk => { hash.update(chunk); bytes += chunk.length; })
      .on('error', fail).on('end', () => ok({ file: basename(file), sha256: hash.digest('hex'), bytes }));
  });
}

/** A review is current only for the exact renderFingerprint of the exported quality.json. */
export function bindReview(quality, review) {
  const findings = [];
  if (review?.schema !== REVIEW_SCHEMA) findings.push({ code: 'REVIEW_SCHEMA', message: `review schema must be ${REVIEW_SCHEMA}` });
  if (!FINGERPRINT.test(quality?.renderFingerprint ?? '')) findings.push({ code: 'QUALITY_FINGERPRINT', message: 'quality.json has no valid renderFingerprint' });
  else if (review?.renderFingerprint !== quality.renderFingerprint) findings.push({ code: 'REVIEW_STALE', message: 'review renderFingerprint differs from the exported quality.json; re-review the current cut' });
  const bound = findings.length === 0;
  const receipt = buildReceipt(bound && review.inputs && typeof review.inputs === 'object' ? review.inputs : {});
  return { schema: 'comfyrizz.production-review-binding/v1', renderFingerprint: quality?.renderFingerprint ?? null,
    reviewBinding: bound ? 'current' : 'stale_or_invalid', findings, receipt,
    note: 'A bound JSON review is local evidence, not authenticated approval or proof of listening.' };
}

export async function run(argv) {
  const [command, ...args] = argv;
  if (command === 'plan' || command === 'final') {
    const result = checkProduction(resolve(args[0] ?? DEFAULT_DIR), command);
    return { result, exitCode: result.ok ? 0 : 1 };
  }
  if (command === 'captions') {
    const timeline = readJson(flag(args, '--timeline') ?? '');
    const pkg = readJson(flag(args, '--package') ?? '');
    const findings = checkCaptionQuality({ timeline, pkg });
    return { result: { schema: 'comfyrizz.production-captions/v1', findings, note: 'Advisory diagnostics; check the intended viewport directly.' }, exitCode: findings.length ? 1 : 0 };
  }
  if (command === 'bind') {
    const result = bindReview(readJson(flag(args, '--quality') ?? ''), readJson(flag(args, '--review') ?? ''));
    return { result, exitCode: result.reviewBinding === 'current' && result.receipt.ok !== false ? 0 : 1 };
  }
  if (command === 'hash' && args.length) {
    return { result: { schema: 'comfyrizz.production-hashes/v1', files: await Promise.all(args.map(sha256File)) }, exitCode: 0 };
  }
  return { usage: true, exitCode: 2 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const out = await run(process.argv.slice(2));
    if (out.usage) process.stderr.write('Usage: node tools/quality-gate.mjs <plan|final [dir]|captions --timeline f --package f|bind --quality f --review f|hash files...>\n');
    else process.stdout.write(JSON.stringify(out.result, null, 2) + '\n');
    process.exitCode = out.exitCode;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
