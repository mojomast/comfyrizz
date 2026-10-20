// Q-H2/G6-14a: a *dangling* workflows symlink must not stop the harness from writing its package.
//
// The first fix called lstatSync without importing it, so the catch swallowed a ReferenceError, decided
// the link was absent, and symlinkSync threw EEXIST - which is the failure that put G6-13 back to todo
// while the dry run itself passed. This test makes the dangling link the *only* unusual thing.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeGpu6Package } from "../../../scripts/gpu6/g6_package.mjs";

test("a dangling workflows symlink is re-pointed at this repo, not left dangling (G6-14a)", () => {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-qh2-symlink-"));
  const workflows = join(dir, "workflows");
  // the link exists but its target does not: existsSync follows the link and says false. Left alone, the
  // bundle then ships with no workflow files at all, which is a failed run rather than a failed link.
  symlinkSync(join(dir, "does-not-exist"), workflows);
  assert.equal(existsSync(workflows), false, "the fixture is a dangling link");
  assert.ok(lstatSync(workflows), "but the entry itself is there");

  const pkg = writeGpu6Package(dir);
  assert.equal(pkg.id, "pkg_gpu6run0001");
  assert.ok(existsSync(workflows), "the link resolves after the write");
  const entries = readdirSync(workflows);
  assert.ok(entries.includes("ltx25_a2v_2stage.api.json"), `the graphs are reachable: ${entries.slice(0, 4).join(", ")}`);
});

test("a missing workflows symlink is created (G6-14a)", () => {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-qh2-fresh-"));
  mkdirSync(join(dir, "empty"));
  const fresh = join(dir, "empty");
  writeGpu6Package(fresh);
  assert.ok(lstatSync(join(fresh, "workflows")), "the link is made when there is none");
});
