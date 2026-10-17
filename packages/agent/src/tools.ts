import { createHash } from 'node:crypto';
import { z } from 'zod';
import { routeAsset, type AssetNeed, type RouteDecision } from './router.js';
import { expandFluxCaption } from './caption.js';
import type { SvgIntentLike } from './svg.js';
import type { ToolDef } from './types.js';

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
}

export interface PlannedImage {
  caption?: string;
  workflow?: string;
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
}

const sceneSchema = z.object({
  id: z.string().min(1),
  layout: z.enum(['title', 'hero', 'stat', 'chart', 'list']).optional(),
  preferredFrames: z.number().int().positive().optional(),
  copy: z.record(z.string()).optional(),
  narration: z.string().optional(),
}).passthrough();

export const proposeSchema = z.object({
  brief: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
  scenes: z.array(sceneSchema).max(12).optional(),
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
});

const searchSchema = z.object({
  query: z.string().min(1),
  orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
  license_policy: z.enum(['cc0', 'by', 'by-sa', 'any']).optional(),
});

const attachSchema = z.object({ scene_id: z.string().min(1), candidate_id: z.string().min(1) });

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

/**
 * Tools the model may call. Approval-requiring tools (spend, stock attach,
 * uploads) return a card request and never perform the action here.
 */
export function createToolset(options: ToolsetOptions = {}): Record<string, AgentTool> {
  const state: { package?: Record<string, any> } = {
    package: options.initialPackage ? structuredClone(options.initialPackage) : undefined,
  };

  const propose = (args: z.infer<typeof proposeSchema>) => {
    const title = args.title ?? args.brief.slice(0, 90);
    const id = hashId('pkg', args.brief);
    const scenes = args.scenes?.length
      ? args.scenes
      : [{ id: 's1', layout: 'title' as const, preferredFrames: 120, copy: { headline: title, sub: '' } }];
    state.package = {
      schemaVersion: 1,
      revision: 0,
      id,
      title,
      format: { width: 1920, height: 1080, fps: 30 },
      duration: { mode: 'flexible' },
      theme: { palette: ['#0d0f14', '#6d8cff', '#e6e8ee'], font: 'Inter' },
      voice: { enabled: false, engine: 'kokoro', voice: 'af_heart', speed: 1 },
      datasets: {},
      scenes,
      assets: {},
      compliance: { open_weights_only: true },
      renders: [],
    };
    return { package: state.package, revision: 0, placeholders: scenes.length === 1 && !args.scenes ? ['duration', 'palette'] : [] };
  };

  const edit = (args: z.infer<typeof editSchema>) => {
    if (!state.package) throw new Error('no package draft; call storyboard.propose first');
    const scenes: any[] = Array.isArray(state.package.scenes) ? state.package.scenes : [];
    const index = scenes.findIndex(scene => scene?.id === args.scene_id);
    if (index < 0) throw new Error(`scene ${args.scene_id} not found`);
    const current = scenes[index] ?? {};
    const patch = args.patch as Record<string, any>;
    const nextScenes = scenes.map((scene, sceneIndex) => sceneIndex === index ? {
      ...current,
      ...patch,
      ...(patch.copy ? { copy: { ...(current.copy ?? {}), ...patch.copy } } : {}),
    } : scene);
    state.package = { ...state.package, scenes: nextScenes, revision: Number(state.package.revision ?? 0) + 1 };
    return { package: state.package, revision: state.package.revision, scene_id: args.scene_id };
  };

  const route = (args: z.infer<typeof routeSchema>): RouteDecision =>
    routeAsset({ sceneId: args.scene_id, intent: args.need, kind: args.kind, animated: args.animated, transparent: args.transparent, source: args.source } as AssetNeed);

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
    return {
      scene_id: args.scene_id,
      asset: {
        id,
        kind: 'image',
        origin: 'generated',
        generator: 'llm-svg',
        status: 'ready',
        format: 'svg',
        svg: result.svg,
        sha256,
        bytes: Buffer.byteLength(result.svg),
        license: { id: 'CC0-1.0' },
      },
      pipeline: {
        sanitized: true,
        render_checked: true,
        attempts: result.attempts ?? 1,
        repairs: result.repairs ?? 0,
        sanitizer_version: result.sanitizerVersion ?? '1.0.0',
      },
    };
  };

  const planImage = (args: z.infer<typeof generateImageSchema>) => {
    const planned = options.planImage?.(args) ?? {};
    const caption = planned.caption ?? expandFluxCaption({ intent: args.intent, cutout: args.cutout, ...(args.aspect ? { aspect: args.aspect } : {}) });
    const id = hashId('a_img', `${args.scene_id}:${args.intent}:${args.seed ?? 0}:${caption}`);
    return {
      scene_id: args.scene_id,
      asset: {
        id,
        kind: 'image',
        origin: 'generated',
        status: 'planned',
        generator: 'flux-3-klein',
        gen: {
          workflow: planned.workflow ?? 'workflows/flux3_klein_t2i.api.json',
          model: planned.model ?? 'flux-3-klein',
          inputs: planned.inputs ?? { prompt: caption, width: 1024, height: 576, seed: args.seed ?? 0, ...(args.cutout ? { cutout: true } : {}) },
          backend: planned.backend ?? 'colab:G4',
          refs: args.refs ?? [],
        },
      },
      caption,
      requires_approval: 'spend',
      note: 'planned only; no GPU job was submitted',
    };
  };

  return {
    'storyboard.propose': tool(
      'storyboard.propose',
      'Create a package draft from a brief. Unprovided numbers stay labelled placeholders.',
      baseParameters({ brief: { type: 'string' }, title: { type: 'string' }, scenes: { type: 'array', items: { type: 'object' } } }, ['brief']),
      proposeSchema,
      propose,
    ),
    'storyboard.edit': tool(
      'storyboard.edit',
      'Patch one scene (copy, layout, data, background, foreground, narration) by scene id.',
      baseParameters({ scene_id: { type: 'string' }, patch: { type: 'object' } }, ['scene_id', 'patch']),
      editSchema,
      edit,
    ),
    'assets.route': tool(
      'assets.route',
      'Choose SVG, FLUX image, stock search or upload for a scene need. SVG is default for icons/diagrams/charts/patterns.',
      baseParameters({ scene_id: { type: 'string' }, need: { type: 'string' }, kind: { type: 'string' }, animated: { type: 'boolean' }, transparent: { type: 'boolean' }, source: { type: 'string', enum: ['generate', 'openverse', 'stock', 'upload'] } }, ['scene_id', 'need']),
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
      baseParameters({ scene_id: { type: 'string' }, kind: { type: 'string' }, intent: { type: 'string' }, seed: { type: 'number' }, refs: { type: 'array', items: { type: 'string' } }, cutout: { type: 'boolean' }, aspect: { type: 'string', enum: ['16:9', '1:1', '4:5', '9:16'] } }, ['scene_id', 'intent']),
      generateImageSchema,
      planImage,
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
  };
}
