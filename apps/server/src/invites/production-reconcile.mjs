// A pipeline can have allocated Google Colab before it fails or the server
// crashes. In the absence of a trustworthy, invite-isolated usage reading,
// charge the full reserved estimate on terminal outcomes rather than release
// uncertain exposure. The operation is idempotent after restart.
import { packageModels } from './model-provenance.mjs';

export function reconcileInvitePipeline({ ledger, run, readPackage = () => null } = {}) {
  if (!run) return false;
  const productionId = run.origin?.productionId;
  const actionId = run.origin?.actionId;
  if (!productionId || !actionId) return false;
  const reservation = ledger.actionReservation(productionId, actionId);
  if (!reservation) return false;
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
  if (terminal) {
    const result = ledger.settleAction({ productionId, actionId, spent: reservation.units, filmCompleted: run.status === 'completed' });
    if (!result.ok) throw new Error('invite pipeline settlement failed');
  }
  {
    let pkg = null;
    try { pkg = readPackage(run.packageId); } catch { /* generation remains attributable without package details */ }
    const metadata = run.packageId ? ledger.resourceDetails?.('package', run.packageId) : null;
    ledger.recordGeneration(reservation.inviteId, {
      runId: run.runId,
      packageId: run.packageId ?? '',
      prompt: metadata?.prompt ?? (typeof pkg?.brief?.prompt === 'string' ? pkg.brief.prompt : ''),
      title: typeof pkg?.title === 'string' ? pkg.title : '',
      spentEstimateCu: terminal ? reservation.units : 0,
      status: run.status === 'completed' ? 'ready' : terminal ? run.status : 'running',
      showcase: run.status === 'completed',
      details: { status: run.status, costSource: 'reserved_upper_estimate', productionId,
        plannedModels: packageModels(pkg), models: run.result?.models ?? [],
        modelEvidence: Array.isArray(run.result?.models) ? 'completed_pipeline' : 'not_recorded',
        planner: metadata?.planner ?? null,
        reservedEstimateCu: reservation.units, startedAt: run.startedAt },
    });
  }
  return true;
}
