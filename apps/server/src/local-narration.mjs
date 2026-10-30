import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { prepareRunNarration, runNeedsNarration } from './run-narration.mjs';
import { compilePackage } from './compile-package.mjs';
import { narrationApproval, saveNarrationFit } from './narration-fit-recovery.mjs';

function approved(store, productionId, packageId) {
  return Boolean(narrationApproval(store, productionId, packageId));
}

/** Local, free narration for an approved package. No backend or paid action is started. */
export async function generateLocalNarration({ store, productionStore, runtimeDir, operations, packageId, productionId, baseRevision, recoveryInputs, prepare = prepareRunNarration }) {
  const pkg = store.read(packageId);
  if (!pkg || pkg.revision !== baseRevision) throw Object.assign(new Error('Package changed; reload before generating narration.'), { status: 409, code: 'REVISION_CONFLICT' });
  if (!approved(productionStore, productionId, packageId)) throw Object.assign(new Error('Approve the current production plan before generating narration.'), { status: 409, code: 'PLAN_NOT_APPROVED' });
  const approvedAtStart = narrationApproval(productionStore, productionId, packageId);
  const pinnedPackage = structuredClone(pkg);
  if (!runNeedsNarration(pkg) || pkg.voice?.engine !== 'kokoro') throw Object.assign(new Error('Local narration requires an enabled Kokoro voice and scene narration.'), { status: 400, code: 'LOCAL_VOICE_UNAVAILABLE' });
  const lease = operations.tryAcquire('narration', packageId);
  if (lease.busy) throw Object.assign(new Error('Another render or generation is running.'), { status: 409, code: 'BUSY' });
  let temp;
  try {
    const tempRoot = join(runtimeDir, 'local-narration');
    mkdirSync(tempRoot, { recursive: true });
    temp = mkdtempSync(join(tempRoot, 'work-'));
    const workDir = join(temp, 'work');
    const packageDir = dirname(store.path(packageId));
    const relative = `audio/generated/${randomUUID().replaceAll('-', '')}`;
    const destination = join(packageDir, relative);
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));
    try {
      await prepare({ pkg, workDir, outputDir: join(temp, 'output'), packageDir: join(temp, 'package') });
    } catch (error) {
      if (error.code === 'NARRATION_TOO_LONG') {
        try {
          saveNarrationFit({ runtimeDir, store, productionStore, productionId, pkg: pinnedPackage, error, expectedApproval: approvedAtStart, recoveryInputs });
        } catch {
          throw Object.assign(new Error('The measured narration failure could not be saved. Check the local storage and retry.'), { status: 503, code: 'NARRATION_RECOVERY_SAVE_FAILED' });
        }
      }
      if (/No module named ['"](?:kokoro_onnx|numpy)/.test(error.message)) {
        throw new Error('Local Kokoro is not installed. Run: python3 -m venv .venv && .venv/bin/pip install -r packages/tts/py/requirements.txt; then run packages/tts/scripts/fetch-models.sh and retry.');
      }
      throw error;
    }
    if (!approved(productionStore, productionId, packageId) || store.read(packageId)?.revision !== baseRevision) {
      throw Object.assign(new Error('The plan or package changed while narration was generated; retry with the current plan.'), { status: 409, code: 'REVISION_CONFLICT' });
    }
    pkg.assets.a_narration.file = `${relative}/narration.norm.wav`;
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(workDir, 'audio'), destination, { recursive: true });
    let saved;
    try { saved = store.save(packageId, pkg, baseRevision); }
    catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
    return { package: saved, revision: saved.revision, timeline: compilePackage(saved, packageDir), preservePreviewState: true };
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
    lease.release();
  }
}
