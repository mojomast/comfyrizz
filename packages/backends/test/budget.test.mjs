// B3 acceptance: the reserve formula, the 80% warning, the wall-clock cap, and the
// labelling that keeps spend honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COLLECT_AND_STOP_RESERVE_MINUTES, assessBudget, nextJobUpperEstimate, spendEstimate, unitsForMinutes, wallClockCheck } from "../src/budget.mjs";

const RATE = 8.9;

test("units come from minutes at the observed rate", () => {
  assert.equal(unitsForMinutes(60, RATE), RATE);
  assert.equal(Number(unitsForMinutes(6, RATE).toFixed(2)), 0.89);
  assert.equal(unitsForMinutes(5, null), null);
});

test("the next job's upper bound carries a margin", () => {
  const point = unitsForMinutes(10, RATE);
  const upper = nextJobUpperEstimate({ gpuMinutes: 10, ratePerHour: RATE });
  assert.ok(upper > point, `${upper} should exceed ${point}`);
  assert.equal(upper, Number((point * 1.35).toFixed(3)));
});

test("the reserve formula refuses a job that would not fit", () => {
  const decision = assessBudget({
    budgetUnits: 5,
    spentEstimate: 1,
    committedEstimate: 0.5,
    nextJobUpperEstimate: 3.5,
    ratePerHour: RATE,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.state, "refused");
  assert.ok(decision.required > decision.budget);
  assert.match(decision.message, /Refusing the next job/);
  assert.ok(decision.formula.some((line) => line.includes("collect and stop reserve")));
});

test("the reserve formula admits a job that fits, and warns at 80%", () => {
  const roomy = assessBudget({ budgetUnits: 40, spentEstimate: 1, committedEstimate: 1, nextJobUpperEstimate: 2, ratePerHour: RATE });
  assert.equal(roomy.allowed, true);
  assert.equal(roomy.warn, false);
  assert.equal(roomy.state, "ok");
  assert.ok(roomy.remaining > 0);

  const tight = assessBudget({ budgetUnits: 5, spentEstimate: 2.4, committedEstimate: 0.5, nextJobUpperEstimate: 1.2, ratePerHour: RATE });
  assert.equal(tight.allowed, true);
  assert.equal(tight.warn, true, `${tight.required} of ${tight.budget}`);
  assert.match(tight.message, /Warning/);
});

test("a missing budget is a refusal, not an implicit yes", () => {
  const decision = assessBudget({ budgetUnits: 0, nextJobUpperEstimate: 1, ratePerHour: RATE });
  assert.equal(decision.allowed, false);
  assert.equal(decision.state, "no_budget");
  assert.match(decision.message, /No project unit budget/);
});

test("the collect-and-stop reserve is the measured cold-start window", () => {
  assert.equal(COLLECT_AND_STOP_RESERVE_MINUTES, 6);
  const decision = assessBudget({ budgetUnits: 10, spentEstimate: 0, committedEstimate: 0, nextJobUpperEstimate: 0, ratePerHour: RATE });
  assert.equal(decision.reserve, Number(unitsForMinutes(6, RATE).toFixed(3)));
});

test("the wall-clock cap applies independently of metering", () => {
  assert.equal(wallClockCheck({ elapsedMinutes: 10, capMinutes: 180 }).exceeded, false);
  const hit = wallClockCheck({ elapsedMinutes: 181, capMinutes: 180 });
  assert.equal(hit.exceeded, true);
  assert.match(hit.message, /Wall-clock cap reached/);
  assert.equal(wallClockCheck({ elapsedMinutes: 10, capMinutes: null }).exceeded, false);
});

test("spend is an estimate and says when the account has other sessions", () => {
  const solo = spendEstimate({ usageBefore: { balance: 400 }, usageAfter: { balance: 399.1, ratePerHour: RATE, assignments: 1 }, elapsedMinutes: 6 });
  assert.equal(solo.label, "estimate");
  assert.equal(solo.units, 0.9);
  assert.equal(solo.units, solo.balanceDelta);
  assert.match(solo.detail, /estimate/);

  const shared = spendEstimate({ usageBefore: { balance: 400 }, usageAfter: { balance: 398, ratePerHour: RATE, assignments: 3 }, elapsedMinutes: 6 });
  assert.equal(shared.units, 2);
  assert.match(shared.detail, /other sessions running/);

  const noBalance = spendEstimate({ usageBefore: { balance: null }, usageAfter: { balance: null, ratePerHour: RATE }, elapsedMinutes: 30 });
  assert.equal(Number(noBalance.units.toFixed(3)), Number(unitsForMinutes(30, RATE).toFixed(3)));
});
