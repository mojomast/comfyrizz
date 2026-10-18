// R1: the quality gate from the JS side - the run record carries the gate's verdict over the assets
// that run produced, and the gate never takes a run down with it.
//
// The gate itself is python (`python -m eval.gate`); these tests drive the real thing with the
// project's venv, because the wiring is exactly the part that a stub could hide.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { DEFAULT_GATE_COMMAND, runPackage, runQualityGate } from "../src/run-package.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PYTHON = process.env.COMFYRIZZ_PYTHON || join(REPO, ".venv", "bin", "python");
const STILL_SIZE = { width: 96, height: 64 };

/**
 * A real `llm-svg` asset's `gen` block, taken from an example package.
 *
 * The schema has opinions about what a generated SVG records (generator, sanitizer version, render
 * check), and a test that invents its own would drift from them.
 */
const ICON_GEN = JSON.parse(readFileSync(join(REPO, "examples", "launch-demo", "package.json"), "utf8")).assets.a_icon_check.gen;

/**
 * A flat two-block still, in the theme's own colours, written with the project's python.
 *
 * Flat value blocks are what the palette check is for (research section 1.2 tells the agent to author
 * the SVG that way); a photographed render would fail a palette comparison without anything being
 * wrong.
 */
function flatStill(path, left = "#0d0f14", right = "#6d8cff") {
  mkdirSync(dirname(path), { recursive: true });
  const script = [
    "import sys",
    "from PIL import Image, ImageDraw",
    "image = Image.new('RGB', (96, 64))",
    "draw = ImageDraw.Draw(image)",
    "draw.rectangle((0, 0, 47, 63), fill=sys.argv[2])",
    "draw.rectangle((48, 0, 95, 63), fill=sys.argv[3])",
    "image.save(sys.argv[1])",
  ].join("\n");
  const wrote = spawnSync(PYTHON, ["-c", script, path, left, right], { encoding: "utf8" });
  assert.equal(wrote.status, 0, `could not write ${path}: ${wrote.stderr}`);
  return path;
}

function packageWith(assets, format, palette = ["#0d0f14", "#6d8cff", "#f4f6fb"]) {
  return {
    $schema: "https://comfyrizz.example/schema/package-v1.json",
    schemaVersion: 1,
    revision: 1,
    id: "pkg_r1_gate",
    title: "R1 gate",
    createdAt: "2026-10-18T00:00:00.000Z",
    format: { ...format, fps: 24 },
    duration: { mode: "flexible", flexibleCeilingFrames: 2700 },
    theme: { palette: [...palette], font: "Inter" },
    voice: { enabled: false, engine: "none" },
    datasets: {},
    scenes: [
      {
        id: "s1",
        layout: "title",
        variant: "centered",
        preferredFrames: 97,
        copy: { headline: "R1 gate" },
        background: { procedural: { pattern: "grid", seed: 1 } },
      },
    ],
    assets,
    compliance: {
      open_weights_only: true,
      llm: { provider: "local-agent", model: "llm-svg", weights: "open" },
      backends_used: [],
      closed_apis_used: [],
      warnings: [],
    },
  };
}

test("the gate judges a run's own produced file and passes it when it matches the plan (R1)", (t) => {
  if (!existsSync(PYTHON)) return t.skip(`no project python at ${PYTHON}`);
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-r1-gate-"));
  const outDir = join(work, "out");
  mkdirSync(join(outDir, "assets"), { recursive: true });
  flatStill(join(outDir, "assets", "a_city.png"));
  const size = STILL_SIZE;

  // the command the app runs is `python -m eval.gate` with the project's own interpreter: the gate
  // needs numpy, PIL and jsonschema (eval imports the pipeline's schema module), none of which the
  // system python has - which is exactly why `COMFYRIZZ_PYTHON` exists and why this is passed here
  const gateCommand = [PYTHON, "-m", "eval.gate"];
  const honest = ["#0d0f14", "#6d8cff"];

  // a package that describes the file it produced: the palette is the file's own, and the size it
  // records is the size the file has
  const good = runQualityGate({
    package: packageWith(
      { a_city: { kind: "svg", file: "assets/a_city.png", media: { width: size.width, height: size.height } } },
      size,
      honest,
    ),
    outDir,
    gateCommand,
  });
  assert.equal(good.ran, true, JSON.stringify(good));
  assert.equal(good.ok, true, JSON.stringify(good.failures));
  assert.equal(good.judged, 1);
  assert.ok(good.assets.a_city, Object.keys(good.assets).join(","));

  // the same file, described wrongly: a palette it is not, and a size it is not
  const wrong = runQualityGate({
    package: packageWith(
      { a_city: { kind: "svg", file: "assets/a_city.png", media: { width: size.width + 64, height: size.height } } },
      size,
      ["#ff0000", "#00ff00"],
    ),
    outDir,
    gateCommand,
  });
  assert.equal(wrong.ok, false);
  const codes = wrong.failures.map((failure) => failure.code);
  assert.ok(codes.includes("GATE_PALETTE_DRIFT"), JSON.stringify(codes));
  assert.ok(codes.includes("GATE_STILL_ASSET_DIMS"), JSON.stringify(codes));

  // and a file the package names but the run never produced is named too
  const missing = runQualityGate({
    package: packageWith({ a_ghost: { kind: "svg", file: "assets/a_ghost.png" } }, size),
    outDir,
    gateCommand,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.failures.map((failure) => failure.code), ["GATE_ASSET_MISSING"]);
});

test("a gate that cannot run is reported, not thrown (R1)", () => {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-r1-gate-bad-"));
  const outDir = join(work, "out");
  mkdirSync(outDir, { recursive: true });
  const pkg = packageWith({}, { width: 100, height: 100 });

  const disabled = runQualityGate({ package: pkg, outDir, gateCommand: null });
  assert.deepEqual(disabled, { ok: null, ran: false, detail: "the quality gate is disabled for this run" });

  const missingPython = runQualityGate({ package: pkg, outDir, gateCommand: ["definitely-not-a-python", "-m", "eval.gate"] });
  assert.equal(missingPython.ran, false);
  assert.equal(missingPython.ok, null);
  assert.match(missingPython.detail, /did not run/);
});

test("runPackage records the gate's verdict and never fails the run for it (R1)", async () => {
  const calls = [];
  const backend = {
    id: "colab",
    async describe() {
      return { label: "stub", costVisibility: "none" };
    },
    async ensureUp() {
      calls.push("ensureUp");
      return { state: "created", session: "comfyrizz-r1", hardware: "G4" };
    },
    async health() {
      return { ok: true, detail: "stub" };
    },
    async run() {
      calls.push("run");
      return { manifest: { complete: true, counts: { succeeded: 1 }, jobs: [{ job: "a_city.still", status: "succeeded", outputs: [] }] } };
    },
    async appliedBackendId() {
      return "colab:G4";
    },
    async teardown() {
      return { state: "stopped", evidence: "stub" };
    },
  };
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-r1-run-"));
  const outDir = join(work, "out");
  mkdirSync(join(outDir, "assets"), { recursive: true });
  flatStill(join(outDir, "assets", "a_city.png"));
  const size = STILL_SIZE;
  const pkg = packageWith(
    {
      a_city: {
        kind: "svg",
        origin: "generated",
        status: "pending",
        gen: ICON_GEN,
        file: "assets/a_city.png",
        media: { width: size.width, height: size.height },
      },
    },
    size,
    ["#0d0f14", "#6d8cff"],
  );
  const phases = [];

  // with the gate: the record carries its verdict, and the run's own phases still end in teardown
  const ran = await runPackage(backend, pkg, {
    workDir: work,
    outDir,
    approved: true,
    gateCommand: [PYTHON, "-m", "eval.gate"],
    onEvent: (event) => {
      if (event.event === "run_phase") phases.push(event.phase);
    },
  });
  assert.ok(ran.gate, "the run record has no gate verdict");
  assert.equal(ran.gate.ran, true, JSON.stringify(ran.gate));
  assert.equal(phases.includes("gated"), true, phases.join(","));
  assert.equal(phases.at(-1), "teardown", phases.join(","));

  // without it: no verdict claimed, and the run is unaffected
  const quiet = await runPackage(backend, pkg, { workDir: work, outDir, approved: true, gateCommand: null });
  assert.equal(quiet.gate, null);
  assert.equal(quiet.ok, true);
});

test("the gate's command is the pipeline's own module (R1)", () => {
  assert.equal(DEFAULT_GATE_COMMAND[1], "-m");
  assert.equal(DEFAULT_GATE_COMMAND[2], "eval.gate");
  // and it exists where the gate is spawned from
  assert.equal(existsSync(join(REPO, "pipeline-py", "eval", "gate.py")), true);
});
