// Predeclared decision targets. These are not statistical-significance claims
// and must exist before any main-run results are written.

export const ENGINEERING_TARGETS = {
  maxPassRateDropPpVsOn: 5,
  noCriticalOrCollateralIncrease: true,
  minMedianTokenSavingsVsOn: 0.25,
  minMedianLatencySavingsVsOn: 0.20,
  reportHybridMoreExpensiveThanOn: true,
};

export const TARGET_NOTES = [
  'Hybrid final pass rate is at most 5 percentage points below thinking-on.',
  'Critical failures and correction collateral damage must not increase.',
  'Median total-token savings versus thinking-on is at least 25%.',
  'Median E2E latency savings versus thinking-on is at least 20%.',
  'Trials where hybrid costs more than thinking-on are reported, not hidden.',
];
