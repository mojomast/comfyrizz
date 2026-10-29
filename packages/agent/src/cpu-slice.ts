import { runAgent, type AgentEvent, type RunAgentResult, type ToolRecord } from './agent.js';
import type { BrandKit } from './brand.js';
import type { StylePreset } from './brief.js';
import { defaultCpuDatasets, defaultCpuScenes, titleFor } from './package.js';
import { createScriptedModel, type ScriptedCall } from './scripted-model.js';
import { createToolset, type PlannedImage, type SvgAssetResult, type ToolsetOptions } from './tools.js';
import type { ChatModel } from './types.js';
import type { SvgIntentLike } from './svg.js';
import { classifyProductionIntent, type ProductionIntent } from './production-intent.js';
import { parseMotionModel, type MotionModel } from './motion-model.js';
import { getVideoType, type VideoType } from './video-types.js';

export interface CpuSliceOptions {
  brief: string;
  /** A real model for the live path; omitted means the deterministic script. */
  model?: ChatModel;
  generateSvg?: (intent: SvgIntentLike) => Promise<SvgAssetResult> | SvgAssetResult;
  persistSvg?: ToolsetOptions['persistSvg'];
  persistAudio?: ToolsetOptions['persistAudio'];
  prepareDialogueAudio?: ToolsetOptions['prepareDialogueAudio'];
  motionModel?: MotionModel;
  /** Existing package for one bounded semantic-repair pass. */
  initialPackage?: Record<string, unknown>;
  /** Restrict semantic repair to CPU tools when no GPU asset is requested. */
  repairWithoutGpu?: boolean;
  adoptReferenceImage?: ToolsetOptions['adoptReferenceImage'];
  /** The runner's single classification, shared by gates and storyboard tools. */
  initialIntent?: ProductionIntent;
  /** Optional server-owned planner preset. */
  videoType?: VideoType;
  planImage?: (args: Parameters<NonNullable<ToolsetOptions['planImage']>>[0]) => PlannedImage;
  sessionId?: string;
  signal?: AbortSignal;
  maxSteps?: number;
  maxInvalidArgumentRepairs?: number;
  /** Edit-only repair uses a focused system prompt instead of the full builder prompt. */
  system?: string;
  systemSuffix?: string;
  /** Server-resolved, untrusted attachment and reference context for a user-role message. */
  contextSystem?: string;
  csvAttachments?: ToolsetOptions['csvAttachments'];
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

type MotionVideoType = Exclude<VideoType, 'action-scene'>;

type ScriptedScene = Record<string, any>;

function presetScene(
  id: string,
  layout: 'title' | 'hero' | 'stat' | 'chart' | 'list',
  copy: Record<string, unknown>,
  options: { motion?: Record<string, unknown>; notes?: string; data?: Record<string, unknown>; pattern?: string } = {},
): ScriptedScene {
  const frames = { title: 150, hero: 240, stat: 180, chart: 240, list: 210 }[layout];
  const scene: ScriptedScene = {
    id,
    layout,
    ...(layout === 'title' ? { variant: id === 's_outro' ? 'outro' : 'centered' } : {}),
    ...(layout === 'hero' ? { variant: 'split' } : {}),
    ...(layout === 'chart' ? { variant: 'bar' } : {}),
    ...(layout === 'list' ? { variant: 'bullets' } : {}),
    preferredFrames: id === 's_outro' && layout === 'title' ? 240 : frames,
    copy,
    background: { procedural: { pattern: options.pattern ?? 'grid', seed: 11 } },
    foreground: [],
    ...(options.data ? { data: options.data } : {}),
    ...(options.motion ? { motion: options.motion } : {}),
    ...(options.notes ? { notes: options.notes } : {}),
  };
  if (id !== 's_outro') scene.transitionOut = { type: 'fade', frames: 12 };
  return scene;
}

const PRESET_COPY: Record<Exclude<MotionVideoType, 'data-story'>, {
  logline: string;
  soundtrack: string;
  titleSub: string;
  heroHeadline: string;
  heroSub: string;
  listHeadline: string;
  items: string[];
  outroHeadline: string;
  outroSub: string;
  heroMotion?: Record<string, unknown>;
  listMotion?: Record<string, unknown>;
  titleMotion?: Record<string, unknown>;
  outroMotion?: Record<string, unknown>;
  outroNotes?: string;
}> = {
  'motion-explainer': {
    logline: 'A causal visual explanation that connects each step to the next.',
    soundtrack: 'A restrained pulse with soft transition cues.',
    titleSub: 'A technical-flow explanation, one connected step at a time.',
    heroHeadline: 'See how the whole process connects',
    heroSub: 'Inputs, transformations, and outcomes appear as one readable system.',
    listHeadline: 'Follow cause and effect',
    items: ['Start with the actual input', 'Reveal each transformation in order', 'Land on the observable outcome'],
    outroHeadline: 'The process, made clear',
    outroSub: 'A resolved flow the viewer can follow again.',
    heroMotion: { recipe: 'technical-flow', diagram: 'flow', entry: 'drawOn' },
    listMotion: { recipe: 'technical-flow', diagram: 'flow', entry: 'waterfall' },
  },
  'sketch-build': {
    logline: 'An idea assembles through drawn lines, labels, and useful annotations.',
    soundtrack: 'Pencil texture and a light, measured pulse.',
    titleSub: 'Lines become labels; labels become a complete drawing.',
    heroHeadline: 'Watch the idea take shape',
    heroSub: 'A drawOn reveal builds the important geometry before the details arrive.',
    listHeadline: 'Annotate what matters',
    items: ['Draw the main contour first', 'Add the working parts in sequence', 'Resolve the labels and final sketch'],
    outroHeadline: 'The finished sketch',
    outroSub: 'Every line and label stays readable.',
    titleMotion: { recipe: 'sketch', entry: 'drawOn' },
    heroMotion: { recipe: 'sketch', entry: 'drawOn' },
    listMotion: { recipe: 'sketch', entry: 'drawOn' },
    outroMotion: { entry: 'none' },
    outroNotes: 'Final hold: keep the completed drawing and annotations static and readable.',
  },
  'product-walkthrough': {
    logline: 'A guided product frame connects visible details to the features named in the brief.',
    soundtrack: 'Clean percussive cues with a polished, quiet bed.',
    titleSub: 'A close look at the product and the details that matter.',
    heroHeadline: 'Put the product in focus',
    heroSub: 'The hero frame establishes the object before attention moves to real features.',
    listHeadline: 'Callouts with a visible purpose',
    items: ['Frame the detail being discussed', 'Connect one concise callout to it', 'Return to the complete product view'],
    outroHeadline: 'The product, clearly presented',
    outroSub: 'A clean closing frame with no unsupported claims.',
    heroMotion: { recipe: 'focus', focus: { x: 0.42, y: 0.18, width: 0.5, height: 0.64 }, entry: 'fadeUp' },
    listMotion: { recipe: 'focus', focus: { x: 0.5, y: 0.25, width: 0.42, height: 0.5 }, entry: 'waterfall' },
    outroMotion: { entry: 'none' },
    outroNotes: 'Final product hold: keep the resolved packshot and product promise static.',
  },
  'title-reveal': {
    logline: 'The requested words become the event through a restrained kinetic reveal.',
    soundtrack: 'A concise sonic rise that resolves into a clean final hold.',
    titleSub: 'Purposeful type motion, then room to read the resolved message.',
    heroHeadline: 'Let every word earn its entrance',
    heroSub: 'Short kinetic gestures establish rhythm without burying the exact title.',
    listHeadline: 'Build, resolve, hold',
    items: ['Introduce the primary words', 'Settle the supporting line', 'Hold the finished composition'],
    outroHeadline: 'The title, fully resolved',
    outroSub: 'A static final hold makes the last word unmistakable.',
    titleMotion: { recipe: 'kinetic', entry: 'maskRise' },
    heroMotion: { recipe: 'kinetic', entry: 'waterfall' },
    listMotion: { recipe: 'kinetic', entry: 'maskRise' },
    outroMotion: { recipe: 'kinetic', entry: 'none' },
    outroNotes: 'Final hold: no further type or decorative motion after the title resolves.',
  },
  'music-video': {
    logline: 'A section-led editorial visual plan that keeps the supplied song as its only authoritative master.',
    soundtrack: 'Use only the supplied song. No composed or procedural replacement, Kokoro/Qwen voice, or H3 dialogue.',
    titleSub: 'Section-led visuals for the supplied song, with no replacement audio.',
    heroHeadline: 'Give each song section its own visual identity',
    heroSub: 'Illustrative waveform and amplitude-reactive motifs add editorial energy; they do not detect beats or lyrics.',
    listHeadline: 'Edit by sections; audition performances honestly',
    items: [
      'Use supplied sections or label the editorial section plan provisional',
      'Treat waveform and amplitude-style graphics as illustration, never beat or lyric inference',
      'Keep FastH3 singing inserts pending: experimental audition, SyncNet diagnostics, and human review',
    ],
    outroHeadline: 'The supplied song stays in charge',
    outroSub: 'No narration, procedural song, or claim of approved lip sync.',
    titleMotion: { recipe: 'kinetic', entry: 'maskRise' },
    heroMotion: { recipe: 'focus', focus: { x: 0.08, y: 0.2, width: 0.84, height: 0.6 }, entry: 'fadeUp' },
    listMotion: { recipe: 'kinetic', entry: 'waterfall' },
    outroMotion: { entry: 'none' },
    outroNotes: 'Final hold on the supplied-song master. No FastH3 performance has been generated or approved.',
  },
};

const PRESET_ASSETS: Record<MotionVideoType, {
  vectors: Array<[string, string, 'icon' | 'diagram' | 'pattern' | 'vector-anim', string]>;
  still: [string, string, string];
}> = {
  'motion-explainer': {
    vectors: [
      ['s_title', 'a clean input node for the explanation', 'icon', 'a single input node with a directional arrow, no words'],
      ['s_hero', 'a connected technical-flow diagram', 'diagram', 'three connected mechanism nodes with explicit directional connectors, no numeric labels'],
      ['s_list', 'a subtle connector-grid pattern', 'pattern', 'a restrained technical connector grid for the process background'],
      ['s_outro', 'an animated path resolving into a check', 'vector-anim', 'a vector path that travels through three nodes and resolves into a check mark'],
    ],
    still: ['s_hero', 'an abstract system-depth texture behind the flow', 'an abstract layered paper texture suggesting depth in a technical system, no text or numbers'],
  },
  'sketch-build': {
    vectors: [
      ['s_title', 'a pencil nib beginning the title sketch', 'icon', 'a simple pencil nib with one short hand-drawn stroke, no words'],
      ['s_hero', 'a drawOn construction sketch', 'diagram', 'an ordered construction drawing with contour lines, guides, and annotation leaders but no numeric labels'],
      ['s_list', 'a light graph-paper sketch pattern', 'pattern', 'subtle hand-drawn graph paper and small registration marks'],
      ['s_outro', 'a drawOn underline resolving the final sketch', 'vector-anim', 'one hand-drawn underline stroke that resolves and then remains static'],
    ],
    still: ['s_hero', 'a tactile paper texture under the drawing', 'clean off-white sketchbook paper with subtle fibres and soft daylight, no drawings, text, or numbers'],
  },
  'data-story': {
    vectors: [
      ['s_title', 'a neutral data-source marker', 'icon', 'a simple source-table icon with blank cells and no numbers'],
      ['s_hero', 'an unnumbered chart scaffold', 'diagram', 'clean chart axes and a source connector with no labels or numeric values'],
      ['s_list', 'a quiet measurement-grid pattern', 'pattern', 'a restrained blank measurement grid with no ticks, labels, or numbers'],
      ['s_outro', 'a countUp accent that resolves to a static summary', 'vector-anim', 'abstract bars rising into alignment, with no numeric glyphs or invented values'],
    ],
    still: ['s_hero', 'a neutral editorial data-paper texture', 'an abstract editorial paper texture with faint blank grid lines, no text, charts, or numbers'],
  },
  'product-walkthrough': {
    vectors: [
      ['s_title', 'a clean product-frame marker', 'icon', 'a minimal product frame with a central focus bracket, no logo or words'],
      ['s_hero', 'feature-callout leader lines', 'diagram', 'three blank product callout labels connected by precise leader lines to a central product frame'],
      ['s_list', 'a restrained product-detail grid', 'pattern', 'a subtle alignment grid for product details and feature callouts'],
      ['s_outro', 'a resolving product spotlight', 'vector-anim', 'a clean spotlight outline that settles around the product and then holds'],
    ],
    still: ['s_hero', 'a clean product-stage backdrop', 'an unbranded studio product stage with soft directional light and no object, label, logo, or text'],
  },
  'title-reveal': {
    vectors: [
      ['s_title', 'a minimal kinetic-type accent', 'icon', 'a geometric baseline and two blank typographic blocks, no letters or numbers'],
      ['s_hero', 'a kinetic-title alignment diagram', 'diagram', 'blank typographic alignment guides with a masked central title area, no letters or numbers'],
      ['s_list', 'a restrained editorial-type grid', 'pattern', 'a minimal baseline grid with no letters, numbers, or logos'],
      ['s_outro', 'a title underline resolving into a final hold', 'vector-anim', 'a single underline wipes in, resolves, and remains completely static for the final hold'],
    ],
    still: ['s_hero', 'a clean typographic stage texture', 'a smooth editorial stage with subtle directional light and generous blank space, no text, letters, or numbers'],
  },
  'music-video': {
    vectors: [
      ['s_title', 'an illustrative waveform section marker', 'icon', 'an abstract unmeasured waveform crest and blank editorial section marker, no words, notes, or beat markers'],
      ['s_hero', 'a section-based waveform editorial diagram', 'diagram', 'four abstract visual-section panels with unmeasured waveform ribbons and amplitude-style bars, no timestamps, beat grid, or lyrics'],
      ['s_list', 'an amplitude-reactive editorial pattern', 'pattern', 'abstract unequal bars and soft waveform contours for reactive editorial styling, unlabeled and not based on measured audio'],
      ['s_outro', 'a waveform ribbon settling into a static end frame', 'vector-anim', 'an illustrative waveform ribbon contracts into a clean section divider and holds, with no beat markers or lyric text'],
    ],
    still: ['s_hero', 'an empty stage plate for a possible performance insert', 'an empty experimental performance stage with abstract lighting and a blank foreground, no performer, instruments, readable text, or recorded footage'],
  },
};

interface BriefDataset {
  unit: string;
  label: string;
  values: Array<{ label: string; value: number }>;
  source: 'user';
}

const NON_DATA_LABELS = /^(?:length|duration|seconds?|minutes?|mins?|fps|frames?|width|height|aspect|format|resolution|ratio|shots?)$/i;
const DATA_UNIT_RE = /^(?:%|percent|percentage|users?|customers?|sales?|signups?|downloads?|views?|members?|subscribers?|orders?|revenue|profit|points?|units?|items?|minutes?|hours?|days?|weeks?|months?|years?|ms|s|kg|km|miles?|dollars?|usd|eur|gbp)$/i;

/** Extract only explicit user values; an absent dataset never becomes demo statistics. */
function dataStoryDataset(brief: string): BriefDataset | null {
  const values: Array<{ label: string; value: number; unit?: string }> = [];
  const seen = new Set<string>();
  const add = (rawLabel: string, rawValue: string, rawUnit?: string) => {
    const label = rawLabel.trim().replace(/\s+/g, ' ').replace(/^(?:the|our)\s+/i, '').slice(0, 64);
    const value = Number(rawValue);
    if (!label || NON_DATA_LABELS.test(label) || !Number.isFinite(value)) return;
    const key = `${label.toLowerCase()}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const unit = rawUnit?.toLowerCase() === 'percent' || rawUnit?.toLowerCase() === 'percentage'
      ? '%'
      : rawUnit && DATA_UNIT_RE.test(rawUnit) ? rawUnit.toLowerCase() : undefined;
    values.push({ label, value, ...(unit ? { unit } : {}) });
  };
  const paired = /(?:^|[.,;:\n]\s*|\band\s+)([A-Za-z][A-Za-z0-9 _&'\/-]{0,40}?)\s*(?:=|:)\s*(-?\d+(?:\.\d+)?)\s*(%|percent|percentage|[A-Za-z]+)?/gi;
  for (const match of brief.matchAll(paired)) add(match[1], match[2], match[3]);
  const natural = /\b([A-Za-z][A-Za-z0-9_&'\/-]*(?:\s+[A-Za-z][A-Za-z0-9_&'\/-]*){0,3})\s+(?:grew|rose|increased|fell|dropped|decreased|reached|was|were|is|are)\s+(?:by\s+|to\s+)?(-?\d+(?:\.\d+)?)\s*(%|percent|percentage|[A-Za-z]+)?/gi;
  for (const match of brief.matchAll(natural)) add(match[1], match[2], match[3]);
  if (values.length === 0) return null;
  const units = new Set(values.map(entry => entry.unit).filter(Boolean));
  const unit = units.size === 1 ? [...units][0]! : 'value';
  return {
    unit,
    label: 'Values supplied in the brief',
    values: values.slice(0, 12).map(({ label, value }) => ({ label, value })),
    source: 'user',
  };
}

function dataStoryScenes(brief: string, dataset: BriefDataset | null): ScriptedScene[] {
  const title = titleFor(brief);
  if (!dataset) {
    return [
      presetScene('s_title', 'title', { kicker: 'Data story', headline: title, sub: 'A sourced narrative outline with no invented numbers.' }, { motion: { recipe: 'kinetic', entry: 'maskRise' } }),
      presetScene('s_hero', 'hero', { headline: 'Start with the question behind the data', sub: 'The story structure is ready; factual charts wait for user-supplied values.', body: 'No usable dataset was supplied, so this plan does not fabricate a chart, statistic, trend, or count-up.' }, { motion: { recipe: 'focus', focus: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 } } }),
      presetScene('s_list', 'list', { headline: 'What the sourced version needs', items: ['A name for every value', 'The exact supplied numbers', 'The unit and source context'] }, { motion: { entry: 'waterfall' }, notes: 'No dataset was supplied; no values were invented.' }),
      presetScene('s_outro', 'title', { headline: 'Add the numbers. Tell the story.', sub: 'No factual chart is drawn until the data arrives.' }, { motion: { entry: 'none' }, notes: 'Final hold on the data request; no statistics are shown.' }),
    ];
  }
  const first = dataset.values[0];
  const suffix = dataset.unit === 'value' ? '' : ` ${dataset.unit}`;
  return [
    presetScene('s_title', 'title', { kicker: 'Data story', headline: title, sub: 'Every value comes directly from the brief.' }, { motion: { recipe: 'kinetic', entry: 'maskRise' } }),
    presetScene('s_hero', 'hero', { headline: 'What the supplied numbers say', sub: 'A plain-language reading before the sourced chart.', body: 'The chart and statistic below use only the named values supplied in the request.' }, { motion: { recipe: 'focus', focus: { x: 0.12, y: 0.2, width: 0.76, height: 0.58 } } }),
    presetScene('s_stat', 'stat', { headline: first.label, sub: 'User-supplied value', body: `${first.value}${suffix}` }, { data: { dataset: 'd_story', display: 'number' }, motion: { entry: 'countUp' }, pattern: 'gradient' }),
    presetScene('s_chart', 'chart', { headline: 'Compare the supplied values', sub: 'Same source, same visual scale.', footnote: 'Source: values supplied in the brief.' }, { data: { dataset: 'd_story', display: 'bar' }, motion: { entry: 'countUp' }, pattern: 'grain' }),
    presetScene('s_list', 'list', { headline: 'The values in context', items: dataset.values.slice(0, 6).map(entry => `${entry.label}: ${entry.value}${suffix}`) }, { motion: { entry: 'waterfall' } }),
    presetScene('s_outro', 'title', { headline: 'Let the sourced numbers carry the point', sub: 'No inferred trend and no invented total.' }, { motion: { entry: 'none' }, notes: 'Final hold on the sourced takeaway.' }),
  ];
}

function presetCpuScript(brief: string, type: MotionVideoType): ScriptedCall[] {
  const preset = getVideoType(type)!;
  const dataset = type === 'data-story' ? dataStoryDataset(brief) : null;
  const scenes = type === 'data-story'
    ? dataStoryScenes(brief, dataset)
    : (() => {
        const copy = PRESET_COPY[type];
        const title = titleFor(brief);
        return [
          presetScene('s_title', 'title', { kicker: preset.label, headline: title, sub: copy.titleSub }, { motion: copy.titleMotion }),
          presetScene('s_hero', 'hero', { headline: copy.heroHeadline, sub: copy.heroSub }, { motion: copy.heroMotion }),
          presetScene('s_list', 'list', { headline: copy.listHeadline, items: copy.items }, { motion: copy.listMotion }),
          presetScene('s_outro', 'title', { headline: copy.outroHeadline, sub: copy.outroSub }, { motion: copy.outroMotion, notes: copy.outroNotes }),
        ];
      })();
  const logline = type === 'data-story'
    ? dataset ? 'A sourced data narrative using only the values named in the brief.' : 'A data-story outline that waits for sourced values instead of inventing them.'
    : PRESET_COPY[type].logline;
  const soundtrack = type === 'data-story' ? 'A measured pulse with cues that settle for each sourced value.' : PRESET_COPY[type].soundtrack;
  const calls: ScriptedCall[] = [{
    name: 'storyboard.propose',
    args: {
      brief,
      title: titleFor(brief),
      proposal: { logline, look: preset.scriptedTreatment, soundtrack },
      scenes,
      ...(dataset ? { datasets: { d_story: dataset } } : {}),
    },
  }];
  const assets = PRESET_ASSETS[type];
  assets.vectors.forEach(([sceneId, need, kind, intent], index) => {
    calls.push(
      { name: 'assets.route', args: { scene_id: sceneId, need, kind, ...(kind === 'vector-anim' ? { animated: true } : {}) } },
      { name: 'assets.generate_svg', args: { scene_id: sceneId, kind, intent, seed: index + 1 } },
    );
  });
  const [sceneId, need, intent] = assets.still;
  calls.push(
    { name: 'assets.route', args: { scene_id: sceneId, need, kind: 'illustration' } },
    { name: 'assets.generate_image', args: { scene_id: sceneId, kind: 'illustration', intent, seed: 5 } },
  );
  return calls;
}

/** The offline plan: route and generate four vector assets, then plan one FLUX still. */
export function defaultCpuScript(brief: string, videoType?: VideoType): ScriptedCall[] {
  if (videoType !== undefined && videoType !== 'action-scene') return presetCpuScript(brief, videoType);
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
 * same tools the live model uses. Native visuals need no generated assets;
 * requested raster generation remains a pending-GPU plan.
 */
export async function runCpuSlice(options: CpuSliceOptions): Promise<CpuSliceResult> {
  try {
    return await planCpuSlice(options);
  } catch (error) {
    throw cpuSliceFailure(error);
  }
}

async function planCpuSlice(options: CpuSliceOptions): Promise<CpuSliceResult> {
  const preset = options.videoType ? getVideoType(options.videoType) : undefined;
  const intent = options.initialIntent ?? classifyProductionIntent(options.brief, preset?.fallbackKind);
  const motionModel = parseMotionModel(options.motionModel, 'auto');
  if (intent.generatedFilm && !options.model) {
    throw cpuSliceError('GENERATED_FILM_REQUIRES_MODEL', 'generated-film planning requires a live model and scene-referenced generated shots; the scripted defaultCpuScript is motion-graphics-only and is not an acceptable fallback');
  }
  let draft: Record<string, any> | undefined = options.initialPackage ? structuredClone(options.initialPackage) : undefined;
  const stylePreset = /Look:\s*([a-z-]+)/i.exec(options.brief)?.[1] as StylePreset | undefined;
  const allTools = createToolset({
    csvAttachments: options.csvAttachments,
    generateSvg: options.generateSvg,
    ...(options.initialPackage ? { initialPackage: options.initialPackage } : {}),
    initialIntent: intent,
    ...(options.persistSvg ? { persistSvg: options.persistSvg } : {}),
    ...(options.persistAudio ? { persistAudio: options.persistAudio } : {}),
    ...(options.prepareDialogueAudio ? { prepareDialogueAudio: options.prepareDialogueAudio } : {}),
    motionModel,
    ...(options.planImage ? { planImage: options.planImage } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.brand ? { brand: options.brand } : {}),
    ...(options.brandAssets ? { brandAssets: options.brandAssets } : {}),
    ...(options.adoptReferenceImage ? { adoptReferenceImage: options.adoptReferenceImage } : {}),
    ...(stylePreset ? { stylePreset } : {}),
    onPackageChange: pkg => {
      draft = pkg;
    },
  });
  // Keep generated-film planning focused. SVG/style/chart tools are irrelevant,
  // enlarge every model request and can derail a shot plan before video exists.
  const planningTools = intent.generatedFilm
    ? Object.fromEntries(Object.entries(allTools).filter(([name]) => ['storyboard.propose', 'storyboard.edit', 'assets.generate_image', 'assets.generate_video'].includes(name)))
    : allTools;
  // Repair operates on the supplied package; a new proposal would discard the
  // user's existing choices and attachments even if the resulting schema passes.
  const tools = options.initialPackage
    ? Object.fromEntries(Object.entries(planningTools).filter(([name]) => name !== 'storyboard.propose'
      && !(options.repairWithoutGpu && ['assets.generate_image', 'assets.generate_video', 'assets.sketch_to_render'].includes(name))))
    : planningTools;
  const live = Boolean(options.model);
  // Offline is an editorial outline using native layouts, not an SVG generator.
  // The scripted asset intents are not drawings; omit them rather than labeling
  // unrelated test shapes as ready illustrations.
  const scriptedCalls = options.model ? [] : defaultCpuScript(options.brief, options.videoType);
  const offlineScript = !options.model && !options.generateSvg ? scriptedCalls.filter(call =>
    call.name !== 'assets.generate_svg'
      && !(call.name === 'assets.route' && ['icon', 'diagram', 'pattern', 'vector-anim'].includes(String((call.args as any)?.kind)))
  ) : scriptedCalls;
  const model = options.model ?? createScriptedModel(offlineScript);
  const result = await runAgent({
    model,
    brief: options.brief,
    tools,
    sessionId: options.sessionId ?? 'cpu-slice',
    ...(options.signal ? { signal: options.signal } : {}),
    maxSteps: options.maxSteps ?? 24,
    ...(options.maxInvalidArgumentRepairs !== undefined ? { maxInvalidArgumentRepairs: options.maxInvalidArgumentRepairs } : {}),
    ...(options.system ? { system: options.system } : {}),
    ...(options.systemSuffix ? { systemSuffix: options.systemSuffix } : {}),
    ...(options.contextSystem ? { contextSystem: options.contextSystem } : {}),
    ...(options.videoType ? { videoType: options.videoType } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const pkg = draft ?? (result.toolCalls.find(call => call.name === 'storyboard.propose')?.result as any)?.package;
  if (result.stopped === 'model_error') {
    const code = result.errorCode ?? 'MODEL_ERROR';
    const status = /^http_([45]\d\d)$/.exec(code);
    throw Object.assign(new Error(result.error || 'Model request failed'), { code, status: status ? Number(status[1]) : 502 });
  }
  if (!pkg) throw cpuSliceError('PACKAGE_DRAFT_MISSING', `agent did not produce a package draft${result.stopped && result.stopped !== 'final' ? ` (${result.stopped}: ${result.error ?? 'planning stopped'})` : ''}`);
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
    ok: result.ok && problems.length === 0,
    live,
    package: pkg,
    routes,
    pendingGpu,
    svgAssets,
    problems,
    result,
  };
}
