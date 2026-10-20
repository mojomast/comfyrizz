// M14: look-quality score tests.
//
// Fixtures are hand-written and small: a package that follows its recipe exactly, a package
// that ignores the recipe and falls back to fade + fadeUp everywhere, and a recipe whose
// palette is too low-contrast to read.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { contrastRatio, LOOK_SCORE_WEIGHTS, relativeLuminance, scoreLook } from "./look-score.mjs";

const MODULE_URL = new URL("./look-score.mjs", import.meta.url);

function perfectRecipe() {
  return {
    schema: "comfyrizz.recipe/v1",
    id: "test-grid",
    label: "Test grid",
    taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "grotesk" },
    palette: [
      { role: "background", hex: "#f2f0eb" },
      { role: "text", hex: "#111111" },
      { role: "accent", hex: "#e3241b" },
      { role: "muted", hex: "#6b6b6b" },
    ],
    fonts: { display: "space-grotesk", text: "inter" },
    easing: { personality: "editorial", entry: "enter", exit: "exit", spring: "settle" },
    entries: ["maskRise", "fadeUp", "waterfall", "pop", "drawOn"],
    emphasis: ["keyword", "hero"],
    transitions: { primary: "wipe", accent: ["push", "cut"] },
    storyRecipe: "kinetic",
    background: { pattern: "grid" },
    finish: [{ id: "paper-grain" }, { id: "vignette-soft" }],
    rules: { do: ["flush-left headlines"], dont: ["centered text"] },
    prompt: "A strict grid poster with a red accent on cream paper.",
  };
}

function perfectPackage() {
  return {
    schemaVersion: 1,
    id: "pkg_perfect0001",
    title: "Perfect",
    format: { width: 1920, height: 1080, fps: 30 },
    theme: {
      palette: ["#f2f0eb", "#111111", "#e3241b"],
      font: "Space Grotesk",
      text: "#111111",
      text_muted: "#6b6b6b",
    },
    motion: { energy: "medium", direction: "left" },
    scenes: [
      {
        id: "s1",
        layout: "title",
        preferredFrames: 180,
        copy: { headline: "One grid" },
        background: { procedural: { pattern: "grid" } },
        transitionOut: { type: "wipe", frames: 12, direction: "left" },
        motion: { entry: "maskRise", ease: "enter", spring: "settle", recipe: "kinetic" },
      },
      {
        id: "s2",
        layout: "list",
        variant: "bullets",
        preferredFrames: 240,
        copy: { headline: "Three rules", items: ["flush left", "one accent", "no shadows"] },
        background: { procedural: { pattern: "grid" } },
        transitionOut: { type: "push", frames: 12, direction: "left" },
        motion: { entry: "fadeUp", ease: "enter", emphasis: "keyword", highlight: "flush left", recipe: "kinetic" },
      },
      {
        id: "s3",
        layout: "hero",
        preferredFrames: 210,
        copy: { headline: "Big number" },
        background: { procedural: { pattern: "grid" } },
        transitionOut: { type: "cut", frames: 0 },
        motion: { entry: "waterfall", ease: "enter", emphasis: "hero", recipe: "kinetic" },
      },
      {
        id: "s4",
        layout: "stat",
        preferredFrames: 270,
        copy: { headline: "Twelve" },
        background: { procedural: { pattern: "grid" } },
        transitionOut: { type: "wipe", frames: 12, direction: "left" },
        motion: { entry: "pop", ease: "enter", spring: "settle", recipe: "kinetic" },
      },
      {
        id: "s5",
        layout: "title",
        variant: "outro",
        preferredFrames: 150,
        copy: { headline: "Comfyrizz" },
        background: { procedural: { pattern: "grid" } },
        motion: { entry: "drawOn", ease: "enter", spring: "settle", recipe: "kinetic" },
      },
    ],
  };
}

/** The look that ignores its recipe: every scene fades in and fades out the same way. */
function flatRecipe() {
  return {
    schema: "comfyrizz.recipe/v1",
    id: "test-poster",
    label: "Test poster",
    taxonomy: { era: "modernist", finish: "raw", energy: "high", geometry: "flat", type: "condensed" },
    palette: [
      { role: "background", hex: "#0d0d0d" },
      { role: "text", hex: "#f5f5f5" },
      { role: "accent", hex: "#ff5a1f" },
      { role: "muted", hex: "#3a3a3a" },
    ],
    fonts: { display: "bebas-neue", text: "inter" },
    easing: { personality: "snappy", entry: "enter", exit: "exit", spring: "snap" },
    entries: ["pop", "maskRise", "waterfall"],
    emphasis: ["keyword", "hero"],
    transitions: { primary: "push", accent: ["zoom", "cut"] },
    storyRecipe: "kinetic",
    background: { pattern: "gradient" },
    finish: [{ id: "grain-fine" }, { id: "motion-smear" }],
    rules: { do: ["big type"], dont: ["small type"] },
    prompt: "A loud poster with huge condensed type on black.",
  };
}

function flatPackage() {
  const scenes = ["a", "b", "c", "d", "e"].map((id, index) => ({
    id,
    layout: "title",
    preferredFrames: 150,
    copy: { headline: `Frame ${index + 1}` },
    background: { procedural: { pattern: "grid" } },
    transitionOut: index < 4 ? { type: "fade", frames: 15 } : undefined,
    motion: { entry: "fadeUp", ease: "enter", spring: "settle", emphasis: "none" },
  }));
  return {
    schemaVersion: 1,
    id: "pkg_flat0000001",
    title: "Flat",
    format: { width: 1920, height: 1080, fps: 30 },
    theme: { palette: ["#0d0d0d", "#f5f5f5", "#ff5a1f"], font: "Bebas Neue", text: "#f5f5f5" },
    motion: { energy: "medium", direction: "left" },
    scenes,
  };
}

function frameQaReport(severity, code, sceneId) {
  return {
    ok: false,
    checked: 150,
    findings: [
      {
        severity,
        code,
        frame: 42,
        timeSeconds: 1.4,
        sceneId,
        message: `a ${severity} was found in ${sceneId}`,
      },
    ],
  };
}

test("a package that follows its recipe scores at least 90", () => {
  const result = scoreLook(perfectPackage(), perfectRecipe());
  assert.ok(result.score >= 90, `expected >= 90, got ${result.score}`);
  assert.equal(result.score, Math.round(Object.values(result.parts).reduce((sum, value) => sum + value, 0)));
  for (const [key, weight] of Object.entries(LOOK_SCORE_WEIGHTS)) {
    assert.ok(result.parts[key] >= 0 && result.parts[key] <= weight, `${key} out of range`);
  }
  assert.equal(result.parts.adherence, LOOK_SCORE_WEIGHTS.adherence);
  assert.equal(result.parts.qa, LOOK_SCORE_WEIGHTS.qa);
});

test("an all-fade, all-fadeUp package scores below 60 and reports a variety problem", () => {
  const result = scoreLook(flatPackage(), flatRecipe());
  assert.ok(result.score < 60, `expected < 60, got ${result.score}`);
  const variety = result.findings.filter((item) => item.part === "variety");
  assert.ok(variety.length > 0, "expected a variety finding");
  assert.ok(variety.some((item) => item.code === "VARIETY_LOW_ENTROPY"));
  assert.ok(result.parts.variety < LOOK_SCORE_WEIGHTS.variety * 0.5);
});

test("a low-contrast palette is reported", () => {
  const recipe = perfectRecipe();
  recipe.palette = [
    { role: "background", hex: "#f2f0eb" },
    { role: "text", hex: "#9a9a9a" },
    { role: "accent", hex: "#e3241b" },
    { role: "muted", hex: "#9a9a9a" },
  ];
  const pkg = perfectPackage();
  pkg.theme = { palette: ["#f2f0eb", "#9a9a9a", "#e3241b"], font: "Space Grotesk", text: "#9a9a9a", text_muted: "#9a9a9a" };
  const result = scoreLook(pkg, recipe);
  const finding = result.findings.find((item) => item.code === "CONTRAST_LOW");
  assert.ok(finding, "expected a low-contrast finding");
  assert.equal(finding.part, "contrast");
  assert.ok(result.parts.contrast < LOOK_SCORE_WEIGHTS.contrast * 0.8);
});

test("frame-qa errors lower the score and name the scene", () => {
  const pkg = perfectPackage();
  const recipe = perfectRecipe();
  const clean = scoreLook(pkg, recipe);
  const withErrors = scoreLook(pkg, recipe, { frameQa: frameQaReport("error", "QA_FLASH", "s3") });
  assert.ok(withErrors.score < clean.score, `${withErrors.score} should be below ${clean.score}`);
  assert.ok(withErrors.parts.qa < clean.parts.qa);
  const finding = withErrors.findings.find((item) => item.code === "QA_FLASH");
  assert.ok(finding, "expected the frame-qa finding to be carried over");
  assert.equal(finding.scene, "s3");
});

test("frame-qa warnings lower the score less than frame-qa errors", () => {
  const pkg = perfectPackage();
  const recipe = perfectRecipe();
  const warned = scoreLook(pkg, recipe, { frameQa: frameQaReport("warning", "QA_STATIC", "s2") });
  const errored = scoreLook(pkg, recipe, { frameQa: frameQaReport("error", "QA_FLASH", "s2") });
  assert.ok(warned.score > errored.score);
});

test("the score is deterministic and the package is not mutated", () => {
  const pkg = perfectPackage();
  const before = JSON.stringify(pkg);
  const first = scoreLook(pkg, perfectRecipe());
  const second = scoreLook(pkg, perfectRecipe());
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(pkg), before);
});

test("the module is pure: no clock, no randomness, no filesystem", () => {
  const source = readFileSync(MODULE_URL, "utf8");
  assert.ok(!source.includes("Math.random"), "no Math.random");
  assert.ok(!/from\s+["']node:fs["']/.test(source), "no node:fs import");
  assert.ok(!/Date\.now|new Date\(/.test(source), "no clock");
});

test("a package without scenes cannot score, and missing inputs are reported", () => {
  const empty = scoreLook({ scenes: [] }, perfectRecipe());
  assert.ok(empty.score < 70);
  assert.ok(empty.findings.some((item) => item.code === "ADHERENCE_NO_SCENES"));
  const broken = scoreLook(null, null);
  assert.equal(broken.score, 0);
  assert.equal(broken.findings[0].code, "SCORE_INPUT");
});

test("WCAG helpers agree with the published ratios", () => {
  assert.equal(relativeLuminance("#ffffff"), 1);
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(Math.round(contrastRatio("#111111", "#f2f0eb")), 17);
});
