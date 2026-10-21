import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import * as transitions from "./transitions.mjs";
import { TRANSITIONS } from "../../packages/schema/src/motion.mjs";

const fs = {
  readFileSync: (url) => readFileSync(url.toString().replace("file://", ""), "utf8"),
};

describe("transitions catalog (M05)", () => {
  it("validates catalog and loads 20+ entries", () => {
    const { ok, count } = transitions.validateCatalog(fs);
    assert.equal(ok, true);
    assert.ok(count >= 20, `expected >= 20 entries, got ${count}`);
  });

  it("every native value is a schema transition type", () => {
    const list = transitions.listTransitions(fs);
    const valid = new Set([
      "none", "cut", "fade", "blur", "slide", "push", "wipe", "zoom", "iris",
      "paper-reveal", "draw-reveal", "shape-reveal",
    ]);
    for (const entry of list) {
      assert.ok(valid.has(entry.native), `${entry.id} native ${entry.native} is not a schema transition type`);
    }
    assert.ok(list.length >= 20);
  });

  it("resolveTransition returns schema-valid {type, direction?, frames} at 24 and 30 fps", () => {
    const list = transitions.listTransitions(fs);
    for (const entry of list) {
      for (const fps of [24, 30]) {
        const r = transitions.resolveTransition(entry.id, { fs, fps });
        assert.ok(typeof r.type === "string" && r.type.length > 0, `${entry.id} missing type at ${fps} fps`);
        assert.ok(Number.isInteger(r.frames) && r.frames >= 0, `${entry.id} frames not a non-negative int at ${fps} fps`);
        if (r.type === "cut" || r.type === "none") {
          assert.equal(r.frames, 0, `${entry.id} cut/none frames must be 0 at ${fps} fps`);
        }
        // band check via TRANSITIONS
        const spec = TRANSITIONS[r.type];
        if (spec) {
          const min = Math.floor(spec.minSeconds * fps + 0.5);
          const max = Math.floor(spec.maxSeconds * fps + 0.5);
          if (r.type !== "cut" && r.type !== "none") {
            assert.ok(r.frames >= min && r.frames <= max,
              `${entry.id} frames ${r.frames} outside band [${min},${max}] at ${fps} fps`);
          }
        }
        if (r.direction !== undefined) {
          const dirs = ["left", "right", "up", "down", "in", "out"];
          assert.ok(dirs.includes(r.direction), `${entry.id} bad direction ${r.direction}`);
        }
      }
    }
  });

  it("glsl entries name MIT shaders only", () => {
    const list = transitions.listTransitions(fs);
    for (const entry of list) {
      const full = transitions.getTransition(fs, entry.id);
      if (full.glsl) {
        assert.equal(full.glsl.license, "MIT", `${entry.id} glsl license not MIT`);
        assert.ok(typeof full.glsl.name === "string" && full.glsl.name.length > 0, `${entry.id} glsl name missing`);
      }
    }
  });

  it("resolveTransition throws on unknown id and bad fps", () => {
    assert.throws(() => transitions.resolveTransition("no-such-id", { fs }));
    assert.throws(() => transitions.resolveTransition("hard-cut", { fs, fps: 0 }));
    assert.throws(() => transitions.resolveTransition("hard-cut", { fs, fps: -1 }));
  });

  it("hard-cut resolves to cut with 0 frames", () => {
    const r = transitions.resolveTransition("hard-cut", { fs, fps: 30 });
    assert.equal(r.type, "cut");
    assert.equal(r.frames, 0);
    assert.equal(r.direction, undefined);
  });

  it("linear-wipe resolves to wipe with planar direction and in-band frames", () => {
    const r = transitions.resolveTransition("linear-wipe", { fs, fps: 30 });
    assert.equal(r.type, "wipe");
    assert.ok(["left", "right", "up", "down"].includes(r.direction));
    assert.ok(r.frames >= 8 && r.frames <= 18, `linear-wipe frames ${r.frames} out of band at 30fps`);
  });

  it("webgl flag attaches MIT glsl only", () => {
    const r = transitions.resolveTransition("luma-fade", { fs, fps: 30, webgl: true });
    assert.equal(r.glsl.name, "luma");
    assert.equal(r.glsl.license, "MIT");
    const r2 = transitions.resolveTransition("hard-cut", { fs, fps: 30, webgl: true });
    assert.equal(r2.glsl, undefined);
  });
});
