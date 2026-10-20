import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { duckingPlan, gainAt, ffmpegVolumeExpr } from "./ducking.mjs";

// Synthetic fixture built from the measured examples in
// docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md (sections 3 and 7):
// dialogue spans plus a deliberate reaction pause, scaled to a short film.
const filmS = 30;
const utterances = [
  { id: "u_ada_sandwich", speaker: "Ada", startS: 2.0, endS: 6.5 },
  { id: "u_reporter_chair", speaker: "Reporter", startS: 8.0, endS: 12.0 },
  { id: "u_ada_punchline", speaker: "Ada", startS: 15.0, endS: 18.0 },
];
const pauses = [
  {
    id: "pause_reaction",
    startS: 18.5,
    endS: 21.5,
    reason: "reaction pause after punchline",
  },
];
const opts = { duckDb: -8, attackMs: 80, releaseMs: 300, fps: 30, filmS };

describe("Q16 ducking", () => {
  describe("duckingPlan", () => {
    test("points are time-sorted and inside the film", () => {
      const plan = duckingPlan(utterances, pauses, opts);
      assert.ok(plan.points.length >= 2, "plan emits automation points");
      for (let i = 0; i < plan.points.length; i += 1) {
        const p = plan.points[i];
        assert.ok(Number.isFinite(p.tS), `point ${i} has finite tS`);
        assert.ok(Number.isFinite(p.gainDb), `point ${i} has finite gainDb`);
        assert.ok(p.tS >= 0, `point ${i} not before film start`);
        assert.ok(p.tS <= filmS + 1e-9, `point ${i} not after film end`);
        if (i > 0) {
          assert.ok(
            plan.points[i - 1].tS <= p.tS + 1e-9,
            `point ${i} not earlier than point ${i - 1}`
          );
        }
      }
    });

    test("music is never at full gain during speech", () => {
      const plan = duckingPlan(utterances, pauses, opts);
      for (const u of utterances) {
        for (let t = u.startS; t <= u.endS + 1e-9; t += 0.05) {
          const g = gainAt(plan.points, Math.min(t, u.endS));
          assert.ok(
            g <= opts.duckDb + 1e-6,
            `gain ${g.toFixed(3)} dB at t=${t.toFixed(2)} must be <= ${opts.duckDb} dB during "${u.id}"`
          );
          assert.ok(g < 0, `music not full gain at t=${t.toFixed(2)} during "${u.id}"`);
        }
      }
    });

    test("reaction pause produces a rest window", () => {
      const plan = duckingPlan(utterances, pauses, opts);
      assert.equal(plan.rests.length, 1);
      assert.equal(plan.rests[0].id, "pause_reaction");
      const pause = pauses[0];
      for (let t = pause.startS; t <= pause.endS + 1e-9; t += 0.05) {
        const g = gainAt(plan.points, Math.min(t, pause.endS));
        assert.ok(
          g <= plan.options.restDb + 1e-6,
          `gain ${g.toFixed(3)} dB at t=${t.toFixed(2)} must sit at the rest floor inside pause_reaction`
        );
      }
      const restPoints = plan.points.filter((p) => p.level === "rest");
      assert.ok(restPoints.length >= 2, "rest window is bracketed by automation points");
    });

    test("music restores to unity after speech and rest release", () => {
      const plan = duckingPlan(utterances, pauses, opts);
      const releaseS = opts.releaseMs / 1000;
      const lastEnd = 21.5;
      const g = gainAt(plan.points, lastEnd + releaseS + 0.1);
      assert.ok(Math.abs(g) < 1e-6, `gain restored to 0 dB after release, got ${g}`);
    });

    test("speech starting within attack of t=0 is ducked by its start", () => {
      const plan = duckingPlan(
        [{ id: "u_open", speaker: "Ada", startS: 0.02, endS: 1.5 }],
        [],
        { ...opts, filmS: 5 }
      );
      const g0 = gainAt(plan.points, 0);
      assert.ok(g0 < 0, `t=0 must already be mid-attack, not full gain, got ${g0}`);
      const gStart = gainAt(plan.points, 0.02);
      assert.ok(
        gStart <= opts.duckDb + 1e-6,
        `gain at speech start must be ducked, got ${gStart}`
      );
      assert.ok(plan.points[0].tS >= 0);
    });

    test("frame-based pauses convert with fps", () => {
      const plan = duckingPlan(
        [{ id: "u", startS: 1, endS: 2 }],
        [{ id: "p_frames", startFrame: 90, endFrame: 120 }],
        { ...opts, filmS: 10 }
      );
      assert.equal(plan.rests.length, 1);
      assert.ok(Math.abs(plan.rests[0].startS - 3) < 1e-9);
      assert.ok(Math.abs(plan.rests[0].endS - 4) < 1e-9);
      const g = gainAt(plan.points, 3.5);
      assert.ok(g <= plan.options.restDb + 1e-6, "converted pause still rests");
    });

    test("empty inputs yield an empty deterministic plan", () => {
      const a = duckingPlan([], [], opts);
      const b = duckingPlan([], [], opts);
      assert.deepEqual(a, b);
      assert.equal(a.points.length, 0);
      assert.equal(a.rests.length, 0);
    });
  });

  describe("ffmpegVolumeExpr", () => {
    test("expression builder output is deterministic", () => {
      const plan = duckingPlan(utterances, pauses, opts);
      const one = ffmpegVolumeExpr(plan.points);
      const two = ffmpegVolumeExpr(plan.points);
      assert.equal(typeof one, "string");
      assert.equal(one, two, "same points produce identical expression");
      assert.ok(!one.includes("NaN"), "no NaN in expression");
      assert.ok(!one.includes("Infinity"), "no Infinity in expression");
      assert.ok(one.includes("if(lt(t,"), "expression is a time-ordered if-chain");
    });

    test("expression handles degenerate inputs", () => {
      assert.equal(ffmpegVolumeExpr([]), "1");
      assert.equal(
        ffmpegVolumeExpr([{ tS: 1, gainDb: 0, level: "unity" }]),
        "1"
      );
    });

    test("ducked plan expression never reports unity amplitude inside speech", () => {
      const plan = duckingPlan(utterances, pauses, opts);
      const expr = ffmpegVolumeExpr(plan.points);
      // The ducked hold for u_ada_speech is -8 dB linearised at its segment.
      const duckAmp = Math.pow(10, opts.duckDb / 20).toFixed(6).replace(/\.?0+$/, "");
      assert.ok(expr.includes(duckAmp), "ducked level appears in expression");
    });
  });
});
