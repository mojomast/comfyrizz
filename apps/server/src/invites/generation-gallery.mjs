import { guestProductionResult } from './guest-result.mjs';

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
        videoApiPath: `/api/demo/generations/${encodeURIComponent(row.id)}/video`,
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
