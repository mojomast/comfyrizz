// SPW01: a plate job carries the shot metadata ref-watch chaining needs.
//
// Without `job.shot` the ref-watch controller's chainPlanFor never chains: it requires
// `isObject(video.shot)`. The planner adds the owning scene, the plate's 0-based position among
// that scene's plates, and a hard boundary only when the package asked for a cut. None of it may
// enter the cache key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planJobs, checkJobsDoc, cacheKeyFor } from "../src/index.mjs";

const SHA = "a".repeat(64);

function plateAsset(seed, extra = {}) {
  return {
    kind: "video",
    origin: "generated",
    status: "pending",
    gen: {
      generator: "ltx25",
      workflow: "workflows/ltx25_t2v_2stage.api.json",
      workflow_sha256: SHA,
      model: "ltx-2.5-22b-distilled",
      inputs: { width: 1024, height: 576, frames: 97, fps: 24, seed, prompt: `shot ${seed}` },
      ...extra,
    },
  };
}

function shotPackage() {
  return {
    schemaVersion: 1,
    revision: 1,
    id: "pkg_shot_meta",
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [
      { id: "s1", media: [{ asset: "p1" }, { asset: "p2" }] },
      { id: "s2", media: [{ asset: "p3" }] },
    ],
    assets: {
      p1: plateAsset(1),
      p2: plateAsset(2),
      p3: plateAsset(3),
      orphan: plateAsset(4),
    },
  };
}

function plateJobs(doc) {
  return Object.fromEntries(doc.jobs.filter((job) => job.kind === "plate").map((job) => [job.asset, job]));
}

test("plates in one scene get 0-based indexes, and a second scene starts at 0", () => {
  const plates = plateJobs(planJobs(shotPackage()));
  assert.deepEqual(plates.p1.shot, { sceneId: "s1", index: 0 });
  assert.deepEqual(plates.p2.shot, { sceneId: "s1", index: 1 });
  assert.deepEqual(plates.p3.shot, { sceneId: "s2", index: 0 });
});

test("gen.cut / gen.transition mark a hard boundary, and are omitted otherwise", () => {
  const pkg = shotPackage();
  pkg.assets.p1.gen.cut = true;
  pkg.assets.p2.gen.transition = "hard";
  const plates = plateJobs(planJobs(pkg));
  assert.equal(plates.p1.shot.cut, true);
  assert.equal(plates.p2.shot.cut, true);
  assert.equal("cut" in plates.p3.shot, false);
});

test("gen.chainFromPrevious is copied only when it is a boolean", () => {
  const pkg = shotPackage();
  pkg.assets.p1.gen.chainFromPrevious = false;
  pkg.assets.p2.gen.chainFromPrevious = true;
  const plates = plateJobs(planJobs(pkg));
  assert.equal(plates.p1.chainFromPreviousOverride, false);
  assert.equal(plates.p2.chainFromPreviousOverride, true);
  assert.equal("chainFromPreviousOverride" in plates.p3, false);
});

test("a plate with no owning scene gets no shot", () => {
  const doc = planJobs(shotPackage(), { assets: ["orphan"] });
  const orphan = doc.jobs.find((job) => job.asset === "orphan");
  assert.ok(orphan);
  assert.equal(orphan.shot, undefined);
});

test("shot metadata never enters the cache key or the plan hash", () => {
  const baseDoc = planJobs(shotPackage());
  const base = plateJobs(baseDoc);
  const pkg = shotPackage();
  pkg.assets.p1.gen.cut = true;
  pkg.assets.p1.gen.chainFromPrevious = true;
  const markedDoc = planJobs(pkg);
  const marked = plateJobs(markedDoc);
  assert.equal(marked.p1.cacheKey, base.p1.cacheKey);
  assert.equal(markedDoc.hash, baseDoc.hash);
  for (const [asset, job] of Object.entries(base)) {
    assert.equal(
      job.cacheKey,
      cacheKeyFor({
        workflowSha256: job.workflowSha256,
        generator: job.generator,
        model: job.model,
        modelRevision: job.modelRevision,
        params: job.params,
        seed: job.seed,
        width: job.dims.width,
        height: job.dims.height,
        frames: job.frames,
      }),
      `${asset}: cacheKey is over the job inputs, not the shot metadata`,
    );
  }
});

test("the doc validator accepts the optional shot fields", () => {
  const pkg = shotPackage();
  pkg.assets.p1.gen.cut = true;
  pkg.assets.p2.gen.chainFromPrevious = true;
  const doc = planJobs(pkg);
  assert.deepEqual(checkJobsDoc(doc), []);
});

test("SPW integration: consecutive scenes sharing `sequence` are shots of one story scene", () => {
  const pkg = {
    schemaVersion: 1, revision: 1, id: "pkg_sequence", format: { width: 1920, height: 1080, fps: 30 },
    scenes: [
      { id: "a1", sequence: "storm", background: { asset: "p1" } },
      { id: "a2", sequence: "storm", background: { asset: "p2" } },
      { id: "b1", sequence: "dawn", background: { asset: "p3" } },
      { id: "b2", sequence: "dawn", background: { asset: "p4" } },
      { id: "solo", background: { asset: "p5" } },
    ],
    assets: { p1: plateAsset(1), p2: plateAsset(2), p3: plateAsset(3), p4: plateAsset(4), p5: plateAsset(5),
      t: { kind: "image", origin: "generated", status: "pending", gen: { generator: "flux3-klein", workflow: "workflows/flux3_klein_t2i.api.json", workflow_sha256: SHA, model: "flux-3-image-klein", inputs: { prompt: "x", width: 1024, height: 576, seed: 1 } } } },
    titleCards: [{ asset: "t", text: "Title" }],
  };
  const plates = plateJobs(planJobs(pkg));
  assert.deepEqual(plates.p1.shot, { sceneId: "storm", index: 0 });
  assert.deepEqual(plates.p2.shot, { sceneId: "storm", index: 1 });
  assert.deepEqual(plates.p3.shot, { sceneId: "dawn", index: 0 });
  assert.deepEqual(plates.p4.shot, { sceneId: "dawn", index: 1 });
  assert.deepEqual(plates.p5.shot, { sceneId: "solo", index: 0 });
});
