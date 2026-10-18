// GENERATED FILE - do not edit by hand.
//
// Source:        packages/schema/package-v1.schema.json
// Schema sha256: 7885329f61cc260b9d06f2df0507e822afb8e7cdeb6a6e5bf48f0a427bd7c2cb
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
    /**
     * Primary text colour. Without it the renderer falls back to palette[0], which a media scene may
     * set to 'transparent' (P-fix1).
     */
    text?: HexColor;
    text_muted?: HexColor;
    text_on_accent?: HexColor;
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
  motion?: PackageMotion;
  presenter?: Presenter;
  captions?: PackageCaptions;
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
 * MS2: a named ease, exactly the keys of EASING_TOKENS in apps/renderer/src/motion/index.js (MS1).
 * `linear` is only for continuous motion, never an entrance.
 */
export type EasingToken = "enter" | "exit" | "move" | "land" | "linear";

/**
 * MS2: a spring preset, exactly the keys of SPRING_PRESETS (MS1). `elastic` is an accent: at most
 * once per video.
 */
export type SpringPreset = "settle" | "heavy" | "snap" | "pop" | "elastic";

/**
 * MS2: an energy profile, exactly the keys of ENERGY_PROFILES (MS1). Scales entries, stagger and
 * travel; picks the transition family.
 */
export type MotionEnergy = "calm" | "medium" | "high";

/**
 * MS2: the direction content travels in (vector law). The package direction is the film's one
 * current for ordinary 'next point' cuts; `up` is reserved for a conclusion.
 */
export type MotionDirection = "left" | "right" | "up" | "down";

/**
 * MS2 transition vocabulary. none/cut: no overlap; fade/blur: calm crossfades; slide/push/wipe:
 * directional (medium); zoom/iris: in/out (high). The first four of the original enum (none, fade,
 * slide, wipe) keep their meaning.
 */
export type TransitionType = "none" | "cut" | "fade" | "blur" | "slide" | "push" | "wipe" | "zoom" | "iris";

/**
 * MS2: direction of a transition. left/right/up/down for slide, push and wipe; in/out for zoom (in
 * = deeper, out = arrival) and iris (in = closes, out = opens).
 */
export type TransitionDirection = "left" | "right" | "up" | "down" | "in" | "out";

export interface Presenter {
  enabled?: boolean;
  portrait?: AssetId;
  placement?: "pip-br" | "pip-bl" | "pip-bc" | "split-left";
  shape?: "circle" | "rounded-rect";
  /**
   * the presenter's width as a fraction of the frame's short side (research 2.2: 18-32 %)
   * [min 0.18, max 0.32]
   */
  size?: number;
  /**
   * which scenes show the presenter: both bookends, every scene, or the scene ids the agent chose
   * (the cheap knob is coverage, not stitching)
   */
  scenes?: "all" | "bookends" | Array<string>;
  /**
   * the corner chip's text, when one is drawn
   * [maxLength 64]
   */
  label?: string;
  }

export interface PackageMotion {
  energy?: MotionEnergy;
  direction?: MotionDirection;
  }

export interface PackageCaptions {
  /**
   * K1: caption presentation. sentence is the default; when style is absent a 9:16 video defaults to
   * big-word and everything else to sentence.
   * [default "sentence"]
   */
  style?: "sentence" | "karaoke" | "word-pop" | "big-word";
  }

export interface SceneMotion {
  /**
   * Entry preset. fadeUp/maskRise/pop/countUp are the MS1 primitives of the same name
   * (apps/renderer/src/motion/primitives.js); waterfall (kinetic words) and drawOn (SVG stroke
   * draw-on via pathLength) are MS3. Omitted: the layout's own default entry.
   */
  entry?: "none" | "fadeUp" | "maskRise" | "pop" | "countUp" | "waterfall" | "drawOn";
  /**
   * Ease for the entry; omitted: the preset's own ease (enter for tweens).
   */
  ease?: EasingToken;
  /**
   * Spring for a pop entry; omitted: pop.
   */
  spring?: SpringPreset;
  /**
   * Stagger family, exactly the keys of STAGGER_SECONDS (MS1); total stagger is capped at 0.5 s.
   */
  stagger?: "none" | "word" | "listItem" | "dot";
  /**
   * none; keyword = highlight one word or phrase (needs `highlight`); hero = the film's one hero
   * moment.
   */
  emphasis?: "none" | "keyword" | "hero";
  /**
   * The word or phrase of this scene's copy that a keyword emphasis highlights; must appear in the
   * copy.
   * [minLength 1, maxLength 60]
   */
  highlight?: string;
  /**
   * Per-scene energy override; omitted: the package motion.energy.
   */
  energy?: MotionEnergy;
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
  /**
   * Dark overlay drawn between the media and the layout text, 0 (none) to 1 (black). P-fix1 renders
   * it in the media layer.
   * [min 0, max 1, default 0]
   */
  scrim?: number;
  loop?: boolean;
  muted?: boolean;
  speed?: number;
  trim?: {
    startSeconds: number;
    endSeconds?: number;
    };
  /**
   * Optional plate label for a split or compare media item.
   * [minLength 1, maxLength 40]
   */
  label?: string;
  }

export interface ForegroundItem {
  asset: AssetId;
  x?: UnitFloat;
  y?: UnitFloat;
  w?: number;
  h?: number;
  z?: number;
  anim?: "none" | "fade-in" | "slide-in" | "parallax-in" | "zoom-in" | "ken-burns";
  /**
   * LP2 inset. pip draws this item in a framed picture-in-picture (placement + mask + ring +
   * shadow). none, and omitting the field, keep the existing panel.
   */
  frame?: "none" | "pip";
  /**
   * Where a pip frame sits. pip-bc is the bottom-centre spot above captions. The same names the
   * presenter overlay uses.
   */
  placement?: "pip-br" | "pip-bl" | "pip-bc" | "split-left";
  /**
   * PiP mask. Omitted means rounded-rect. A 3 px brand ring and soft shadow are drawn by the
   * renderer.
   */
  mask?: "circle" | "rounded-rect";
  /**
   * PiP size as a fraction of the frame's short side (18-32%). Omitted means 0.24. Ignored unless
   * frame is pip.
   * [min 0.18, max 0.32]
   */
  size?: number;
  }

export interface Scene {
  id: SceneId;
  layout: "title" | "hero" | "stat" | "chart" | "list" | "split" | "compare" | "code";
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
   * LP2: the two plates of a split or compare scene. Each plate is a background (exactly one of
   * asset or procedural) plus an optional label. Optional on every layout; split and compare require
   * it.
   * [minItems 2, maxItems 2]
   */
  media?: Array<Background>;
  /**
   * LP2 code/terminal scene. Typing is characters per second; omitted means about 0.035 s/char.
   * highlights are 1-based line numbers, one accent for the whole scene.
   */
  code?: {
    language: string;
    code: string;
    highlights?: Array<number>;
    typing?: {
      /**
       * Characters revealed per second. Omitted means 1/0.035 (about 28.57), which is 0.035 s/char.
       * [min 1, max 120]
       */
      charsPerSecond?: number;
      };
    };
  /**
   * Skip this scene's layout and draw only the media layer (background media + scrim + foreground
   * panels + lower_third). Requires a media background or a foreground item (P-fix1).
   * [default false]
   */
  media_only?: boolean;
  /**
   * Lower-third overlay, drawn by the media layer (P-fix1). Its text is bound by the same rule as
   * copy: too long is a visible fail state, never silent clipping.
   */
  lower_third?: {
    kicker?: string;
    text: string;
    };
  /**
   * Transition into the next scene (PLAN.md A1: fades; MS2: the motion transition vocabulary).
   * Missing transitionOut means a default fade. `direction` applies to slide | push | wipe
   * (left/right/up/down) and zoom | iris (in/out); when it is omitted on a directional type the
   * renderer uses the package motion.direction (the film's one current) or `in`. `cut` always has
   * frames 0. lintMotion() checks budget, vector law and durations.
   * [default {"type":"fade","frames":15}]
   */
  transitionOut?: {
    type: TransitionType;
    frames?: number;
    direction?: TransitionDirection;
    };
  motion?: SceneMotion;
  narration?: string;
  narration_asset?: AssetId;
  presenter_asset?: AssetId;
  /**
   * H17: this scene's own answer about the AI presenter - off, picture-in-picture, or the
   * intro/outro split layout. The package's `presenter.scenes` decides the default.
   */
  presenter?: "off" | "pip" | "split";
  narration_duration_frames?: number;
  locked?: boolean;
  notes?: string;
  }

export interface AssetVariants {
  upscaled?: {
    file: string;
    width: number;
    height: number;
    scale?: number;
    sha256?: string;
    bytes?: number;
    };
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
   * stills; ltx25 = LTX-2.5 plates; ltx25-a2v = LTX-2.5 audio-to-video (the H17 presenter, driven by
   * a scene's narration WAV); kokoro = narration audio.
   */
  generator?: "llm-svg" | "flux3-klein" | "ltx25" | "ltx25-a2v" | "kokoro";
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
  variants?: AssetVariants;
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
