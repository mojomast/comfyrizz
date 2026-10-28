// A pipeline can have allocated Google Colab before it fails or the server
// crashes. In the absence of a trustworthy, invite-isolated usage reading,
// charge the full reserved estimate on terminal outcomes rather than release
// uncertain exposure. The operation is idempotent after restart.
export function reconcileInvitePipeline({ ledger, run, readPackage = () => null } = {}) {
  if (!run || !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return false;
  const productionId = run.origin?.productionId;
  const actionId = run.origin?.actionId;
  if (!productionId || !actionId) return false;
  const reservation = ledger.actionReservation(productionId, actionId);
  if (!reservation) return false;
  const result = ledger.settleAction({ productionId, actionId, spent: reservation.units, filmCompleted: run.status === 'completed' });
  if (!result.ok) throw new Error('invite pipeline settlement failed');
  if (run.status === 'completed' || run.status === 'failed') {
    let pkg = null;
    try { pkg = readPackage(run.packageId); } catch { /* generation remains attributable without package details */ }
    ledger.recordGeneration(reservation.inviteId, {
      runId: run.runId,
      packageId: run.packageId ?? '',
      prompt: typeof pkg?.brief?.prompt === 'string' ? pkg.brief.prompt : '',
      title: typeof pkg?.title === 'string' ? pkg.title : '',
      spentEstimateCu: reservation.units,
      status: run.status === 'completed' ? 'ready' : 'failed',
      showcase: run.status === 'completed',
      details: { status: run.status, costSource: 'reserved_upper_estimate' },
    });
  }
  return true;
}
