import test from "node:test";
import assert from "node:assert/strict";
import { samplePlan, ffmpegSampleArgs } from "./sample-plan.mjs";

test("10s 24fps action 4-8 includes 0,4,6,8,last", () => {
  const times = samplePlan({ durationS: 10, fps: 24, actionWindows: [{ start: 4, end: 8 }], everyS: 2 });
  const frames = new Set(times);
  assert.ok(frames.has(0));
  assert.ok(frames.has(4 * 24));
  assert.ok(frames.has(6 * 24));
  assert.ok(frames.has(8 * 24));
  assert.ok(frames.has(10 * 24 - 1));
  for (const t of times) assert.equal(Number.isInteger(t), true);
});

test("argv no shell metacharacters joined", () => {
  const args = ffmpegSampleArgs("in.mp4", [0, 96], "out_%04d.png");
  assert.ok(Array.isArray(args));
  const joined = args.join(" ");
  for (const m of [";", "|", "&", "$", "`"]) assert.ok(!joined.includes(m), m);
});
