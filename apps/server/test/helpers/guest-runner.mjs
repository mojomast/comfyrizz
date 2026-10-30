// Scripted package planning for guest ownership/spend tests. No model/provider
// is contacted and pending Comfy work stays pending until the injected worker.
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plannedContribution } from './comfy-contribution.mjs';

const example = new URL('../../../../examples/launch-demo/', import.meta.url);
export function scriptedGuestRunnerFactory({ runtimeDir }) {
  return async () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', example)));
    const packageDir = join(runtimeDir, 'packages');
    mkdirSync(packageDir, { recursive: true });
    cpSync(new URL('assets/', example), join(packageDir, 'assets'), { recursive: true });
    const assetId = plannedContribution(pkg);
    return { package: pkg, live: false, pendingGpu: [{ sceneId: pkg.scenes[0].id, assetId }] };
  };
}
