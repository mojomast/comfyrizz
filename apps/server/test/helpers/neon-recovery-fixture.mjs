// Optional acceptance fixture: copy only public package/media/run evidence.
// No credentials, production database, provider settings or live endpoints.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function copyNeonRecoveryFixture(sourceRoot, runtimeDir) {
  const packageId = 'pkg_564ee1180b41ba4a';
  const sourceRuntime = join(sourceRoot, 'runtime');
  const read = relative => JSON.parse(readFileSync(join(sourceRuntime, relative)));
  const pkg = read(`packages/${packageId}.json`);
  const takeDoc = read(`takes/${packageId}.json`);
  const paths = new Set([`packages/${packageId}.json`, `takes/${packageId}.json`]);
  const runIds = new Set();
  for (const asset of Object.values(pkg.assets)) {
    if (asset.file) paths.add(`packages/${asset.file}`);
    if (asset.sha256) paths.add(`.comfy-provenance/${asset.sha256}.json`);
  }
  for (const entry of Object.values(takeDoc.clips)) for (const take of entry.takes) {
    paths.add(`packages/${packageId}/${take.file}`);
    if (take.runId) runIds.add(take.runId);
  }
  for (const runId of runIds) {
    for (const name of ['work/package.json', 'work/jobs.json', 'out/manifest.json']) paths.add(`runs/${runId}/${name}`);
    const manifest = read(`runs/${runId}/out/manifest.json`);
    for (const entry of manifest.jobs) for (const output of entry.outputs ?? []) {
      const relative = output.relative ?? output.file;
      paths.add(`runs/${runId}/out/${relative}`);
      paths.add(`runs/${runId}/out/${relative.replace(/\.[^/.]+$/, '.workflow.api.json')}`);
    }
  }
  const originalHashes = {};
  for (const relative of paths) {
    if (relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('unsafe fixture path');
    const source = join(sourceRuntime, relative), destination = join(runtimeDir, relative);
    originalHashes[relative] = createHash('sha256').update(readFileSync(source)).digest('hex');
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return { pkg, takeDoc, sourceRuntime, originalHashes,
    original: JSON.parse(readFileSync(join(sourceRoot, 'evidence/neon-original-generated-package.json'))) };
}
