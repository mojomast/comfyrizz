// H18/G6-1: a bundle the runtime would refuse is refused here, before the session is paid for.
//
// The real run spent 0.14 units discovering this: jobs.zip was 646 MB of repository because packageDir
// defaulted to the process's cwd, and the runtime answered with a 400 that said only "Bad Request".
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertBundleSize, BUNDLE_MAX_BYTES } from "../src/colab-backend.mjs";

function bundleOfSize(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-h18-bundle-"));
  const path = join(dir, "jobs.zip");
  // sparse: the size is what is under test, not 130 MB of disk
  closeSync(openSync(path, "w"));
  truncateSync(path, bytes);
  return path;
}

test("a bundle over the ceiling is refused, with its size and where to look (G6-1)", () => {
  const path = bundleOfSize(BUNDLE_MAX_BYTES + 2 * 1024 * 1024);
  assert.throws(
    () => assertBundleSize(path, { packageDir: "/home/box/comfyrizz" }),
    (error) => {
      assert.match(error.message, /over the 128 MB ceiling/);
      assert.match(error.message, /130 MB/);
      assert.match(error.message, /packageDir is \/home\/box\/comfyrizz/);
      return true;
    },
  );
});

test("a bundle at the ceiling passes, and its size comes back (G6-1)", () => {
  const path = bundleOfSize(BUNDLE_MAX_BYTES);
  assert.equal(assertBundleSize(path, { packageDir: "/tmp/pkg" }), BUNDLE_MAX_BYTES);
});

test("the real harness bundle is nowhere near the ceiling (G6-1)", () => {
  // the dry run's bundle was 83 KB with 16 entries; this is the size that made the point
  assert.ok(BUNDLE_MAX_BYTES >= 32 * 1024 * 1024, "the ceiling has to leave room for a package's own files");
  const path = bundleOfSize(83 * 1024);
  assert.equal(assertBundleSize(path, { packageDir: null }), 83 * 1024);
  writeFileSync(join(tmpdir(), "comfyrizz-h18-bundle-check.txt"), "ok\n");
});
