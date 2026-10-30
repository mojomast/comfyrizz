import {
  REF_DECISION_SCHEMA,
  REF_POLICY_DEFAULTS,
  refRegenJobCap,
  validateRefVerdict,
} from '../../../../packages/schema/src/ref-review.mjs';

const STEER_PLACEHOLDER = '<steer>';
const REPLACE_REF_PLACEHOLDER = '<replace-ref>';

const isFailed = (check) => check && check.pass === false;

function hardFailures(checks) {
  return checks.filter((check) => isFailed(check) && check.severity === 'hard');
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

export function decide({ verdict, attempt, regenJobsUsed, stillCount, identityFailures, policy = REF_POLICY_DEFAULTS }) {
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
  if (verdict?.overall === 'fail' && hardFailures(checks).length === 0) {
    return { ...base, action: 'accept', reason: 'only soft checks failed' };
  }
  if (verdict?.overall !== 'fail') {
    return { ...base, action: 'escalate', reason: `unknown verdict overall: ${String(verdict?.overall)}` };
  }

  const failures = hardFailures(checks);
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

  const dimensions = [...new Set(failures.map((check) => check.dimension))];
  return {
    ...base,
    action: 'reprompt',
    reason: `hard checks failed: ${dimensions.join(', ')}`,
    nextPrompt: STEER_PLACEHOLDER,
  };
}
