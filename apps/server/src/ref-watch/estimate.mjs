import {
  REF_POLICY_DEFAULTS,
  refRegenJobCap,
} from '../../../../packages/schema/src/ref-review.mjs';
import { estimateIteration } from '../productions/iteration-estimate.mjs';
import { ITERATION_PRESETS } from '../productions/iteration.mjs';

// One still regen (Klein reprompt or a Qwen edit) on a VM that is already up: no allocation,
// bootstrap or collect-and-stop reserve, which is what estimateIteration prices for a new session.
export const LIVE_REGEN_MINUTES = Object.freeze({ low: 0.5, expected: 1, high: 2 });
const LIVE_RATE_PER_HOUR = 10.05;

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
  liveSession = false,
  ratePerHour = LIVE_RATE_PER_HOUR,
} = {}) {
  if (!decision || !ESTIMATE_ACTIONS.has(decision.action)) return null;

  const caps = { ...REF_POLICY_DEFAULTS, ...(policy ?? {}) };
  const perStillOpen = Number.isSafeInteger(decision.attempt)
    && decision.attempt < caps.maxRegensPerStill;
  const productionCap = refRegenJobCap(stillCount, caps);
  const productionOpen = Number.isSafeInteger(regenJobsUsed)
    && regenJobsUsed + 1 <= productionCap;
  const blocked = !perStillOpen || !productionOpen;

  if (liveSession) {
    const units = Object.fromEntries(Object.entries(LIVE_REGEN_MINUTES).map(([key, minutes]) => [key, Math.round(minutes * ratePerHour / 60 * 1000) / 1000]));
    return {
      label: 'one still regen on the live Google Colab session',
      units,
      blocked,
      reason: blocked ? capReason({ perStillOpen, productionOpen }) : 'within regen caps',
    };
  }

  const estimate = estimateIteration({
    ...(iteration ?? {}),
    // A package run (no production iteration settings) still needs a policy to price the regen.
    policy: iteration?.policy ?? ITERATION_PRESETS.balanced,
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
