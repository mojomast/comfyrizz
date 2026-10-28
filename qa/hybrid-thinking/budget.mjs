// Predeclared main-run request count and hard token budget. The main live run
// must not start until an operator sets HYBRID_THINKING_MAIN=1 after reading
// these numbers. No approval has been given.

export const MAIN_REPS = 3;
export const SMOKE_REPS = 1;

export const MAIN_FIXTURE_COUNT = 12;
export const SMOKE_FIXTURE_COUNT = 2;

// Arms A and B always run. Arm C runs a provider call only on bounded failures.
export const MAIN_BASELINE_REQUESTS = MAIN_FIXTURE_COUNT * MAIN_REPS * 2;
export const MAIN_MAX_CORRECTION_REQUESTS = MAIN_FIXTURE_COUNT * MAIN_REPS;
export const MAIN_MAX_REQUESTS = MAIN_BASELINE_REQUESTS + MAIN_MAX_CORRECTION_REQUESTS;

// Calibration-only preliminary sample (not evidence): off ~69k, on ~308k.
// Hard ceiling uses a conservative envelope, not that sample as a mean.
export const TOKEN_ENVELOPE = {
  offPerTrial: 80_000,
  onPerTrial: 320_000,
  correctionPerTrial: 90_000,
  assumedCorrectionRate: 0.55,
};

export const MAIN_TOKEN_ESTIMATE = Math.round(
  (MAIN_FIXTURE_COUNT * MAIN_REPS * TOKEN_ENVELOPE.offPerTrial)
  + (MAIN_FIXTURE_COUNT * MAIN_REPS * TOKEN_ENVELOPE.onPerTrial)
  + (MAIN_FIXTURE_COUNT * MAIN_REPS * TOKEN_ENVELOPE.assumedCorrectionRate * TOKEN_ENVELOPE.correctionPerTrial),
);

export const MAIN_HARD_TOKEN_BUDGET = 20_000_000;

export const SMOKE_MAX_REQUESTS = SMOKE_FIXTURE_COUNT * SMOKE_REPS * 3;

export function mainBudget() {
  if (MAIN_HARD_TOKEN_BUDGET < MAIN_TOKEN_ESTIMATE) {
    throw new Error('hard token budget is below the predeclared estimate');
  }
  return {
    fixtures: MAIN_FIXTURE_COUNT,
    reps: MAIN_REPS,
    baselineRequests: MAIN_BASELINE_REQUESTS,
    maxCorrectionRequests: MAIN_MAX_CORRECTION_REQUESTS,
    maxRequests: MAIN_MAX_REQUESTS,
    estimatedTokens: MAIN_TOKEN_ESTIMATE,
    hardTokenBudget: MAIN_HARD_TOKEN_BUDGET,
    approvalRequired: true,
    approved: false,
    started: false,
  };
}
