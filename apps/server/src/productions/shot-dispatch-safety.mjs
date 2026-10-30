import { hashFor } from './plan-from-package.mjs';

// The full pipeline is not yet a shot-scoped executor. Do not redeem a shot
// slot unless the work it would actually perform matches that approved slot.
export function shotDispatchProblem(pkg, slot, plan) {
  if (slot?.kind !== 'shot.generate') return null;
  const ids = slot.assetIds;
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length
    || typeof slot.effectiveInputHash !== 'string') return 'The approved shot has no verifiable asset scope.';
  if (slot.takes !== 1) return 'The pipeline cannot yet execute the approved number of shot takes.';
  const assets = ids.map(assetId => ({ assetId, gen: pkg.assets?.[assetId]?.gen }))
    .sort((a, b) => a.assetId.localeCompare(b.assetId));
  if (assets.some(asset => !asset.gen) || hashFor(slot.targetId, assets) !== slot.effectiveInputHash) {
    return 'The shot inputs changed after approval; prepare and approve a new plan.';
  }
  const actual = new Set((plan.jobs ?? []).map(job => job.assetId));
  if (actual.size !== ids.length || ids.some(id => !actual.has(id))) {
    return 'The pipeline cannot execute exactly the approved shot assets; prepare a scoped generation.';
  }
  if (plan.remoteVoice || plan.presenters || plan.remoteRender) {
    return 'The shot plan does not authorize additional remote pipeline stages.';
  }
  return null;
}
