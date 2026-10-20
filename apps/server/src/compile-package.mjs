import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileTimeline, measuredFromReport } from '../../../packages/planner/dist/src/index.js';

/** Read audio/durations.json beside a package, or {} when the sidecar is absent. */
export function measuredOptionsFromDir(packageDir) {
  if (!packageDir) return {};
  const file = join(packageDir, 'audio', 'durations.json');
  if (!existsSync(file)) return {};
  return measuredFromReport(JSON.parse(readFileSync(file, 'utf8')));
}

/** Compile with measured narration whenever the package directory has a sidecar. */
export function compilePackage(pkg, packageDir) {
  return compileTimeline(pkg, measuredOptionsFromDir(packageDir));
}
