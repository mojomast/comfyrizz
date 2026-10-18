// H12: an upscaled plate has two files, and the applied package has to say so in the shape the
// exporter reads: `assets.<id>.file` is the 1x plate, `assets.<id>.variants.upscaled` is the x2
// rendition (Pi's A9 prefers it for a 1920x1080 export, and falls back to the 1x file when it is
// absent). The size comes from the file the run measured (N4), never from the plan.
import assert from "node:assert/strict";
import test from "node:test";

import { applyManifestToPackage } from "../src/apply.mjs";
import { validatePackage } from "../../schema/src/index.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function pkg() {
  return {
    $schema: "https://comfyrizz.example/schema/package-v1.json",
    schemaVersion: 1,
    revision: 3,
    id: "pkg_h12_variants",
    title: "H12 variants",
    createdAt: "2026-10-17T00:00:00.000Z",
    format: { width: 1920, height: 1080, fps: 24 },
    duration: { mode: "flexible", flexibleCeilingFrames: 2700 },
    theme: { palette: ["#0d0f14", "#1b2440", "#6d8cff", "#e6e8ee"], font: "Inter" },
    voice: { enabled: false, engine: "none" },
    datasets: {},
    scenes: [
      {
        id: "s_plate",
        layout: "hero",
        variant: "split",
        preferredFrames: 97,
        copy: { headline: "Plate", sub: "One upscaled plate." },
        background: { procedural: { pattern: "grid", seed: 3 } },
        foreground: [{ asset: "a_plate1", x: 0.75, y: 0.5, w: 0.4, anim: "fade-in" }],
      },
    ],
    assets: {
      a_plate1: {
        kind: "video",
        origin: "generated",
        status: "pending",
        license: { id: "CC0-1.0" },
        model_license: { id: "LicenseRef-LTX-2.5" },
        redistributable: true,
        media: { width: 1024, height: 576, fps: 24, frames: 97 },
        gen: { generator: "ltx25", workflow: "workflows/ltx25_i2v_2stage.api.json", model: "ltx-2.5" },
      },
    },
    compliance: { open_weights_only: true, llm: { provider: "local-agent", model: "llm-svg", weights: "open" }, backends_used: [], closed_apis_used: [], warnings: [] },
  };
}

function jobsDoc() {
  return {
    v: 1,
    packageId: "pkg_h12_variants",
    jobs: [
      {
        id: "a_plate1.plate",
        kind: "plate",
        batch: "plates",
        asset: "a_plate1",
        output: "assets/a_plate1.mp4",
        outputKind: "video",
        dims: { width: 1024, height: 576 },
        frames: 97,
        fps: 24,
      },
      {
        id: "a_plate1.upscale",
        kind: "upscale",
        batch: "upscales",
        asset: "a_plate1",
        output: "assets/a_plate1@2x.mp4",
        outputKind: "video",
        variant: "upscaled",
        scale: 2,
        source: "assets/a_plate1.mp4",
        dims: { width: 1920, height: 1080 },
        frames: 97,
        fps: 24,
      },
    ],
  };
}

const baseEntry = {
  job: "a_plate1.plate",
  status: "succeeded",
  job_id: "job-plate-1",
  attempt_id: "att-plate-1",
  outputs: [{ file: "/work/out/assets/a_plate1.mp4", relative: "assets/a_plate1.mp4", sha256: SHA_A, bytes: 2048, measured: { width: 1024, height: 576, fps: 24, frames: 97, source: "header" } }],
};

const upscaleEntry = {
  job: "a_plate1.upscale",
  status: "succeeded",
  job_id: "job-up-1",
  attempt_id: "att-up-1",
  outputs: [{ file: "/work/out/assets/a_plate1@2x.mp4", relative: "assets/a_plate1@2x.mp4", sha256: SHA_B, bytes: 8192, measured: { width: 1920, height: 1080, fps: 24, frames: 97, source: "header" } }],
};

test("an upscale job lands as variants.upscaled and leaves the asset's own file alone", () => {
  const result = applyManifestToPackage(pkg(), {
    manifest: { updatedAt: "2026-10-17T20:00:00Z", jobs: [baseEntry, upscaleEntry] },
    jobsDoc: jobsDoc(),
    outDir: null,
    backend: "colab:G4",
  });

  const asset = result.package.assets.a_plate1;
  assert.equal(asset.status, "ready");
  // the plate is the asset's file, and its measured size is the asset's media
  assert.equal(asset.file, "assets/a_plate1.mp4");
  assert.equal(asset.sha256, SHA_A);
  assert.equal(asset.media.width, 1024);
  assert.equal(asset.media.height, 576);
  // the upscale is an alternate, with the size the file actually had
  assert.deepEqual(asset.variants, {
    upscaled: { file: "assets/a_plate1@2x.mp4", width: 1920, height: 1080, scale: 2, sha256: SHA_B, bytes: 8192 },
  });
  assert.equal(asset.gen.backend, "colab:G4");
  assert.deepEqual(result.untouched, []);
  assert.deepEqual(
    result.applied.map((entry) => `${entry.job}:${entry.variant ?? "file"}`),
    ["a_plate1.plate:file", "a_plate1.upscale:upscaled"],
  );
  assert.deepEqual(validatePackage(result.package).errors, []);
});

test("the measured size wins over the planned one", () => {
  // a 1.5x graph, and the file came out cropped to the project format: the metadata follows the file
  const result = applyManifestToPackage(pkg(), {
    manifest: {
      updatedAt: "2026-10-17T20:00:00Z",
      jobs: [
        baseEntry,
        { ...upscaleEntry, outputs: [{ ...upscaleEntry.outputs[0], measured: { width: 1536, height: 864, source: "ffprobe" } }] },
      ],
    },
    jobsDoc: jobsDoc(),
    outDir: null,
    backend: "colab:G4",
  });
  assert.equal(result.package.assets.a_plate1.variants.upscaled.width, 1536);
  assert.equal(result.package.assets.a_plate1.variants.upscaled.height, 864);
  assert.deepEqual(validatePackage(result.package).errors, []);
});

test("a variant with no base file is not attached, and says why", () => {
  const result = applyManifestToPackage(pkg(), {
    manifest: { updatedAt: "2026-10-17T20:00:00Z", jobs: [upscaleEntry] },
    jobsDoc: jobsDoc(),
    outDir: null,
    backend: "colab:G4",
  });
  const asset = result.package.assets.a_plate1;
  assert.equal(asset.variants, undefined);
  assert.equal(asset.file, undefined);
  assert.equal(asset.status, "pending");
  assert.equal(result.untouched.length, 1);
  assert.match(result.untouched[0].reason, /no base file yet/);
  assert.deepEqual(validatePackage(result.package).errors, []);
});

test("a variant whose size nobody knows is not guessed at", () => {
  const blind = { ...upscaleEntry, outputs: [{ ...upscaleEntry.outputs[0], measured: undefined }] };
  blind.outputs[0].relative = "assets/a_plate1@2x.mp4";
  const doc = jobsDoc();
  doc.jobs[1].dims = undefined; // no planned dims either
  const result = applyManifestToPackage(pkg(), {
    manifest: { updatedAt: "2026-10-17T20:00:00Z", jobs: [baseEntry, blind] },
    jobsDoc: doc,
    outDir: null,
    backend: "colab:G4",
  });
  assert.equal(result.package.assets.a_plate1.variants, undefined);
  assert.equal(result.untouched.length, 1);
  assert.match(result.untouched[0].reason, /size is unknown/);
  assert.deepEqual(validatePackage(result.package).errors, []);
});

test("a cached variant keeps its file and size too", () => {
  const cached = { ...upscaleEntry, status: "cached" };
  const result = applyManifestToPackage(pkg(), {
    manifest: { updatedAt: "2026-10-17T21:00:00Z", jobs: [baseEntry, cached] },
    jobsDoc: jobsDoc(),
    outDir: null,
    backend: "colab:G4",
  });
  assert.equal(result.package.assets.a_plate1.variants.upscaled.file, "assets/a_plate1@2x.mp4");
  assert.deepEqual(validatePackage(result.package).errors, []);
});
