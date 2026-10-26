#!/usr/bin/env node
// A single CPU-only production check invokes the existing specialized reviews.
// It does not infer creative approval from successful media generation.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli } from './cli.mjs';

export function checkProduction(target, stage = 'final') {
  const commands = stage === 'plan' ? ['beats', 'continuity'] :
    stage === 'final' ? ['beats', 'takes', 'continuity', 'edit', 'captions', 'sound', 'receipt'] : null;
  if (!commands) throw new TypeError('Expected plan or final quality stage');
  const checks = commands.map(command => {
    const result = runCli([command, target, '--json']);
    return { command, exitCode: result.exitCode, report: result.report };
  });
  return { schema: 'comfyrizz.production-quality/v1', stage,
    ok: checks.every(c => c.exitCode === 0), checks };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [stage, target, ...rest] = process.argv.slice(2);
  if (!target || rest.length) {
    process.stderr.write('Usage: pnpm quality:production <plan|final> <production-directory>\n');
    process.exitCode = 2;
  } else {
    try {
      const result = checkProduction(target, stage);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 2; }
  }
}
