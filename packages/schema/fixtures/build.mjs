#!/usr/bin/env node
// B1: build the invalid-fixture corpus and fixtures/manifest.json from the
// hand-written valid fixtures, so every negative case is one declared mutation of a
// known-good package and the expectation is stated up front (not derived from the
// implementation).
//
//   node fixtures/build.mjs           # write fixtures/invalid/*.json + manifest.json
//   node fixtures/build.mjs --check   # fail if the committed corpus is stale
//
// Ops: ["set", path, value] | ["del", path] | ["push", path, value]
// Paths are dot-separated, with array indices as numbers ("scenes.0.copy.headline").
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const VALID_DIR = join(here, "valid");
const INVALID_DIR = join(here, "invalid");
const MANIFEST = join(here, "manifest.json");
const INF_MARKER = "__COMFYRIZZ_INFINITY__";

/** Every invalid fixture: one declared rule violation over a valid base. */
export const MUTATIONS = [
  // H17: the presenter, and the audio-to-video jobs it is made of
  {
    name: "presenter-without-portrait",
    base: "generated-first",
    ops: [["set", "presenter", { enabled: true, scenes: "bookends" }]],
    expect: { schemaOk: true, semantic: ["SEM_PRESENTER_NO_PORTRAIT"] },
  },
  {
    name: "presenter-unknown-scene",
    base: "generated-first",
    ops: [["set", "presenter", { enabled: true, portrait: "a_cutout", scenes: ["s2", "s99"] }], ["set", "scenes.2.presenter", "pip"]],
    expect: { schemaOk: true, semantic: ["SEM_PRESENTER_UNKNOWN_SCENE"] },
  },
  {
    name: "a2v-without-audio",
    base: "generated-first",
    ops: [
      ["set", "presenter", { enabled: true, portrait: "a_cutout", scenes: "bookends" }],
      ["set", "assets.a_presenter", { kind: "video", origin: "generated", status: "pending", gen: { generator: "ltx25-a2v", inputs: { image: "a_cutout", frames: 97 } } }],
    ],
    expect: { schemaOk: true, semantic: ["SEM_A2V_NO_AUDIO"] },
  },
  {
    name: "a2v-audio-not-audio",
    base: "generated-first",
    ops: [
      ["set", "presenter", { enabled: true, portrait: "a_cutout", scenes: "bookends" }],
      ["set", "assets.a_presenter", { kind: "video", origin: "generated", status: "pending", gen: { generator: "ltx25-a2v", inputs: { image: "a_cutout", audio: "a_anim_bars", frames: 97 } } }],
    ],
    expect: { schemaOk: true, semantic: ["SEM_A2V_AUDIO_NOT_AUDIO"] },
  },
  {
    name: "a2v-audio-not-ready",
    base: "generated-first",
    ops: [
      ["set", "presenter", { enabled: true, portrait: "a_cutout", scenes: "bookends" }],
      ["set", "assets.a_presenter", {
      kind: "video",
      origin: "generated",
      status: "pending",
      gen: { generator: "ltx25-a2v", inputs: { image: "a_cutout", audio: "a_narr", frames: 97 } },
    }],
      ["set", "assets.a_narr.status", "pending"],
      ["del", "assets.a_narr.file"],
    ],
    expect: { schemaOk: true, semantic: ["SEM_A2V_AUDIO_NOT_READY"] },
  },
  {
    name: "duplicate-scene-id",
    base: "spec-6.3-example",
    ops: [["set", "scenes.0.id", "s1"], ["push", "scenes", { id: "s1", layout: "title", variant: "outro", preferredFrames: 120, copy: { headline: "Duplicate" } }]],
    expect: { schemaOk: true, semantic: ["SEM_DUPLICATE_SCENE_ID"] },
  },
  {
    name: "bad-scene-id-pattern",
    base: "generated-first",
    ops: [["set", "scenes.2.id", "x3"]],
    expect: { schemaOk: false, semantic: ["SEM_ID_PATTERN"] },
    schemaCodes: ["SCHEMA_PATTERN"],
  },
  {
    name: "bad-dataset-id-pattern",
    base: "generated-first",
    ops: [["set", "datasets.revenue", "datasets.d_revenue"], ["del", "datasets.d_revenue"]],
    expect: { schemaOk: false, semantic: ["SEM_ID_PATTERN", "SEM_REF_UNRESOLVED"] },
    schemaCodes: ["SCHEMA_PATTERN"],
  },
  {
    name: "unresolved-asset-ref",
    base: "spec-6.3-example",
    ops: [["del", "assets.a_hero"]],
    expect: { schemaOk: true, semantic: ["SEM_REF_UNRESOLVED"] },
  },
  {
    name: "unresolved-dataset-ref",
    base: "generated-first",
    ops: [["del", "datasets.d_revenue"]],
    expect: { schemaOk: true, semantic: ["SEM_REF_UNRESOLVED"] },
  },
  {
    name: "absolute-path",
    base: "spec-6.3-example",
    ops: [["set", "assets.a_logo.file", "/etc/comfyrizz/logo.svg"]],
    expect: { schemaOk: true, semantic: ["SEM_PATH_NOT_RELATIVE"] },
  },
  {
    name: "traversal-path",
    base: "spec-6.3-example",
    ops: [["set", "assets.a_plate1.file", "assets/../../outside.mp4"]],
    expect: { schemaOk: true, semantic: ["SEM_PATH_NOT_RELATIVE"] },
  },
  {
    name: "windows-path",
    base: "spec-6.3-example",
    ops: [["set", "assets.a_plate1.gen.workflow", "workflows\\\\ltx25_i2v.api.json"]],
    expect: { schemaOk: true, semantic: ["SEM_PATH_NOT_RELATIVE"] },
  },
  {
    name: "variant-same-file",
    base: "variants",
    ops: [["set", "assets.a_plate1.variants.upscaled.file", "assets/a_plate1.mp4"]],
    expect: { schemaOk: true, semantic: ["SEM_ASSET_VARIANT_SAME_FILE"] },
  },
  {
    name: "variant-not-bigger",
    base: "variants",
    ops: [["set", "assets.a_plate1.variants.upscaled.width", 512], ["set", "assets.a_plate1.variants.upscaled.height", 288]],
    expect: { schemaOk: true, semantic: ["SEM_ASSET_VARIANT_NOT_BIGGER"] },
  },
  {
    name: "variant-unknown-name",
    base: "variants",
    ops: [["del", "assets.a_plate1.variants.upscaled"], ["set", "assets.a_plate1.variants.bigger", { file: "assets/a_plate1@2x.mp4", width: 1920, height: 1080 }]],
    expect: { schemaOk: true, semantic: ["SEM_ASSET_VARIANT_NAME"] },
  },
  {
    name: "variant-without-a-file",
    base: "variants",
    ops: [
      ["del", "assets.a_plate1.file"],
      ["del", "assets.a_plate1.sha256"],
      ["set", "assets.a_plate1.status", "pending"],
    ],
    expect: { schemaOk: true, semantic: ["SEM_ASSET_VARIANT_NO_FILE"] },
  },
  {
    name: "variant-shape",
    base: "variants",
    ops: [["set", "assets.a_plate1.variants.upscaled", "assets/a_plate1@2x.mp4"]],
    expect: { schemaOk: false, semantic: ["SEM_ASSET_VARIANT_SHAPE"] },
    schemaCodes: ["SCHEMA_TYPE"],
  },
  {
    name: "variant-absolute-path",
    base: "variants",
    ops: [["set", "assets.a_plate1.variants.upscaled.file", "/tmp/a_plate1@2x.mp4"]],
    expect: { schemaOk: true, semantic: ["SEM_ASSET_VARIANT_PATH"] },
  },
  {
    name: "layout-variant",
    base: "generated-first",
    ops: [["set", "scenes.2.variant", "centered"]],
    expect: { schemaOk: true, semantic: ["SEM_LAYOUT_VARIANT"] },
  },
  {
    name: "chart-without-data",
    base: "generated-first",
    ops: [["del", "scenes.2.data"]],
    expect: { schemaOk: true, semantic: ["SEM_LAYOUT_REQUIRES_DATA"] },
  },
  {
    name: "title-without-headline",
    base: "minimal",
    ops: [["del", "scenes.0.copy.headline"]],
    expect: { schemaOk: true, semantic: ["SEM_COPY_REQUIRED"] },
  },
  {
    name: "copy-too-long",
    base: "minimal",
    ops: [["set", "scenes.0.copy.headline", "A headline that is far longer than this layout can render"]],
    expect: { schemaOk: true, semantic: ["SEM_COPY_TOO_LONG"] },
  },
  {
    name: "bullets-without-items",
    base: "generated-first",
    ops: [["del", "scenes.1.copy.items"]],
    expect: { schemaOk: true, semantic: ["SEM_COPY_REQUIRED"] },
  },
  {
    name: "non-commercial-license-redistributable",
    base: "spec-6.3-example",
    ops: [["set", "assets.a_hero.license.id", "CC-BY-NC-4.0"]],
    expect: { schemaOk: true, semantic: ["SEM_LICENSE_CONFLICT"] },
  },
  {
    name: "blocked-license-redistributable",
    base: "spec-6.3-example",
    ops: [
      ["set", "assets.a_hero.license.blocked", true],
      ["set", "assets.a_hero.license.blocked_reason", "rights filter: no licence found"],
    ],
    expect: { schemaOk: true, semantic: ["SEM_LICENSE_CONFLICT"] },
  },
  {
    name: "svg-missing-sanitizer",
    base: "minimal",
    ops: [["del", "assets.a_logo.gen.sanitizer_version"]],
    expect: { schemaOk: true, semantic: ["SEM_SVG_PROVENANCE"] },
  },
  {
    name: "render-check-failed",
    base: "minimal",
    ops: [["set", "assets.a_logo.gen.render_check.ok", false]],
    expect: { schemaOk: true, semantic: ["SEM_RENDER_CHECK_FAILED"] },
  },
  {
    name: "model-license-missing",
    base: "generated-first",
    ops: [["del", "assets.a_cutout.model_license"]],
    expect: { schemaOk: true, semantic: ["SEM_MODEL_LICENSE_MISSING"] },
  },
  {
    name: "ready-without-file",
    base: "minimal",
    ops: [["del", "assets.a_logo.file"]],
    expect: { schemaOk: true, semantic: ["SEM_READY_WITHOUT_FILE"] },
  },
  {
    name: "narration-blank",
    base: "spec-6.3-example",
    ops: [["set", "scenes.0.narration", "   "]],
    expect: { schemaOk: true, semantic: ["SEM_NARRATION_EMPTY"] },
  },
  {
    name: "voice-incomplete",
    base: "spec-6.3-example",
    ops: [["del", "voice.voice"]],
    expect: { schemaOk: true, semantic: ["SEM_VOICE_INCOMPLETE"] },
  },
  {
    name: "example-data-unapproved",
    base: "generated-first",
    ops: [["set", "datasets.d_revenue.approved", false]],
    expect: { schemaOk: true, semantic: ["SEM_DATASET_UNAPPROVED"] },
  },
  {
    name: "background-ambiguous",
    base: "spec-6.3-example",
    ops: [["set", "scenes.0.background.procedural", { pattern: "grid" }]],
    expect: { schemaOk: true, semantic: ["SEM_BACKGROUND_AMBIGUOUS"] },
  },
  {
    name: "cutout-on-audio",
    base: "generated-first",
    ops: [["set", "assets.a_narr.cutout", true]],
    expect: { schemaOk: true, semantic: ["SEM_CUTOUT_KIND"] },
  },
  {
    name: "generated-without-generator",
    base: "generated-first",
    ops: [["del", "assets.a_cutout.gen.generator"]],
    expect: { schemaOk: true, semantic: ["SEM_GEN_MISSING_GENERATOR"] },
  },
  {
    name: "generated-without-output-license",
    base: "spec-6.3-example",
    ops: [["del", "assets.a_plate1.license"]],
    expect: { schemaOk: true, semantic: ["SEM_LICENSE_MISSING"] },
  },
  {
    name: "duration-target-without-frames",
    base: "minimal",
    ops: [["del", "duration.targetFrames"]],
    expect: { schemaOk: true, semantic: ["SEM_DURATION_TARGET_REQUIRED"] },
  },
  {
    name: "flexible-over-ceiling",
    base: "generated-first",
    ops: [["set", "duration.targetFrames", 4000]],
    expect: { schemaOk: true, semantic: ["SEM_FLEXIBLE_OVER_CEILING"] },
  },
  {
    name: "extra-property",
    base: "spec-6.3-example",
    ops: [["set", "scenes.0.typography", "big"]],
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_UNEVALUATEDPROPERTIES"],
  },
  {
    name: "uppercase-sha256",
    base: "minimal",
    ops: [["set", "assets.a_logo.sha256", "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"]],
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_PATTERN"],
  },
  {
    name: "value-overflows-to-infinity",
    base: "spec-6.3-example",
    ops: [["set", "datasets.d_stars.values.0.value", Number.POSITIVE_INFINITY]],
    expect: { schemaOk: false, semantic: ["SEM_NUMBER_NOT_FINITE"] },
  },
  {
    name: "colab-backend-label",
    base: "spec-6.3-example",
    ops: [["set", "assets.a_plate1_still.gen.backend", "colab-g4"]],
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_PATTERN"],
  },
  // --- media layer (H-fix1, Pi's P-fix1 proposal) -------------------------------------
  {
    name: "media-only-without-media",
    base: "spec-6.3-example",
    ops: [
      ["set", "scenes.0.background", { procedural: { pattern: "gradient", palette: ["#0d0f14"] } }],
      ["set", "scenes.0.foreground", []],
      ["set", "scenes.0.media_only", true],
    ],
    expect: { schemaOk: true, semantic: ["SEM_MEDIA_ONLY_NO_MEDIA"] },
  },
  {
    name: "lower-third-blank",
    base: "spec-6.3-example",
    ops: [["set", "scenes.0.lower_third", { kicker: "Still", text: "   " }]],
    expect: { schemaOk: true, semantic: ["SEM_LOWER_THIRD_EMPTY"] },
  },
  {
    name: "lower-third-too-long",
    base: "spec-6.3-example",
    ops: [["set", "scenes.0.lower_third", { text: "x".repeat(121) }]],
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_MAXLENGTH"],
  },
  {
    name: "scrim-out-of-range",
    base: "spec-6.3-example",
    ops: [["set", "scenes.0.background.scrim", 1.4]],
    // background is a oneOf(null, $ref background), so ajv reports SCHEMA_MAXIMUM at the scrim
    // while jsonschema reports the enclosing SCHEMA_ONEOF. Only the code both produce is
    // declared here; the TS side still proves the bound itself in its own unit test.
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_ONEOF"],
  },
  {
    name: "text-colour-not-hex",
    base: "spec-6.3-example",
    ops: [["set", "theme.text", "white"]],
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_PATTERN"],
  },
  // --- motion (MS2): the vocabulary is closed, like the layouts -----------------------
  {
    name: "motion-unknown-transition",
    base: "generated-first",
    ops: [["set", "scenes.0.transitionOut", { type: "spin", frames: 12 }]],
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_ENUM"],
  },
  {
    name: "motion-unknown-entry",
    base: "generated-first",
    ops: [["set", "scenes.1.motion", { entry: "bounce" }]],
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_ENUM"],
  },
  {
    name: "motion-unknown-ease",
    base: "generated-first",
    ops: [["set", "scenes.1.motion", { entry: "fadeUp", ease: "easeInOutQuad" }]],
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_ENUM"],
  },
  {
    name: "motion-extra-property",
    base: "generated-first",
    ops: [["set", "motion", { energy: "high", tempo: 120 }]],
    expect: { schemaOk: false, semantic: [] },
    schemaCodes: ["SCHEMA_UNEVALUATEDPROPERTIES"],
  },
  {
    name: "split-without-media",
    base: "layout-pack-v2",
    ops: [["del", "scenes.0.media"]],
    expect: { schemaOk: true, semantic: ["SEM_LAYOUT_REQUIRES_MEDIA"] },
  },
  {
    name: "code-without-source",
    base: "layout-pack-v2",
    ops: [["del", "scenes.2.code"]],
    expect: { schemaOk: true, semantic: ["SEM_CODE_REQUIRED"] },
  },
];

/** Warnings each hand-written valid fixture is expected to raise (advisory only). */
const VALID_WARNINGS = {
  // H12: an x2 variant on the spec-6.3 plate; it inherits that fixture's unused dataset
  "variants.json": ["WARN_DATASET_UNUSED"],
  "minimal.json": [],
  "spec-6.3-example.json": ["WARN_DATASET_UNUSED"],
  "generated-first.json": [],
  "defaults-unfilled.json": [],
  "layout-pack-v2.json": [],
};

/** Derived valid fixtures (warnings are not errors). */
export const DERIVED_VALID = [
  {
    name: "warnings-unused-asset",
    base: "minimal",
    ops: [
      [
        "set",
        "assets.a_orphan",
        {
          kind: "image",
          origin: "generated",
          status: "pending",
          gen: { generator: "flux3-klein", workflow: "workflows/flux3_klein_t2i.api.json", caption: "unused" },
        },
      ],
    ],
    expect: { schemaOk: true, semantic: [], warnings: ["WARN_ASSET_UNUSED"] },
  },
  {
    // The media layer Pi's P-fix1 asked for: a scene that skips its layout, a scrim over the
    // media, a lower third, and text colours that do not come from palette[0].
    name: "media-layer",
    base: "spec-6.3-example",
    ops: [
      ["set", "scenes.0.background.scrim", 0.45],
      ["set", "scenes.0.media_only", true],
      [
        "set",
        "scenes.0.lower_third",
        { kicker: "FLUX 3 Klein on Google Colab", text: "Every plate in this scene was generated, not licensed." },
      ],
      ["set", "theme.text", "#f7f8fb"],
      ["set", "theme.text_muted", "#a9b0c0"],
      ["set", "theme.text_on_accent", "#0d0f14"],
    ],
    expect: { schemaOk: true, semantic: [], warnings: ["WARN_DATASET_UNUSED"] },
  },
  {
    // MS2: every motion field in use - package energy + current, per-scene presets, the one hero
    // moment, a keyword highlight, and directional transitions that obey the vector law.
    name: "motion-fields",
    base: "generated-first",
    ops: [
      ["set", "motion", { energy: "medium", direction: "left" }],
      ["set", "scenes.0.motion", { entry: "maskRise", ease: "enter", emphasis: "keyword", highlight: "one box" }],
      ["set", "scenes.0.transitionOut", { type: "push", frames: 12, direction: "left" }],
      ["set", "scenes.1.motion", { entry: "fadeUp", stagger: "listItem" }],
      ["set", "scenes.1.transitionOut", { type: "push", frames: 12, direction: "left" }],
      ["set", "scenes.2.motion", { entry: "countUp", ease: "move", emphasis: "hero", energy: "high" }],
      ["set", "scenes.2.transitionOut", { type: "zoom", frames: 9, direction: "out" }],
      ["set", "scenes.3.motion", { entry: "pop", spring: "settle" }],
      ["set", "scenes.3.transitionOut", { type: "cut", frames: 0 }],
    ],
    expect: { schemaOk: true, semantic: [], warnings: [] },
  },
];

function resolveParent(doc, path) {
  const parts = path.split(".");
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    const key = /^\d+$/.test(part) ? Number(part) : part;
    if (node[key] === undefined) throw new Error(`path does not exist: ${path} (at ${part})`);
    node = node[key];
  }
  return { parent: node, key: /^\d+$/.test(parts.at(-1)) ? Number(parts.at(-1)) : parts.at(-1) };
}

function applyOp(doc, [op, path, value]) {
  if (op === "set") {
    const { parent, key } = resolveParent(doc, path);
    parent[key] = cloneish(value);
  } else if (op === "del") {
    const { parent, key } = resolveParent(doc, path);
    if (parent[key] === undefined) throw new Error(`cannot delete missing path: ${path}`);
    delete parent[key];
  } else if (op === "push") {
    const { parent, key } = resolveParent(doc, path);
    if (!Array.isArray(parent[key])) throw new Error(`push target is not an array: ${path}`);
    parent[key].push(cloneish(value));
  } else {
    throw new Error(`unknown op: ${op}`);
  }
  return doc;
}

const cloneish = (v) =>
  v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v, (k, val) => (val === Infinity ? INF_MARKER : val)));

function render(doc) {
  const text = JSON.stringify(doc, (k, val) => (val === Infinity || val === Number.POSITIVE_INFINITY ? INF_MARKER : val), 2);
  // JSON.stringify turns Infinity into null; emit the bare 1e999 token instead so the
  // fixture is still parseable by both JSON.parse and Python's json module.
  return `${text.split(`"${INF_MARKER}"`).join("1e999")}\n`;
}

export function build() {
  const files = new Map();
  for (const mutation of MUTATIONS) {
    const doc = deepLoad(mutation.base);
    applyOp(doc, ["set", "id", `pkg_${mutation.name.replace(/[^A-Za-z0-9]/g, "")}`]);
    applyOp(doc, ["set", "revision", 1]);
    for (const op of mutation.ops) applyOp(doc, op);
    files.set(`invalid/${mutation.name}.json`, render(doc));
  }
  for (const derived of DERIVED_VALID) {
    const doc = deepLoad(derived.base);
    for (const op of derived.ops) applyOp(doc, op);
    files.set(`valid/${derived.name}.json`, render(doc));
  }
  const manifest = {
    version: 1,
    generatedBy: "packages/schema/fixtures/build.mjs",
    note: "sha256 values and dates in fixtures are synthetic; they exist to exercise the format, not to describe real files.",
    fixtures: [
      ...readdirSync(VALID_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => {
          const derived = DERIVED_VALID.find((d) => `${d.name}.json` === f);
          return {
            file: `valid/${f}`,
            kind: "valid",
            schemaOk: true,
            semantic: [],
            warnings: derived ? derived.expect.warnings : (VALID_WARNINGS[f] ?? []),
          };
        }),
      ...MUTATIONS.map((m) => ({
        file: `invalid/${m.name}.json`,
        kind: "invalid",
        schemaOk: m.expect.schemaOk,
        schemaCodes: m.schemaCodes || [],
        semantic: m.expect.semantic,
        warnings: null,
      })),
    ],
  };
  return { files, manifest };
}

function deepLoad(name) {
  return JSON.parse(readFileSync(join(VALID_DIR, `${name}.json`), "utf8"));
}

function main() {
  const check = process.argv.includes("--check");
  const { files, manifest } = build();
  const targets = [["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`], ...[...files.entries()].sort()];
  const stale = [];
  for (const [rel, content] of targets) {
    const abs = rel === "manifest.json" ? MANIFEST : join(here, rel);
    let current = null;
    try {
      current = readFileSync(abs, "utf8");
    } catch {
      current = null;
    }
    if (current === content) continue;
    if (check) stale.push(rel);
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      console.log(`wrote fixtures/${rel}`);
    }
  }
  if (check && stale.length) {
    console.error(`fixture corpus is stale (run node fixtures/build.mjs): ${stale.join(", ")}`);
    process.exit(1);
  }
  if (check) console.log(`fixture corpus up to date (${manifest.fixtures.length} fixtures)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
