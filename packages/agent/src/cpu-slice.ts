import { runAgent, type AgentEvent, type RunAgentResult, type ToolRecord } from './agent.js';
import type { BrandKit } from './brand.js';
import type { StylePreset } from './brief.js';
import { defaultCpuDatasets, defaultCpuScenes, titleFor } from './package.js';
import { createScriptedModel, type ScriptedCall } from './scripted-model.js';
import { createToolset, type PlannedImage, type SvgAssetResult, type ToolsetOptions } from './tools.js';
import type { ChatModel } from './types.js';
import type { SvgIntentLike } from './svg.js';
import { classifyProductionIntent } from './production-intent.js';
import { parseMotionModel, type MotionModel } from './motion-model.js';

export interface CpuSliceOptions {
  brief: string;
  /** A real model for the live path; omitted means the deterministic script. */
  model?: ChatModel;
  generateSvg: (intent: SvgIntentLike) => Promise<SvgAssetResult> | SvgAssetResult;
  persistSvg?: ToolsetOptions['persistSvg'];
  persistAudio?: ToolsetOptions['persistAudio'];
  motionModel?: MotionModel;
  /** Existing package for one bounded semantic-repair pass. */
  initialPackage?: Record<string, unknown>;
  planImage?: (args: Parameters<NonNullable<ToolsetOptions['planImage']>>[0]) => PlannedImage;
  sessionId?: string;
  maxSteps?: number;
  /** Edit-only repair uses a focused system prompt instead of the full builder prompt. */
  system?: string;
  now?: () => string;
  onEvent?: (event: AgentEvent) => void;
  /** B1: brand kit whose theme overrides the default palette/font/logo. */
  brand?: Partial<BrandKit>;
  /** B1: uploaded logo assets the brand theme references. */
  brandAssets?: Record<string, unknown>;
}

export interface CpuSliceProblem {
  code: string;
  message: string;
  assetId?: string;
}

export interface CpuSliceResult {
  ok: boolean;
  live: boolean;
  package: Record<string, any>;
  routes: Array<{ sceneId?: string; tool: string }>;
  pendingGpu: Array<{ assetId: string; generator: string; workflow?: string; sceneId?: string }>;
  svgAssets: string[];
  /** Actionable completion gaps; the runner repairs or refuses with these codes. */
  problems: CpuSliceProblem[];
  result: RunAgentResult;
}

/** A slice completion gap is an actionable 422, never an untyped 500. */
function cpuSliceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'CpuSliceError', status: 422, code });
}

/** Preserve an already typed failure; otherwise make the untyped one an actionable 422. */
function cpuSliceFailure(error: unknown): Error {
  if (error && typeof error === 'object') {
    const candidate = error as { status?: unknown };
    if (Number.isInteger(candidate.status)) return error as Error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return cpuSliceError('CPU_SLICE_FAILED', message.trim() || 'CPU slice failed without an error message.');
}

/** The final scene has no next scene, so its outgoing transition is a cut (0 overlap), not a 500. */
function clearFinalSceneTransition(pkg: Record<string, any>): void {
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const transition = scenes.at(-1)?.transitionOut;
  if (!transition || typeof transition !== 'object') return;
  const frames = Number(transition.frames);
  if (transition.type === 'cut' && frames === 0) return;
  if (transition.type === 'none' && !(frames > 0)) return;
  scenes[scenes.length - 1].transitionOut = { type: 'cut', frames: 0 };
}

/** The offline plan: route and generate four vector assets, then plan one FLUX still. */
export function defaultCpuScript(brief: string): ScriptedCall[] {
  const scenes = defaultCpuScenes(brief);
  return [
    { name: 'storyboard.propose', args: { brief, title: titleFor(brief), scenes, datasets: defaultCpuDatasets() } },
    { name: 'assets.route', args: { scene_id: 's_title', need: 'a check icon for the CPU render pipeline', kind: 'icon' } },
    { name: 'assets.generate_svg', args: { scene_id: 's_title', kind: 'icon', intent: 'a check mark icon for a CPU render pipeline', seed: 1 } },
    { name: 'assets.route', args: { scene_id: 's_hero', need: 'a flow diagram from brief to package', kind: 'diagram' } },
    { name: 'assets.generate_svg', args: { scene_id: 's_hero', kind: 'diagram', intent: 'a three-step diagram from a chat brief to a rendered package', seed: 2 } },
    { name: 'assets.route', args: { scene_id: 's_list', need: 'a dot pattern for a dark background', kind: 'pattern' } },
    { name: 'assets.generate_svg', args: { scene_id: 's_list', kind: 'pattern', intent: 'a subtle dot pattern for a dark background', seed: 3 } },
    { name: 'assets.route', args: { scene_id: 's_outro', need: 'animated bars like a render progress meter', kind: 'vector-anim', animated: true } },
    { name: 'assets.generate_svg', args: { scene_id: 's_outro', kind: 'vector-anim', intent: 'animated bars that grow like a render progress meter', seed: 4 } },
    { name: 'assets.route', args: { scene_id: 's_hero', need: 'an illustrative nebula texture for the hero plate', kind: 'illustration' } },
    { name: 'assets.generate_image', args: { scene_id: 's_hero', kind: 'illustration', intent: 'a soft nebula texture behind the hero copy', seed: 5 } },
  ];
}

/**
 * Run the CPU agent slice: a chat brief becomes a package draft through the
 * same tools the live model uses, with at least four llm-svg assets and any
 * raster need left as a pending-GPU plan plus a procedural fallback.
 */
export async function runCpuSlice(options: CpuSliceOptions): Promise<CpuSliceResult> {
  try {
    return await planCpuSlice(options);
  } catch (error) {
    throw cpuSliceFailure(error);
  }
}

async function planCpuSlice(options: CpuSliceOptions): Promise<CpuSliceResult> {
  const intent = classifyProductionIntent(options.brief);
  const motionModel = parseMotionModel(options.motionModel, 'auto');
  if (intent.generatedFilm && !options.model) {
    throw cpuSliceError('GENERATED_FILM_REQUIRES_MODEL', 'generated-film planning requires a live model and scene-referenced generated shots; the scripted defaultCpuScript is motion-graphics-only and is not an acceptable fallback');
  }
  let draft: Record<string, any> | undefined = options.initialPackage ? structuredClone(options.initialPackage) : undefined;
  const stylePreset = /Look:\s*([a-z-]+)/i.exec(options.brief)?.[1] as StylePreset | undefined;
  const allTools = createToolset({
    generateSvg: options.generateSvg,
    ...(options.initialPackage ? { initialPackage: options.initialPackage, initialIntent: intent } : {}),
    ...(options.persistSvg ? { persistSvg: options.persistSvg } : {}),
    ...(options.persistAudio ? { persistAudio: options.persistAudio } : {}),
    motionModel,
    ...(options.planImage ? { planImage: options.planImage } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.brand ? { brand: options.brand } : {}),
    ...(options.brandAssets ? { brandAssets: options.brandAssets } : {}),
    ...(stylePreset ? { stylePreset } : {}),
    onPackageChange: pkg => {
      draft = pkg;
    },
  });
  // Keep generated-film planning focused. SVG/style/chart tools are irrelevant,
  // enlarge every model request and can derail a shot plan before video exists.
  const tools = intent.generatedFilm
    ? Object.fromEntries(Object.entries(allTools).filter(([name]) => ['storyboard.propose', 'storyboard.edit', 'assets.generate_image', 'assets.generate_video'].includes(name)))
    : allTools;
  const live = Boolean(options.model);
  const model = options.model ?? createScriptedModel(defaultCpuScript(options.brief));
  const result = await runAgent({
    model,
    brief: options.brief,
    tools,
    sessionId: options.sessionId ?? 'cpu-slice',
    maxSteps: options.maxSteps ?? 24,
    ...(options.system ? { system: options.system } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const pkg = draft ?? (result.toolCalls.find(call => call.name === 'storyboard.propose')?.result as any)?.package;
  if (!pkg) throw cpuSliceError('PACKAGE_DRAFT_MISSING', 'agent did not produce a package draft');
  clearFinalSceneTransition(pkg);
  const now = options.now ?? (() => new Date().toISOString());
  pkg.$schema = pkg.$schema ?? 'https://comfyrizz.example/schema/package-v1.json';
  pkg.createdAt = pkg.createdAt ?? now();
  pkg.revision = Math.max(1, Number(pkg.revision ?? 1));
  pkg.renders = Array.isArray(pkg.renders) ? pkg.renders : [];

  const svgAssets = Object.entries(pkg.assets ?? {})
    .filter(([, asset]: [string, any]) => asset?.gen?.generator === 'llm-svg' && asset.status === 'ready')
    .map(([id]) => id);
  const problems: CpuSliceProblem[] = [];
  if (!intent.generatedFilm && svgAssets.length < 4) {
    problems.push({
      code: 'SVG_ASSET_FLOOR',
      message: `CPU slice needs at least 4 ready llm-svg assets, got ${svgAssets.length}`,
    });
  }
  const { reachableAssetIds } = await import(new URL('../../../jobs/src/reachable.mjs', import.meta.url).href) as {
    reachableAssetIds: (pkg: Record<string, any>) => Set<string>;
  };
  const reachable = reachableAssetIds(pkg);
  const pendingGpu = Object.entries(pkg.assets ?? {})
    .filter(([assetId, asset]: [string, any]) => reachable.has(assetId) && asset?.status === 'pending' && ['flux3-klein', 'ltx25', 'fasth3-omni'].includes(asset?.gen?.generator))
    .map(([assetId, asset]: [string, any]) => {
      const scene = (pkg.scenes ?? []).find((candidate: any) => candidate?.background?.asset === assetId
        || candidate?.foreground?.some((item: any) => item?.asset === assetId)
        || candidate?.media?.some((item: any) => item?.asset === assetId)
        || candidate?.narration_asset === assetId || candidate?.presenter_asset === assetId);
      return { assetId, generator: asset.gen.generator, ...(asset.gen.workflow ? { workflow: asset.gen.workflow } : {}), ...(scene?.id ? { sceneId: scene.id } : {}) };
    });
  const routes = result.toolCalls
    .filter((call: ToolRecord) => call.name === 'assets.route' && call.ok)
    .map((call: ToolRecord) => {
      const value = call.result as { sceneId?: string; tool?: string } | undefined;
      return { ...(value?.sceneId ? { sceneId: value.sceneId } : {}), tool: value?.tool ?? 'unknown' };
    });
  return {
    ok: result.stopped !== 'model_error' && result.stopped !== 'aborted' && problems.length === 0,
    live,
    package: pkg,
    routes,
    pendingGpu,
    svgAssets,
    problems,
    result,
  };
}
