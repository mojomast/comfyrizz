import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compileTimeline, measuredFromReport } from '../../../packages/planner/dist/src/index.js';

/** Read audio/durations.json beside a package, or {} when the sidecar is absent. */
export function measuredOptionsFromDir(packageDir, pkg = null) {
  if (!packageDir) return {};
  const audio = pkg?.assets?.a_narration?.file;
  const scoped = typeof audio === 'string' && /^audio\/generated\/[A-Za-z0-9_-]+\/narration\.norm\.wav$/.test(audio);
  const file = scoped ? join(packageDir, dirname(audio), 'durations.json') : join(packageDir, 'audio', 'durations.json');
  if (!existsSync(file)) return {};
  return measuredFromReport(JSON.parse(readFileSync(file, 'utf8')));
}

/** Compile with measured narration whenever the package directory has a sidecar. */
export function compilePackage(pkg, packageDir) {
  return compileTimeline(pkg, measuredOptionsFromDir(packageDir, pkg));
}
