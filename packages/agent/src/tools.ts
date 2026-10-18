import { createHash } from 'node:crypto';
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
  /** Wired to A5: autoFix(generate, intent) with sanitize/render-check. */
  generateSvg?: (intent: SvgIntentLike) => Promise<SvgAssetResult> | SvgAssetResult;
  /** Wired to the job planner; defaults to a caption + workflow plan, never a GPU run. */
  planImage?: (args: z.infer<typeof generateImageSchema>) => PlannedImage;
  /** Persist an SVG and return its package-relative path (C5 server). */
  persistSvg?: (assetId: string, svg: string, kind: string) => string | undefined;
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

const sceneSchema = z.object({
  id: z.string().min(1),
  layout: z.enum(['title', 'hero', 'stat', 'chart', 'list']).optional(),
  preferredFrames: z.number().int().positive().optional(),
  // DeepSeek often sends `copy` as a plain headline string; accept it and lift it
  // to `{ headline }` so a common model shape is not a repair-loop failure.
  copy: z
    .preprocess(value => (typeof value === 'string' ? { headline: value } : value), z.record(z.unknown()))
    .optional(),
  narration: z.string().optional(),
}).passthrough();

export const proposeSchema = z.object({
  brief: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
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
  style: z.string().min(1).max(80).optional(),
});

export const sketchToRenderSchema = z.object({
  scene_id: z.string().min(1),
  kind: z.enum(['diagram', 'hero', 'background', 'illustration', 'plate', 'pattern', 'chart', 'vector', 'vector-anim']),
  intent: z.string().min(1),
  style: z.string().min(1).max(80),
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

function baseParameters(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const SCENE_LAYOUTS = ['title', 'hero', 'stat', 'chart', 'list'] as const;
type SceneLayout = (typeof SCENE_LAYOUTS)[number];
const SCENE_KEYS = new Set([
  'id', 'layout', 'variant', 'preferredFrames', 'copy', 'data', 'background', 'foreground',
  'media_only', 'lower_third', 'transitionOut', 'motion', 'narration', 'narration_asset',
  'narration_duration_frames', 'locked', 'notes', 'presenter', 'presenter_asset',
]);
const COPY_KEYS = new Set(['headline', 'kicker', 'sub', 'body', 'quote', 'attribution', 'footnote', 'cta', 'items']);
const COPY_LIMITS: Record<SceneLayout, Record<string, number>> = {
  title: { headline: 48, sub: 90 },
  hero: { headline: 64, sub: 120, body: 240 },
  stat: { headline: 48, sub: 90, body: 40 },
  chart: { headline: 64, sub: 120, footnote: 120 },
  list: { headline: 64, quote: 200, attribution: 80 },
};
const LAYOUT_VARIANTS: Record<SceneLayout, string[]> = {
  title: ['centered', 'outro'],
  hero: ['full-bleed', 'split'],
  stat: [],
  chart: ['bar'],
  list: ['bullets', 'quote'],
};
const BACKGROUND_PATTERNS = ['gradient', 'grid', 'dots', 'grain', 'mesh'];
const DEFAULT_SCENE_FRAMES: Record<SceneLayout, number> = { title: 150, hero: 210, stat: 180, chart: 210, list: 180 };
const SCENE_ID_RE = /^s[A-Za-z0-9_-]{0,63}$/;

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}\u2026` : text;
}

/** The live model often sends `role`/`title` and no `layout`; infer one. */
function inferSceneLayout(scene: Record<string, any>): SceneLayout {
  const hint = `${scene.layout ?? ''} ${scene.role ?? ''} ${scene.id ?? ''} ${scene.title ?? ''}`.toLowerCase();
  if (/outro|intro|title|cover|opening|closing|hook/.test(hint)) return 'title';
  if (/stat|metric|kpi|number|figure|score/.test(hint)) return 'stat';
  if (/chart|graph|bar|data|plot|trend/.test(hint)) return 'chart';
  if (/list|bullet|steps|feature|checklist|points/.test(hint)) return 'list';
  return 'hero';
}

/**
 * Coerce a model-authored scene into the published package shape: a valid
 * layout, readable copy, a real dataset reference, a known variant/background,
 * and only schema-known keys. Assets that do not exist yet are dropped.
 */
function normalizeScene(raw: Record<string, any>, fallbackTitle: string, datasetIds: Set<string>, assetIds: Set<string>): Record<string, any> {
  const source: Record<string, any> = { ...raw };
  const rawId = typeof source.id === 'string' ? source.id : '';
  const id = SCENE_ID_RE.test(rawId) ? rawId : `s_${hashId('', rawId || fallbackTitle).slice(0, 12)}`;
  const layout: SceneLayout = (SCENE_LAYOUTS as readonly string[]).includes(source.layout) ? source.layout : inferSceneLayout(source);

  const copy: Record<string, any> = typeof source.copy === 'string'
    ? { headline: source.copy }
    : source.copy && typeof source.copy === 'object' ? { ...source.copy } : {};
  if (!copy.headline && typeof source.title === 'string') copy.headline = source.title;
  if (!copy.headline && typeof source.headline === 'string') copy.headline = source.headline;
  for (const key of Object.keys(copy)) if (!COPY_KEYS.has(key)) delete copy[key];

  let finalLayout: SceneLayout = layout;
  let data = source.data && typeof source.data === 'object' ? { ...source.data } : undefined;
  if (data && (typeof data.dataset !== 'string' || !datasetIds.has(data.dataset))) data = undefined;
  if (['stat', 'chart'].includes(finalLayout) && !data) finalLayout = Array.isArray(copy.items) && copy.items.length >= 2 ? 'list' : 'hero';
  if (data) {
    for (const key of Object.keys(data)) if (key !== 'dataset' && key !== 'display') delete data[key];
    if (finalLayout === 'stat' && data.display === undefined) data.display = 'number';
    if (finalLayout === 'chart' && data.display === undefined) data.display = 'bar';
  }

  const limits = COPY_LIMITS[finalLayout];
  for (const [key, max] of Object.entries(limits)) if (copy[key] !== undefined) copy[key] = clampText(copy[key], max);
  if (Array.isArray(copy.items)) copy.items = copy.items.map(item => clampText(item, 72)).filter(Boolean).slice(0, 6);
  if (!copy.headline) copy.headline = clampText(source.title ?? fallbackTitle ?? id, limits.headline);

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
    ? source.foreground.filter((item: any) => item && typeof item === 'object' && typeof item.asset === 'string' && assetIds.has(item.asset)).slice(0, 12)
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
  // SCENE_KEYS is the allow-list. `motion` has to be in it or this drops the field.
  for (const key of Object.keys(scene)) if (!SCENE_KEYS.has(key)) delete scene[key];
  return scene;
}

function withMotionFixes<T extends Record<string, unknown>>(result: T, pkg: Record<string, any>): T {
  const fixes = motionFixInstructions(lintPackageMotion(pkg));
  if (fixes.length === 0) return result;
  return { ...result, motion_fixes: fixes };
}

/**
 * Tools the model may call. Approval-requiring tools (spend, stock attach,
 * uploads) return a card request and never perform the action here.
 */
export function createToolset(options: ToolsetOptions = {}): Record<string, AgentTool> {
  const state: { package?: Record<string, any> } = {
    package: options.initialPackage ? structuredClone(options.initialPackage) : undefined,
  };

  const touch = () => {
    if (state.package) options.onPackageChange?.(state.package);
  };

  const propose = (args: z.infer<typeof proposeSchema>) => {
    const rawTitle = args.title ?? args.brief.slice(0, 90);
    const title = rawTitle.length > 48 ? `${rawTitle.slice(0, 45).trimEnd()}…` : rawTitle;
    const id = hashId('pkg', args.brief);
    const datasetIds = new Set(Object.keys(args.datasets ?? {}));
    const scenes = args.scenes?.length
      ? args.scenes.map(scene => normalizeScene(scene, title, datasetIds, new Set()))
      : [{ id: 's1', layout: 'title' as const, preferredFrames: 120, copy: { headline: title, sub: '' } }];
    state.package = {
      $schema: 'https://comfyrizz.example/schema/package-v1.json',
      schemaVersion: 1,
      revision: 1,
      id,
      title,
      createdAt: (options.now ?? (() => new Date().toISOString()))(),
      format: { width: 1920, height: 1080, fps: 30 },
      duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
      theme: { palette: ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'], font: 'Inter', ...brandTheme(options.brand) },
      voice: { enabled: false, engine: 'none' },
      datasets: args.datasets ?? {},
      scenes,
      assets: { ...(options.brandAssets ?? {}) },
      compliance: { open_weights_only: true },
      renders: [],
    };
    const motion = normalizePackageMotion(args.motion);
    if (motion) state.package.motion = motion;
    touch();
    return withMotionFixes(
      { package: state.package, revision: state.package.revision, placeholders: scenes.length === 1 && !args.scenes ? ['duration', 'palette'] : [] },
      state.package,
    );
  };

  const edit = (args: z.infer<typeof editSchema>) => {
    if (!state.package) throw new Error('no package draft; call storyboard.propose first');
    const draft = state.package;
    const scenes: any[] = Array.isArray(draft.scenes) ? draft.scenes : [];
    const index = scenes.findIndex(scene => scene?.id === args.scene_id);
    if (index < 0) throw new Error(`scene ${args.scene_id} not found`);
    const current = scenes[index] ?? {};
    const patch = args.patch as Record<string, any>;
    const datasetIds = new Set(Object.keys(draft.datasets ?? {}));
    const assetIds = new Set(Object.keys(draft.assets ?? {}));
    const nextScenes = scenes.map((scene, sceneIndex) => sceneIndex === index
      ? normalizeScene(mergeScenePatch(current, patch), draft.title, datasetIds, assetIds)
      : scene);
    state.package = { ...draft, scenes: nextScenes, revision: Number(draft.revision ?? 0) + 1 };
    touch();
    return withMotionFixes(
      { package: state.package, revision: state.package.revision, scene_id: args.scene_id },
      state.package,
    );
  };

  const route = (args: z.infer<typeof routeSchema>): RouteDecision =>
    routeAsset({ sceneId: args.scene_id, intent: args.need, kind: args.kind, animated: args.animated, transparent: args.transparent, source: args.source, style: args.style } as AssetNeed);

  const generateSvg = async (args: z.infer<typeof generateSvgSchema>) => {
    const intent: SvgIntentLike = {
      kind: args.kind,
      prompt: args.intent,
      ...(args.palette ? { palette: args.palette } : {}),
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
    const file = result.file ?? options.persistSvg?.(id, result.svg, kind) ?? `assets/${id}.svg`;
    const rawCheck = result.renderCheck;
    const renderCheck = rawCheck
      ? {
          ok: rawCheck.ok === true,
          ...(rawCheck.version ? { version: rawCheck.version } : {}),
          ...(rawCheck.width ? { width: rawCheck.width } : {}),
          ...(rawCheck.height ? { height: rawCheck.height } : {}),
          blank: typeof rawCheck.opaqueFraction === 'number' ? rawCheck.opaqueFraction < 0.005 : false,
          palette_ok: rawCheck.outOfPaletteFraction == null || rawCheck.outOfPaletteFraction <= 0.5,
        }
      : { ok: true, version: result.sanitizerVersion ?? '1.0.0' };
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
    const requestedAspect = (args.aspect as Aspect | undefined) ?? outputAspect;
    const dims = sourceDims(requestedAspect);
    const palette = Array.isArray(state.package?.theme?.palette) ? state.package.theme.palette : undefined;
    const refs = args.refs ?? [];
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
          aspect: requestedAspect,
        })
      : expandFluxCaption({
          intent: args.intent,
          ...(args.style ? { style: args.style } : {}),
          ...(palette ? { palette } : {}),
          ...(styleBlock ? { styleBlock } : {}),
          ...(args.cutout ? { cutout: true } : {}),
          ...(args.text ? { text: true } : {}),
          ...(args.labelled ? { labelled: true } : {}),
          aspect: requestedAspect,
        }));
    const id = hashId('a_img', `${args.scene_id}:${args.intent}:${args.seed ?? 0}:${caption}`);
    const defaultWorkflow = isRefEdit ? 'workflows/flux3_klein_ref_edit.api.json' : 'workflows/flux3_klein_t2i.api.json';
    // P-fix5: the jobs planner requires `gen.workflow_sha256`, so a package built by the
    // agent must stamp it. A caller-provided plan wins; otherwise the committed manifest
    // supplies the hash for the workflow this tool is about to name.
    const workflow = planned.workflow ?? defaultWorkflow;
    const workflowSha256 = planned.workflowSha256 ?? WORKFLOW_SHA256[workflow];
    // The package schema only allows scalar gen.inputs values, and ReferenceMultiLatent
    // wires image0, so the first ref is the reference raster; extras are recorded only.
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
      model_license: { id: 'Apache-2.0', url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell' },
      redistributable: true,
      notes: isRefEdit
        ? 'pending-GPU: ReferenceMultiLatent keeps the source layout/labels while restyling (GPU test 2)'
        : 'pending-GPU: procedural background is the CPU fallback until a spend is approved',
      gen: {
        generator: 'flux3-klein',
        workflow,
        ...(workflowSha256 ? { workflow_sha256: workflowSha256 } : {}),
        model: planned.model ?? 'flux-3-klein',
        inputs: planned.inputs ?? defaultInputs,
        backend: planned.backend ?? 'colab:G4',
      },
    };
    if (state.package) {
      state.package = {
        ...state.package,
        assets: { ...(state.package.assets ?? {}), [id]: asset },
        revision: Number(state.package.revision ?? 0) + 1,
      };
      touch();
    }
    const aspectMismatch = args.aspect !== undefined && requestedAspect !== outputAspect;
    return {
      scene_id: args.scene_id,
      asset: { id, ...asset },
      caption,
      reference_edit: isRefEdit,
      source_aspect: requestedAspect,
      output_aspect: outputAspect,
      requires_approval: 'spend',
      note: aspectMismatch
        ? `planned only; no GPU job was submitted. Source is ${requestedAspect} but the package output is ${outputAspect}: i2v will centre-crop.`
        : 'planned only; no GPU job was submitted',
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
        motion: {
          type: 'object',
          additionalProperties: false,
          properties: {
            energy: { type: 'string', enum: [...motionVocab.energies] },
            direction: { type: 'string', enum: [...motionVocab.directions] },
          },
        },
        scenes: { type: 'array', items: { type: 'object' } },
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
      'Plan a FLUX still with an expanded caption. This never runs a GPU job; spend needs approval.',
      baseParameters({ scene_id: { type: 'string' }, kind: { type: 'string' }, intent: { type: 'string' }, seed: { type: 'number' }, refs: { type: 'array', items: { type: 'string' } }, cutout: { type: 'boolean' }, aspect: { type: 'string', enum: ['16:9', '1:1', '4:5', '9:16'] }, text: { type: 'boolean' }, labelled: { type: 'boolean' }, style: { type: 'string' } }, ['scene_id', 'intent']),
      generateImageSchema,
      planImage,
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
