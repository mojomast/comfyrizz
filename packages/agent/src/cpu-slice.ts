import { runAgent, type AgentEvent, type RunAgentResult, type ToolRecord } from './agent.js';
import type { BrandKit } from './brand.js';
import { defaultCpuDatasets, defaultCpuScenes, titleFor } from './package.js';
import { createScriptedModel, type ScriptedCall } from './scripted-model.js';
import { createToolset, type PlannedImage, type SvgAssetResult, type ToolsetOptions } from './tools.js';
import type { ChatModel } from './types.js';
import type { SvgIntentLike } from './svg.js';

export interface CpuSliceOptions {
  brief: string;
  /** A real model for the live path; omitted means the deterministic script. */
  model?: ChatModel;
  generateSvg: (intent: SvgIntentLike) => Promise<SvgAssetResult> | SvgAssetResult;
  persistSvg?: ToolsetOptions['persistSvg'];
  planImage?: (args: Parameters<NonNullable<ToolsetOptions['planImage']>>[0]) => PlannedImage;
  sessionId?: string;
  maxSteps?: number;
  now?: () => string;
  onEvent?: (event: AgentEvent) => void;
  /** B1: brand kit whose theme overrides the default palette/font/logo. */
  brand?: Partial<BrandKit>;
}

export interface CpuSliceResult {
  ok: boolean;
  live: boolean;
  package: Record<string, any>;
  routes: Array<{ sceneId?: string; tool: string }>;
  pendingGpu: Array<{ assetId: string; generator: string; workflow?: string; sceneId?: string }>;
  svgAssets: string[];
  result: RunAgentResult;
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
  let draft: Record<string, any> | undefined;
  const tools = createToolset({
    generateSvg: options.generateSvg,
    ...(options.persistSvg ? { persistSvg: options.persistSvg } : {}),
    ...(options.planImage ? { planImage: options.planImage } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.brand ? { brand: options.brand } : {}),
    onPackageChange: pkg => {
      draft = pkg;
    },
  });
  const live = Boolean(options.model);
  const model = options.model ?? createScriptedModel(defaultCpuScript(options.brief));
  const result = await runAgent({
    model,
    brief: options.brief,
    tools,
    sessionId: options.sessionId ?? 'cpu-slice',
    maxSteps: options.maxSteps ?? 24,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const pkg = draft ?? (result.toolCalls.find(call => call.name === 'storyboard.propose')?.result as any)?.package;
  if (!pkg) throw new Error('agent did not produce a package draft');
  const now = options.now ?? (() => new Date().toISOString());
  pkg.$schema = pkg.$schema ?? 'https://comfyrizz.example/schema/package-v1.json';
  pkg.createdAt = pkg.createdAt ?? now();
  pkg.revision = Math.max(1, Number(pkg.revision ?? 1));
  pkg.renders = Array.isArray(pkg.renders) ? pkg.renders : [];

  const svgAssets = Object.entries(pkg.assets ?? {})
    .filter(([, asset]: [string, any]) => asset?.gen?.generator === 'llm-svg' && asset.status === 'ready')
    .map(([id]) => id);
  if (svgAssets.length < 4) throw new Error(`CPU slice needs at least 4 ready llm-svg assets, got ${svgAssets.length}`);
  const pendingGpu = Object.entries(pkg.assets ?? {})
    .filter(([, asset]: [string, any]) => asset?.status === 'pending' && ['flux3-klein', 'ltx25'].includes(asset?.gen?.generator))
    .map(([assetId, asset]: [string, any]) => ({ assetId, generator: asset.gen.generator, ...(asset.gen.workflow ? { workflow: asset.gen.workflow } : {}) }));
  const routes = result.toolCalls
    .filter((call: ToolRecord) => call.name === 'assets.route' && call.ok)
    .map((call: ToolRecord) => {
      const value = call.result as { sceneId?: string; tool?: string } | undefined;
      return { ...(value?.sceneId ? { sceneId: value.sceneId } : {}), tool: value?.tool ?? 'unknown' };
    });
  return {
    ok: result.stopped !== 'model_error' && result.stopped !== 'aborted',
    live,
    package: pkg,
    routes,
    pendingGpu,
    svgAssets,
    result,
  };
}
