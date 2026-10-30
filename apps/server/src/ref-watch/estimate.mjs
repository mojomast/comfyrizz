import {
  REF_POLICY_DEFAULTS,
  refRegenJobCap,
} from '../../../../packages/schema/src/ref-review.mjs';
import { estimateIteration } from '../productions/iteration-estimate.mjs';

const ESTIMATE_ACTIONS = new Set(['reprompt', 'replace_ref']);

function capReason({ perStillOpen, productionOpen }) {
  if (!perStillOpen && !productionOpen) return 'per-still and production regen caps exhausted';
  if (!perStillOpen) return 'per-still regen cap exhausted';
  return 'production regen cap exhausted';
}

export function estimateRegen({
  decision,
  shot,
  regenJobsUsed,
  stillCount,
  policy,
  iteration,
} = {}) {
  if (!decision || !ESTIMATE_ACTIONS.has(decision.action)) return null;

  const caps = { ...REF_POLICY_DEFAULTS, ...(policy ?? {}) };
  const perStillOpen = Number.isSafeInteger(decision.attempt)
    && decision.attempt < caps.maxRegensPerStill;
  const productionCap = refRegenJobCap(stillCount, caps);
  const productionOpen = Number.isSafeInteger(regenJobsUsed)
    && regenJobsUsed + 1 <= productionCap;
  const blocked = !perStillOpen || !productionOpen;

  const estimate = estimateIteration({
    ...(iteration ?? {}),
    shots: [{ ...shot, kind: 'still' }],
  });

  const result = {
    label: estimate.labels.join('; '),
    units: estimate.units,
    blocked,
    reason: blocked ? capReason({ perStillOpen, productionOpen }) : 'within regen caps',
  };
  if (estimate.money) result.money = estimate.money;
  return result;
}
