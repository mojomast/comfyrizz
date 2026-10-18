// MS2: motion fields, the transition vocabulary and lintMotion().
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackage, applyDefaults, loadSchema, lintMotion, applyMotionFixes, autofixMotion, MOTION_VOCABULARY, MOTION_LINT_CODES, TRANSITIONS, ENERGY_TRANSITIONS } from "../src/index.mjs";
import { ENERGY_SCALES, STAGGER_STEP_SECONDS } from "../src/motion.mjs";
import { MOTION_CASES, caseDoc, motionBase } from "./motion-cases.mjs";
import * as tokens from "../../../apps/renderer/src/motion/index.js";
import * as primitives from "../../../apps/renderer/src/motion/primitives.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const pipelineDir = join(repo, "pipeline-py");
const defs = loadSchema().$defs;
const triple = (f) => [f.code, f.severity, f.scene];
const sorted = (list) => list.map((x) => JSON.stringify(x)).sort();

// ---------------------------------------------------------------- vocabulary alignment

test("the schema enums are the motion vocabulary", () => {
  assert.deepEqual(defs.easingToken.enum, MOTION_VOCABULARY.easing);
  assert.deepEqual(defs.springPreset.enum, MOTION_VOCABULARY.springs);
  assert.deepEqual(defs.motionEnergy.enum, MOTION_VOCABULARY.energies);
  assert.deepEqual(defs.motionDirection.enum, MOTION_VOCABULARY.directions);
  assert.deepEqual(defs.transitionType.enum, MOTION_VOCABULARY.transitionTypes);
  assert.deepEqual(defs.transitionDirection.enum, MOTION_VOCABULARY.transitionDirections);
  assert.deepEqual(defs.sceneMotion.properties.entry.enum, MOTION_VOCABULARY.entries);
  assert.deepEqual(defs.sceneMotion.properties.stagger.enum, MOTION_VOCABULARY.staggers);
  assert.deepEqual(defs.sceneMotion.properties.emphasis.enum, MOTION_VOCABULARY.emphasis);
  assert.deepEqual(Object.keys(TRANSITIONS), [...MOTION_VOCABULARY.transitionTypes]);
  for (const family of Object.values(ENERGY_TRANSITIONS)) for (const type of family) assert.ok(TRANSITIONS[type], type);
});

test("the vocabulary uses the renderer's MS1 token names exactly", () => {
  assert.deepEqual([...MOTION_VOCABULARY.easing].sort(), Object.keys(tokens.EASING_TOKENS).sort());
  assert.deepEqual([...MOTION_VOCABULARY.springs].sort(), Object.keys(tokens.SPRING_PRESETS).sort());
  assert.deepEqual([...MOTION_VOCABULARY.energies].sort(), Object.keys(tokens.ENERGY_PROFILES).sort());
  assert.deepEqual(MOTION_VOCABULARY.staggers.filter((s) => s !== "none").sort(), Object.keys(tokens.STAGGER_SECONDS).sort());
  // The MS1 entry primitives exist under the same names; waterfall and drawOn are MS3's to add.
  for (const name of ["fadeUp", "maskRise", "pop", "countUp"]) assert.equal(typeof primitives[name], "function", name);
  for (const [name, scales] of Object.entries(ENERGY_SCALES)) {
    assert.equal(scales.entryScale, tokens.ENERGY_PROFILES[name].entryScale);
    assert.equal(scales.staggerScale, tokens.ENERGY_PROFILES[name].staggerScale);
  }
  for (const [name, step] of Object.entries(tokens.STAGGER_SECONDS)) assert.equal(STAGGER_STEP_SECONDS[name], step);
  assert.equal(tokens.MAX_STAGGER_SECONDS, 0.5);
});

// ---------------------------------------------------------------- schema fields

test("motion fields validate and stay optional (backward compatible)", () => {
  const doc = motionBase();
  assert.equal(validatePackage(doc).valid, true, JSON.stringify(validatePackage(doc).errors));
  delete doc.motion;
  for (const scene of doc.scenes) {
    delete scene.motion;
    scene.transitionOut = { type: "wipe", frames: 12 };
  }
  assert.equal(validatePackage(doc).valid, true, "a package with no motion fields and an original transition type is still valid");
  for (const type of MOTION_VOCABULARY.transitionTypes) {
    doc.scenes[0].transitionOut = { type, frames: type === "cut" || type === "none" ? 0 : 12 };
    assert.equal(validatePackage(doc).schemaOk, true, type);
  }
});

test("the closed vocabulary rejects unknown names", () => {
  const cases = [
    ["transition direction", (d) => (d.scenes[0].transitionOut.direction = "sideways")],
    ["package energy", (d) => (d.motion.energy = "frantic")],
    ["package direction", (d) => (d.motion.direction = "in")],
    ["spring", (d) => (d.scenes[3].motion.spring = "wobbly")],
    ["stagger", (d) => (d.scenes[1].motion.stagger = "letter")],
    ["emphasis", (d) => (d.scenes[1].motion.emphasis = "loud")],
    ["empty highlight", (d) => (d.scenes[0].motion.highlight = "")],
    ["unknown scene motion key", (d) => (d.scenes[0].motion.duration = 12)],
  ];
  for (const [name, mutate] of cases) {
    const doc = motionBase();
    mutate(doc);
    assert.equal(validatePackage(doc).schemaOk, false, name);
  }
});

test("applyDefaults fills package motion only when the block is present", () => {
  const schema = loadSchema();
  const legacy = motionBase();
  delete legacy.motion;
  assert.equal("motion" in applyDefaults(legacy, schema), false, "no motion block is invented");
  const partial = motionBase();
  partial.motion = { energy: "high" };
  assert.deepEqual(applyDefaults(partial, schema).motion, { energy: "high", direction: "left" });
  const scene = applyDefaults(motionBase(), schema).scenes[1].motion;
  assert.deepEqual(scene, { entry: "fadeUp", stagger: "listItem" }, "scene motion has no schema defaults");
});

// ---------------------------------------------------------------- lintMotion

test("every shared case raises exactly its declared findings", () => {
  for (const c of MOTION_CASES) {
    const got = lintMotion(caseDoc(c), c.options).map(triple);
    assert.deepEqual(sorted(got), sorted(c.expect), c.name);
  }
});

test("findings are structured: code, severity, scene, path, message, autofix", () => {
  for (const c of MOTION_CASES) {
    for (const f of lintMotion(caseDoc(c), c.options)) {
      assert.equal(MOTION_LINT_CODES[f.code], f.severity, f.code);
      assert.ok(["error", "warning", "info"].includes(f.severity));
      assert.equal(f.source, "motion");
      assert.match(f.path, /^\//);
      assert.ok(f.message.length > 0);
      if (f.severity === "info") assert.equal(f.autofix, null, `${f.code} is advisory only`);
      else {
        assert.ok(f.autofix && f.autofix.description && f.autofix.ops.length > 0, `${f.code} (${c.name}) is auto-fixable`);
        for (const op of f.autofix.ops) assert.ok(["set", "delete"].includes(op.op));
      }
    }
  }
});

test("autofix clears every fixable finding and the result still validates", () => {
  for (const c of MOTION_CASES) {
    const doc = caseDoc(c);
    const before = JSON.stringify(doc);
    const { document, applied, remaining } = autofixMotion(doc, c.options ?? {});
    assert.equal(JSON.stringify(doc), before, `${c.name}: autofix is pure`);
    assert.equal(validatePackage(document).valid, true, `${c.name}: ${JSON.stringify(validatePackage(document).errors)}`);
    const fixable = remaining.filter((f) => f.severity !== "info");
    if (c.options?.timeline) {
      // A compiled timeline is input, not output: the fix lengthens preferredFrames, and the
      // finding goes once the timeline is recompiled from the fixed package.
      assert.equal(applied.length, 1);
      assert.deepEqual(lintMotion(document).filter((f) => f.severity !== "info"), []);
    } else {
      assert.deepEqual(fixable.map(triple), [], c.name);
    }
  }
});

test("specific autofixes do what they say", () => {
  const fixed = (name, opts) => autofixMotion(caseDoc(MOTION_CASES.find((c) => c.name === name)), opts).document;
  assert.equal(fixed("cut with frames").scenes[1].transitionOut.frames, 0);
  assert.equal(fixed("zoom going left").scenes[2].transitionOut.direction, "in");
  assert.equal(fixed("push going in").scenes[0].transitionOut.direction, "left", "the package current");
  assert.equal(fixed("zoom too slow").scenes[2].transitionOut.frames, 12, "0.4 s at 30 fps");
  assert.equal(fixed("push too fast").scenes[0].transitionOut.frames, 8, "0.25 s at 30 fps, rounded");
  assert.deepEqual(fixed("default fade out of band at 60 fps").scenes[0].transitionOut, { type: "fade", frames: 18 });
  assert.equal(fixed("direction on a fade").scenes[1].transitionOut.direction, undefined);
  assert.equal(fixed("direction ping-pong").scenes[1].transitionOut.direction, "left");
  assert.deepEqual(fixed("four transition types").scenes[4].transitionOut, { type: "push", frames: 15 });
  const heroes = fixed("two heroes").scenes.map((s) => s.motion?.emphasis);
  assert.deepEqual(heroes.filter((e) => e === "hero").length, 1);
  assert.equal(heroes[2], "hero", "the later hero is kept: build to it");
  assert.equal(fixed("elastic twice").scenes[3].motion.spring, "pop");
  assert.equal(fixed("linear entry").scenes[1].motion.ease, "enter");
  assert.equal(fixed("keyword without highlight").scenes[0].motion.emphasis, "none");
  const noCopy = fixed("highlight not in copy").scenes[0].motion;
  assert.equal(noCopy.highlight, undefined);
  assert.equal(noCopy.emphasis, "none");
  assert.equal(fixed("countUp without data").scenes[1].motion.entry, undefined);
  assert.ok(fixed("reading hold too short").scenes[1].preferredFrames > 90);
  assert.ok(fixed("final hold too short").scenes[3].preferredFrames > 60);
});

test("ping-pong fixes cascade across passes", () => {
  const doc = motionBase();
  const extra = structuredClone(doc.scenes[1]);
  extra.id = "s5";
  doc.scenes.splice(2, 0, extra);
  doc.scenes[0].transitionOut = { type: "push", frames: 12, direction: "left" };
  doc.scenes[1].transitionOut = { type: "push", frames: 12, direction: "right" };
  doc.scenes[2].transitionOut = { type: "push", frames: 12, direction: "left" };
  // left, right, left: the second is ping-pong; once it is fixed to left the third is fine.
  assert.deepEqual(lintMotion(doc).filter((f) => f.code === "MOTION_DIRECTION_PINGPONG").map((f) => f.scene), ["s2", "s5"]);
  const { document, remaining } = autofixMotion(doc);
  assert.deepEqual(document.scenes.slice(0, 3).map((s) => s.transitionOut.direction), ["left", "left", "left"]);
  assert.deepEqual(remaining.filter((f) => f.severity !== "info"), []);
});

test("applyMotionFixes honours the severity filter and reports what it applied", () => {
  const doc = caseDoc(MOTION_CASES.find((c) => c.name === "cut with frames"));
  const findings = lintMotion(doc);
  assert.deepEqual(applyMotionFixes(doc, findings, { severities: ["warning"] }).applied, []);
  const { document, applied } = applyMotionFixes(doc, findings);
  assert.deepEqual(applied.map((f) => f.code), ["MOTION_CUT_HAS_FRAMES"]);
  assert.equal(document.scenes[1].transitionOut.frames, 0);
});

test("lintMotion never throws on malformed input", () => {
  for (const doc of [null, 7, "x", [], {}, { scenes: "no" }, { scenes: [null, 3, { id: 9, motion: "x", transitionOut: { type: 4 } }] }, { scenes: [{ id: "s1", copy: { headline: 5, items: [1, "a b"] }, preferredFrames: 1.5 }] }]) {
    assert.ok(Array.isArray(lintMotion(doc)));
  }
});

test("validatePackage carries the motion report without changing validity", () => {
  const doc = caseDoc(MOTION_CASES.find((c) => c.name === "cut with frames"));
  const result = validatePackage(doc);
  assert.equal(result.valid, true);
  assert.deepEqual(result.motion.map((f) => f.code), ["MOTION_CUT_HAS_FRAMES"]);
});

test("the shipped examples and the valid corpus have no motion errors", () => {
  const files = readdirSync(join(here, "..", "fixtures", "valid")).map((f) => join(here, "..", "fixtures", "valid", f));
  const examples = join(repo, "examples");
  if (existsSync(examples)) {
    for (const dir of readdirSync(examples)) {
      const file = join(examples, dir, "package.json");
      if (existsSync(file)) files.push(file);
    }
  }
  for (const file of files) {
    const errors = lintMotion(JSON.parse(readFileSync(file, "utf8"))).filter((f) => f.severity === "error");
    assert.deepEqual(errors, [], file);
  }
});

test("the CLI reports motion findings in --json and as advisory lines", () => {
  const doc = caseDoc(MOTION_CASES.find((c) => c.name === "cut with frames"));
  const run = (...args) => spawnSync(process.execPath, [join(here, "..", "bin", "comfyrizz-validate.mjs"), ...args, "-"], { input: JSON.stringify(doc), encoding: "utf8" });
  const json = run("--json");
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).motion.map((f) => f.code), ["MOTION_CUT_HAS_FRAMES"]);
  const human = run();
  assert.equal(human.status, 0);
  assert.match(human.stdout, /motion error MOTION_CUT_HAS_FRAMES \/scenes\/1\/transitionOut\/frames .*\[autofix\]/);
});

// ---------------------------------------------------------------- TS <-> Python conformance

function findPython() {
  for (const candidate of [process.env.COMFYRIZZ_PYTHON, join(repo, ".venv", "bin", "python"), "python3"].filter(Boolean)) {
    if (spawnSync(candidate, ["-c", "import jsonschema"], { encoding: "utf8" }).status === 0) return candidate;
  }
  return null;
}
const python = findPython();

test("the Python lint_motion mirror agrees on every shared case", { skip: python ? false : "no python with jsonschema found" }, () => {
  const inputs = MOTION_CASES.map((c) => ({ name: c.name, doc: caseDoc(c), timeline: c.options?.timeline ?? null }));
  const script = [
    "import json, sys",
    "from comfyrizz_pipeline.motion_lint import lint_motion, autofix_motion",
    "cases = json.load(sys.stdin)",
    "out = [{'lint': lint_motion(c['doc'], timeline=c['timeline']), 'fixed': autofix_motion(c['doc'], timeline=c['timeline'])['document']} for c in cases]",
    "print(json.dumps(out))",
  ].join("\n");
  const run = spawnSync(python, ["-c", script], { cwd: pipelineDir, input: JSON.stringify(inputs), encoding: "utf8", env: { ...process.env, PYTHONPATH: pipelineDir }, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  const fromPython = JSON.parse(run.stdout);
  const shape = (f) => ({ code: f.code, severity: f.severity, scene: f.scene, path: f.path, autofix: f.autofix });
  inputs.forEach((input, i) => {
    const options = input.timeline ? { timeline: input.timeline } : {};
    assert.deepEqual(fromPython[i].lint.map(shape), lintMotion(input.doc, options).map(shape), input.name);
    assert.deepEqual(fromPython[i].fixed, JSON.parse(JSON.stringify(autofixMotion(input.doc, options).document)), `${input.name}: fixed document`);
  });
});
