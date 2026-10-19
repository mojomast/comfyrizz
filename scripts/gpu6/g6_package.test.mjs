import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gpu6Package,
  writeGpu6Package,
  wavDurationSeconds,
  wavIsAudible,
  PORTRAIT_ASSET,
} from "./g6_package.mjs";
import { planJobs } from "../../packages/jobs/src/plan.mjs";

describe("G6-12 harness package", () => {
  it("is judgeable: audible narration, distinct music, non-nebula portrait", () => {
    const dir = mkdtempSync(join(tmpdir(), "g6-12-"));
    try {
      const pkg = writeGpu6Package(dir);
      const narr = join(dir, pkg.assets.a_narr.file);
      const music = join(dir, pkg.assets.a_music.file);
      const portrait = join(dir, pkg.assets[PORTRAIT_ASSET].file);
      assert.ok(wavDurationSeconds(narr) > 5, "narration longer than 5s");
      assert.ok(wavIsAudible(narr), "narration is audible");
      assert.notEqual(pkg.assets.a_narr.file, pkg.assets.a_music.file);
      assert.notEqual(pkg.assets.a_narr.sha256, pkg.assets.a_music.sha256);
      assert.equal(pkg.presenter.portrait, PORTRAIT_ASSET);
      assert.notEqual(pkg.presenter.portrait, "a_still");
      assert.match(readFileSync(portrait).subarray(0, 8).toString("hex"), /^89504e47/);
      const presenter = planJobs(pkg).jobs.find((j) => j.kind === "presenter");
      assert.ok(presenter, "presenter job planned");
      assert.equal(presenter.params.image, PORTRAIT_ASSET);
      assert.ok(presenter.params.frames >= 200, `presenter frames ${presenter.params.frames} track narration`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gpu6Package keeps the nebula still for backgrounds only", () => {
    const pkg = gpu6Package();
    assert.match(String(pkg.assets.a_still.gen.inputs.prompt), /nebula/i);
    assert.equal(pkg.presenter.portrait, PORTRAIT_ASSET);
  });
});
