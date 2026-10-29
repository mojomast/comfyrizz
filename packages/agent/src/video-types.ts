export const VIDEO_TYPE_IDS = [
  'motion-explainer',
  'sketch-build',
  'data-story',
  'product-walkthrough',
  'title-reveal',
  'action-scene',
  'music-video',
] as const;

/** A stable, user-selectable video planner preset id. */
export type VideoType = (typeof VIDEO_TYPE_IDS)[number];

export interface VideoTypeDefinition {
  id: VideoType;
  version: number;
  label: string;
  description: string;
  fallbackKind: 'motion-graphics' | 'generated-film';
  /** Server-owned direction appended to the default builder prompt. */
  plannerPrompt: string;
  /** Server-owned direction used by the deterministic offline planner. */
  scriptedTreatment: string;
  promptPlaceholder: string;
  inputHint: string;
  costLabel: string;
  icon?: string;
}

/**
 * Ordered planner contracts. This module deliberately has no runtime imports or
 * Node builtins so the same cards can be rendered by browser clients.
 */
export const VIDEO_TYPES = [
  {
    id: 'motion-explainer',
    version: 1,
    label: 'Motion explainer',
    description: 'Turn a mechanism, workflow, or idea into a clear animated explanation.',
    fallbackKind: 'motion-graphics',
    plannerPrompt: 'Build a motion-graphics explanation with a technical-flow visual hierarchy. Break the idea into causal steps, connect editable nodes with deliberate motion, and use concise copy that explains the actual mechanism. Keep charts tied to supplied data and preserve every explicit brief constraint.',
    scriptedTreatment: 'technical-flow steps, connected diagrams, concise mechanism copy, and procedural vector accents',
    promptPlaceholder: 'Explain how a heat pump moves warmth from outdoors to indoors…',
    inputHint: 'Name the process or mechanism and the audience. Include any steps that must be covered.',
    costLabel: 'CPU plan; optional stills need approval',
    icon: 'workflow',
  },
  {
    id: 'sketch-build',
    version: 1,
    label: 'Sketch build',
    description: 'Reveal an idea as hand-drawn lines, labels, and annotations assemble.',
    fallbackKind: 'motion-graphics',
    plannerPrompt: 'Treat the storyboard as a sketch being built in view. For explicit hand-drawn or procedural animation, use storyboard.draw and storyboard.extend_drawing to progressively reveal subject-specific geometry, labels and annotations, one scene or layer per turn. Copy a held previous scene to preserve geometry. Otherwise use the sketch recipe and drawOn entries for SVG or vector-anim assets. Keep the final drawing readable and do not substitute generated footage for explicit procedural wording.',
    scriptedTreatment: 'sketch recipe, drawOn vector reveals, handwritten-style annotations, and a resolved final drawing',
    promptPlaceholder: 'Sketch how a bicycle derailleur shifts the chain between gears…',
    inputHint: 'Describe the object or diagram to draw and any labels that should appear.',
    costLabel: 'CPU plan; optional stills need approval',
    icon: 'pencil-line',
  },
  {
    id: 'data-story',
    version: 1,
    label: 'Data story',
    description: 'Tell a sourced story with charts, statistics, and measured count-ups.',
    fallbackKind: 'motion-graphics',
    plannerPrompt: 'Make the supplied data the story. For CSV attachments use context.read_csv to inspect columns and context.query_csv for exact filtered counts and distinct values; never count mentally. After proposing scenes use storyboard.csv_dataset to bind grouped chart counts directly to the CSV; for years in ISO dates use group_by_transform year. For one-mark-per-row visuals use storyboard.csv_tile_wall with explicit category colors, require_categories for essential outcomes and review uncategorized results; set reveal_frames to animate rows. Rules take precedence in order, then exact category colors, then fallback. Use chart and stat scenes with countUp where appropriate, and explain the numbers. Never invent, extrapolate, or silently replace numbers; when no usable values are supplied, plan a qualitative outline that asks for sourced data instead of drawing a factual chart.',
    scriptedTreatment: 'user-sourced chart/stat scenes, countUp reveals, plain-language takeaways, and no invented numbers',
    promptPlaceholder: 'Show our quarterly story: North = 42, South = 35, West = 28…',
    inputHint: 'Supply named values and their unit. Without values, the planner will not invent a dataset.',
    costLabel: 'CPU plan; optional stills need approval',
    icon: 'chart-no-axes-column-increasing',
  },
  {
    id: 'product-walkthrough',
    version: 2,
    label: 'Product walkthrough',
    description: 'Focus attention on a product, its details, and feature callouts.',
    fallbackKind: 'motion-graphics',
    plannerPrompt: 'Build a product-focused walkthrough in the medium requested by the brief: generated product footage, supplied media or procedural graphics. Establish the product, show the requested details, and return to a complete product view. Preserve its physical design, materials and shared references across shots. Feature callouts are optional, never a reason to add text beyond an explicit copy list. When copy is supplied in order, use only those exact strings unless additions are allowed; intermediate detail shots can be text-free. Use native text overlays rather than generated lettering when requested. Match the requested motion intensity and final hold; do not invent a closing promise, specifications or claims.',
    scriptedTreatment: 'product hero, focus/detail windows, feature callouts, and a clean closing product frame',
    promptPlaceholder: 'Walk through a compact travel camera, highlighting its lens, grip, and flip screen…',
    inputHint: 'Name the product and the real features to highlight. Avoid claims you cannot support.',
    costLabel: 'CPU plan; optional stills need approval',
    icon: 'scan-search',
  },
  {
    id: 'title-reveal',
    version: 1,
    label: 'Title reveal',
    description: 'Make typography the event with a kinetic entrance and clean final hold.',
    fallbackKind: 'motion-graphics',
    plannerPrompt: 'Make typography carry the piece. Use a kinetic title treatment with short, purposeful text gestures and a readable resolved composition. Reserve a static final hold for the completed title or message; do not stack decorative motion after the words have resolved.',
    scriptedTreatment: 'kinetic title entrances, minimal typographic vector accents, and an explicit static final hold',
    promptPlaceholder: 'Reveal “The Night Market” with bold type and the line “One street. A hundred stories.”…',
    inputHint: 'Provide the exact title and optional supporting line. Mention the desired tone.',
    costLabel: 'CPU plan; optional stills need approval',
    icon: 'type',
  },
  {
    id: 'action-scene',
    version: 1,
    label: 'Action scene',
    description: 'Plan a generated-film action sequence with physical beats and directed sound.',
    fallbackKind: 'generated-film',
    plannerPrompt: 'Plan this as a generated-film action scene: observable physical beats, continuous shot geography, intentional camera direction, and a directed soundscape. Preserve explicit generated-film and live-action wording. Explicit procedural, SVG, chart, or motion-graphics wording overrides this preset fallback and stays procedural. Offline scripted planning must retain the honest GENERATED_FILM_REQUIRES_MODEL refusal rather than substituting motion graphics.',
    scriptedTreatment: 'generated action shots only; offline planning refuses honestly instead of substituting motion graphics',
    promptPlaceholder: 'A courier vaults a rooftop gap as a drone closes in, with wind and traffic below…',
    inputHint: 'Describe the subject, physical action, setting, and desired sound. Generated media needs a live model.',
    costLabel: 'Generated video; approval and live model required',
    icon: 'clapperboard',
  },
  {
    id: 'music-video',
    version: 1,
    label: 'Music video',
    description: 'Build section-based motion graphics around your supplied song, with honest performance-insert options.',
    fallbackKind: 'motion-graphics',
    plannerPrompt: 'Plan a section-based music video around the user-supplied song. The supplied song is the only authoritative master: never replace it with composed music, a procedural song, Kokoro or Qwen narration or vocals, or H3 dialogue, and never fabricate a song asset. Use only explicitly supplied song sections or clearly provisional editorial sections. Waveform and amplitude-reactive graphics are illustrative editorial devices, not beat or lyric analysis; never claim beats, lyrics, timestamps, or song structure were inferred from amplitude. FastH3 is the default candidate for new image-based singing-performance auditions, with LTX available for comparison. Every performance insert is a pending experimental audition requiring SyncNet diagnostics and human review; never describe it as perfect, approved, or production-ready lip sync.',
    scriptedTreatment: 'section visuals, reactive waveforms, pending FastH3 auditions; no inferred beats/lyrics',
    promptPlaceholder: 'Create a music video for my supplied song with bold section-based type and abstract waveform visuals…',
    inputHint: 'Supply the song and any known sections or visual references. The offline planner will not invent audio or infer beats or lyrics.',
    costLabel: 'CPU visuals; optional FastH3 auditions need approval',
    icon: 'audio-waveform',
  },
] as const satisfies readonly VideoTypeDefinition[];

const VIDEO_TYPE_SET: ReadonlySet<string> = new Set(VIDEO_TYPE_IDS);

export function isVideoType(value: unknown): value is VideoType {
  return typeof value === 'string' && VIDEO_TYPE_SET.has(value);
}

/** Return the immutable contract for a known id, or undefined for an unknown value. */
export function getVideoType(value: unknown): VideoTypeDefinition | undefined {
  return isVideoType(value) ? VIDEO_TYPES.find(preset => preset.id === value) : undefined;
}
