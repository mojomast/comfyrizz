// H18/G6-5: the staged Hugging Face token file must not outlive the run.
//
// The first real Google Colab run left a 0600 copy of the token under /tmp, because the staging helper
// returned a cleanup that the entry point never called. These tests hold both halves: the helper's
// cleanup removes the file, and a whole fakes-only run of the entry point leaves nothing behind.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { stageFakeToken, stageToken } from "../../../scripts/gpu6/g6_run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "..", "..", "..", "scripts", "gpu6", "g6_run.mjs");

/** Every /tmp directory the staging helpers leave, by the prefix they use. */
function stagedDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("comfyrizz-g6-token-") || name.startsWith("comfyrizz-g6-faketoken-"));
}

test("staging a token from a 0600 file is undone by its own cleanup (G6-5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-g6-source-"));
  const source = join(dir, "hf-token");
  writeFileSync(source, "hf_source_token_value\n", { mode: 0o600 });
  chmodSync(source, 0o600);

  const staged = stageToken(source);
  assert.ok(staged.path, staged.error ?? "the token should stage");
  assert.ok(existsSync(staged.path), "the staged copy is where the backend reads it");
  assert.equal(statSync(staged.path).mode & 0o777, 0o600, "and it is 0600 like the source");
  staged.cleanup();
  assert.equal(existsSync(staged.path), false, "cleanup removes it");
});

test("a token file that is not 0600 is refused rather than copied (G6-5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-g6-loose-"));
  const source = join(dir, "hf-token");
  writeFileSync(source, "hf_source_token_value\n", { mode: 0o644 });
  chmodSync(source, 0o644);
  const staged = stageToken(source);
  assert.equal(staged.path, null);
  assert.match(staged.error, /0600/);
});

const PIPELINE_PYTHON = process.env.COMFYRIZZ_PYTHON || null;

test("a whole fakes-only run leaves no staged token behind (G6-5)", (t) => {
  // the child run starts the fake Comfy server with the pipeline's python; without one, the run never
  // gets as far as staging a token and the assertion would be about the environment, not the cleanup
  if (!PIPELINE_PYTHON) return t.skip("no pipeline python (set COMFYRIZZ_PYTHON)");
  const before = new Set(stagedDirs());
  const out = mkdtempSync(join(tmpdir(), "comfyrizz-g6-runout-"));
  const run = spawnSync(process.execPath, [RUN, "--fake", "--no-render", "--out", out], { encoding: "utf8", timeout: 300000 });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  // the run is allowed to fail for reasons that are not this test's business (the fake VM's manifest is
  // still a stub); what it may not do is leave the token behind
  assert.match(output, /(PASS|FAIL) token-file/, "the run got as far as staging a token");

  const leaked = stagedDirs().filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], `a staged token directory survived the run: ${leaked.join(", ")}`);
  assert.match(output, /PASS token-cleaned/, `the run has to say the staged token is gone:\n${output.slice(-1200)}`);
});

test("the fake staging path cleans up too (G6-5)", () => {
  const staged = stageFakeToken();
  const content = readFileSync(staged.path, "utf8");
  assert.match(content, /fake_token/, "the fake token is a value that is obviously not a secret");
  staged.cleanup();
  assert.equal(existsSync(staged.path), false);
});
