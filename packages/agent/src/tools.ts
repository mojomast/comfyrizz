import { createHash } from 'node:crypto';
import { synthesizeFinishingWav } from './finishing-audio.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { routeAsset, type AssetNeed, type RouteDecision } from './router.js';
import { foregroundFor } from './package.js';
import { expandFluxCaption, expandReferenceEditCaption, aspectFromSize, sourceDims, type Aspect } from './caption.js';
import { WORKFLOW_SHA256 } from './workflow-manifest.js';
import { brandStyleBlock, brandTheme, type BrandKit } from './brand.js';
import type { StylePreset } from './brief.js';
import {
  applyPresenterSet,
  PRESENTER_COVERAGES,
  PRESENTER_PLACEMENTS,
  PRESENTER_PRESETS,
  PRESENTER_SCENE_VALUES,
  PRESENTER_SHAPES,
} from './presenter.js';
import {
  lintPackageMotion,
  mergeScenePatch,
  motionFixInstructions,
  motionVocabulary,
  normalizePackageMotion,
  normalizeSceneMotion,
  normalizeTransitionOut,
} from './prompts/motion.js';
import type { SvgIntentLike } from './svg.js';
import type { ToolDef } from './types.js';
import { cutdownPackage, type VoiceFn } from './cutdown.js';
import { styleApplyFor, styleList, styleSuggest } from './style-recipes.js';
import { classifyProductionIntent, type ProductionIntent } from './production-intent.js';
import { parseMotionModel, resolveShotMotionModel, type MotionModel } from './motion-model.js';

export interface AgentTool {
  definition: ToolDef;
  schema: z.ZodTypeAny;
  run(args: any, context?: { operationId?: string }): Promise<unknown> | unknown;
}

export interface SvgAssetResult {
  svg: string;
  attempts?: number;
  repairs?: number;
  sanitizerVersion?: string;
  history?: unknown[];
  /** Persisted package-relative path; the tool falls back to assets/<id>.svg. */
  file?: string;
  /** A5 render-check metadata stored in the package (C5). */
  renderCheck?: { ok: boolean; version?: string; width?: number; height?: number; opaqueFraction?: number; outOfPaletteFraction?: number | null };
}

export interface PlannedImage {
  caption?: string;
  workflow?: string;
  /** sha256 of the workflow graph, so a planned asset can pass the jobs planner. */
  workflowSha256?: string;
  model?: string;
  inputs?: Record<string, unknown>;
  backend?: string;
}

export interface ToolsetOptions {
  initialPackage?: Record<string, any>;
  /** Original brief constraints retained when an existing package is repaired without propose. */
  initialIntent?: ProductionIntent;
  /** Wired to A5: autoFix(generate, intent) with sanitize/render-check. */
  generateSvg?: (intent: SvgIntentLike) => Promise<SvgAssetResult> | SvgAssetResult;
  /** Wired to the job planner; defaults to a caption + workflow plan, never a GPU run. */
  planImage?: (args: z.infer<typeof generateImageSchema>) => PlannedImage;
  /** Persist an SVG and return its package-relative path (C5 server). */
  persistSvg?: (assetId: string, svg: string, kind: string) => string | undefined;
  /** Persist deterministic CPU audio conditioning; never calls a model or GPU. */
  persistAudio?: (assetId: string, wav: Uint8Array, kind: 'silent-conditioning' | 'finishing-stem') => string | undefined;
  /** Generated-film router. Auto selects H3 or LTX independently for each shot. */
  motionModel?: MotionModel;
  /** Observe every package mutation; runCpuSlice uses this to return the draft. */
  onPackageChange?: (pkg: Record<string, any>) => void;
  /** Clock injection so tests are deterministic. */
  now?: () => string;
  /**
   * X1: CPU voice for `variant.cutdown`. Defaults to the word-timing stub
   * (no Kokoro weights, no model). Must be synchronous. Never a GPU call.
   */
  voice?: VoiceFn;
  /**
   * B1: a normalised brand kit. `storyboard.propose` merges its theme over the
   * defaults, so the palette every image caption and SVG follows is the brand
   * palette from the first tool call.
   */
  brand?: Partial<BrandKit>;
  /** B1: uploaded logo/font assets referenced by the brand kit's theme. */
  brandAssets?: Record<string, unknown>;
  /** B1: the look the generation STYLE_BLOCK is written from (default cinematic-dark). */
  stylePreset?: StylePreset;
}

const motionVocab = motionVocabulary();

function zodEnum(values: readonly string[]) {
  if (values.length === 0) throw new Error('empty motion enum');
  return z.enum(values as [string, ...string[]]);
}

const SCENE_LAYOUTS = ['title', 'hero', 'stat', 'chart', 'list', 'split', 'compare', 'code'] as const;
type SceneLayout = (typeof SCENE_LAYOUTS)[number];

const PACKAGE_FPS = [24, 25, 30, 50, 60] as const;
const FORMAT_PRESETS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};
const UNSUPPORTED_ASPECTS = new Set(['4:3', '3:2', '5:4', '16:10', '21:9', '2:1', '2.39:1', '2.35:1', '1.85:1', '1.66:1']);

interface PackageFormat {
  width: number;
  height: number;
  fps: number;
}

function briefClauses(brief: string): string[] {
  return brief.split(/[;!?\n]+|\.\s+/).map(clause => clause.trim()).filter(Boolean);
}

function negatedClause(clause: string): boolean {
  return /\b(?:no|not|never|avoid|without|don'?t|cannot|can't)\b/i.test(clause);
}

function unsupportedFormatError(reasons: string[]): Error {
  return Object.assign(
    new Error(`Unsupported format: ${reasons.join(', ')} cannot be rendered. Use 1920x1080 at 30 fps and 16:9, or a supported WxH size such as 1080x1920 at 30 fps.`),
    { name: 'UnsupportedFormatError', status: 422, code: 'UNSUPPORTED_FORMAT' },
  );
}

function supportedSize(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height)
    && width >= 64 && width <= 7680 && width % 2 === 0
    && height >= 64 && height <= 4320 && height % 2 === 0;
}

/** Read the output size and fps the brief actually asks for; never silently fall back from a rejected format. */
function resolveFormat(brief: string): PackageFormat {
  const clauses = briefClauses(brief).filter(clause => !negatedClause(clause));
  const reasons: string[] = [];
  const addReason = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  let size: { width: number; height: number } | undefined;
  let preset: { width: number; height: number } | undefined;
  let fps = 30;

  for (const clause of clauses) {
    for (const match of clause.matchAll(/\b(\d{1,2})\s*k\b/gi)) {
      const resolution = Number(match[1]);
      if (resolution >= 8) addReason(`${resolution}K resolution`);
    }
    for (const match of clause.matchAll(/\b(\d{1,3})\s*(?:fps\b|frames?\s+per\s+second)\b/gi)) {
      const value = Number(match[1]);
      if ((PACKAGE_FPS as readonly number[]).includes(value)) fps = value;
      else addReason(`${value} fps`);
    }
    for (const match of clause.matchAll(/\b(\d{1,2}(?:\.\d+)?)\s*:\s*(\d{1,2}(?:\.\d+)?)\b/g)) {
      const ratio = `${match[1]}:${match[2]}`;
      const known = FORMAT_PRESETS[ratio];
      if (known) {
        preset = known;
        continue;
      }
      const context = /\b(?:aspect|format|ratio|resolution)\b/i.test(clause);
      if (UNSUPPORTED_ASPECTS.has(ratio) || match[1].includes('.') || match[2].includes('.') || context) addReason(`${ratio} aspect`);
    }
    for (const match of clause.matchAll(/\b(\d{2,5})\s*[x×]\s*(\d{2,5})\b/gi)) {
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (supportedSize(width, height)) size = { width, height };
      else addReason(`${width}x${height} resolution`);
    }
  }

  if (reasons.length > 0) throw unsupportedFormatError(reasons);
  if (size) return { ...size, fps };
  if (preset) return { ...preset, fps };
  const words = clauses.join(' ');
  if (/\b(?:vertical|portrait|9:16)\b/i.test(words)) return { width: 1080, height: 1920, fps };
  if (/\b(?:square|1:1)\b/i.test(words)) return { width: 1080, height: 1080, fps };
  return { width: 1920, height: 1080, fps };
}

const sceneSchema = z.object({
  id: z.string().min(1),
  layout: z.enum(SCENE_LAYOUTS).optional(),
  preferredFrames: z.number().int().positive().optional(),
  // DeepSeek often sends `copy` as a plain headline string; accept it and lift it
  // to `{ headline }` so a common model shape is not a repair-loop failure.
  copy: z
    .preprocess(value => (typeof value === 'string' ? { headline: value } : value), z.record(z.unknown()))
    .optional(),
  narration: z.string().optional(),
}).passthrough();

function boundedText(max: number) {
  return z.preprocess(value => typeof value === 'string' ? clampText(value, max) : value, z.string().min(1).max(max));
}

export const proposeSchema = z.object({
  brief: z.string().min(1),
  title: boundedText(120).optional(),
  proposal: z.object({
    logline: boundedText(240),
    look: boundedText(100),
    soundtrack: boundedText(100),
  }).strict().optional(),
  motion: z.object({
    energy: zodEnum(motionVocab.energies).optional(),
    direction: zodEnum(motionVocab.directions).optional(),
  }).strict().optional(),
  scenes: z.array(sceneSchema).max(12).optional(),
  datasets: z.record(z.unknown()).optional(),
});

export const editSchema = z.object({
  scene_id: z.string().min(1),
  patch: z.record(z.unknown()),
});

export const routeSchema = z.object({
  scene_id: z.string().min(1),
  need: z.string().min(1),
  kind: z.string().optional(),
  animated: z.boolean().optional(),
  transparent: z.boolean().optional(),
  source: z.enum(['generate', 'openverse', 'stock', 'upload']).optional(),
  /** Requested style; a styled hero/background/diagram routes to assets.sketch_to_render. */
  style: z.string().optional(),
});

export const generateSvgSchema = z.object({
  scene_id: z.string().min(1),
  kind: z.enum(['icon', 'diagram', 'pattern', 'vector-anim']),
  intent: z.string().min(1),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8).optional(),
  width: z.number().int().positive().max(4096).optional(),
  height: z.number().int().positive().max(4096).optional(),
  seed: z.number().int().optional(),
});

export const generateImageSchema = z.object({
  scene_id: z.string().min(1),
  kind: z.string().min(1).optional(),
  intent: z.string().min(1),
  seed: z.number().int().optional(),
  refs: z.array(z.string()).max(4).optional(),
  cutout: z.boolean().optional(),
  aspect: z.enum(['16:9', '1:1', '4:5', '9:16']).optional(),
  /** Allow text in the still (default false: Klein draws garbled pseudo-text). */
  text: z.boolean().optional(),
  /** Labelled frame: keep labels and lock the camera. */
  labelled: z.boolean().optional(),
  /** Target style for a reference edit (with refs): clay, glass, editorial, ... */
  style: boundedText(80).optional(),
});

export const generateVideoSchema = z.object({
  scene_id: z.string().min(1),
  motion_model: z.enum(['auto', 'h3', 'ltx', 'klein']).optional(),
  subject: z.string().min(1).max(2000),
  composition: z.string().min(1).max(4000),
  action: z.string().min(1).max(4000),
  camera: z.string().min(1).max(2000),
  soundscape: z.string().min(1).max(2000),
  characterCount: z.number().int().min(0).max(100),
  /** Picture 1: recurring subject/identity reference (H3), or LTX start art. */
  image: z.string().min(1).optional(),
  /** Picture 2: composition/art-direction reference. Required by H3. */
  reference: z.string().min(1).optional(),
  /** Exact-line voice conditioning for dialogue. Wordless shots create silence. */
  audio: z.string().min(1).optional(),
  /** Required for LTX: this model generates no native audio track. */
  finishing_sound: z.string().min(1).max(2000).optional(),
  frames: z.number().int().positive().optional(),
  seed: z.number().int().min(0).max(0xffffffff).optional(),
  wordless: z.boolean().optional(),
  media_index: z.union([z.literal(0), z.literal(1)]).optional(),
  dialogue: z.object({
    text: z.string().min(1).max(2000),
    conditioningText: z.string().min(1).max(2000),
    language: z.string().min(1).max(64),
    voice: z.string().min(1).max(512),
    delivery: z.string().min(1).max(2000),
    offscreen: z.boolean().optional(),
  }).strict().optional(),
});

export const sketchToRenderSchema = z.object({
  scene_id: z.string().min(1),
  kind: z.enum(['diagram', 'hero', 'background', 'illustration', 'plate', 'pattern', 'chart', 'vector', 'vector-anim']),
  intent: z.string().min(1),
  style: boundedText(80),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8).optional(),
  width: z.number().int().positive().max(4096).optional(),
  height: z.number().int().positive().max(4096).optional(),
  seed: z.number().int().optional(),
  aspect: z.enum(['16:9', '1:1', '4:5', '9:16']).optional(),
});

export const presenterSetSchema = z.object({
  enabled: z.boolean().optional(),
  coverage: z.enum(PRESENTER_COVERAGES).optional(),
  preset: z.enum(PRESENTER_PRESETS).optional(),
  // scene id or 1-based index → off | pip | split; null clears the per-scene override.
  scenes: z.record(z.union([z.enum(PRESENTER_SCENE_VALUES), z.null()])).optional(),
  placement: z.enum(PRESENTER_PLACEMENTS).optional(),
  shape: z.enum(PRESENTER_SHAPES).optional(),
  size: z.number().min(0.18).max(0.32).optional(),
  label: z.string().max(64).nullable().optional(),
  portrait: z.string().min(1).max(120).optional(),
  preset_style: z.string().max(80).optional(),
  backdrop: z.string().max(120).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1),
  orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
  license_policy: z.enum(['cc0', 'by', 'by-sa', 'any']).optional(),
});

const attachSchema = z.object({ scene_id: z.string().min(1), candidate_id: z.string().min(1) });

export const codeSceneSchema = z.object({
  scene_id: z.string().min(1).max(64).optional(),
  language: z.string().min(1).max(32),
  code: z.string().min(1).max(4000),
  highlights: z.array(z.number().int().min(1).max(400)).max(8).optional(),
  charsPerSecond: z.number().min(1).max(120).optional(),
});

export const cutdownSchema = z.object({
  target_s: z.union([z.literal(6), z.literal(15), z.literal(30)]),
});

const tool = (name: string, description: string, parameters: Record<string, unknown>, schema: z.ZodTypeAny, run: AgentTool['run']): AgentTool => ({
  definition: { name, description, parameters },
  schema,
  run,
});

function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

/** A generation/render rejection is an actionable 422, never an untyped 500. */
function svgAssetError(code: string, assetId: string, message: string): Error {
  const error = Object.assign(new Error(`${assetId}: ${message}`), {
    name: 'SvgAssetError',
    status: 422,
    code,
    assetId,
  });
  return error;
}

export const SILENT_CONDITIONING_ASSET_ID = 'a_h3_silence_500ms_24k';
const FASTH3_WORKFLOW = 'workflows/fasth3_omni_ref2va.api.json';
const LTX_I2V_WORKFLOW = 'workflows/ltx25_i2v_2stage.api.json';

/** A deterministic 0.5 s, mono, 24 kHz PCM16 RIFF/WAV conditioning signal. */
export function silentConditioningWav(): Buffer {
  const sampleRate = 24000;
  const samples = sampleRate / 2;
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function nextFastH3Frames(requested: number): number {
  const base = Math.max(5, requested);
  return base + ((5 - (base % 17) + 17) % 17);
}

function nextLtxFrames(requested: number): number {
  const base = Math.max(1, requested);
  return base + ((1 - (base % 8) + 8) % 8);
}

function meaningfulCopy(copy: unknown): boolean {
  if (!copy || typeof copy !== 'object') return false;
  return Object.values(copy).some(value => Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim().length > 0 : value != null);
}

function baseParameters(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const SCENE_KEYS = new Set([
  'id', 'layout', 'variant', 'preferredFrames', 'copy', 'data', 'background', 'foreground',
  'media_only', 'lower_third', 'transitionOut', 'motion', 'narration', 'narration_asset',
  'narration_duration_frames', 'locked', 'notes', 'presenter', 'presenter_asset', 'cast',
  'media', 'code',
]);
const COPY_KEYS = new Set(['headline', 'kicker', 'sub', 'body', 'quote', 'attribution', 'footnote', 'cta', 'items']);
const COPY_LIMITS: Record<SceneLayout, Record<string, number>> = {
  title: { headline: 48, sub: 90 },
  hero: { headline: 64, sub: 120, body: 240 },
  stat: { headline: 48, sub: 90, body: 40 },
  chart: { headline: 64, sub: 120, footnote: 120 },
  list: { headline: 64, quote: 200, attribution: 80 },
  split: { headline: 48, sub: 90 },
  compare: { headline: 48, sub: 90 },
  code: { headline: 64 },
};
const LAYOUT_VARIANTS: Record<SceneLayout, string[]> = {
  title: ['centered', 'outro'],
  hero: ['full-bleed', 'split'],
  stat: [],
  chart: ['bar'],
  list: ['bullets', 'quote'],
  split: [],
  compare: [],
  code: [],
};
const BACKGROUND_PATTERNS = ['gradient', 'grid', 'dots', 'grain', 'mesh'];
const DEFAULT_SCENE_FRAMES: Record<SceneLayout, number> = { title: 150, hero: 210, stat: 180, chart: 210, list: 180, split: 180, compare: 180, code: 240 };
const DEFAULT_CHARS_PER_SECOND = 1 / 0.035;
const PIP_PLACEMENTS = new Set(['pip-br', 'pip-bl', 'pip-bc', 'split-left']);
const PIP_MASKS = new Set(['circle', 'rounded-rect']);

type CodeLayoutModule = {
  DEFAULT_CHARS_PER_SECOND: number;
  lintCodeScene: (code: string, width: number, height: number) => Array<{ code: string }>;
  codeTimelineFrames: (source: string, fps: number, rate: number) => number;
};

let codeLayoutPromise: Promise<CodeLayoutModule> | null = null;

/** Resolve code-layout.mjs from either src/ (tsx) or dist/src/ (the built test). */
function loadCodeLayout(): Promise<CodeLayoutModule> {
  if (!codeLayoutPromise) {
    let dir = dirname(fileURLToPath(import.meta.url));
    let found: string | null = null;
    for (let hop = 0; hop < 6 && !found; hop += 1) {
      const candidate = join(dir, 'schema', 'src', 'code-layout.mjs');
      if (existsSync(candidate)) found = candidate;
      dir = dirname(dir);
    }
    if (!found) throw new Error('code-layout.mjs not found');
    codeLayoutPromise = import(pathToFileURL(found).href) as Promise<CodeLayoutModule>;
  }
  return codeLayoutPromise;
}
const SCENE_ID_RE = /^s[A-Za-z0-9_-]{0,63}$/;
const DATASET_ID_RE = /^d[A-Za-z0-9_-]{0,63}$/;
const DATASET_SOURCES = ['user', 'openverse', 'example', 'derived'] as const;
const DATASET_MAX_VALUES = 64;

type DatasetErrorCode =
  | 'DATASETS_INVALID'
  | 'DATASET_INVALID'
  | 'DATASET_UNIT_REQUIRED'
  | 'DATASET_VALUES_REQUIRED'
  | 'DATASET_VALUE_INVALID'
  | 'DATASET_SOURCE_INVALID';

/** A dataset the tool cannot repair is an actionable 422, never invented values. */
function datasetError(datasetId: string, code: DatasetErrorCode, message: string): Error {
  return Object.assign(new Error(`${datasetId}: ${message}`), {
    name: 'DatasetError',
    status: 422,
    code,
    datasetId,
  });
}

function datasetNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(raw.trim())) return Number(raw.trim());
  return null;
}

/** A model-authored dataset key becomes the schema id `^d[A-Za-z0-9_-]{0,63}$`. */
function normalizeDatasetId(raw: string): string {
  const trimmed = raw.trim();
  if (DATASET_ID_RE.test(trimmed)) return trimmed;
  const body = trimmed.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const prefixed = !body ? 'd_data' : body.startsWith('d') ? body : `d_${body}`;
  return prefixed.slice(0, 64);
}

function uniqueDatasetId(base: string, used: Set<string>): string {
  let candidate = base;
  for (let suffixNumber = 2; used.has(candidate); suffixNumber += 1) {
    const suffix = `_${suffixNumber}`;
    candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  }
  return candidate;
}

function normalizeDatasetBody(raw: unknown, id: string): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw datasetError(id, 'DATASET_INVALID', 'dataset must be an object with unit, values and source; never invent statistics.');
  }
  const dataset = raw as Record<string, unknown>;
  const source = dataset.source === undefined
    ? 'user'
    : typeof dataset.source === 'string' ? dataset.source.trim().toLowerCase() : dataset.source;
  if (typeof source !== 'string' || !(DATASET_SOURCES as readonly string[]).includes(source)) {
    throw datasetError(id, 'DATASET_SOURCE_INVALID', 'dataset.source must be user, openverse, example or derived.');
  }
  const unit = typeof dataset.unit === 'string' ? dataset.unit.trim() : '';
  if (!unit) {
    throw datasetError(id, 'DATASET_UNIT_REQUIRED', 'dataset.unit is required (1-32 characters); keep the user-supplied unit instead of inventing one.');
  }
  const candidateValues = dataset.values && typeof dataset.values === 'object' && !Array.isArray(dataset.values)
    ? Object.entries(dataset.values as Record<string, unknown>).map(([label, value]) => ({ label, value }))
    : dataset.values;
  if (!Array.isArray(candidateValues) || candidateValues.length === 0) {
    throw datasetError(id, 'DATASET_VALUES_REQUIRED', 'dataset.values must contain at least one user-supplied number; never invent statistics.');
  }
  const values = candidateValues.slice(0, DATASET_MAX_VALUES).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw datasetError(id, 'DATASET_VALUE_INVALID', `dataset.values[${index}] must be { label, value }; never invent statistics.`);
    }
    const item = entry as Record<string, unknown>;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    if (!label) {
      throw datasetError(id, 'DATASET_VALUE_INVALID', `dataset.values[${index}].label must be a non-empty string; never invent labels or statistics.`);
    }
    const value = datasetNumber(item.value);
    if (value === null || Math.abs(value) > 1e12) {
      throw datasetError(id, 'DATASET_VALUE_INVALID', `dataset.values[${index}].value must be a finite number within ±1e12; keep the user's value and never invent statistics.`);
    }
    return { label: label.slice(0, 64), value };
  });

  const normalized: Record<string, any> = { unit: unit.slice(0, 32), values, source };
  if (typeof dataset.label === 'string' && dataset.label.trim()) normalized.label = dataset.label.trim().slice(0, 64);
  if (typeof dataset.approved === 'boolean') normalized.approved = dataset.approved;
  if (typeof dataset.source_url === 'string' && dataset.source_url.trim()) {
    try {
      const href = new URL(dataset.source_url.trim()).href;
      if (href.length <= 512) normalized.source_url = href;
    } catch {
      // Drop an unusable optional source URL instead of failing the whole package.
    }
  }
  if (typeof dataset.retrieved_at === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(dataset.retrieved_at)
    && !Number.isNaN(Date.parse(dataset.retrieved_at))) {
    normalized.retrieved_at = dataset.retrieved_at;
  }
  if (typeof dataset.note === 'string' && dataset.note.trim()) normalized.note = dataset.note.trim().slice(0, 256);
  return normalized;
}

/** Normalize every dataset key and value once, and keep the scene-reference aliases. */
function normalizeDatasets(raw: unknown): { datasets: Record<string, any>; aliases: Map<string, string> } {
  if (raw === undefined || raw === null) return { datasets: {}, aliases: new Map() };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw datasetError('datasets', 'DATASETS_INVALID', 'datasets must be an object keyed by dataset id.');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  const used = new Set<string>();
  const assigned = new Map<string, string>();
  for (const [key] of entries) {
    const id = uniqueDatasetId(normalizeDatasetId(key), used);
    used.add(id);
    assigned.set(key, id);
  }
  const datasets: Record<string, any> = {};
  for (const [key, value] of entries) {
    const id = assigned.get(key)!;
    datasets[id] = normalizeDatasetBody(value, id);
  }
  const aliases = new Map(assigned);
  for (const id of used) if (!aliases.has(id)) aliases.set(id, id);
  return { datasets, aliases };
}

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}\u2026` : text;
}

function sanitizeForegroundItem(item: Record<string, any>): Record<string, any> {
  const next = { ...item };
  if (next.frame !== 'pip') delete next.frame;
  if (!PIP_PLACEMENTS.has(next.placement)) delete next.placement;
  if (!PIP_MASKS.has(next.mask)) delete next.mask;
  if (typeof next.size !== 'number' || next.size < 0.18 || next.size > 0.32) delete next.size;
  return next;
}

function sanitizePlate(plate: any, assetIds: Set<string>): Record<string, any> | undefined {
  if (!plate || typeof plate !== 'object') return undefined;
  const label = clampText(plate.label, 40);
  const procedural = plate.procedural && typeof plate.procedural === 'object' ? { ...plate.procedural } : undefined;
  if (procedural) {
    if (!BACKGROUND_PATTERNS.includes(procedural.pattern)) procedural.pattern = 'gradient';
    if (procedural.seed !== undefined && !Number.isInteger(procedural.seed)) delete procedural.seed;
    if (Array.isArray(procedural.palette)) {
      procedural.palette = procedural.palette.filter((entry: unknown) => typeof entry === 'string' && /^#[0-9a-fA-F]{6}$/.test(entry)).slice(0, 8);
      if (procedural.palette.length === 0) delete procedural.palette;
    }
  }
  const asset = typeof plate.asset === 'string' && assetIds.has(plate.asset) ? plate.asset : undefined;
  if (Boolean(procedural) === Boolean(asset)) return undefined;
  const out: Record<string, any> = procedural ? { procedural } : { asset };
  if (label) out.label = label;
  return out;
}

function sanitizeCodeBlock(block: any, fallbackRate: number): Record<string, any> | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const language = typeof block.language === 'string' ? block.language.trim().slice(0, 32) : '';
  const code = typeof block.code === 'string' ? block.code.replace(/\r\n/g, '\n').slice(0, 4000) : '';
  if (!language || code.trim().length === 0) return undefined;
  const highlights = Array.isArray(block.highlights)
    ? block.highlights.filter((entry: unknown) => Number.isInteger(entry) && (entry as number) >= 1 && (entry as number) <= 400).slice(0, 8)
    : [];
  const raw = typeof block.charsPerSecond === 'number' ? block.charsPerSecond : block.typing?.charsPerSecond;
  const rate = typeof raw === 'number' && raw >= 1 && raw <= 120 ? raw : fallbackRate;
  return { language, code, ...(highlights.length > 0 ? { highlights } : {}), typing: { charsPerSecond: rate } };
}

const COMPARISON_RE = /\bcompar(?:e|ison|ing)\b|\bversus\b|\bvs\.?\b|\bbefore\s*(?:and|&|\/|-|,)?\s*after\b/i;
const SHARED_DATASET_RE = /(?:share|shared|single|same)[^.]{0,80}\bdatasets?\b|\bdatasets?\b[^.]{0,80}(?:share|shared|single|same)|\bone\s+(?:shared\s+)?(?:user\s+)?dataset\b/i;
const ITEM_COUNT_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const LIST_ITEMS_RE = /\b(?:(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[-\s]item\s+list|list\s+scenes?\b[^.]{0,80}?\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+items?)\b/i;
const LIST_HINT_RE = /\blist|bullet|steps|checklist|points\b/i;

/** The item count a brief pins down, e.g. "one list scene with six items". */
function briefListItems(brief: string): number | undefined {
  const match = LIST_ITEMS_RE.exec(brief);
  if (!match) return undefined;
  const raw = (match[1] ?? match[2] ?? '').toLowerCase();
  const count = ITEM_COUNT_WORDS[raw] ?? Number(raw);
  return Number.isInteger(count) && count >= 2 && count <= 6 ? count : undefined;
}

function sceneItems(scene: Record<string, any>): unknown[] {
  if (Array.isArray(scene.copy?.items)) return scene.copy.items;
  return Array.isArray(scene.items) ? scene.items : [];
}

function sceneHintText(scene: Record<string, any>): string {
  const copy = scene.copy && typeof scene.copy === 'object' ? scene.copy : {};
  return [
    scene.layout, scene.role, scene.id, scene.title, scene.headline,
    copy.headline, copy.sub, copy.body,
  ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
}

function briefWantsComparison(brief: string): boolean {
  return COMPARISON_RE.test(brief);
}

function sceneHintsComparison(scene: Record<string, any>): boolean {
  return COMPARISON_RE.test(sceneHintText(scene));
}

function comparisonPlates(): Array<Record<string, any>> {
  return [{ procedural: { pattern: 'gradient' } }, { procedural: { pattern: 'grid' } }];
}

function ensureComparisonPlates(scene: Record<string, any>): Record<string, any> {
  if (scene.layout === 'compare' && (!Array.isArray(scene.media) || scene.media.length !== 2)) {
    scene.media = comparisonPlates();
  }
  return scene;
}

/** The live model often sends `role`/`title` and no `layout`; infer one. */
function inferSceneLayout(scene: Record<string, any>): SceneLayout {
  const hint = sceneHintText(scene);
  if (COMPARISON_RE.test(hint)) return 'compare';
  if (/outro|intro|title|cover|opening|closing|hook/.test(hint)) return 'title';
  if (/stat|metric|kpi|number|figure|score/.test(hint)) return 'stat';
  if (/chart|graph|bar|data|plot|trend/.test(hint)) return 'chart';
  if (/list|bullet|steps|feature|checklist|points/.test(hint)) return 'list';
  return 'hero';
}

function sameDatasetValues(values: unknown, expected: Array<{ label: string; value: number }>): boolean {
  if (!Array.isArray(values) || values.length !== expected.length) return false;
  return expected.every(item => values.some((entry: any) => entry?.label === item.label && entry?.value === item.value));
}

function briefSharedDataset(brief: string, normalizedDatasets: ReturnType<typeof normalizeDatasets>): { datasets: Record<string, any>; id: string } | null {
  if (!SHARED_DATASET_RE.test(brief)) return null;
  const values: Array<{ label: string; value: number }> = [];
  const seen = new Set<string>();
  for (const match of brief.matchAll(/(?:^|[.,;:]\s*|\band\s+)([A-Za-z][A-Za-z0-9 _&'\/-]{0,40}?)\s*=\s*(-?\d+(?:\.\d+)?)/g)) {
    const label = match[1].trim().replace(/\s+/g, ' ');
    const value = Number(match[2]);
    if (!label || !Number.isFinite(value) || seen.has(label.toLowerCase())) continue;
    if (/^(?:aspect|format|resolution|fps|length|duration|width|height|ratio)$/i.test(label)) continue;
    seen.add(label.toLowerCase());
    values.push({ label, value });
  }
  if (values.length === 0) return null;

  const entries = Object.entries(normalizedDatasets.datasets);
  const matching = entries.find(([, dataset]) => dataset.source === 'user' && sameDatasetValues(dataset.values, values));
  const sameLabels = entries.find(([, dataset]) => dataset.source === 'user'
    && Array.isArray(dataset.values)
    && dataset.values.length === values.length
    && values.every((item, index) => dataset.values[index]?.label === item.label));
  const basisEntry = matching ?? sameLabels ?? entries.find(([, dataset]) => dataset.source === 'user');
  const id = matching?.[0] ?? sameLabels?.[0] ?? basisEntry?.[0] ?? 'd_data';
  const basis = basisEntry?.[1];
  const dataset: Record<string, any> = {
    unit: typeof basis?.unit === 'string' ? basis.unit : 'value',
    values,
    source: 'user',
  };
  if (typeof basis?.label === 'string') dataset.label = basis.label;
  return { datasets: { [id]: dataset }, id };
}

function chooseComparisonScene(scenes: Array<Record<string, any>>, protectedScenes: Set<Record<string, any>> = new Set()): Record<string, any> | undefined {
  const allowed = scenes.filter(scene => !protectedScenes.has(scene));
  const hinted = allowed.find(scene => scene.layout !== 'compare' && scene.layout !== 'title' && sceneHintsComparison(scene));
  if (hinted) return hinted;
  const hintedAny = allowed.find(scene => scene.layout !== 'compare' && sceneHintsComparison(scene));
  if (hintedAny) return hintedAny;
  const nonCore = allowed.filter(scene => !['compare', 'chart', 'stat', 'title', 'code'].includes(scene.layout));
  if (nonCore.length > 0) return nonCore[nonCore.length - 1];
  const nonTitle = allowed.filter(scene => scene.layout !== 'title');
  return nonTitle[nonTitle.length - 1] ?? allowed[allowed.length - 1];
}

/** The scene the brief's list bullet refers to: items first, then a list hint, then a non-title scene. */
function chooseListScene(scenes: Array<Record<string, any>>): Record<string, any> | undefined {
  return scenes.find(scene => scene.layout === 'list' && sceneItems(scene).length > 0)
    ?? scenes.find(scene => sceneItems(scene).length > 0)
    ?? scenes.find(scene => scene.layout === 'list')
    ?? scenes.find(scene => LIST_HINT_RE.test(sceneHintText(scene)))
    ?? scenes.find(scene => !['title', 'compare', 'code'].includes(scene.layout));
}

function preparePlanningScenes(rawScenes: Array<Record<string, any>>, brief: string, sharedDatasetId?: string, requiredListItems?: number): Array<Record<string, any>> {
  const scenes = rawScenes.map(scene => ({ ...scene }));
  for (const scene of scenes) {
    if (!(SCENE_LAYOUTS as readonly string[]).includes(scene.layout)) scene.layout = inferSceneLayout(scene);
  }
  const protectedScenes = new Set<Record<string, any>>();
  if (requiredListItems) {
    const listScene = chooseListScene(scenes);
    if (listScene) {
      listScene.layout = 'list';
      protectedScenes.add(listScene);
    }
  }
  if ((briefWantsComparison(brief) || scenes.some(sceneHintsComparison)) && !scenes.some(scene => scene.layout === 'compare')) {
    const candidate = chooseComparisonScene(scenes, protectedScenes);
    if (candidate) {
      candidate.layout = 'compare';
      delete candidate.variant;
      ensureComparisonPlates(candidate);
    }
  }
  for (const scene of scenes) ensureComparisonPlates(scene);
  if (sharedDatasetId) {
    for (const scene of scenes) {
      const display = scene.layout === 'stat' ? 'number' : 'bar';
      scene.data = { dataset: sharedDatasetId, display };
    }
  }
  return scenes;
}

function ensureComparisonScene(scenes: Array<Record<string, any>>, brief: string | undefined, protectedScenes: Set<Record<string, any>> = new Set()): Array<Record<string, any>> {
  if (scenes.some(scene => scene.layout === 'compare')) return scenes;
  if (!(brief && briefWantsComparison(brief)) && !scenes.some(sceneHintsComparison)) return scenes;
  const candidate = chooseComparisonScene(scenes, protectedScenes);
  if (!candidate) return scenes;
  candidate.layout = 'compare';
  delete candidate.variant;
  ensureComparisonPlates(candidate);
  if (candidate.copy?.headline) candidate.copy.headline = clampText(candidate.copy.headline, COPY_LIMITS.compare.headline);
  return scenes;
}

/** A scene that cannot render is an actionable 422, never a silent layout downgrade. */
function sceneDataError(sceneId: string, layout: string, detail: string, code: 'SCENE_DATA_REQUIRED' | 'SCENE_DATASET_UNKNOWN' | 'SCENE_DATA_DISPLAY_INVALID'): Error {
  return Object.assign(
    new Error(`${sceneId}: layout ${layout} ${detail} Set data.dataset to a dataset id from datasets and data.display to bar, number or counter.`),
    { name: 'SceneDataError', status: 422, code },
  );
}

/** The brief pinned the list length; dropping or inventing bullets is a 422, never a silent trim. */
function sceneListItemsError(sceneId: string, required: number, supplied: number): Error {
  return Object.assign(
    new Error(`${sceneId}: the brief requires exactly ${required === 6 ? 'six' : required} items in the list scene, but the plan supplied ${supplied}. Return ${required} distinct strings in copy.items (or scene.items); the tool will not silently truncate or invent bullets.`),
    { name: 'SceneListItemsError', status: 422, code: 'SCENE_LIST_ITEMS_REQUIRED' },
  );
}

function clampListItem(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return clampText(String(value), 72);
  return clampText(value, 72);
}

/** Recover line or semicolon separated bullets when a model put a six-item list in body/sub. */
function itemsFromText(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/\r?\n|;/)
    .map(line => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Coerce a model-authored scene into the published package shape: a valid
 * layout, readable copy, a real dataset reference, a known variant/background,
 * and only schema-known keys. Assets that do not exist yet are dropped.
 */
function normalizeScene(raw: Record<string, any>, fallbackTitle: string, datasetIds: Set<string>, assetIds: Set<string>, datasetAliases?: Map<string, string>, requiredListItems?: number): Record<string, any> {
  const source: Record<string, any> = { ...raw };
  const rawId = typeof source.id === 'string' ? source.id : '';
  const id = SCENE_ID_RE.test(rawId) ? rawId : `s_${hashId('', rawId || fallbackTitle).slice(0, 12)}`;
  const layout: SceneLayout = (SCENE_LAYOUTS as readonly string[]).includes(source.layout) ? source.layout : inferSceneLayout(source);

  const copy: Record<string, any> = typeof source.copy === 'string'
    ? { headline: source.copy }
    : source.copy && typeof source.copy === 'object' ? { ...source.copy } : {};
  if (!copy.headline && typeof source.title === 'string') copy.headline = source.title;
  if (!copy.headline && typeof source.headline === 'string') copy.headline = source.headline;
  // The conversation-plan shape carries bullets at scene level; lift them so a
  // list scene does not lose every item on the way into the package.
  if (!Array.isArray(copy.items) && Array.isArray(source.items)) copy.items = [...source.items];
  for (const key of Object.keys(copy)) if (!COPY_KEYS.has(key)) delete copy[key];

  const finalLayout: SceneLayout = layout;
  let data = source.data && typeof source.data === 'object' ? { ...source.data } : undefined;
  if (data) {
    const requestedDatasetId = typeof data.dataset === 'string' ? data.dataset.trim() : '';
    if (!requestedDatasetId) throw sceneDataError(id, finalLayout, 'has data but no dataset id.', 'SCENE_DATA_REQUIRED');
    const datasetId = datasetAliases?.get(requestedDatasetId) ?? requestedDatasetId;
    if (!datasetIds.has(datasetId)) throw sceneDataError(id, finalLayout, `references unknown dataset "${requestedDatasetId}".`, 'SCENE_DATASET_UNKNOWN');
    data.dataset = datasetId;
    for (const key of Object.keys(data)) if (key !== 'dataset' && key !== 'display') delete data[key];
    if (data.display !== undefined && !['bar', 'number', 'counter'].includes(data.display)) {
      throw sceneDataError(id, finalLayout, `has unsupported data.display "${String(data.display)}".`, 'SCENE_DATA_DISPLAY_INVALID');
    }
    if (finalLayout === 'stat' && data.display === undefined) data.display = 'number';
    if (finalLayout === 'chart' && data.display === undefined) data.display = 'bar';
  }
  if (['stat', 'chart'].includes(finalLayout) && !data) {
    throw sceneDataError(id, finalLayout, 'requires a dataset reference but none was provided.', 'SCENE_DATA_REQUIRED');
  }

  const limits = COPY_LIMITS[finalLayout];
  for (const [key, max] of Object.entries(limits)) if (copy[key] !== undefined) copy[key] = clampText(copy[key], max);
  if (!Array.isArray(copy.items) && requiredListItems && finalLayout === 'list') {
    const extracted = itemsFromText(copy.body);
    copy.items = extracted.length > 0 ? extracted : itemsFromText(copy.sub);
  }
  if (Array.isArray(copy.items)) {
    const items = copy.items.map(clampListItem).filter((item): item is string => Boolean(item));
    if (requiredListItems && finalLayout === 'list' && items.length < requiredListItems) {
      throw sceneListItemsError(id, requiredListItems, items.length);
    }
    copy.items = items.slice(0, requiredListItems ?? 6);
  }
  if (!copy.headline && finalLayout !== 'code') copy.headline = clampText(source.title ?? fallbackTitle ?? id, limits.headline ?? 48);
  if (finalLayout === 'code' && !copy.headline) delete copy.headline;

  let variant = source.variant;
  const allowedVariants = LAYOUT_VARIANTS[finalLayout];
  if (typeof variant !== 'string' || (allowedVariants.length > 0 && !allowedVariants.includes(variant))) variant = undefined;
  if (finalLayout === 'list' && variant === 'bullets' && (!Array.isArray(copy.items) || copy.items.length < 2)) variant = undefined;
  if (finalLayout === 'list' && variant === 'quote' && !copy.quote) variant = undefined;

  let background = source.background && typeof source.background === 'object' ? { ...source.background } : undefined;
  if (background) {
    // Accept a bare `{ pattern }` shape as procedural.
    if (background.procedural === undefined && typeof background.pattern === 'string') background = { procedural: { pattern: background.pattern } };
    const procedural = background.procedural && typeof background.procedural === 'object' ? { ...background.procedural } : undefined;
    if (procedural) {
      if (!BACKGROUND_PATTERNS.includes(procedural.pattern)) procedural.pattern = 'gradient';
      if (procedural.seed !== undefined && !Number.isInteger(procedural.seed)) delete procedural.seed;
      if (Array.isArray(procedural.palette)) procedural.palette = procedural.palette.filter((c: unknown) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 8);
    }
    const asset = typeof background.asset === 'string' && assetIds.has(background.asset) ? background.asset : undefined;
    if (procedural) background = { procedural };
    else if (asset) background = { asset };
    else background = undefined;
  }

  const foreground = Array.isArray(source.foreground)
    ? source.foreground
      .filter((item: any) => item && typeof item === 'object' && typeof item.asset === 'string' && assetIds.has(item.asset))
      .slice(0, 12)
      .map(sanitizeForegroundItem)
    : [];

  const scene: Record<string, any> = { id, layout: finalLayout };
  if (variant) scene.variant = variant;
  // A live model usually omits preferredFrames; fall back to a readable length
  // instead of the planner's bare minimum so the package is a usable video.
  scene.preferredFrames = Number.isInteger(source.preferredFrames) && source.preferredFrames > 0 ? source.preferredFrames : DEFAULT_SCENE_FRAMES[finalLayout];
  if (Object.keys(copy).length > 0) scene.copy = copy;
  if (data) scene.data = data;
  if (background) scene.background = background;
  scene.foreground = foreground;
  if (source.media_only === true) scene.media_only = true;
  if (source.lower_third && typeof source.lower_third === 'object' && typeof source.lower_third.text === 'string') {
    scene.lower_third = { ...(typeof source.lower_third.kicker === 'string' ? { kicker: source.lower_third.kicker } : {}), text: source.lower_third.text };
  }
  const transitionOut = normalizeTransitionOut(source.transitionOut);
  if (transitionOut) scene.transitionOut = transitionOut;
  const motion = normalizeSceneMotion(source.motion);
  if (motion) scene.motion = motion;
  if ((PRESENTER_SCENE_VALUES as readonly string[]).includes(source.presenter)) scene.presenter = source.presenter;
  if (typeof source.presenter_asset === 'string' && assetIds.has(source.presenter_asset)) scene.presenter_asset = source.presenter_asset;
  const narration = clampText(source.narration, 600);
  if (narration) scene.narration = narration;
  if (typeof source.notes === 'string') scene.notes = clampText(source.notes, 512);
  if (Array.isArray(source.cast)) {
    const ids: string[] = [];
    for (const id of source.cast) {
      if (typeof id === 'string' && /^c[A-Za-z0-9_-]{0,63}$/.test(id) && !ids.includes(id)) ids.push(id);
    }
    if (ids.length) scene.cast = ids.slice(0, 8);
  }
  if (finalLayout === 'code') {
    const block = sanitizeCodeBlock(source.code, DEFAULT_CHARS_PER_SECOND);
    if (block) scene.code = block;
  }
  if (Array.isArray(source.media)) {
    const plates = source.media.map((plate: any) => sanitizePlate(plate, assetIds)).filter(Boolean).slice(0, 2);
    if (plates.length === 2) scene.media = plates;
  }
  // SCENE_KEYS is the allow-list. `motion` has to be in it or this drops the field.
  for (const key of Object.keys(scene)) if (!SCENE_KEYS.has(key)) delete scene[key];
  return scene;
}

function applyProductionIntentToScene(scene: Record<string, any>, intent: ProductionIntent): Record<string, any> {
  if (!intent.generatedFilm) return scene;
  const next = { ...scene };
  if (intent.noCaptions) {
    delete next.copy;
    delete next.lower_third;
    // Title/hero layouts require a headline. A copy-free list layout is the
    // schema-supported shell; generate_video subsequently enables media_only.
    if (['title', 'hero', 'stat', 'chart', 'code'].includes(next.layout)) {
      next.layout = 'list';
      delete next.variant;
      delete next.data;
      delete next.code;
    }
  }
  if (intent.wordless) {
    delete next.narration;
    delete next.narration_asset;
  }
  return next;
}

function withMotionFixes<T extends Record<string, unknown>>(result: T, pkg: Record<string, any>): T {
  const fixes = motionFixInstructions(lintPackageMotion(pkg));
  if (fixes.length === 0) return result;
  return { ...result, motion_fixes: fixes };
}

/** Acceptance phrase for CAST1. Fictional mascot only; never a real person or a user photo. */
const SHARED_MASCOT_RE = /use the same mascot in every scene/i;
const KLEIN_REF_CAP = 10;

/** The shared mascot follows the package theme palette so packaging never rejects it. */
function sharedMascotSvg(palette?: readonly string[]): string {
  const ink = palette?.[0] ?? '#0d0f14';
  const background = palette?.[1] ?? ink;
  const accent = palette?.[2] ?? palette?.[1] ?? ink;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
    `<rect width="512" height="512" fill="${background}"/>`,
    `<circle cx="256" cy="210" r="116" fill="${accent}"/>`,
    `<circle cx="214" cy="190" r="16" fill="${ink}"/>`,
    `<circle cx="298" cy="190" r="16" fill="${ink}"/>`,
    `<path d="M214 246 Q256 286 298 246" fill="none" stroke="${ink}" stroke-width="10" stroke-linecap="round"/>`,
    '</svg>',
  ].join('');
}

function briefWantsSharedMascot(brief: string): boolean {
  return SHARED_MASCOT_RE.test(brief);
}

function buildSharedMascot(palette: readonly string[] | undefined, persistSvg: ToolsetOptions['persistSvg']) {
  const svg = sharedMascotSvg(palette);
  const sha256 = createHash('sha256').update(svg).digest('hex');
  const assetId = 'a_cast_pip';
  // Persist the bytes at propose time. Declaring a file without writing it made
  // every later render fail with an untyped ENOENT during packaging (M10).
  const file = persistSvg?.(assetId, svg, 'svg') ?? `assets/${assetId}.svg`;
  return {
    member: {
      id: 'c_pip',
      name: 'Pip',
      description: 'Pip is a fictional round mascot, framed head and shoulders. Not a real person.',
      ref_asset: assetId,
    },
    assetId,
    asset: {
      kind: 'svg',
      origin: 'generated',
      status: 'ready',
      file,
      sha256,
      bytes: Buffer.byteLength(svg),
      license: { id: 'CC0-1.0' },
      redistributable: true,
      gen: {
        generator: 'llm-svg',
        sanitizer_version: '1.0.0',
        render_check: { ok: true, version: '1.0.0', width: 512, height: 512 },
        caption: 'Pip, a fictional round mascot, head and shoulders.',
      },
    },
  };
}

function castRefsForScene(pkg: Record<string, any> | undefined, sceneId: string): { ids: string[]; refs: string[] } {
  const members = (Array.isArray(pkg?.cast) ? pkg.cast : []).filter(
    (member: any) => member && typeof member.id === 'string' && typeof member.ref_asset === 'string',
  );
  if (!members.length) return { ids: [], refs: [] };
  const scene = (Array.isArray(pkg?.scenes) ? pkg.scenes : []).find((item: any) => item?.id === sceneId);
  const named = new Set((Array.isArray(scene?.cast) ? scene.cast : []).filter((id: unknown) => typeof id === 'string'));
  const chosen = named.size ? members.filter((member: any) => named.has(member.id)) : members;
  return { ids: chosen.map((member: any) => member.id), refs: chosen.map((member: any) => member.ref_asset) };
}

/** Existing refs first, then cast refs, capped at Klein's 10 reference images. */
function mergeRefs(userRefs: string[], castRefs: string[]): string[] {
  const out: string[] = [];
  for (const ref of [...userRefs, ...castRefs]) {
    if (!ref || out.includes(ref) || out.length >= KLEIN_REF_CAP) continue;
    out.push(ref);
  }
  return out;
}

/** Model-invented role names like shot_2_identity_reference are never asset ids. */
const PLACEHOLDER_REF_RE = /identity|subject|character|cast|portrait|mascot|composition|art[_-]?direction|reference|start[_-]?frame|^shot[_-]?\d+/i;
const IDENTITY_REF_RE = /identity|subject|character|cast|portrait|mascot/i;

function isPlaceholderRef(id: string): boolean {
  return PLACEHOLDER_REF_RE.test(id);
}

/** A reference that names no package asset is a 422 before semantic validation can fail. */
function semanticRefError(sceneId: string, role: string, id: string): Error {
  return Object.assign(
    new Error(`${sceneId}: ${role} ${JSON.stringify(id)} is not an asset id in this package. Create the reference with assets.generate_image or assets.generate_svg and pass its returned id; invented placeholder names are rejected before the package can fail semantic validation.`),
    { name: 'SemanticRefError', status: 422, code: 'SEM_REF_UNRESOLVED', assetId: id },
  );
}

/**
 * Tools the model may call. Approval-requiring tools (spend, stock attach,
 * uploads) return a card request and never perform the action here.
 */
export function createToolset(options: ToolsetOptions = {}): Record<string, AgentTool> {
  const configuredMotionModel = parseMotionModel(options.motionModel, 'auto');
  const state: { package?: Record<string, any>; intent?: ProductionIntent; proposal?: z.infer<typeof proposeSchema>['proposal']; brief?: string } = {
    package: options.initialPackage ? structuredClone(options.initialPackage) : undefined,
    intent: options.initialPackage ? options.initialIntent : undefined,
    proposal: options.initialPackage?.proposal,
  };
  // Rebuild the whole-film stem as each shot arrives. Using only the first
  // shot's plan made otherwise different scenes share one generic sound bed.
  const finishingSoundPlans = new Map<string, string>();
  // Role of each planned image, so a later invented identity name can bind the
  // real raster identity even when the package has no cast member.
  const plannedImageRoles = new Map<string, { sceneId: string; kind: string }>();

  const touch = () => {
    if (state.package) options.onPackageChange?.(state.package);
  };

  /** A raster identity image already linked to this scene's cast, if one exists. */
  const existingIdentityImageId = (sceneId: string, castIds: string[]): string | undefined => {
    const assets = state.package?.assets ?? {};
    const scene = (Array.isArray(state.package?.scenes) ? state.package.scenes : []).find((item: any) => item?.id === sceneId);
    const sceneCast = new Set([
      ...(Array.isArray(scene?.cast) ? scene.cast : []),
      ...castIds,
    ]);
    const linked = Object.entries(assets).filter(([id, asset]: [string, any]) => {
      if (asset?.kind !== 'image') return false;
      if (typeof asset.cast === 'string' && sceneCast.has(asset.cast)) return true;
      return (Array.isArray(scene?.foreground) && scene.foreground.some((item: any) => item?.asset === id))
        || (Array.isArray(scene?.media) && scene.media.some((item: any) => item?.asset === id));
    });
    const plannedIdentity = Object.entries(assets).find(([id, asset]: [string, any]) => {
      if (asset?.kind !== 'image') return false;
      const role = plannedImageRoles.get(id);
      return role?.sceneId === sceneId && IDENTITY_REF_RE.test(role.kind);
    });
    if (!linked.length && !plannedIdentity) return undefined;
    const identity = linked.find(([, asset]: [string, any]) =>
      IDENTITY_REF_RE.test(`${asset?.gen?.inputs?.prompt ?? ''} ${asset?.notes ?? ''}`));
    return (identity ?? plannedIdentity ?? linked[0])[0];
  };

  /**
   * Resolve a model-supplied reference to a real package asset. A placeholder
   * identity name binds the scene's existing cast identity instead of entering
   * the package as a dangling gen.inputs.reference.
   */
  const resolveReferenceId = (
    raw: string,
    sceneId: string,
    role: string,
    cast: { ids: string[]; refs: string[] },
    rasterOnly = false,
  ): string => {
    const id = raw.trim();
    if (state.package?.assets?.[id]) return id;
    if (!isPlaceholderRef(id)) return id;
    if (IDENTITY_REF_RE.test(id)) {
      const castRef = cast.refs.find(ref => state.package?.assets?.[ref]);
      if (!rasterOnly && castRef) return castRef;
      const imageId = existingIdentityImageId(sceneId, cast.ids);
      if (imageId) return imageId;
      const castImage = cast.refs.find(ref => state.package?.assets?.[ref]?.kind === 'image');
      if (castImage) return castImage;
    }
    throw semanticRefError(sceneId, role, id);
  };

  const propose = (args: z.infer<typeof proposeSchema>) => {
    const rawTitle = args.title ?? args.brief.slice(0, 90);
    const title = rawTitle.length > 48 ? `${rawTitle.slice(0, 45).trimEnd()}…` : rawTitle;
    const id = hashId('pkg', args.brief);
    const format = resolveFormat(args.brief);
    const requiredListItems = briefListItems(args.brief);
    const normalizedDatasets = normalizeDatasets(args.datasets);
    const sharedDataset = briefSharedDataset(args.brief, normalizedDatasets);
    const datasets = sharedDataset?.datasets ?? normalizedDatasets.datasets;
    const datasetIds = new Set(Object.keys(datasets));
    const datasetAliases = sharedDataset ? new Map([[sharedDataset.id, sharedDataset.id]]) : normalizedDatasets.aliases;
    const intent = classifyProductionIntent(args.brief);
    state.intent = intent;
    state.brief = args.brief;
    state.proposal = args.proposal;
    const scenes = (args.scenes?.length
      ? preparePlanningScenes(args.scenes, args.brief, sharedDataset?.id, requiredListItems)
        .map(scene => ensureComparisonPlates(normalizeScene(scene, title, datasetIds, new Set(), datasetAliases, requiredListItems)))
      : [{ id: 's1', layout: 'title' as const, preferredFrames: 120, copy: { headline: title, sub: '' } }])
      .map(scene => applyProductionIntentToScene(scene, intent));
    const theme = { palette: ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'], font: 'Inter', ...brandTheme(options.brand) };
    const mascot = briefWantsSharedMascot(args.brief) ? buildSharedMascot(theme.palette, options.persistSvg) : null;
    if (mascot) {
      for (const scene of scenes) scene.cast = [mascot.member.id];
    }
    state.package = {
      $schema: 'https://comfyrizz.example/schema/package-v1.json',
      schemaVersion: 1,
      revision: 1,
      id,
      title,
      createdAt: (options.now ?? (() => new Date().toISOString()))(),
      format,
      duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
      theme,
      voice: { enabled: false, engine: 'none' },
      datasets,
      ...(args.proposal ? { proposal: args.proposal } : {}),
      scenes,
      ...(mascot ? { cast: [mascot.member] } : {}),
      assets: { ...(options.brandAssets ?? {}), ...(mascot ? { [mascot.assetId]: mascot.asset } : {}) },
      compliance: { open_weights_only: true },
      ...(mascot ? { presenter: { enabled: false, cast: mascot.member.id, portrait: mascot.member.id } } : {}),
      renders: [],
    };
    const motion = normalizePackageMotion(args.motion);
    if (motion) state.package.motion = motion;
    touch();
    return withMotionFixes(
      { package: state.package, revision: state.package.revision, proposal: state.proposal ?? null, placeholders: scenes.length === 1 && !args.scenes ? ['duration', 'palette'] : [] },
      state.package,
    );
  };

  const edit = (args: z.infer<typeof editSchema>) => {
    if (!state.package) throw new Error('no package draft; call storyboard.propose first');
    const draft = state.package;
    const requiredListItems = state.brief ? briefListItems(state.brief) : undefined;
    const normalizedDatasets = normalizeDatasets(draft.datasets);
    const sharedDataset = state.brief ? briefSharedDataset(state.brief, normalizedDatasets) : null;
    const datasets = sharedDataset?.datasets ?? normalizedDatasets.datasets;
    const aliases = sharedDataset ? new Map([[sharedDataset.id, sharedDataset.id]]) : normalizedDatasets.aliases;
    const scenes: any[] = Array.isArray(draft.scenes) ? draft.scenes : [];
    const remappedScenes = scenes.map(scene => {
      if (sharedDataset) {
        return { ...scene, data: { dataset: sharedDataset.id, display: scene?.layout === 'stat' ? 'number' : 'bar' } };
      }
      const currentDataset = typeof scene?.data?.dataset === 'string' ? scene.data.dataset : '';
      const datasetId = currentDataset ? aliases.get(currentDataset) : undefined;
      return datasetId && datasetId !== currentDataset
        ? { ...scene, data: { ...scene.data, dataset: datasetId } }
        : scene;
    });
    const index = remappedScenes.findIndex(scene => scene?.id === args.scene_id);
    if (index < 0) throw new Error(`scene ${args.scene_id} not found`);
    const current = remappedScenes[index] ?? {};
    const patch = args.patch as Record<string, any>;
    const datasetIds = new Set(Object.keys(datasets));
    const assetIds = new Set(Object.keys(draft.assets ?? {}));
    let nextScenes = remappedScenes.map((scene, sceneIndex) => sceneIndex === index
      ? applyProductionIntentToScene(ensureComparisonPlates(normalizeScene(mergeScenePatch(current, patch), draft.title, datasetIds, assetIds, aliases, requiredListItems)), state.intent ?? classifyProductionIntent(''))
      : scene);
    for (const scene of nextScenes) ensureComparisonPlates(scene);
    const patchSetsLayout = typeof patch.layout === 'string' && (SCENE_LAYOUTS as readonly string[]).includes(patch.layout);
    const protectedLists = new Set<Record<string, any>>(requiredListItems ? nextScenes.filter(scene => scene.layout === 'list') : []);
    if (!patchSetsLayout) nextScenes = ensureComparisonScene(nextScenes, state.brief, protectedLists);
    state.package = { ...draft, datasets, scenes: nextScenes, revision: Number(draft.revision ?? 0) + 1 };
    touch();
    return withMotionFixes(
      { package: state.package, revision: state.package.revision, scene_id: args.scene_id },
      state.package,
    );
  };

  const route = (args: z.infer<typeof routeSchema>): RouteDecision =>
    routeAsset({ sceneId: args.scene_id, intent: args.need, kind: args.kind, animated: args.animated, transparent: args.transparent, source: args.source, style: args.style } as AssetNeed);

  const generateSvg = async (args: z.infer<typeof generateSvgSchema>) => {
    // A5 and the packaging render-check must agree on one source of colour:
    // the package theme. A model-supplied palette is only a pre-propose fallback.
    const packagePalette = Array.isArray(state.package?.theme?.palette)
      ? state.package.theme.palette.filter((color: unknown): color is string => typeof color === 'string')
      : [];
    const palette = packagePalette.length ? packagePalette : args.palette;
    const intent: SvgIntentLike = {
      kind: args.kind,
      prompt: args.intent,
      ...(palette ? { palette } : {}),
      ...(args.width ? { width: args.width } : {}),
      ...(args.height ? { height: args.height } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    };
    if (!options.generateSvg) throw new Error('SVG generator is not configured');
    const result = await options.generateSvg(intent);
    if (!result?.svg) throw new Error('SVG generator returned no markup');
    const sha256 = createHash('sha256').update(result.svg).digest('hex');
    const id = hashId('a_svg', `${args.scene_id}:${args.intent}:${sha256}`);
    const kind = args.kind === 'vector-anim' ? 'vector-anim' : 'svg';
    const rawCheck = result.renderCheck;
    const paletteOk = rawCheck ? rawCheck.outOfPaletteFraction == null || rawCheck.outOfPaletteFraction <= 0.5 : true;
    const renderCheck = rawCheck
      ? {
          ok: rawCheck.ok === true,
          ...(rawCheck.version ? { version: rawCheck.version } : {}),
          ...(rawCheck.width ? { width: rawCheck.width } : {}),
          ...(rawCheck.height ? { height: rawCheck.height } : {}),
          blank: typeof rawCheck.opaqueFraction === 'number' ? rawCheck.opaqueFraction < 0.005 : false,
          palette_ok: paletteOk,
        }
      : { ok: true, version: result.sanitizerVersion ?? '1.0.0' };
    if (!paletteOk) {
      const fraction = typeof rawCheck?.outOfPaletteFraction === 'number' ? rawCheck.outOfPaletteFraction : null;
      throw svgAssetError(
        'SVG_PALETTE_MISMATCH',
        id,
        `render-check failed: out-of-palette${fraction === null ? '' : ` (${(fraction * 100).toFixed(0)}% of visible pixels)`}`,
      );
    }
    if (!renderCheck.ok) throw svgAssetError('SVG_RENDER_CHECK_FAILED', id, 'render-check failed');
    const file = result.file ?? options.persistSvg?.(id, result.svg, kind) ?? `assets/${id}.svg`;
    const asset = {
      kind,
      origin: 'generated',
      status: 'ready',
      file,
      sha256,
      bytes: Buffer.byteLength(result.svg),
      license: { id: 'CC0-1.0' },
      redistributable: true,
      gen: {
        generator: 'llm-svg',
        sanitizer_version: result.sanitizerVersion ?? '1.0.0',
        render_check: renderCheck,
        caption: args.intent,
      },
    };
    if (state.package) {
      const assets = { ...(state.package.assets ?? {}), [id]: asset };
      const scenes = (Array.isArray(state.package.scenes) ? state.package.scenes : []).map(scene => {
        if (scene?.id !== args.scene_id) return scene;
        const existing = Array.isArray(scene.foreground) ? scene.foreground : [];
        if (existing.some((item: any) => item?.asset === id)) return scene;
        const index = existing.length;
        const slot = foregroundFor(args.scene_id, index);
        const placement = slot ?? { x: 0.5, y: 0.5 + index * 0.05, w: 0.2, anim: 'fade-in' };
        return { ...scene, foreground: [...existing, { ...placement, asset: id }] };
      });
      state.package = { ...state.package, assets, scenes, revision: Number(state.package.revision ?? 0) + 1 };
      touch();
    }
    return {
      scene_id: args.scene_id,
      asset: { id, ...asset, format: 'svg', svg: result.svg },
      pipeline: {
        sanitized: true,
        render_checked: renderCheck.ok === true,
        attempts: result.attempts ?? 1,
        repairs: result.repairs ?? 0,
        sanitizer_version: result.sanitizerVersion ?? '1.0.0',
      },
    };
  };

  const planImage = (args: z.infer<typeof generateImageSchema>) => {
    const planned = options.planImage?.(args) ?? {};
    const format = state.package?.format ?? {};
    const outputAspect = aspectFromSize(format.width, format.height);
    const formatWidth = Number(format.width);
    const formatHeight = Number(format.height);
    const hasOutputSize = Number.isInteger(formatWidth) && formatWidth > 0 && Number.isInteger(formatHeight) && formatHeight > 0;
    const requestedAspect = args.aspect as Aspect | undefined;
    // Source stills must match the output frame exactly: i2v centre-crops a
    // mismatched source. Portrait, square and 4:5 films always source at their
    // own output aspect and dimensions; a landscape film keeps an explicit
    // alternate framing for a deliberate crop.
    const plannedAspect = requestedAspect && outputAspect === '16:9'
      ? requestedAspect
      : outputAspect;
    const dims = plannedAspect === outputAspect && hasOutputSize
      ? { width: formatWidth, height: formatHeight }
      : sourceDims(plannedAspect);
    const palette = Array.isArray(state.package?.theme?.palette) ? state.package.theme.palette : undefined;
    const cast = castRefsForScene(state.package, args.scene_id);
    const requestedRefs = (args.refs ?? []).map(ref => resolveReferenceId(ref, args.scene_id, 'reference', cast));
    const refs = mergeRefs(requestedRefs, cast.refs);
    const isRefEdit = refs.length > 0;
    // B1: the same STYLE_BLOCK goes on every image job, so a run does not drift
    // from the owner's palette/attributes after the first call.
    const styleBlock = options.brand
      ? brandStyleBlock(options.stylePreset ?? 'cinematic-dark', options.brand)
      : undefined;
    const caption = planned.caption ?? (isRefEdit
      ? expandReferenceEditCaption({
          intent: args.intent,
          ...(args.style ? { style: args.style } : {}),
          ...(palette ? { palette } : {}),
          aspect: plannedAspect,
        })
      : expandFluxCaption({
          intent: args.intent,
          ...(args.style ? { style: args.style } : {}),
          ...(palette ? { palette } : {}),
          ...(styleBlock ? { styleBlock } : {}),
          ...(args.cutout ? { cutout: true } : {}),
          ...(args.text ? { text: true } : {}),
          ...(args.labelled ? { labelled: true } : {}),
          aspect: plannedAspect,
        }));
    const id = hashId('a_img', `${args.scene_id}:${args.intent}:${args.seed ?? 0}:${caption}`);
    plannedImageRoles.set(id, { sceneId: args.scene_id, kind: args.kind ?? '' });
    const defaultWorkflow = isRefEdit ? 'workflows/flux3_klein_ref_edit.api.json' : 'workflows/flux3_klein_t2i.api.json';
    // P-fix5: the jobs planner requires `gen.workflow_sha256`, so a package built by the
    // agent must stamp it. A caller-provided plan wins; otherwise the committed manifest
    // supplies the hash for the workflow this tool is about to name.
    const workflow = planned.workflow ?? defaultWorkflow;
    const workflowSha256 = planned.workflowSha256 ?? WORKFLOW_SHA256[workflow];
    // The package schema only allows scalar gen.inputs values. ReferenceMultiLatent wires
    // image0 from the first ref; further refs are reference_2 … (Klein's cap is 10). The
    // planner turns those into uploaded `_reference_N` file inputs.
    const extraRefs = isRefEdit && refs.length > 1
      ? Object.fromEntries(refs.slice(1).map((ref, index) => [`reference_${index + 2}`, ref]))
      : {};
    const defaultInputs: Record<string, unknown> = {
      prompt: caption,
      width: dims.width,
      height: dims.height,
      seed: args.seed ?? 0,
      ...(args.cutout ? { cutout: true } : {}),
      ...(isRefEdit ? { reference: refs[0], text: true, ...extraRefs } : {}),
    };
    const asset = {
      kind: 'image',
      origin: 'generated',
      status: 'pending',
      license: { id: 'CC0-1.0' },
      model_license: { id: 'FLUX-Kommunity', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein', note: 'FLUX Kommunity License v1.0; model terms are separate from generated-output rights.' },
      redistributable: true,
      ...(cast.ids[0] ? { cast: cast.ids[0] } : {}),
      notes: isRefEdit
        ? 'pending-GPU: ReferenceMultiLatent keeps the source layout/labels while restyling (GPU test 2)'
        : 'pending-GPU: procedural background is the CPU fallback until a spend is approved',
      gen: {
        generator: 'flux3-klein',
        workflow,
        ...(workflowSha256 ? { workflow_sha256: workflowSha256 } : {}),
        model: planned.model ?? 'flux-3-klein',
        inputs: planned.inputs
          ? { ...planned.inputs, ...(plannedAspect === outputAspect && hasOutputSize ? { width: formatWidth, height: formatHeight } : {}) }
          : defaultInputs,
        backend: planned.backend ?? 'colab:G4',
      },
    };
    if (state.package) {
      const referenceOnly = (isRefEdit && cast.ids.length === 0) || /\b(?:reference|identity|cast|portrait|start[\s-]?frame)\b/i.test(args.kind ?? '');
      const scenes = (Array.isArray(state.package.scenes) ? state.package.scenes : []).map((scene: any) => {
        if (scene?.id !== args.scene_id) return scene;
        let next = scene;
        if (cast.ids.length) {
          const existing = Array.isArray(next.cast) ? next.cast : [];
          const castIds = [...existing];
          for (const castId of cast.ids) if (!castIds.includes(castId)) castIds.push(castId);
          if (castIds.length !== existing.length) next = { ...next, cast: castIds.slice(0, 8) };
        }
        if (!referenceOnly) {
          const existing = Array.isArray(next.foreground) ? next.foreground : [];
          if (!existing.some((item: any) => item?.asset === id)) {
            const index = existing.length;
            const placement = foregroundFor(args.scene_id, index) ?? { x: 0.5, y: 0.5 + index * 0.05, w: 0.5, anim: 'fade-in' as const };
            next = { ...next, foreground: [...existing, { ...placement, asset: id }] };
          }
        }
        return next;
      });
      state.package = {
        ...state.package,
        scenes,
        assets: { ...(state.package.assets ?? {}), [id]: asset },
        revision: Number(state.package.revision ?? 0) + 1,
      };
      touch();
    }
    const aspectMismatch = args.aspect !== undefined && plannedAspect !== outputAspect;
    return {
      scene_id: args.scene_id,
      asset: { id, ...asset },
      caption,
      reference_edit: isRefEdit,
      source_aspect: plannedAspect,
      output_aspect: outputAspect,
      requires_approval: 'spend',
      note: aspectMismatch
        ? `planned only; no GPU job was submitted. Source is ${plannedAspect} but the package output is ${outputAspect}: i2v will centre-crop.`
        : 'planned only; no GPU job was submitted',
    };
  };

  const generateVideo = (args: z.infer<typeof generateVideoSchema>) => {
    if (!state.package) throw new Error('no package draft; call storyboard.propose first');
    const sceneIndex = (Array.isArray(state.package.scenes) ? state.package.scenes : []).findIndex((scene: any) => scene?.id === args.scene_id);
    if (sceneIndex < 0) throw new Error(`scene ${args.scene_id} not found`);
    const intent = state.intent ?? classifyProductionIntent('');
    const wordless = args.wordless ?? args.dialogue === undefined;
    if (wordless && args.dialogue) throw new Error('wordless shots cannot also carry dialogue; remove dialogue or set wordless:false');
    if (!wordless && !args.dialogue) throw new Error('wordless:false needs exact dialogue and ready conditioning audio');

    const noText = intent.generatedFilm && intent.noCaptions
      ? ' Every surface, garment and prop is plain and unmarked.'
      : '';
    const direction = {
      subject: args.subject.trim(),
      composition: `${args.composition.trim()}${noText}`,
      action: args.action.trim(),
      camera: args.camera.trim(),
      soundscape: args.soundscape.trim(),
      characterCount: args.characterCount,
      ...(args.dialogue ? { dialogue: { ...args.dialogue } } : {}),
    };
    const model = resolveShotMotionModel(configuredMotionModel, args.motion_model, direction);
    if (model === 'ltx' && args.dialogue) {
      throw new Error('LTX-2.5 i2v does not generate synchronized dialogue; choose motion_model h3 for this shot or make it wordless with an explicit finishing sound plan');
    }
    if (model === 'klein' && args.dialogue) {
      throw new Error('Klein stills + code motion does not accept H3 dialogue conditioning; put speech and sound in finishing_sound, or choose h3 for native AV');
    }

    const cast = castRefsForScene(state.package, args.scene_id);
    const visualRef = (id: string | undefined, role: string, required: boolean): string | undefined => {
      if (!id) {
        if (required) throw new Error(`${model} needs ${role}. Call assets.generate_image for that role and pass its returned asset id; a FLUX still alone is not film completion.`);
        return undefined;
      }
      const resolved = resolveReferenceId(id, args.scene_id, role, cast, true);
      const asset = state.package!.assets?.[resolved];
      if (!asset) throw semanticRefError(args.scene_id, role, resolved);
      if (asset.kind !== 'image') throw new Error(`${role} ${resolved} is ${asset.kind}; ${model} needs a raster image reference, not ${asset.kind}. Generate a proper image reference instead of substituting a still for video.`);
      if (asset.status === 'ready') {
        if (typeof asset.file !== 'string' || typeof asset.sha256 !== 'string') throw new Error(`${role} ${resolved} is ready but has no usable file/sha256; regenerate the image reference.`);
      } else if (asset.status !== 'pending' || asset.gen?.generator !== 'flux3-klein') {
        throw new Error(`${role} ${resolved} is ${asset.status}; provide a ready image or a pending FLUX image plan that the shot can depend on.`);
      }
      return resolved;
    };

    let image = visualRef(args.image, 'Picture 1 (subject/identity)', model === 'h3');
    let reference = visualRef(args.reference, 'Picture 2 (composition/art direction)', model === 'h3');
    if (model === 'ltx' && !image && !reference) {
      throw new Error('LTX-2.5 i2v needs a start-frame image. Generate a shot image with assets.generate_image and pass it as image (or reference).');
    }

    const scene = state.package.scenes[sceneIndex];
    const packageFps = Number(state.package.format?.fps ?? 30);
    const slotSeconds = Number(scene.preferredFrames) / packageFps;
    if (!(slotSeconds > 0.2)) throw new Error(`${args.scene_id}: set preferredFrames and package fps before planning a generated shot`);
    const requestedFrames = args.frames ?? Math.max(1, Math.ceil(slotSeconds * 24));
    let asset: Record<string, any>;
    let id: string;
    let resolvedFrames: number;
    let outputFps = 24;
    let finishingSound: string | undefined;

    if (model === 'h3') {
      let audio: string;
      if (wordless) {
        if (args.audio) throw new Error('wordless H3 shots use the shared silent conditioning asset; omit audio or provide dialogue with an exact-line clip');
        const wav = silentConditioningWav();
        const sha256 = createHash('sha256').update(wav).digest('hex');
        const existing = state.package.assets?.[SILENT_CONDITIONING_ASSET_ID];
        if (existing && (existing.kind !== 'audio' || existing.status !== 'ready' || existing.sha256 !== sha256)) {
          throw new Error(`${SILENT_CONDITIONING_ASSET_ID} already exists with different content; replace the collision before planning wordless H3 shots`);
        }
        if (!existing) {
          const file = options.persistAudio?.(SILENT_CONDITIONING_ASSET_ID, wav, 'silent-conditioning') ?? `assets/${SILENT_CONDITIONING_ASSET_ID}.wav`;
          state.package.assets = {
            ...(state.package.assets ?? {}),
            [SILENT_CONDITIONING_ASSET_ID]: {
              kind: 'audio', origin: 'upload', status: 'ready', file, sha256, bytes: wav.length,
              license: { id: 'CC0-1.0' }, redistributable: true,
              source: { provider: 'repo', id: 'comfyrizz/deterministic-silence-500ms-24k-mono' },
              media: { durationSeconds: 0.5, audio: 'present', codec: 'pcm_s16le' },
              notes: 'Deterministic digital silence for wordless FastH3 conditioning; no TTS model was run.',
            },
          };
        }
        audio = SILENT_CONDITIONING_ASSET_ID;
      } else {
        audio = args.audio ?? '';
        const conditioning = state.package.assets?.[audio];
        if (!args.audio || !conditioning || conditioning.kind !== 'audio' || conditioning.status !== 'ready'
          || typeof conditioning.file !== 'string' || typeof conditioning.sha256 !== 'string'
          || !(Number(conditioning.media?.durationSeconds) > 0)) {
          throw new Error('H3 dialogue needs a ready exact-line audio asset with file, sha256 and measured media.durationSeconds; wordless shots can omit audio to reuse deterministic silence');
        }
      }
      resolvedFrames = nextFastH3Frames(requestedFrames);
      if (resolvedFrames > 362 || slotSeconds > resolvedFrames / 24 + 1 / 24) {
        throw new Error(`${args.scene_id}: the ${slotSeconds.toFixed(3)} s editorial slot exceeds FastH3's legal 17n+5 source duration; shorten the shot or split coverage`);
      }
      id = hashId('a_vid', `${args.scene_id}:h3:${image}:${reference}:${audio}:${resolvedFrames}:${args.seed ?? 0}:${JSON.stringify(direction)}`);
      asset = {
        kind: 'video', origin: 'generated', status: 'pending',
        license: { id: 'LicenseRef-MiniMax-H3-Community' }, redistributable: false,
        model_license: { id: 'LicenseRef-MiniMax-H3-Community', url: 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE' },
        notes: wordless
          ? 'pending-GPU: FastH3 native AV; wordless means no speech, with the directed physical soundscape retained.'
          : 'pending-GPU: FastH3 native AV with exact-line voice conditioning.',
        gen: {
          generator: 'fasth3-omni', workflow: FASTH3_WORKFLOW, workflow_sha256: WORKFLOW_SHA256[FASTH3_WORKFLOW], model: 'fasth3-omni',
          direction: { ...direction, slotSeconds },
          inputs: { image, reference, audio, width: 832, height: 480, frames: resolvedFrames, fps: 24, seed: args.seed ?? 0 },
        },
      };
    } else if (model === 'ltx') {
      finishingSound = args.finishing_sound?.trim();
      if (!finishingSound) {
        throw new Error('LTX-2.5 generates picture without native audio; pass finishing_sound with an explicit soundscape/music/SFX mix plan (or choose h3 for native AV)');
      }
      if (image && reference && image !== reference) {
        // LTX has one start-image slot. Compile a real, traceable start-frame
        // still from both shared roles rather than dropping either reference.
        const start = planImage({
          scene_id: args.scene_id,
          kind: 'ltx-start-frame',
          intent: `${args.subject}. ${args.composition}`,
          refs: [reference!, image!],
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
        });
        const startId = start.asset.id;
        const startAsset = state.package.assets[startId];
        startAsset.gen.inputs.prompt = [
          'Create the first frame of one continuous cinematic shot.',
          `Identity and subject: ${args.subject}.`,
          `Composition and art direction: ${args.composition}.`,
          'Preserve the shared subject identity from Picture 2 and the composition from Picture 1.',
          intent.generatedFilm && intent.noCaptions ? 'Every surface, garment and prop is plain and unmarked.' : 'Background surfaces are clean and unmarked.',
        ].join(' ');
        delete startAsset.gen.inputs.text;
        startAsset.notes = 'pending-GPU: LTX start frame compiled from the shared identity and composition references; this still is an input, not film completion.';
        image = startId;
        reference = undefined;
      } else {
        image = image ?? reference;
        reference = undefined;
      }
      resolvedFrames = nextLtxFrames(requestedFrames);
      if (slotSeconds > resolvedFrames / 24 + 1 / 24) {
        throw new Error(`${args.scene_id}: the ${slotSeconds.toFixed(3)} s slot is longer than the requested LTX source; omit frames to fit the scene or split the shot`);
      }
      const startAsset = state.package.assets[image!];
      const outputAspect = aspectFromSize(state.package.format?.width, state.package.format?.height);
      const fallbackDims = sourceDims(outputAspect);
      const width = Number(startAsset?.gen?.inputs?.width ?? startAsset?.media?.width ?? fallbackDims.width);
      const height = Number(startAsset?.gen?.inputs?.height ?? startAsset?.media?.height ?? fallbackDims.height);
      const prompt = [
        'Use the provided start image as the first frame.',
        `${args.subject.trim()}. ${args.composition.trim()}.`,
        `${args.action.trim()}. ${args.camera.trim()}.`,
        'One continuous shot, no cuts.',
        intent.generatedFilm && intent.noCaptions ? 'Every surface, garment and prop is plain and unmarked.' : 'Background surfaces are clean and unmarked.',
      ].join(' ');
      id = hashId('a_vid', `${args.scene_id}:ltx:${image}:${resolvedFrames}:${args.seed ?? 0}:${prompt}:${finishingSound}`);
      asset = {
        kind: 'video', origin: 'generated', status: 'pending',
        license: { id: 'CC0-1.0' }, redistributable: true,
        model_license: { id: 'LTX-2.x-Community', url: 'https://huggingface.co/Lightricks/LTX-2.5' },
        media: { audio: 'none', fps: 24, frames: resolvedFrames },
        notes: `pending-GPU: LTX-2.5 picture only; no native audio. Finishing sound plan: ${finishingSound}`,
        gen: {
          generator: 'ltx25', workflow: LTX_I2V_WORKFLOW, workflow_sha256: WORKFLOW_SHA256[LTX_I2V_WORKFLOW], model: 'ltx-2.5',
          inputs: { image, prompt, width, height, frames: resolvedFrames, fps: 24, seed: args.seed ?? 0, strength: 0.85 },
        },
      };
    } else {
      finishingSound = args.finishing_sound?.trim();
      if (!finishingSound) {
        throw new Error('Klein stills + code motion generates no native audio; pass finishing_sound with an explicit soundscape/music/SFX mix plan');
      }
      const refs = [...new Set([image, reference].filter((value): value is string => typeof value === 'string' && value.length > 0))];
      const keyframe = planImage({
        scene_id: args.scene_id,
        kind: 'klein-film-keyframe',
        intent: `${args.subject}. ${args.composition}. Keyframe for: ${args.action}`,
        refs,
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      });
      id = keyframe.asset.id;
      asset = state.package.assets[id];
      asset.gen.inputs.prompt = `${asset.gen.inputs.prompt} Single still keyframe only; camera movement, transitions and timing are handled by Remotion. stills + code motion.`;
      delete asset.gen.inputs.text;
      asset.media = { ...(asset.media ?? {}), audio: 'none' };
      asset.notes = `pending-GPU: Klein image keyframe only, not generated character animation. stills + code motion; Remotion handles camera movement, transitions and timing. Finishing sound plan: ${finishingSound}`;
      resolvedFrames = Number(scene.preferredFrames);
      outputFps = packageFps;
    }

    const scenes = state.package.scenes.map((candidate: any, index: number) => {
      if (index !== sceneIndex) return candidate;
      let next = applyProductionIntentToScene(candidate, intent);
      const mediaIndex = args.media_index ?? 0;
      const existingMedia = Array.isArray(next.media) && next.media.length === 2 ? next.media : [{ asset: id }, { asset: id }];
      next.media = existingMedia.map((plate: any, plateIndex: number) => plateIndex === mediaIndex ? { asset: id } : plate);
      next.background = { asset: id };
      const hasEditorialCopy = Object.values(next.copy ?? {}).some(value =>
        typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) && value.some(item => typeof item === 'string' && item.trim().length > 0));
      // media_only still supports animated lower thirds. When the brief asks
      // for Remotion typography, preserve full copy layouts too; an explicit
      // media_only scene remains the cinematic lower-third-only choice.
      next.media_only = candidate.media_only === true || !hasEditorialCopy;
      if (intent.generatedFilm) next.foreground = [];
      if (model === 'ltx') {
        const note = `LTX finishing sound plan (picture has no native audio): ${finishingSound}`;
        next.notes = clampText(next.notes && !next.notes.includes('LTX finishing sound plan') ? `${next.notes} ${note}` : note, 512);
      }
      if (model === 'klein') {
        next.foreground = [{
          asset: id, x: 0.5, y: 0.5, w: 1,
          anim: /push|dolly|zoom|pan|tracking|drift/i.test(args.camera) ? 'ken-burns' as const : 'fade-in' as const,
        }];
        next.motion = normalizeSceneMotion({
          ...(next.motion ?? {}), entry: next.motion?.entry ?? 'fadeUp', ease: next.motion?.ease ?? 'enter',
          spring: next.motion?.spring ?? 'settle', stagger: next.motion?.stagger ?? 'none', emphasis: next.motion?.emphasis ?? 'none',
        }) ?? { entry: 'fadeUp', ease: 'enter', spring: 'settle', stagger: 'none', emphasis: 'none' };
        next.transitionOut = next.transitionOut ?? { type: 'fade', frames: 15 };
        const note = `Klein stills + code motion; Remotion handles camera movement, transitions and timing. Finishing sound plan (no native audio): ${finishingSound}`;
        next.notes = clampText(next.notes && !next.notes.includes('stills + code motion') ? `${next.notes} ${note}` : note, 512);
      }
      return next;
    });
    if (model === 'klein' && state.proposal) {
      state.proposal = {
        ...state.proposal,
        look: clampText(`stills + code motion; ${state.proposal.look}`, 100)!,
        soundtrack: clampText(`stills + code motion finishing sound: ${finishingSound}`, 100)!,
      };
    }
    const compliance = model === 'klein' ? {
      ...(state.package.compliance ?? {}),
      warnings: [
        ...(Array.isArray(state.package.compliance?.warnings) ? state.package.compliance.warnings : []).filter((note: string) => !note.startsWith('Proposal medium:') && !note.startsWith('Finishing sound plan (stills + code motion):')),
        'Proposal medium: stills + code motion',
        `Finishing sound plan (stills + code motion): ${finishingSound}`,
      ].slice(-64),
    } : state.package.compliance;
    state.package = {
      ...state.package,
      compliance,
      scenes,
      assets: { ...(state.package.assets ?? {}), [id]: asset },
      revision: Number(state.package.revision ?? 0) + 1,
    };
    if (finishingSound && model !== 'h3' && options.persistAudio) {
      finishingSoundPlans.set(args.scene_id, finishingSound);
      const combinedPlan = state.package.scenes
        .map((scene: any) => finishingSoundPlans.get(scene.id))
        .filter((plan: string | undefined): plan is string => Boolean(plan))
        .join(' | ');
      const seconds = scenes.reduce((sum: number, scene: any) => sum + (Number(scene.preferredFrames) || 0), 0) / packageFps;
      const stem = synthesizeFinishingWav(combinedPlan, seconds, args.seed ?? 1);
      const assetId = 'a_finishing_mix';
      const file = options.persistAudio(assetId, stem.wav, 'finishing-stem') ?? `assets/${assetId}.wav`;
      state.package.assets[assetId] = {
        kind: 'audio', origin: 'generated', status: 'ready',
        file, sha256: createHash('sha256').update(stem.wav).digest('hex'), bytes: stem.wav.length,
        media: { durationSeconds: stem.durationSeconds },
        gen: { generator: 'procedural-audio', model: 'deterministic-pcm-v2', inputs: { plan: combinedPlan, seed: args.seed ?? 1 } },
        license: { id: 'CC0-1.0' }, redistributable: true,
        notes: clampText(`Original deterministic procedural finishing stem; not native model audio. Whole-film plan: ${combinedPlan}`, 512),
      };
      state.package.audio = {
        ...(state.package.audio ?? {}),
        music: { asset: assetId, gain_db: configuredMotionModel === 'auto' ? -16 : -12, fade_in_seconds: 0.5, fade_out_seconds: 1, loop: false },
      };
    }
    touch();
    return {
      scene_id: args.scene_id,
      motion_model: model,
      asset: { id, ...asset },
      native_audio: model === 'h3',
      ...(model === 'klein' ? { medium: 'stills + code motion', generated_character_animation: false, ...(state.proposal ? { proposal: state.proposal } : {}) } : {}),
      ...(finishingSound ? { finishing_sound: finishingSound } : {}),
      frames: resolvedFrames,
      fps: outputFps,
      requires_approval: 'spend',
      note: 'planned only; no GPU job was submitted',
    };
  };

  /**
   * Sketch-to-render (C7): a styled hero/background/diagram becomes an SVG base
   * through the A5 pipeline plus a Klein reference edit whose image0 is that SVG
   * (GPU test 2: the reference edit is the best way to style an agent SVG). The
   * SVG is CPU-ready; the restyle is planned only and needs spend approval.
   */
  const sketchToRender = async (args: z.infer<typeof sketchToRenderSchema>) => {
    const svgKind: z.infer<typeof generateSvgSchema>['kind'] =
      args.kind === 'vector-anim' ? 'vector-anim' : args.kind === 'pattern' || args.kind === 'background' ? 'pattern' : 'diagram';
    const svg = await generateSvg({
      scene_id: args.scene_id,
      kind: svgKind,
      intent: args.intent,
      ...(args.palette ? { palette: args.palette } : {}),
      ...(args.width ? { width: args.width } : {}),
      ...(args.height ? { height: args.height } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    });
    const svgAssetId = svg.asset.id;
    const image = planImage({
      scene_id: args.scene_id,
      kind: args.kind,
      intent: args.intent,
      style: args.style,
      refs: [svgAssetId],
      labelled: true,
      ...(args.aspect ? { aspect: args.aspect } : {}),
      ...(args.seed !== undefined ? { seed: args.seed + 1 } : {}),
    });
    return {
      scene_id: args.scene_id,
      kind: args.kind,
      style: args.style,
      reference_edit: true,
      svg_asset: svgAssetId,
      image_asset: image.asset.id,
      svg: svg.asset,
      image: image.asset,
      note: 'SVG is the CPU-ready base; the Klein reference edit is planned only (spend needs approval).',
    };
  };

  /**
   * C-pres: the presenter controls. Pure package mutation (H17 schema); no model,
   * network or GPU. Returns the portrait prompt the agent should pass to
   * assets.generate_image, plus advisory presenter_fixes.
   */
  const presenterSet = (args: z.infer<typeof presenterSetSchema>) => {
    if (!state.package) throw new Error('presenter.set needs a package; call storyboard.propose first');
    const result = applyPresenterSet(state.package, {
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(args.coverage !== undefined ? { coverage: args.coverage } : {}),
      ...(args.preset !== undefined ? { preset: args.preset } : {}),
      ...(args.scenes ? { scenes: args.scenes } : {}),
      ...(args.placement !== undefined ? { placement: args.placement } : {}),
      ...(args.shape !== undefined ? { shape: args.shape } : {}),
      ...(args.size !== undefined ? { size: args.size } : {}),
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.portrait !== undefined ? { portrait: args.portrait } : {}),
      ...(args.preset_style !== undefined ? { presetStyle: args.preset_style as StylePreset } : {}),
      ...(args.backdrop !== undefined ? { backdrop: args.backdrop } : {}),
    });
    state.package = { ...result.package, revision: Number(result.package.revision ?? 0) + 1 };
    touch();
    const findings = result.findings ?? [];
    return withMotionFixes(
      {
        package: state.package,
        revision: state.package.revision,
        summary: result.summary,
        presenter: state.package.presenter ?? null,
        scenes: (Array.isArray(state.package.scenes) ? state.package.scenes : []).map((scene: any) => ({ id: scene.id, presenter: scene.presenter ?? null, presenter_asset: scene.presenter_asset ?? null })),
        portrait_prompt: result.portrait_prompt,
        ...(findings.length
          ? { presenter_fixes: findings.map(finding => (finding.fix ? `${finding.message}; set scenes {${finding.fix.sceneId}: "${finding.fix.presenter}"}` : finding.message)) }
          : {}),
      },
      state.package,
    );
  };

  return {
    'storyboard.propose': tool(
      'storyboard.propose',
      'Create a package draft from a brief. Set package motion and per-scene motion from the system motion vocabulary; never write animation code. Unprovided numbers stay labelled "Example data".',
      baseParameters({
        brief: { type: 'string' },
        title: { type: 'string' },
        proposal: {
          type: 'object',
          additionalProperties: false,
          description: 'A short user-facing film proposal: one or two sentences, not technical production details.',
          properties: {
            logline: { type: 'string', maxLength: 240, description: 'Clear story summary in at most two sentences and 240 characters.' },
            look: { type: 'string', maxLength: 100, description: 'Short visual style description, at most 100 characters.' },
            soundtrack: { type: 'string', maxLength: 100, description: 'Short audio direction, including wordless sound when relevant, at most 100 characters.' },
          },
          required: ['logline', 'look', 'soundtrack'],
        },
        motion: {
          type: 'object',
          additionalProperties: false,
          properties: {
            energy: { type: 'string', enum: [...motionVocab.energies] },
            direction: { type: 'string', enum: [...motionVocab.directions] },
          },
        },
        scenes: { type: 'array', items: { type: 'object' } },
        datasets: { type: 'object', additionalProperties: true, description: 'User datasets keyed by dataset id; plain names are normalized to the schema id form d_regions. Each dataset needs unit, values:[{label,value}] and source; source example needs approved:true. chart/stat/compare scenes reference data.dataset.' },
      }, ['brief']),
      proposeSchema,
      propose,
    ),
    'storyboard.edit': tool(
      'storyboard.edit',
      'Patch one scene (copy, layout, data, background, foreground, motion, transitionOut, narration) by scene id. Apply each motion_fixes entry from the previous result with this tool.',
      baseParameters({ scene_id: { type: 'string' }, patch: { type: 'object' } }, ['scene_id', 'patch']),
      editSchema,
      edit,
    ),
    'assets.route': tool(
      'assets.route',
      'Choose SVG, FLUX image, sketch-to-render (styled SVG base + reference edit), stock search or upload for a scene need. SVG is default for icons/diagrams/charts/patterns.',
      baseParameters({ scene_id: { type: 'string' }, need: { type: 'string' }, kind: { type: 'string' }, animated: { type: 'boolean' }, transparent: { type: 'boolean' }, source: { type: 'string', enum: ['generate', 'openverse', 'stock', 'upload'] }, style: { type: 'string' } }, ['scene_id', 'need']),
      routeSchema,
      route,
    ),
    'assets.generate_svg': tool(
      'assets.generate_svg',
      'Generate an SVG asset through A5 sanitize + CPU render-check + auto-fix; CC0 output.',
      baseParameters({ scene_id: { type: 'string' }, kind: { type: 'string', enum: ['icon', 'diagram', 'pattern', 'vector-anim'] }, intent: { type: 'string' }, palette: { type: 'array', items: { type: 'string' } }, width: { type: 'number' }, height: { type: 'number' }, seed: { type: 'number' } }, ['scene_id', 'kind', 'intent']),
      generateSvgSchema,
      generateSvg,
    ),
    'assets.generate_image': tool(
      'assets.generate_image',
      'Plan a FLUX 3 Image Klein still with an expanded caption (with refs: a Klein reference edit). This never runs a GPU job; spend needs approval.',
      baseParameters({ scene_id: { type: 'string' }, kind: { type: 'string' }, intent: { type: 'string', description: 'Klein prose, subject first: pose or action, setting, light and mood in one or two specific sentences. Describe what is visible, not what is absent. Style, palette, framing and the text guard are appended. With text:true, quote the exact words and their placement. With refs, say what changes and what stays.' }, seed: { type: 'number' }, refs: { type: 'array', items: { type: 'string' } }, cutout: { type: 'boolean' }, aspect: { type: 'string', enum: ['16:9', '1:1', '4:5', '9:16'] }, text: { type: 'boolean' }, labelled: { type: 'boolean' }, style: { type: 'string', maxLength: 80, description: 'Optional short reference-edit style, at most 80 characters.' } }, ['scene_id', 'intent']),
      generateImageSchema,
      planImage,
    ),
    'assets.generate_video': tool(
      'assets.generate_video',
      'Plan one scene-referenced generated-film shot; never submits GPU work. motion_model auto routes character acting/dialogue/native sound to FastH3 and scenery/B-roll/camera-led shots to LTX-2.5. H3 requires image=identity and reference=composition plus exact-line audio for dialogue; wordless H3 reuses deterministic silent conditioning and still generates native soundscape. LTX requires a start image and finishing_sound because it emits no native audio. Explicit klein plans still keyframes only, labels stills + code motion, uses Remotion for camera/transitions/timing and requires finishing_sound. Conflicting explicit selections fail; no model is a fallback for another.',
      baseParameters({
        scene_id: { type: 'string' },
        motion_model: { type: 'string', enum: ['auto', 'h3', 'ltx', 'klein'], description: 'Per-shot selection. Must agree with a non-auto configured motionModel.' },
        subject: { type: 'string', description: 'Visible subject and stable identity, not a prompt tag. For a recurring character, the same verbatim identity sentence in every shot.' },
        composition: { type: 'string', description: 'Framing, setting, spatial contacts and art direction, phrased as what is visible.' },
        action: { type: 'string', description: 'One observable action in the present tense, in order and sized to the shot (for LTX: the motion that follows the start frame); auto uses character action to select H3.' },
        camera: { type: 'string', description: 'Shot size and one camera move relative to the subject, or a static camera; auto uses camera-led scenery to select LTX.' },
        soundscape: { type: 'string', description: 'Physical/native diegetic audio direction for H3 (ambience, contact sounds); score belongs in finishing. Wordless never means silent.' },
        characterCount: { type: 'integer', minimum: 0 },
        image: { type: 'string', description: 'Picture 1 subject/identity image asset id; LTX start art when reference is absent.' },
        reference: { type: 'string', description: 'Picture 2 composition/art-direction image asset id. Required for H3.' },
        audio: { type: 'string', description: 'Ready exact-line voice WAV asset for H3 dialogue. Omit for wordless silent conditioning.' },
        finishing_sound: { type: 'string', description: 'Required LTX/Klein post-production sound plan; neither emits native audio. Name concrete ambience, effects and, when music is wanted, instruments, tempo and mood.' },
        frames: { type: 'integer', minimum: 1, description: 'Requested source frames at 24 fps; snapped up to the selected model lattice and must cover the scene slot.' },
        seed: { type: 'integer', minimum: 0 },
        wordless: { type: 'boolean' },
        media_index: { type: 'integer', enum: [0, 1], description: 'Which supported scene.media plate receives this video; defaults to 0.' },
        dialogue: {
          type: 'object', additionalProperties: false,
          properties: {
            text: { type: 'string' }, conditioningText: { type: 'string' }, language: { type: 'string' },
            voice: { type: 'string' }, delivery: { type: 'string' }, offscreen: { type: 'boolean' },
          },
          required: ['text', 'conditioningText', 'language', 'voice', 'delivery'],
        },
      }, ['scene_id', 'subject', 'composition', 'action', 'camera', 'soundscape', 'characterCount']),
      generateVideoSchema,
      generateVideo,
    ),
    'assets.sketch_to_render': tool(
      'assets.sketch_to_render',
      'Styled hero/background/diagram: emit an SVG base through A5, then plan a Klein reference edit that restyles it and keeps every label. Icons stay SVG-only.',
      baseParameters({ scene_id: { type: 'string' }, kind: { type: 'string', enum: ['diagram', 'hero', 'background', 'illustration', 'plate', 'pattern', 'chart', 'vector', 'vector-anim'] }, intent: { type: 'string' }, style: { type: 'string' }, palette: { type: 'array', items: { type: 'string' } }, width: { type: 'number' }, height: { type: 'number' }, seed: { type: 'number' }, aspect: { type: 'string', enum: ['16:9', '1:1', '4:5', '9:16'] } }, ['scene_id', 'kind', 'intent', 'style']),
      sketchToRenderSchema,
      sketchToRender,
    ),
    'assets.search': tool(
      'assets.search',
      'Find Openverse candidates with licence metadata (fallback; attach requires approval).',
      baseParameters({ query: { type: 'string' }, orientation: { type: 'string' }, license_policy: { type: 'string' } }, ['query']),
      searchSchema,
      (args: z.infer<typeof searchSchema>) => ({ candidates: [], query: args.query, note: 'wire the Openverse client; no network call in agent core' }),
    ),
    'assets.attach': tool(
      'assets.attach',
      'Attach a chosen stock candidate; records provenance and requires user approval.',
      baseParameters({ scene_id: { type: 'string' }, candidate_id: { type: 'string' } }, ['scene_id', 'candidate_id']),
      attachSchema,
      (args: z.infer<typeof attachSchema>) => ({ scene_id: args.scene_id, candidate_id: args.candidate_id, requires_approval: true }),
    ),
    'presenter.set': tool(
      'presenter.set',
      'Turn the AI presenter on/off and shape it: coverage (none/bookends/all), a per-scene value (off/pip/split) keyed by scene id or 1-based index, placement, shape, size and label. Returns the portrait prompt for assets.generate_image and advisory presenter_fixes.',
      baseParameters(
        {
          enabled: { type: 'boolean' },
          coverage: { type: 'string', enum: [...PRESENTER_COVERAGES] },
          preset: { type: 'string', enum: [...PRESENTER_PRESETS] },
          scenes: { type: 'object', additionalProperties: { type: ['string', 'null'], enum: [...PRESENTER_SCENE_VALUES, null] } },
          placement: { type: 'string', enum: [...PRESENTER_PLACEMENTS] },
          shape: { type: 'string', enum: [...PRESENTER_SHAPES] },
          size: { type: 'number' },
          label: { type: ['string', 'null'] },
          portrait: { type: 'string' },
          preset_style: { type: 'string' },
          backdrop: { type: 'string' },
        },
        [],
      ),
      presenterSetSchema,
      presenterSet,
    ),
    'scene.code': tool(
      'scene.code',
      'Add or replace a code/terminal scene. Typing is deterministic (chars per second; default about 0.035 s/char). Returns layout-lint findings and does not write the scene when the source overflows the frame, including when shrunk to 360 px wide.',
      baseParameters({
        scene_id: { type: 'string' },
        language: { type: 'string' },
        code: { type: 'string' },
        highlights: { type: 'array', items: { type: 'integer' } },
        charsPerSecond: { type: 'number' },
      }, ['language', 'code']),
      codeSceneSchema,
      async (args: z.infer<typeof codeSceneSchema>) => {
        const layoutMod = await loadCodeLayout();
        if (!state.package) {
          state.package = {
            $schema: 'https://comfyrizz.example/schema/package-v1.json',
            schemaVersion: 1,
            revision: 1,
            id: hashId('pkg', `code:${args.language}:${args.code}`),
            title: 'Code scene',
            createdAt: (options.now ?? (() => new Date().toISOString()))(),
            format: { width: 1920, height: 1080, fps: 30 },
            duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
            theme: { palette: ['#243056', '#6d8cff', '#e6e8ee'], font: 'Inter', ...brandTheme(options.brand) },
            voice: { enabled: false, engine: 'none' },
            datasets: {},
            scenes: [],
            assets: { ...(options.brandAssets ?? {}) },
            compliance: { open_weights_only: true },
            renders: [],
          };
        }
        const draft = state.package;
        const width = draft.format?.width ?? 1920;
        const height = draft.format?.height ?? 1080;
        const fps = draft.format?.fps ?? 30;
        const block = sanitizeCodeBlock(
          { language: args.language, code: args.code, highlights: args.highlights, charsPerSecond: args.charsPerSecond },
          layoutMod.DEFAULT_CHARS_PER_SECOND,
        );
        if (!block) throw new Error('scene.code needs a language and a code string');
        const findings = layoutMod.lintCodeScene(block.code, width, height);
        const rawId = args.scene_id ?? 's_code';
        const id = SCENE_ID_RE.test(rawId) ? rawId : 's_code';
        if (findings.length > 0) return { ok: false, scene_id: id, findings };
        const scene = {
          id,
          layout: 'code' as const,
          preferredFrames: layoutMod.codeTimelineFrames(block.code, fps, block.typing.charsPerSecond),
          code: block,
          background: { procedural: { pattern: 'gradient', palette: ['#243056', '#6d8cff'] } },
        };
        const scenes = Array.isArray(draft.scenes) ? draft.scenes : [];
        const index = scenes.findIndex(item => item?.id === id);
        const next = index >= 0 ? scenes.map((item, sceneIndex) => sceneIndex === index ? scene : item) : [...scenes, scene];
        state.package = { ...draft, scenes: next, revision: Number(draft.revision ?? 0) + 1 };
        touch();
        return { ok: true, scene_id: id, scene, findings, package: state.package, revision: state.package.revision };
      },
    ),
    'style.list': styleList,
    'style.suggest': styleSuggest,
    'style.apply': styleApplyFor(() => state.package, pkg => { state.package = pkg; touch(); }),
    'variant.cutdown': tool(
      'variant.cutdown',
      'Cut the current package to 6, 15 or 30 seconds. Keeps a scene subset, rewrites narration to fit, and re-voices on CPU. Presenter clips are planned only for scenes whose narration changed, and are never run.',
      baseParameters({ target_s: { type: 'number', enum: [6, 15, 30] } }, ['target_s']),
      cutdownSchema,
      (args: z.infer<typeof cutdownSchema>) => {
        if (!state.package) throw new Error('variant.cutdown needs a package; call storyboard.propose first');
        const cut = cutdownPackage(state.package, args.target_s, { ...(options.voice ? { voice: options.voice } : {}) });
        state.package = cut.package;
        touch();
        return {
          target_s: cut.targetSeconds,
          targetFrames: cut.targetFrames,
          frames: cut.frames,
          seconds: Number((cut.frames / (state.package.format?.fps || 30)).toFixed(3)),
          sceneIds: cut.sceneIds,
          voiced: cut.voiced,
          presenter: cut.presenter,
          package: cut.package,
        };
      },
    ),
  };
}
