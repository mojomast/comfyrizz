// Route only explicitly planned chat correction slots to the take runner. The
// runner itself consumes journal authority, fences retries, and settles the hold.
import { fingerprint } from '../pipeline-contract.mjs';

export function createCorrectionAdapter({ store, runs, pipeline }) {
  function facts(productionId, actionId) {
    const events = store.readEvents(productionId);
    let action = null;
    for (const event of events) if (event.type === 'action.state_changed' && event.data?.id === actionId) {
      action = { ...action, ...event.data };
    }
    const plan = events.findLast(event => event.type === 'plan.proposed'
      && event.data?.id === action?.planId && event.data?.planHash === action?.planHash)?.data;
    const slot = plan?.actions?.find(item => item.id === actionId);
    return { action, slot };
  }
  const isCorrection = fact => fact.slot?.executor === 'chat-correction-take';
  function correctionRun(productionId, actionId, fact) {
    if (!fact.action?.runId) return null;
    const run = runs.get(fact.action.runId);
    const packageId = store.read(productionId)?.packageId;
    // A journaled runId alone cannot attribute a foreign take to this action.
    // The take runner records the action plan separately from its backend plan.
    return run && run.runId === fact.action.runId && run.productionId === productionId
      && run.actionId === actionId && packageId && run.packageId === packageId
      && (run.actionPlanHash ?? run.planHash) === fact.action.planHash ? run : null;
  }
  return {
    runForAction(productionId, actionId) {
      const fact = facts(productionId, actionId);
      // Preserve the pipeline's attributed lookup through this wrapper: the
      // invite spend guard needs it before releasing proven non-submissions.
      if (!isCorrection(fact)) return pipeline.runForAction(productionId, actionId);
      return correctionRun(productionId, actionId, fact);
    },
    async admit(args) {
      const { action, slot } = facts(args.productionId, args.actionId);
      if (!isCorrection({ slot })) return pipeline.admit(args);
      if (action?.state !== 'queued') {
        return { admitted: false, duplicate: true, actionState: action?.state, action, status: action?.state,
          reconcileRequired: !['completed', 'failed', 'cancelled'].includes(action?.state) };
      }
      const production = store.read(args.productionId);
      if (fingerprint(args.pkg) !== slot.basePackageFingerprint) {
        throw Object.assign(new Error('The project changed after this correction was prepared.'), { code: 'SHOT_PLAN_CHANGED' });
      }
      const pkg = structuredClone(args.pkg);
      pkg.assets[slot.assetIds[0]] = structuredClone(slot.stagedAsset);
      const result = await runs.start({
        backendId: slot.backendId, pkg, budgetUnits: slot.upperBound,
        includeReady: true, assets: slot.assetIds, mode: 'take',
        corrections: { [slot.assetIds[0]]: slot.correction },
        authority: { productionId: args.productionId, planId: action.planId, planHash: action.planHash, actionId: action.id },
        expected: { productionRevision: production.revision },
      });
      if (!result.runId) throw Object.assign(new Error(result.error ?? 'The correction was not admitted.'),
        { code: result.code ?? 'CORRECTION_REFUSED' });
      return { admitted: true, started: true, status: 'running', actionState: 'running',
        action: facts(args.productionId, args.actionId).action, run: { runId: result.runId, status: result.status } };
    },
    async observe(args) {
      const fact = facts(args.productionId, args.actionId);
      if (!isCorrection(fact)) return pipeline.observe(args);
      const run = correctionRun(args.productionId, args.actionId, fact);
      return { observed: Boolean(run), changed: false, action: fact.action, actionState: fact.action?.state,
        status: fact.action?.state, run, reconcileRequired: fact.action?.state === 'submission_unknown' };
    },
    cancel(args) {
      const fact = facts(args.productionId, args.actionId);
      if (isCorrection(fact)) {
        const run = correctionRun(args.productionId, args.actionId, fact);
        if (run) runs.cancel(run.runId);
      }
      return pipeline.cancel(args);
    },
  };
}
