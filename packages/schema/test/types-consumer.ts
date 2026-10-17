// B1: proves the generated types are actually usable from TypeScript.
// Typechecked (not executed) by test/generated.test.mjs via `tsc --noEmit --strict`.
import type { Asset, Gen, PackageV1, Scene } from "../types.js";

const scene: Scene = {
  id: "s1",
  layout: "title",
  variant: "centered",
  preferredFrames: 150,
  copy: { headline: "Meet Comfyrizz", sub: "Generated-first motion graphics" },
  transitionOut: { type: "fade", frames: 15 },
};

// The generated-first fields must be reachable and correctly typed.
const svgAsset: Asset = {
  kind: "svg",
  origin: "generated",
  status: "ready",
  file: "assets/a_logo.svg",
  license: { id: "CC0-1.0" },
  redistributable: true,
  gen: {
    generator: "llm-svg",
    sanitizer_version: "1.0.0",
    render_check: { ok: true, rasterizer: "resvg" },
  },
};

const gen: Gen = svgAsset.gen as Gen;
export const checkOk: boolean | undefined = gen.render_check?.ok;

export const doc: PackageV1 = {
  schemaVersion: 1,
  revision: 1,
  id: "pkg_tscheck00001",
  title: "Typecheck package",
  format: { width: 1920, height: 1080, fps: 30 },
  duration: { mode: "target", targetFrames: 150 },
  scenes: [scene],
  assets: { a_logo: svgAsset },
  compliance: { open_weights_only: true },
};

// @ts-expect-error - the layout enum is closed
export const badLayout: Scene = { id: "s2", layout: "carousel" };

// @ts-expect-error - schemaVersion is the literal 1
export const badVersion: PackageV1 = { ...doc, schemaVersion: 2 };
