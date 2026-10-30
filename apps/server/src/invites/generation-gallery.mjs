import { guestProductionResult } from './guest-result.mjs';

// Only the viewer's own invite receives this bounded billing projection. Never
// publish raw runtime records, receipt/account/session identities or reasons.
function publicAccounting(row) {
  const value = row.details?.accounting;
  const amount = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  const status = ['reserved', 'unresolved', 'settled', 'not_required', 'legacy_estimate'].includes(value?.status)
    ? value.status : amount(row.spentEstimateCu) > 0 ? 'legacy_estimate' : 'unknown';
  const costSource = ['reserved_estimate', 'unattributed_usage', 'verified_session_usage', 'verified_no_allocation',
    'cpu_no_colab_spend', 'legacy_reserved_upper_estimate'].includes(value?.costSource) ? value.costSource : 'unknown';
  const verified = status === 'settled' && value?.shutdownVerified === true
    && (costSource === 'verified_session_usage' || costSource === 'verified_no_allocation' && value.actualSpendCu === 0);
  const cpu = status === 'not_required' && costSource === 'cpu_no_colab_spend' && value?.actualSpendCu === 0;
  return { status, costSource, shutdownVerified: value?.shutdownVerified === true,
    actualSpendCu: verified || cpu ? amount(value?.actualSpendCu) : null, reservedEstimateCu: amount(row.details?.reservedEstimateCu),
    legacyEstimateCu: status === 'legacy_estimate' ? amount(row.spentEstimateCu) : null };
}

export function createGenerationGallery({ ledger, pipelines, tickets, adminTickets }) {
  const usable = id => { const invite = ledger.get(id); return invite && !['expired', 'revoked'].includes(invite.status); };
  const shared = row => row?.showcase && row.status === 'ready' && usable(row.inviteId);
  function list(viewerId, { offset = 0, limit = 24 } = {}) {
    if (!usable(viewerId)) return null;
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.max(1, Math.min(50, Math.floor(Number(limit) || 24)));
    const rows = ledger.listGenerations().filter(shared).reverse();
    return { total: rows.length, nextOffset: start + size < rows.length ? start + size : null,
      items: rows.slice(start, start + size).map(row => ({
        id: row.id, title: row.title || 'Untitled film', prompt: row.prompt, createdAt: row.createdAt,
        models: row.details?.models ?? [], plannedModels: row.details?.plannedModels ?? [],
        modelEvidence: row.details?.modelEvidence ?? 'not_recorded', planner: row.details?.planner ?? null,
        fromThisInvite: row.inviteId === viewerId,
        ...(row.inviteId === viewerId ? { accounting: publicAccounting(row) } : {}),
        videoApiPath: `/api/demo/generations/${encodeURIComponent(row.id)}/video`,
        editApiPath: `/api/demo/generations/${encodeURIComponent(row.id)}/edit`,
      })) };
  }
  function video(generationId, viewerId, owner = false) {
    const row = ledger.listGenerations().find(g => g.id === generationId);
    if (!row || (!owner && (!usable(viewerId) || !shared(row)))) return null;
    const run = pipelines.get(row.runId);
    if (!run?.origin?.productionId || run.packageId !== row.packageId) return null;
    return guestProductionResult({ ledger, pipelines, tickets: owner ? adminTickets : tickets,
      inviteId: row.inviteId, productionId: run.origin.productionId, runId: row.runId, ownerView: owner,
      authorizeViewer: () => owner || Boolean(usable(viewerId) && shared(ledger.listGenerations().find(g => g.id === generationId))) });
  }
  return { list, video };
}
