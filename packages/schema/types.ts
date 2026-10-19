// GENERATED FILE - do not edit by hand.
//
// Source:        packages/schema/package-v1.schema.json
// Schema sha256: 06d48b0410bc5b953fe45f0a19d7e5057c2cd0d923486a9d4e8730c1d9b3d7e7
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
    /**
     * kokoro (default) is the CPU narrator. qwen3-tts is the optional Qwen3-TTS 1.7B backend; when its
     * runtime is missing the pipeline falls back to kokoro unless voice.strict is true. none disables
     * narration.
     */
    engine?: "kokoro" | "qwen3-tts" | "none";
    voice?: string;
    speed?: number;
    language?: string;
    /**
     * Optional short language tag for Qwen3-TTS (en or fr). When it is omitted, voice.language is
     * used. Kokoro keeps using voice.language.
     * [minLength 2, maxLength 16]
     */
    lang?: string;
    /**
     * Natural-language narrator description. Qwen3-TTS VoiceDesign uses it once per package to build
     * the cloned voice.
     * [minLength 1, maxLength 400]
     */
    persona?: string;
    /**
     * Designed reference clip for the package narrator (CC0, because we generated it). Optional; the
     * synth caches a voice_clone_prompt either way.
     */
    ref_asset?: AssetId;
    /**
     * When true, a selected qwen3-tts runtime that is unavailable fails the run. When false or
     * omitted, the run falls back to Kokoro.
     */
    strict?: boolean;
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
  audio?: PackageAudio;
  /**
   * CAST1: recurring fictional characters (a mascot). Optional. A package without this array
   * validates, plans and renders exactly as before. v1 is fictional only: no real people and no user
   * photos.
   * [maxItems 8]
   */
  cast?: Array<CastMember>;
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
  /**
   * The portrait still: an asset id, or a CAST1 cast id whose ready ref_asset is that still. A cast
   * id is the optional hook that lets the portrait be a fictional cast member without requiring any
   * other presenter field.
   */
  portrait?: AssetId | CastId;
  /**
   * CAST1: this presenter is the fictional cast member. Optional. When portrait is an asset id, jobs
   * for that still append the member's ref_asset. When portrait is a cast id, the portrait is that
   * member's ref_asset.
   */
  cast?: CastId;
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

export interface PackageAudio {
  /**
   * A background music bed under the narration. `asset` names a ready audio asset; a missing or
   * not-ready asset is a semantic error, not a silent skip.
   */
  music?: {
    asset: AssetId;
    /**
     * Bed level before ducking. -18 dB is the intended default under narration.
     * [min -60, max 12, default -18]
     */
    gain_db?: number;
    fade_in_seconds?: number;
    fade_out_seconds?: number;
    /**
     * Loop the bed if it is shorter than the video; the fade-out still applies at the end.
     * [default true]
     */
    loop?: boolean;
    duck?: AudioDuck;
    };
  /**
   * LTX plate audio (an asset with media.audio: present) mixed under the narration. -24 LUFS-ish,
   * ducked.
   */
  ambience?: {
    enabled?: boolean;
    gain_db?: number;
    duck?: AudioDuck;
    };
  /**
   * Short sound effects at scene seams, timed to the MS3 transition. Each names a ready audio asset
   * and the scene it belongs to.
   * [maxItems 64]
   */
  sfx?: Array<AudioSfx>;
  }

export interface AudioDuck {
  enabled?: boolean;
  /**
   * How far the bed/ambience is pushed down while the narration speaks.
   * [min -40, max 0, default -12]
   */
  reduction_db?: number;
  attack_ms?: number;
  release_ms?: number;
  }

export interface AudioSfx {
  asset: AssetId;
  /**
   * The scene whose seam the sound belongs to. scene-start is the scene's first frame;
   * scene-end/transition is its out-transition.
   */
  scene: SceneId;
  at?: "scene-start" | "scene-end" | "transition";
  offset_seconds?: number;
  gain_db?: number;
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
 * CAST1 id of a fictional cast member. v1 is a mascot: never a real person.
 * [pattern ^c[A-Za-z0-9_-]{0,63}$]
 */
export type CastId = string;

export interface CastMember {
  id: CastId;
  name: string;
  /**
   * Ready still of the fictional character. A missing or unready asset is a semantic error.
   */
  ref_asset: AssetId;
  description?: string;
  }

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
  /**
   * Respelling sent to the synthesizer (for example Comfyrizz -> Comfy rizz). Captions keep
   * narration. Optional; otherwise pronounce.py is applied.
   * [maxLength 600]
   */
  narration_spoken?: string;
  /**
   * Alias of narration_spoken. narration_spoken wins when both are set.
   * [maxLength 600]
   */
  spoken_text?: string;
  /**
   * Per-scene emotion instruction for Qwen3-TTS (for example "calm, slightly amused").
   * [maxLength 240]
   */
  narration_style?: string;
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
  /**
   * CAST1: fictional cast members that appear in this scene. Every Klein still the scene names
   * (background or foreground) is planned as a reference edit that includes each member's ref_asset.
   * [maxItems 8]
   */
  cast?: Array<CastId>;
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
   * a scene's narration WAV); kokoro = Kokoro narration audio; qwen3-tts = optional Qwen3-TTS 1.7B
   * narration audio (Apache-2.0).
   */
  generator?: "llm-svg" | "flux3-klein" | "ltx25" | "ltx25-a2v" | "kokoro" | "qwen3-tts";
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
  /**
   * CAST1: this still depicts the fictional cast member. The planner appends that member's ref_asset
   * to the Klein reference-edit inputs.
   */
  cast?: CastId;
  }
