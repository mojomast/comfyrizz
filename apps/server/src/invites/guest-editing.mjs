import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stagePipelineInputs } from '../pipeline-media.mjs';

export function guestPackageDirectory({ ledger, runtimeDir, store }, packageId) {
  return ledger.resourceDetails('package', packageId)?.editableCopy === true
    ? join(runtimeDir, 'guest-projects', packageId) : store.dir;
}

// Copy a completed film into the viewer's private workspace. Its generation
// receipts and ready media travel with it; the original is never edited.
export async function openGuestEdit({ ledger, pipelines, runtimeDir, store, inviteId, generationId }) {
  const usable = id => { const row = ledger.get(id); return row && !['expired', 'revoked'].includes(row.status); };
  const row = ledger.listGenerations().find(row => row.id === generationId);
  if (!usable(inviteId) || !row || row.status !== 'ready' || !row.showcase || !usable(row.inviteId)) return null;
  const run = pipelines.get(row.runId);
  if (run?.status !== 'completed' || run.packageId !== row.packageId
      || ledger.resourceOwner('production', run.origin?.productionId) !== row.inviteId
      || ledger.resourceOwner('package', row.packageId) !== row.inviteId) return null;
  const sourceDir = join(pipelines.directory(run.runId), 'work');
  const pkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
  if (pkg.id !== row.packageId) return null;
  pkg.id = `pkg_${randomUUID().replaceAll('-', '')}`;
  pkg.revision = 1;
  const target = join(runtimeDir, 'guest-projects', pkg.id);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  await stagePipelineInputs(pkg, sourceDir, target);
  if (!usable(inviteId) || !usable(row.inviteId)) return null;
  ledger.bindResource(inviteId, 'package', pkg.id);
  ledger.setResourceDetails('package', pkg.id, { editableCopy: true, prompt: row.prompt,
    planner: row.details?.planner ?? null });
  return store.write(pkg);
}
