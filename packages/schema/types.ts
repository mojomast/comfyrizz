// GENERATED FILE - do not edit by hand.
//
// Source:        packages/schema/package-v1.schema.json
// Schema sha256: ee596d97c3c756e9a08ca69c4d614a65b606445a286fb523fbd1f94e56a77c70
// Generator:     packages/schema/scripts/gen-types.mjs (v1.0.0)
//
// Regenerate: pnpm --filter @comfyrizz/schema gen:types
// CI check:   pnpm --filter @comfyrizz/schema check:types
// TypeScript: tsc --noEmit --strict types.ts must stay green.

export const SCHEMA_ID = "https://comfyrizz.example/schema/package-v1.json" as const;
export const SCHEMA_VERSION = 1 as const;
export interface PackageV1 {
  /**
   * Documentation URL of the schema this document was written against. Deliberately not checked as a
   * URI: the scaffolded placeholder in SPEC.md 6.3 is a literal example and must be filled in before
   * release.
   * [minLength 1, maxLength 512]
   */
  $schema?: string;
  /**
   * Version of the comfyrizz.package schema this document conforms to.
   */
  schemaVersion: 1;
  /**
   * Monotonic package revision. Bumped by every accepted edit; a later render must record the
   * revision it used.
   * [min 1, max 1000000]
   */
  revision: number;
  /**
   * Stable package id. Google Colab session names are derived from it (comfyrizz-<id>).
   * [pattern ^pkg_[A-Za-z0-9_-]{4,64}$]
   */
  id: string;
  title: NonEmptyString;
  createdAt?: string;
  format: {
    width: number;
    height: number;
    fps: 24 | 25 | 30 | 50 | 60;
    };
  duration: {
    mode: "target" | "flexible";
    /**
     * Required for mode target. Integer frames at format.fps.
     * [min 1, max 108000]
     */
    targetFrames?: number;
    minFrames?: number;
    maxFrames?: number;
    /**
     * Documented ceiling of flexible mode (SPEC.md 6.8, PLAN.md A2).
     */
    flexibleCeilingFrames?: 2700;
    };
  theme?: {
    palette?: Array<HexColor>;
    font?: string;
    fonts?: Array<{
      family: NonEmptyString;
      file: RelativePath;
      weight?: number;
      license?: License;
      }>;
    logo_asset?: AssetId;
    };
  voice?: {
    enabled: boolean;
    engine?: "kokoro" | "none";
    voice?: string;
    speed?: number;
    language?: string;
    };
  datasets?: {
    [key: string]: Dataset;
    };
  scenes: Array<Scene>;
  assets: {
    [key: string]: Asset;
    };
  compliance: {
    open_weights_only: boolean;
    llm?: {
      provider: NonEmptyString;
      model: NonEmptyString;
      weights: "open" | "closed" | "unknown";
      };
    backends_used?: Array<string>;
    closed_apis_used?: Array<NonEmptyString>;
    warnings?: Array<NonEmptyString>;
    };
  renders?: Array<{
    mode: "preview" | "draft" | "final";
    file: RelativePath;
    revision: number;
    timeline_sha256?: Sha256Hex;
    frames?: number;
    width?: number;
    height?: number;
    fps?: 24 | 25 | 30 | 50 | 60;
    at?: string;
    }>;
  }

/**
 * [minLength 1, maxLength 4096]
 */
export type NonEmptyString = string;

/**
 * [pattern ^#([0-9a-fA-F]{6})$]
 */
export type HexColor = string;

/**
 * Repository-relative POSIX path. Absolute paths, traversal, backslashes, drive letters and ~ are
 * rejected by the semantic validator so the failure message can name the offending form.
 * [minLength 1, maxLength 512]
 */
export type RelativePath = string;

/**
 * Lowercase hex sha256. Uppercase is rejected on purpose: hashes are compared byte-for-byte across
 * the manifest and the package.
 * [pattern ^[a-f0-9]{64}$]
 */
export type Sha256Hex = string;

/**
 * [pattern ^a[A-Za-z0-9_-]{0,63}$]
 */
export type AssetId = string;

/**
 * [pattern ^s[A-Za-z0-9_-]{0,63}$]
 */
export type SceneId = string;

/**
 * [pattern ^d[A-Za-z0-9_-]{0,63}$]
 */
export type DatasetId = string;

/**
 * [min 0, max 1]
 */
export type Number01 = number;

/**
 * [min -4, max 4]
 */
export type UnitFloat = number;

export interface License {
  id: NonEmptyString;
  url?: string;
  attribution?: string;
  approved_by_user?: boolean;
  approved_at?: string;
  /**
   * Set when a rights filter refused the asset (NC/ND/unknown). Blocked assets must not ship.
   * [default false]
   */
  blocked?: boolean;
  blocked_reason?: string;
  }

export interface ModelLicense {
  id: NonEmptyString;
  url?: string;
  commercial_ok_if?: string;
  note?: string;
  }

export interface Dataset {
  unit: string;
  label?: string;
  values: Array<{
    label: string;
    value: number;
    }>;
  /**
   * example means invented placeholder numbers: they must be approved before a final render can cite
   * them.
   */
  source: "user" | "openverse" | "example" | "derived";
  approved?: boolean;
  source_url?: string;
  retrieved_at?: string;
  note?: string;
  }

export interface Copy {
  headline?: string;
  kicker?: string;
  sub?: string;
  body?: string;
  quote?: string;
  attribution?: string;
  footnote?: string;
  cta?: string;
  /**
   * Bullet lines for the list layout.
   * [maxItems 6]
   */
  items?: Array<string>;
  }

export interface Background {
  asset?: AssetId;
  procedural?: {
    pattern: "gradient" | "grid" | "dots" | "grain" | "mesh";
    seed?: number;
    palette?: Array<HexColor>;
    };
  fit?: "cover" | "contain";
  loop?: boolean;
  muted?: boolean;
  speed?: number;
  trim?: {
    startSeconds: number;
    endSeconds?: number;
    };
  }

export interface ForegroundItem {
  asset: AssetId;
  x?: UnitFloat;
  y?: UnitFloat;
  w?: number;
  h?: number;
  z?: number;
  anim?: "none" | "fade-in" | "slide-in" | "parallax-in" | "zoom-in" | "ken-burns";
  }

export interface Scene {
  id: SceneId;
  layout: "title" | "hero" | "stat" | "chart" | "list";
  variant?: "centered" | "outro" | "full-bleed" | "split" | "bar" | "bullets" | "quote";
  preferredFrames?: number;
  copy?: Copy;
  data?: null | {
    dataset: DatasetId;
    display?: "bar" | "number" | "counter";
    };
  background?: null | Background;
  foreground?: Array<ForegroundItem>;
  /**
   * Transition into the next scene (PLAN.md A1: fades). Missing transitionOut means a default fade.
   * [default {"type":"fade","frames":15}]
   */
  transitionOut?: {
    type: "none" | "fade" | "slide" | "wipe";
    frames?: number;
    };
  narration?: string;
  narration_asset?: AssetId;
  narration_duration_frames?: number;
  locked?: boolean;
  notes?: string;
  }

export interface Media {
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  durationSeconds?: number;
  audio?: "none" | "muted" | "present";
  alpha?: boolean;
  codec?: string;
  /**
   * Recorded crop applied to the final plate (SPEC.md 6.4: 1920x1088 -> 1920x1080).
   */
  crop?: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    };
  }

export interface AssetSource {
  provider: "openverse" | "upload" | "user" | "repo";
  id?: string;
  landing_url?: string;
  creator?: string;
  title?: string;
  retrieved_at?: string;
  original_file?: string;
  }

export interface Gen {
  /**
   * llm-svg = procedural vector written as code (CPU, free); flux3-klein = FLUX 3 Image Klein
   * stills; ltx25 = LTX-2.5 plates; kokoro = narration audio.
   */
  generator?: "llm-svg" | "flux3-klein" | "ltx25" | "kokoro";
  workflow?: RelativePath;
  workflow_sha256?: Sha256Hex;
  model?: string;
  model_revision?: string;
  model_sha256?: Sha256Hex;
  quantization?: string;
  /**
   * Resolved workflow inputs. Paths here are repository-relative and any value naming an asset must
   * resolve.
   */
  inputs?: {
    [key: string]: string | number | boolean;
    };
  caption?: string;
  expansion?: {
    model: NonEmptyString;
    template_version?: string;
    template?: "t2i" | "i2i" | "upsampler";
    at?: string;
    };
  /**
   * Required for llm-svg assets (PLAN.md A5): which sanitizer produced the stored SVG.
   * [maxLength 64]
   */
  sanitizer_version?: string;
  /**
   * CPU rasterisation check result (A5 renderCheck). Required for ready llm-svg assets and must have
   * ok true.
   */
  render_check?: {
    ok: boolean;
    version?: string;
    rasterizer?: string;
    width?: number;
    height?: number;
    blank?: boolean;
    palette_ok?: boolean;
    at?: string;
    errors?: Array<{
      code?: string;
      message: string;
      }>;
    };
  backend?: string;
  attempt_id?: string;
  job_id?: string;
  idempotency_key?: string;
  params_hash?: Sha256Hex;
  seed?: number;
  created_at?: string;
  }

export interface Asset {
  /**
   * svg and vector-anim are the generated-first kinds (PLAN.md); vector-anim is a keyframed vector
   * part whose animation is driven by the Remotion frame, not by SMIL clocks.
   */
  kind: "image" | "video" | "audio" | "svg" | "vector-anim";
  origin: "generated" | "stock" | "upload";
  status: "pending" | "ready" | "failed" | "missing" | "candidate" | "rejected";
  file?: RelativePath;
  sha256?: Sha256Hex;
  bytes?: number;
  /**
   * The stored image is an alpha cutout (transparent PNG), so the renderer must composite, not fill.
   * [default false]
   */
  cutout?: boolean;
  media?: Media;
  source?: AssetSource;
  /**
   * Output rights. Defaults for generated assets: id CC0-1.0 and redistributable true.
   */
  license?: License;
  model_license?: ModelLicense;
  redistributable?: boolean;
  gen?: Gen;
  notes?: string;
  }
