// IP58 / A25: a motion video reference may only reach a graph that really has a video slot.
//
// The shipped LTX i2v plate graph and the FastH3 Omni graph take a text prompt, an image (or two
// images) and, for FastH3, an audio file. Neither takes a video. Treating frame 0 of a reference
// clip as a start image is a different, explicit `image` input; it must never masquerade as motion
// transfer. So a plate that names a motion reference on a graph whose capability profile has no
// motion slot fails planning, and a graph that does have one receives only the documented excerpt
// derivative - never the raw upload - with its provenance and hashes in the cache key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  planJobs,
  checkJobsDoc,
  WORKFLOW_CAPABILITY_PROFILES,
  MOTION_REFERENCE_INPUT,
} from "../src/plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel) => JSON.parse(readFileSync(join(here, "fixtures", rel), "utf8"));

const LTX_WORKFLOW = "workflows/ltx25_i2v_2stage.api.json";
const FASTH3_WORKFLOW = "workflows/fasth3_omni_ref2va.api.json";
// Test-only capability profile. No shipped workflow declares a motion/video slot yet.
const FIXTURE_WORKFLOW = "workflows/test_motion_ref.api.json";
const FIXTURE_PROFILE = {
  [FIXTURE_WORKFLOW]: { generator: "ltx25", slots: { image: true, motion_reference: true } },
};

const ORIGINAL_SHA = "a".repeat(64);
const EXCERPT_SHA = "b".repeat(64);
const WORKFLOW_SHA = "c".repeat(64);

// Captured from the planner at the pre-IP58 baseline for fixtures/package-pending.json. The literal
// is deliberate: a package with no motion reference must keep a byte-identical cache key, not one
// that a changed implementation happens to agree with itself about.
const GOLDEN_NO_MOTION = {
  "a_cutout.still": "1a96b4358ffb7ce9631246ea7ba62715df3435475b7df572c7750cba743380b4",
  "a_plate1_still.still": "d151fb1ae63f2c534a2634c9b7d127c0efa33ce3f37047599cd89cc4947e91a1",
  "a_plate1.plate": "ec2f8632ab503e4b7fab9fe372f8906bee1e70b68fec5bd8c13293ddccc3df6f",
  "a_plate1.upscale": "4154882a940388d528103611b06c75ee2d4c0a363c85e2384a20b0e7ffbed7a5",
  "a_narr.audio": "728ace3192217249dc8dc5984863dd2ad95b4e3cc239e577cee02ecb84f4806a",
};

function motionPackage({
  workflow = FIXTURE_WORKFLOW,
  inSeconds = 1.25,
  outSeconds = 4.25,
  fps = 24,
  audio = "muted",
  withStartImage = true,
} = {}) {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_motion_source = {
    kind: "video",
    origin: "stock",
    status: "ready",
    file: "assets/motion-source.mp4",
    sha256: ORIGINAL_SHA,
    media: { width: 1280, height: 720, fps: 30, durationSeconds: 8, audio: "present", codec: "h264" },
  };
  pkg.assets.a_motion_excerpt = {
    kind: "video",
    origin: "upload",
    status: "ready",
    file: "assets/motion-source.excerpt.mp4",
    sha256: EXCERPT_SHA,
    media: { width: 1280, height: 720, fps: 24, durationSeconds: 3, audio: "muted", codec: "h264" },
    source: { provider: "repo", id: "a_motion_source", original_file: "assets/motion-source.mp4" },
  };
  const gen = pkg.assets.a_plate1.gen;
  gen.workflow = workflow;
  gen.workflow_sha256 = WORKFLOW_SHA;
  if (!withStartImage) delete gen.inputs.image;
  gen.inputs.motion_reference = "a_motion_excerpt";
  gen.inputs.motion_reference_in = inSeconds;
  gen.inputs.motion_reference_out = outSeconds;
  gen.inputs.motion_reference_fps = fps;
  gen.inputs.motion_reference_audio = audio;
  return pkg;
}

const jobOf = (doc, id) => doc.jobs.find((job) => job.id === id);

test("the input name is one documented name, and no shipped workflow claims a motion slot", () => {
  assert.equal(MOTION_REFERENCE_INPUT, "motion_reference");
  for (const workflow of [LTX_WORKFLOW, FASTH3_WORKFLOW]) {
    const profile = WORKFLOW_CAPABILITY_PROFILES[workflow];
    assert.ok(profile, `${workflow} has a capability profile`);
    assert.equal(profile.slots.motion_reference, false, `${workflow} has no video slot`);
  }
  assert.equal(WORKFLOW_CAPABILITY_PROFILES[FIXTURE_WORKFLOW], undefined, "the video-slot profile is test-only");
});

test("the shipped LTX i2v plate refuses a motion reference even when it also has a start image", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_plate1.gen.workflow = LTX_WORKFLOW;
  pkg.assets.a_plate1.gen.inputs.motion_reference = "a_motion_excerpt";
  assert.throws(
    () => planJobs(pkg),
    (error) => {
      assert.match(error.message, /PLAN_MOTION_REFERENCE_UNSUPPORTED/);
      assert.match(error.message, /a_plate1/);
      assert.match(error.message, new RegExp(LTX_WORKFLOW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(error.message, /motion reference|video slot/i);
      return true;
    },
  );
});

test("a fully described motion reference is still refused on the shipped LTX graph", () => {
  assert.throws(
    () => planJobs(motionPackage({ workflow: LTX_WORKFLOW })),
    /PLAN_MOTION_REFERENCE_UNSUPPORTED[\s\S]*a_motion_excerpt[\s\S]*ltx25_i2v_2stage/,
  );
});

test("a graph whose profile declares the motion slot uploads only the excerpt derivative", () => {
  const doc = planJobs(motionPackage(), { workflowCapabilities: FIXTURE_PROFILE });
  const plate = jobOf(doc, "a_plate1.plate");

  const motions = plate.fileInputs.filter((entry) => entry.param === "motion_reference");
  assert.deepEqual(motions, [
    { param: "motion_reference", from: "package", path: "assets/motion-source.excerpt.mp4" },
  ]);
  assert.ok(
    !plate.fileInputs.some((entry) => entry.path === "assets/motion-source.mp4"),
    "the raw original is never a file input",
  );
  assert.equal(plate.params.motion_reference, undefined, "the planner control is not a node param");
  for (const name of ["motion_reference_in", "motion_reference_out", "motion_reference_fps", "motion_reference_audio"]) {
    assert.equal(plate.params[name], undefined, `${name} stays out of the graph params`);
  }

  assert.deepEqual(plate.motionReference.original, {
    asset: "a_motion_source",
    sha256: ORIGINAL_SHA,
    file: "assets/motion-source.mp4",
  });
  assert.deepEqual(plate.motionReference.excerpt, {
    asset: "a_motion_excerpt",
    file: "assets/motion-source.excerpt.mp4",
    sha256: EXCERPT_SHA,
  });
  assert.deepEqual(plate.motionReference.source, { inSeconds: 1.25, outSeconds: 4.25, fps: 24 });
  assert.equal(plate.motionReference.audio, "muted");
  assert.deepEqual(
    plate.motionReference.transformations.map((entry) => entry.op),
    ["trim", "fps", "audio"],
    JSON.stringify(plate.motionReference.transformations),
  );
  assert.deepEqual(checkJobsDoc(doc), []);
});

test("an explicit start image is independent of the motion reference and both are planned", () => {
  const doc = planJobs(motionPackage({ withStartImage: true }), { workflowCapabilities: FIXTURE_PROFILE });
  const plate = jobOf(doc, "a_plate1.plate");
  assert.ok(plate.fileInputs.some((entry) => entry.param === "image" && entry.job === "a_plate1_still.still"));
  assert.ok(plate.fileInputs.some((entry) => entry.param === "motion_reference"));
});

test("the cache key carries both hashes and every excerpt parameter", () => {
  const keyOf = (pkg) =>
    jobOf(planJobs(pkg, { workflowCapabilities: FIXTURE_PROFILE }), "a_plate1.plate").cacheKey;

  const base = keyOf(motionPackage());
  assert.notEqual(keyOf(motionPackage({ inSeconds: 1.5 })), base, "source in is part of the key");
  assert.notEqual(keyOf(motionPackage({ outSeconds: 4.0 })), base, "source out is part of the key");
  assert.notEqual(keyOf(motionPackage({ fps: 30 })), base, "excerpt fps is part of the key");
  assert.notEqual(keyOf(motionPackage({ audio: "none" })), base, "audio policy is part of the key");

  const otherExcerpt = motionPackage();
  otherExcerpt.assets.a_motion_excerpt.sha256 = "d".repeat(64);
  assert.notEqual(keyOf(otherExcerpt), base, "the excerpt sha256 is part of the key");

  const otherOriginal = motionPackage();
  otherOriginal.assets.a_motion_source.sha256 = "e".repeat(64);
  assert.notEqual(keyOf(otherOriginal), base, "the original sha256 is part of the key");
});

test("a package without a motion reference keeps its literal baseline cache keys", () => {
  const doc = planJobs(fixture("package-pending.json"));
  for (const [id, expected] of Object.entries(GOLDEN_NO_MOTION)) {
    assert.equal(jobOf(doc, id).cacheKey, expected, id);
    assert.equal(jobOf(doc, id).motionReference, undefined, id);
  }
});

test("asset.frames and asset.derivatives are not alias fallbacks for a motion reference", () => {
  const pkg = fixture("package-pending.json");
  pkg.assets.a_plate1.frames = ["assets/extracted-frame-0.png"];
  pkg.assets.a_plate1.derivatives = { motion: "assets/motion-source.excerpt.mp4" };
  const plate = jobOf(planJobs(pkg), "a_plate1.plate");

  assert.equal(plate.motionReference, undefined);
  assert.equal(plate.fileInputs.some((entry) => entry.param === "motion_reference"), false);
  assert.equal(plate.cacheKey, GOLDEN_NO_MOTION["a_plate1.plate"]);
});

test("an excerpt that is the raw original is refused, not uploaded", () => {
  const pkg = motionPackage();
  pkg.assets.a_motion_excerpt.file = pkg.assets.a_motion_source.file;
  pkg.assets.a_motion_excerpt.sha256 = pkg.assets.a_motion_source.sha256;
  assert.throws(
    () => planJobs(pkg, { workflowCapabilities: FIXTURE_PROFILE }),
    /PLAN_MOTION_REFERENCE_(?:EXCERPT|RAW|INVALID)/,
  );
});
