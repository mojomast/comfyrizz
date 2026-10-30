// A pipeline can have allocated Google Colab before it fails or the server
// crashes. A terminal render is not a billing receipt: retain its durable hold
// until shutdown AND attributable usage are verified. Account-wide deltas and
// reservation estimates never become per-invite actual spend.
import { packageModels } from './model-provenance.mjs';
import { sessionUsageAccounting } from '../../../../packages/backends/src/session-accounting.mjs';

export function reconcileInvitePipeline({ ledger, run, readPackage = () => null } = {}) {
  if (!run) return false;
  const productionId = run.origin?.productionId;
  const actionId = run.origin?.actionId;
  if (!productionId || !actionId) return false;
  const owner = ledger.resourceOwner('production', productionId);
  const cpu = actionId === 'act_invite_cpu' && run.budget?.ceilingUnits === 0 && owner;
  const reservation = ledger.actionReservation(productionId, actionId) ?? (cpu ? { inviteId: owner, units: 0 } : null);
  if (!reservation) return false;
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
  let accounting = cpu
    ? { status: 'not_required', actualSpendCu: 0, costSource: 'cpu_no_colab_spend', shutdownVerified: true, reason: null }
    : { status: 'reserved', actualSpendCu: null, costSource: 'reserved_estimate', shutdownVerified: false, reason: null };
  if (terminal && !cpu) {
    if (reservation.state === 'settled') {
      // Existing deployments charged full estimates. Preserve their history;
      // a restart must not relabel those charges as measured actual usage.
      accounting = reservation.accounting ?? { status: 'legacy_estimate', actualSpendCu: null,
        costSource: 'legacy_reserved_upper_estimate', shutdownVerified: false, reason: 'historical_estimate_settlement' };
    } else {
      accounting = { ...sessionUsageAccounting({ ...run, budget: { ...run.budget, ceilingUnits: reservation.units } }), runId: run.runId };
      const result = accounting.status === 'settled'
        ? ledger.settleAction({ productionId, actionId, spent: accounting.actualSpendCu,
          filmCompleted: run.status === 'completed', accounting })
        : ledger.recordActionAccounting({ productionId, actionId, accounting, filmCompleted: run.status === 'completed' });
      if (!result.ok) throw new Error('invite pipeline settlement failed');
    }
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
      spentEstimateCu: accounting.actualSpendCu ?? (accounting.status === 'legacy_estimate' ? reservation.spent : 0),
      status: run.status === 'completed' ? 'ready' : terminal ? run.status : 'running',
      showcase: run.status === 'completed',
      details: { status: run.status, costSource: accounting.costSource, accounting,
        actualSpendCu: accounting.actualSpendCu, productionId,
        plannedModels: packageModels(pkg), models: run.result?.models ?? [],
        modelEvidence: Array.isArray(run.result?.models) ? 'completed_pipeline' : 'not_recorded',
        planner: metadata?.planner ?? null,
        reservedEstimateCu: reservation.units, startedAt: run.startedAt },
    });
  }
  return true;
}
