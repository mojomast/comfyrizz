import {
  REF_DECISION_SCHEMA,
  REF_POLICY_DEFAULTS,
  refRegenJobCap,
  validateRefVerdict,
} from '../../../../packages/schema/src/ref-review.mjs';
import { EDIT_PLACEHOLDER, planEdit } from './edit-plan.mjs';

const STEER_PLACEHOLDER = '<steer>';
const REPLACE_REF_PLACEHOLDER = '<replace-ref>';

/**
 * Dimensions blacklisted for the current judge model (deepseek-v4.1-flash) by the W4 calibration
 * (docs/ref-watch.md "Current blacklist"). A failed check on one of these is reported but never
 * holds or regenerates a still.
 */
export const REF_UNTRUSTED_DIMENSIONS = Object.freeze(['prompt']);

const isFailed = (check) => check && check.pass === false;

function hardFailures(checks, untrusted = REF_UNTRUSTED_DIMENSIONS) {
  return checks.filter((check) => isFailed(check) && check.severity === 'hard' && !untrusted.includes(check.dimension));
}

function softFailures(checks) {
  return checks.filter((check) => isFailed(check) && check.severity !== 'hard');
}

function capExhaustedReason({ attempt, policy, regenJobsUsed, stillCount }) {
  const perStillOpen = Number.isSafeInteger(attempt) && attempt < policy.maxRegensPerStill;
  const productionOpen = Number.isSafeInteger(regenJobsUsed) && regenJobsUsed < refRegenJobCap(stillCount, policy);
  if (!perStillOpen && !productionOpen) return 'per-still and production regen caps exhausted';
  if (!perStillOpen) return 'per-still regen cap exhausted';
  return 'production regen cap exhausted';
}

export function decide({ verdict, attempt, regenJobsUsed, stillCount, identityFailures, editsTried, policy = REF_POLICY_DEFAULTS, untrustedDimensions = REF_UNTRUSTED_DIMENSIONS }) {
  const checks = Array.isArray(verdict?.checks) ? verdict.checks : [];
  const base = {
    schema: REF_DECISION_SCHEMA,
    jobId: verdict?.jobId,
    keyframeSha256: verdict?.keyframeSha256,
    attempt,
  };

  if (verdict?.overall === 'error' || !validateRefVerdict(verdict).ok) {
    return { ...base, action: 'escalate', reason: 'judge error' };
  }
  if (verdict?.overall === 'pass') {
    return {
      ...base,
      action: 'accept',
      reason: softFailures(checks).length ? 'overall pass; soft checks failed' : 'all checks passed',
    };
  }
  const editPlan = verdict?.overall === 'fail' ? planEdit(verdict) : null;
  if (verdict?.overall === 'fail' && hardFailures(checks, untrustedDimensions).length === 0 && !editPlan) {
    const untrustedOnly = checks.some((check) => isFailed(check) && check.severity === 'hard');
    return { ...base, action: 'accept', reason: untrustedOnly ? 'only untrusted or soft checks failed' : 'only soft checks failed' };
  }
  if (verdict?.overall !== 'fail') {
    return { ...base, action: 'escalate', reason: `unknown verdict overall: ${String(verdict?.overall)}` };
  }

  const failures = hardFailures(checks, untrustedDimensions);
  const perStillOpen = Number.isSafeInteger(attempt) && attempt < policy.maxRegensPerStill;
  const productionOpen = Number.isSafeInteger(regenJobsUsed) && regenJobsUsed < refRegenJobCap(stillCount, policy);
  if (!perStillOpen || !productionOpen) {
    return { ...base, action: 'escalate', reason: capExhaustedReason({ attempt, policy, regenJobsUsed, stillCount }) };
  }

  if (Number.isSafeInteger(identityFailures) && identityFailures >= 2) {
    return {
      ...base,
      action: 'replace_ref',
      reason: 'identity failed twice; replace reference',
      replaceRef: REPLACE_REF_PLACEHOLDER,
    };
  }

  if (editPlan && !(Number.isSafeInteger(editsTried) && editsTried >= 1)) {
    return {
      ...base,
      action: 'targeted_edit',
      reason: `localized hard checks failed: ${editPlan.dimensions.join(', ')}`,
      editInstruction: EDIT_PLACEHOLDER,
      editDimension: editPlan.dimension,
    };
  }

  const failedDimensions = failures.map((check) => check.dimension);
  const dimensions = [...new Set(failedDimensions.length > 0 ? failedDimensions : editPlan?.dimensions ?? [])];
  return {
    ...base,
    action: 'reprompt',
    reason: `hard checks failed: ${dimensions.join(', ')}`,
    nextPrompt: STEER_PLACEHOLDER,
  };
}
