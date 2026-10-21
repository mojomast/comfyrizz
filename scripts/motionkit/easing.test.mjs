import { test } from "node:test";
import assert from "node:assert/strict";
import { cubicBezier, curves, spring, PERSONALITIES } from "./easing.mjs";
import { MOTION_VOCABULARY } from "../../packages/schema/src/motion.mjs";

test("curves hit 0 and 1", () => {
  for (const [n, c] of Object.entries(curves)) {
    if (typeof c !== "function") continue;
    assert.equal(c(0), 0, n);
    assert.equal(c(1), 1, n);
  }
});

test("backOut overshoots >1", () => {
  let max = 0;
  for (let i = 0; i <= 100; i++) max = Math.max(max, curves.backOut(i/100));
  assert.ok(max > 1);
});

test("spring settles within 2% and reports frame", () => {
  const s = spring({ stiffness: 100, damping: 10, mass: 1 });
  assert.ok(s.settleFrame > 0 && s.settleFrame <= s.frames.length);
  const last = s.frames[s.frames.length-1];
  assert.ok(Math.abs(last - 1) < 0.02);
});

test("nearestToken exists in vocabulary", () => {
  const tokens = new Set([...MOTION_VOCABULARY.easing, ...MOTION_VOCABULARY.springs]);
  for (const p of Object.values(PERSONALITIES)) {
    assert.ok(tokens.has(p.nearestToken), p.nearestToken);
  }
});
