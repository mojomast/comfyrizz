// Billing evidence comes only from server-owned runtime records. The Colab CLI
// currently exposes account-wide usage, NOT a final session usage receipt. Never
// divide overlapping balance deltas or turn a watchdog estimate into actual CU.
export function sessionUsageAccounting({ runId, runtimes, budget } = {}) {
  const unknown = (reason, shutdownVerified = false) => ({
    status: 'unresolved', actualSpendCu: null, costSource: 'unattributed_usage',
    shutdownVerified, reason,
  });
  const entries = Object.entries(runtimes ?? {});
  if (!entries.length || !runId) return unknown('runtime_evidence_missing');
  for (const [name, ceiling] of [['media', budget?.mediaCeilingUnits], ['narration', budget?.narrationCeilingUnits]]) {
    if (ceiling > 0 && !runtimes[name]) return unknown('runtime_evidence_missing');
  }
  if (entries.some(([, value]) => value?.runId !== runId || typeof value.session !== 'string' || !value.session
      || value.ownership !== 'managed')) return unknown('runtime_identity_unverified');
  if (entries.some(([, value]) => !['stopped', 'not_started'].includes(value.state) || value.shutdownVerified !== true)) {
    return unknown('shutdown_unconfirmed');
  }
  let milliUnits = 0, allocated = false;
  const sessions = new Set();
  for (const [, value] of entries) {
    if (sessions.has(value.session)) return unknown('duplicate_session_evidence', true);
    sessions.add(value.session);
    if (value.allocation === 'not_attempted' && value.costSource === 'verified_no_allocation' && value.spentUnits === 0) continue;
    allocated = true;
    // Optional future provider-adapter contract, not a client assertion and not
    // populated from `colab usage`/`status`. A receipt must be final and cover
    // the named session's entire lifetime, including shutdown.
    const receipt = value.usageReceipt;
    if (receipt?.source !== 'provider_session' || receipt.final !== true || receipt.unit !== 'CU'
        || receipt.runId !== runId || receipt.session !== value.session
        || typeof receipt.receiptId !== 'string' || !receipt.receiptId
        || typeof receipt.units !== 'number' || !Number.isFinite(receipt.units) || receipt.units < 0) {
      return unknown('session_usage_unavailable', true);
    }
    milliUnits += Math.ceil(receipt.units * 1000);
  }
  if (!Number.isSafeInteger(milliUnits)) return unknown('invalid_session_usage', true);
  const actualSpendCu = milliUnits / 1000;
  if (Number.isFinite(budget?.ceilingUnits) && actualSpendCu > budget.ceilingUnits) return unknown('usage_exceeds_reservation', true);
  return { status: 'settled', actualSpendCu,
    costSource: allocated ? 'verified_session_usage' : 'verified_no_allocation', shutdownVerified: true, reason: null };
}
