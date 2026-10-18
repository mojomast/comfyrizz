// R1 (M7): the motion-role defaults on the i2v path.
//
// Measured, not taste: the overnight GPU run (EXAMPLES.md) found LTX-2.5 i2v ignoring a "static,
// locked-off camera" prompt and pushing in on the UI, diagram and flow plates at strength 0.7-0.9
// with 145 frames. Redos at strength 1.0, 97 frames and an explicit "the frame and framing never
// change" sentence held the board, flow and farm plates. So a plate that declares a static role gets
// those three, and the plan says it applied them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { planJobs } from "../src/index.mjs";
import { FRAMING_LOCK, STATIC_ROLE_FRAMES, STATIC_ROLE_STRENGTH, STATIC_MOTION_ROLES } from "../src/defaults.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel) => JSON.parse(readFileSync(join(here, "fixtures", rel), "utf8"));

/** The pending fixture's plate, optionally with a motion role and a frame count. */
function platePackage({ role = null, frames = null, strength = null, text = false, upscale = false } = {}) {
  const pkg = fixture("package-pending.json");
  const inputs = pkg.assets.a_plate1.gen.inputs;
  if (role) inputs.role = role;
  if (frames !== null) inputs.frames = frames;
  if (strength !== null) inputs.strength = strength;
  if (text) inputs.text = true;
  if (upscale) inputs.upscale = true;
  return pkg;
}

const jobOf = (doc, id) => doc.jobs.find((job) => job.id === id);

test("a static-role plate gets strength 1.0, 97 frames and the framing sentence", () => {
  const doc = planJobs(platePackage({ role: "diagram" }));
  const plate = jobOf(doc, "a_plate1.plate");

  assert.equal(plate.params.strength, STATIC_ROLE_STRENGTH);
  assert.equal(plate.params.frames, STATIC_ROLE_FRAMES);
  assert.equal(plate.frames, 97);
  assert.match(plate.params.prompt, new RegExp(FRAMING_LOCK));
  // the role is a planner control: the LTX params map does not declare it, and an unmapped param is
  // refused on the VM (GPU test 3, N1)
  assert.equal("role" in plate.params, false, JSON.stringify(plate.params));
});

test("every static role behaves the same, and the role itself costs nothing", () => {
  for (const role of STATIC_MOTION_ROLES) {
    const plate = jobOf(planJobs(platePackage({ role })), "a_plate1.plate");
    assert.equal(plate.params.strength, 1, role);
    assert.equal(plate.params.frames, 97, role);
  }
});

test("a hero plate keeps the graph's own strength and is not held still", () => {
  const plate = jobOf(planJobs(platePackage({ role: "hero", frames: 145 })), "a_plate1.plate");

  assert.equal(plate.params.strength, undefined, "the graph's 0.7 stays the default for a moving shot");
  assert.equal(plate.params.frames, 145, "no role means no 4 s default");
  assert.doesNotMatch(plate.params.prompt, new RegExp(FRAMING_LOCK));
});

test("the package's own strength and frame count win", () => {
  const keep = jobOf(planJobs(platePackage({ role: "ui", strength: 0.7, frames: 145 })), "a_plate1.plate");

  assert.equal(keep.params.strength, 0.7, "an explicit strength is the package's decision");
  assert.equal(keep.params.frames, 145);
  assert.match(keep.params.prompt, new RegExp(FRAMING_LOCK), "the framing sentence is still added");
});

test("a long static-role plate is planned, and warned about", () => {
  const doc = planJobs(platePackage({ role: "ui", frames: 145 }));

  assert.equal(jobOf(doc, "a_plate1.plate").params.frames, 145);
  const warning = doc.warnings.find((w) => w.code === "PLAN_STATIC_ROLE_LONG");
  assert.ok(warning, JSON.stringify(doc.warnings));
  assert.match(warning.message, /97 frames/);
});

test("a plate whose first frame carries labels is held still even with no role", () => {
  const plate = jobOf(planJobs(platePackage({ text: true })), "a_plate1.plate");

  assert.match(plate.params.prompt, new RegExp(FRAMING_LOCK));
  assert.equal("strength" in plate.params, false, "no role means no strength default: only the frame is locked");
});

test("a prompt that already locks the framing is not given the sentence twice", () => {
  const pkg = platePackage({ role: "diagram" });
  pkg.assets.a_plate1.gen.inputs.prompt = `A calm diagram. ${FRAMING_LOCK}.`;
  const plate = jobOf(planJobs(pkg), "a_plate1.plate");

  const occurrences = plate.params.prompt.split(FRAMING_LOCK).length - 1;
  assert.equal(occurrences, 1, plate.params.prompt);
});

test("the finals pass inherits the held frame, because it copies the plate's params", () => {
  const doc = planJobs(platePackage({ role: "chart", upscale: true }));
  const up = jobOf(doc, "a_plate1.upscale");

  assert.equal(up.params.strength, 1);
  assert.equal(up.params.frames, 97);
  assert.match(up.params.prompt, new RegExp(FRAMING_LOCK));
});

test("the LTX params maps actually declare the strength knobs", () => {
  // a param the params map does not declare never reaches the graph, so the plan would lie: the
  // strength would be recorded and the graph would keep its own 0.7
  for (const name of ["ltx25_i2v_2stage.api.params.json", "ltx25_i2v_2stage.upscale.params.json"]) {
    const params = JSON.parse(readFileSync(join(here, "..", "..", "..", "workflows", name), "utf8"));
    assert.deepEqual(params.map.strength, ["33", "strength"], name);
    assert.deepEqual(params.map.stage2_strength, ["34", "strength"], name);
  }
});
