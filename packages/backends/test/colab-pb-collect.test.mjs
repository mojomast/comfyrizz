// PB-COLLECT / PB02 collection half: outcome classification + verified live-preview promotion.
// Fake filesystem only — no Google Colab, no network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyCollectionOutcome,
  promoteVerifiedLivePreviews,
} from "../src/colab-backend.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("classifyCollectionOutcome: complete verified collect is generation_complete", () => {
  const outcome = classifyCollectionOutcome({
    manifest: {
      complete: true,
      jobs: [{ job: "j1", status: "succeeded" }],
    },
    verified: true,
    missing: [],
    problems: [],
  });
  assert.equal(outcome.status, "generation_complete");
  assert.equal(outcome.generationComplete, true);
  assert.equal(outcome.collectionComplete, true);
});

test("classifyCollectionOutcome: remote complete but local gaps is collection_incomplete", () => {
  const outcome = classifyCollectionOutcome({
    manifest: {
      complete: true,
      jobs: [
        { job: "j1", status: "succeeded" },
        { job: "j2", status: "succeeded" },
      ],
    },
    verified: false,
    missing: ["out/j2.mp4"],
    problems: ["missing out/j2.mp4"],
  });
  assert.equal(outcome.status, "collection_incomplete");
  assert.equal(outcome.generationComplete, true);
  assert.equal(outcome.collectionComplete, false);
});

test("classifyCollectionOutcome: promoted previews become partial_recovered", () => {
  const outcome = classifyCollectionOutcome({
    manifest: {
      complete: true,
      jobs: [
        { job: "j1", status: "succeeded" },
        { job: "j2", status: "succeeded" },
      ],
    },
    verified: false,
    missing: ["out/j2.mp4"],
    problems: ["missing out/j2.mp4"],
    previewPromoted: ["j1"],
  });
  assert.equal(outcome.status, "partial_recovered");
  assert.deepEqual(outcome.recoveredJobs, ["j1"]);
  assert.equal(outcome.generationComplete, true);
  assert.equal(outcome.collectionComplete, false);
});

test("promoteVerifiedLivePreviews: copies hash-verified preview bytes into final out", () => {
  const root = mkdtempSync(join(tmpdir(), "pb-collect-"));
  const previewDir = join(root, "live-previews");
  const finalOut = join(root, "out");
  mkdirSync(join(previewDir, "clips"), { recursive: true });
  const content = "preview-clip-bytes-v1";
  const digest = sha256(content);
  writeFileSync(join(previewDir, "clips", "dunk.mp4"), content);
  writeFileSync(
    join(previewDir, "manifest.preview.json"),
    JSON.stringify({
      v: 1,
      packageId: "pkg_pb",
      jobsHash: "planhash1",
      complete: false,
      jobs: [
        {
          job: "job_dunk",
          status: "succeeded",
          outputs: [
            {
              relative: "clips/dunk.mp4",
              sha256: digest,
              bytes: Buffer.byteLength(content),
            },
          ],
        },
        {
          job: "job_missing",
          status: "succeeded",
          outputs: [
            {
              relative: "clips/missing.mp4",
              sha256: sha256("nope"),
              bytes: 4,
            },
          ],
        },
      ],
    }),
  );

  const promoted = promoteVerifiedLivePreviews({
    previewDir,
    finalOut,
    jobsDoc: { packageId: "pkg_pb", hash: "planhash1" },
  });
  assert.deepEqual(promoted, ["job_dunk"]);
  assert.equal(existsSync(join(finalOut, "clips", "dunk.mp4")), true);
  assert.equal(readFileSync(join(finalOut, "clips", "dunk.mp4"), "utf8"), content);
  assert.equal(existsSync(join(finalOut, "clips", "missing.mp4")), false);
});

test("promoteVerifiedLivePreviews: refuses plan/package mismatch and bad hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "pb-collect-bad-"));
  const previewDir = join(root, "live-previews");
  const finalOut = join(root, "out");
  mkdirSync(previewDir, { recursive: true });
  writeFileSync(join(previewDir, "clip.mp4"), "bytes");
  writeFileSync(
    join(previewDir, "manifest.preview.json"),
    JSON.stringify({
      packageId: "pkg_a",
      jobsHash: "hash_a",
      jobs: [
        {
          job: "j1",
          status: "succeeded",
          outputs: [{ relative: "clip.mp4", sha256: sha256("other"), bytes: 5 }],
        },
      ],
    }),
  );
  assert.deepEqual(
    promoteVerifiedLivePreviews({
      previewDir,
      finalOut,
      jobsDoc: { packageId: "pkg_b", hash: "hash_a" },
    }),
    [],
  );
  assert.deepEqual(
    promoteVerifiedLivePreviews({
      previewDir,
      finalOut,
      jobsDoc: { packageId: "pkg_a", hash: "hash_a" },
    }),
    [],
  );
  assert.equal(existsSync(join(finalOut, "clip.mp4")), false);
});
