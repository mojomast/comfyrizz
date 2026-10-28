// B1 acceptance: the committed generated artifacts (types.ts, the fixture corpus) really
// are generated, and the generated types really do compile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../scripts/gen-types.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

test("types.ts is byte-identical to a fresh generation (it is generated, not hand-written)", () => {
  const committed = readFileSync(join(pkgDir, "types.ts"), "utf8");
  assert.equal(committed, generate());
  assert.match(committed, /GENERATED FILE - do not edit by hand/);
  for (const name of ["PackageV1", "Asset", "Scene", "Gen", "License", "ModelLicense", "Media", "Copy", "Background"]) {
    assert.match(committed, new RegExp(`export interface ${name}\\b`), `${name} missing from types.ts`);
  }
});

test("the generated types carry the generated-first fields", () => {
  const types = readFileSync(join(pkgDir, "types.ts"), "utf8");
  assert.match(types, /kind: "image" \| "video" \| "audio" \| "svg" \| "vector-anim"/);
  assert.match(types, /generator\?: "llm-svg" \| "procedural-audio" \| "flux3-klein" \| "ltx25" \| "ltx25-a2v" \| "fasth3-omni" \| "kokoro" \| "qwen3-tts"/);
  assert.match(types, /sanitizer_version\?: string/);
  assert.match(types, /render_check\?: \{/);
  assert.match(types, /cutout\?: boolean/);
});

test("the generated types compile under tsc --strict (types.ts and a real consumer)", () => {
  const tsc = spawnSync(
    join(pkgDir, "node_modules", ".bin", "tsc"),
    ["--noEmit", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", "types.ts", "test/types-consumer.ts"],
    { cwd: pkgDir, encoding: "utf8" },
  );
  assert.equal(tsc.status, 0, `tsc failed:\n${tsc.stdout}\n${tsc.stderr}`);
});

test("the fixture corpus is byte-identical to a fresh build", () => {
  const run = spawnSync(process.execPath, [join(pkgDir, "fixtures", "build.mjs"), "--check"], {
    cwd: repoOf(pkgDir),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /fixture corpus up to date/);
});

function repoOf(dir) {
  return join(dir, "..", "..");
}
