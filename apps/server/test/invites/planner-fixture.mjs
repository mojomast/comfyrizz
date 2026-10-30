// Inject a model-result boundary, not the obsolete offline generated-film
// fallback. Tests exercise persistence/admission without calling a paid model.
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
export function guestPlannerFixture({ runtimeDir }) {
  return async ({ brief }) => {
    const pkg = JSON.parse(readFileSync(join(root, 'examples/data-story/package.json')));
    pkg.title = brief.slice(0, 100);
    pkg.scenes = [pkg.scenes[0]];
    pkg.scenes[0].background = { asset: 'a_data_still' };
    delete pkg.scenes[0].transitionOut;
    delete pkg.assets.a_data_plate;
    for (const asset of Object.values(pkg.assets)) {
      if (asset.file) {
        mkdirSync(join(runtimeDir, 'packages/assets'), { recursive: true });
        copyFileSync(join(root, 'examples/data-story', asset.file), join(runtimeDir, 'packages', asset.file));
      }
      if (asset.gen?.workflow) asset.gen.workflow_sha256 = createHash('sha256').update(readFileSync(join(root, asset.gen.workflow))).digest('hex');
    }
    return { package: pkg, pendingGpu: [], live: true, provider: 'fixture', model: 'fixture-planner' };
  };
}
