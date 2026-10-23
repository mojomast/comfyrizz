/**
 * IP53: the closed, swappable graphics and music recipe catalog.
 *
 * A music recipe describes the bed it wants (mood, energy, tempo, search words and a
 * generation/search brief). It never names an asset: the caller finds or generates a bed,
 * then calls applyMusicRecipe again with that ready asset id. The only package field a
 * music swap edits is `audio.music.asset`; gain, fades, loop, duck, graphics and scenes
 * are untouched.
 *
 * A graphics recipe writes the two package fields the renderer reads for a look:
 * `theme.palette` (1..8 hex colours) and `motion.energy` (calm | medium | high).
 *
 * Every function is pure and deterministic: the input package is cloned, never mutated.
 */

export type RecipeKind = 'graphics' | 'music';
export type MotionEnergy = 'calm' | 'medium' | 'high';

export interface GraphicsRecipe {
  readonly kind: 'graphics';
  readonly id: string;
  readonly label: string;
  readonly palette: readonly string[];
  readonly energy: MotionEnergy;
  readonly keywords: readonly string[];
  readonly brief: string;
}

export interface MusicRecipe {
  readonly kind: 'music';
  readonly id: string;
  readonly label: string;
  readonly mood: string;
  readonly energy: MotionEnergy;
  readonly bpm: { readonly min: number; readonly max: number };
  readonly keywords: readonly string[];
  readonly brief: string;
}

export type Recipe = GraphicsRecipe | MusicRecipe;

export type PackageDocument = Record<string, any>;

export interface AppliedGraphicsResult {
  status: 'applied';
  package: PackageDocument;
  recipeId: string;
}

export interface AppliedMusicResult {
  status: 'applied';
  package: PackageDocument;
  recipeId: string;
  assetId: string;
}

export interface NeedsBedResult {
  status: 'needs_bed';
  recipeId: string;
  mood: string;
  energy: MotionEnergy;
  bpm: { min: number; max: number };
}

export type MusicApplyResult = AppliedMusicResult | NeedsBedResult;
export type ApplyRecipeResult = AppliedGraphicsResult | MusicApplyResult;

const MOTION_ENERGIES: readonly MotionEnergy[] = ['calm', 'medium', 'high'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function freezeRecipe<T extends Recipe>(recipe: T): T {
  for (const value of Object.values(recipe)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === 'object') Object.freeze(item);
      }
      Object.freeze(value);
    } else if (value !== null && typeof value === 'object') {
      Object.freeze(value);
    }
  }
  return Object.freeze(recipe) as T;
}

/** The one catalog. A recipe id is unique across both kinds. */
export const ALL_RECIPES: readonly Recipe[] = Object.freeze([
  freezeRecipe<GraphicsRecipe>({
    kind: 'graphics',
    id: 'cinematic',
    label: 'Cinematic',
    palette: ['#080B14', '#1D2438', '#C9A45C', '#F3EEE3', '#7286A5'],
    energy: 'medium',
    keywords: ['cinematic', 'film', 'moody', 'dramatic', 'anamorphic', 'epic', 'teal and orange'],
    brief: 'A filmic palette: near-black shadows, a desaturated cool midtone and one warm accent for titles.',
  }),
  freezeRecipe<GraphicsRecipe>({
    kind: 'graphics',
    id: 'editorial',
    label: 'Editorial',
    palette: ['#F7F4EE', '#111111', '#C6402E', '#7D8B93'],
    energy: 'calm',
    keywords: ['editorial', 'magazine', 'clean', 'serif', 'documentary', 'print'],
    brief: 'A print-editorial palette: warm paper, ink black and one restrained red accent.',
  }),
  freezeRecipe<GraphicsRecipe>({
    kind: 'graphics',
    id: 'minimal',
    label: 'Minimal',
    palette: ['#FFFFFF', '#111111', '#8C8C8C'],
    energy: 'calm',
    keywords: ['minimal', 'minimalist', 'quiet', 'simple', 'monochrome', 'clean'],
    brief: 'A quiet monochrome palette with generous white space and a single grey midtone.',
  }),
  freezeRecipe<GraphicsRecipe>({
    kind: 'graphics',
    id: 'vibrant',
    label: 'Vibrant',
    palette: ['#0A0A0A', '#FF3D81', '#00D1B2', '#FFD166', '#4D5BFF'],
    energy: 'high',
    keywords: ['upbeat', 'vibrant', 'bright', 'energetic', 'bold', 'colorful', 'punchy', 'positive'],
    brief: 'A high-energy palette: saturated magenta, teal and yellow on a near-black ground.',
  }),
  freezeRecipe<GraphicsRecipe>({
    kind: 'graphics',
    id: 'technical',
    label: 'Technical',
    palette: ['#0B1220', '#1E293B', '#38BDF8', '#E2E8F0'],
    energy: 'medium',
    keywords: ['technical', 'tech', 'blueprint', 'data', 'saas', 'product', 'diagram'],
    brief: 'A product/engineering palette: navy panels, a cyan signal colour and cool white type.',
  }),
  freezeRecipe<GraphicsRecipe>({
    kind: 'graphics',
    id: 'organic',
    label: 'Organic',
    palette: ['#F4EBDD', '#3E4A3D', '#A86B4C', '#D9C6A5'],
    energy: 'calm',
    keywords: ['organic', 'natural', 'warm', 'earthy', 'handmade', 'soft', 'craft'],
    brief: 'An earthy palette: unbleached paper, moss green, clay and sand.',
  }),
  freezeRecipe<MusicRecipe>({
    kind: 'music',
    id: 'calm',
    label: 'Calm',
    mood: 'calm, reflective',
    energy: 'calm',
    bpm: { min: 60, max: 80 },
    keywords: ['calm', 'gentle', 'reflective', 'ambient', 'soft', 'quiet', 'peaceful', 'documentary', 'underscore'],
    brief: 'Find or generate a sparse, warm instrumental bed at 60-80 BPM with no vocals: felt piano or soft pads, slow attack, enough headroom to sit under narration.',
  }),
  freezeRecipe<MusicRecipe>({
    kind: 'music',
    id: 'warm',
    label: 'Warm',
    mood: 'warm, optimistic',
    energy: 'medium',
    bpm: { min: 85, max: 105 },
    keywords: ['warm', 'optimistic', 'hopeful', 'uplifting', 'friendly', 'acoustic', 'light', 'human'],
    brief: 'Find or generate a warm instrumental bed at 85-105 BPM with no vocals: plucked acoustic guitar or soft keys, steady but unbusy, leaving space for dialogue.',
  }),
  freezeRecipe<MusicRecipe>({
    kind: 'music',
    id: 'upbeat',
    label: 'Upbeat',
    mood: 'upbeat, energetic',
    energy: 'high',
    bpm: { min: 115, max: 135 },
    keywords: ['upbeat', 'energetic', 'up-tempo', 'driving', 'punchy', 'happy', 'bright', 'motivated', 'positive', 'more upbeat'],
    brief: 'Find or generate an upbeat instrumental bed at 115-135 BPM with no vocals: crisp percussion, a simple bass hook and a bright synth or guitar motif.',
  }),
  freezeRecipe<MusicRecipe>({
    kind: 'music',
    id: 'dramatic',
    label: 'Dramatic',
    mood: 'dramatic, cinematic',
    energy: 'high',
    bpm: { min: 90, max: 120 },
    keywords: ['dramatic', 'cinematic', 'tense', 'epic', 'trailer', 'score', 'orchestral', 'suspense', 'build'],
    brief: 'Find or generate a cinematic instrumental bed at 90-120 BPM with no vocals: low strings or drones, a slow build and a clear but restrained pulse.',
  }),
]);

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertGraphicsRecipe(recipe: GraphicsRecipe): void {
  if (recipe.kind !== 'graphics') throw new TypeError(`recipe ${recipe.id} is not a graphics recipe`);
  if (!Array.isArray(recipe.palette) || recipe.palette.length < 1 || recipe.palette.length > 8) {
    throw new TypeError(`graphics recipe ${recipe.id} needs a palette of 1 to 8 colours`);
  }
  if (!recipe.palette.every(hex => HEX_COLOR.test(hex))) {
    throw new TypeError(`graphics recipe ${recipe.id} has a palette colour that is not #rrggbb`);
  }
  if (!MOTION_ENERGIES.includes(recipe.energy)) {
    throw new TypeError(`graphics recipe ${recipe.id} has an unknown motion energy`);
  }
}

function assertMusicRecipe(recipe: MusicRecipe): void {
  if (recipe.kind !== 'music') throw new TypeError(`recipe ${recipe.id} is not a music recipe`);
  if (!MOTION_ENERGIES.includes(recipe.energy)) {
    throw new TypeError(`music recipe ${recipe.id} has an unknown energy`);
  }
  if (!Number.isFinite(recipe.bpm.min) || !Number.isFinite(recipe.bpm.max) || recipe.bpm.min <= 0 || recipe.bpm.max < recipe.bpm.min) {
    throw new TypeError(`music recipe ${recipe.id} has an invalid bpm range`);
  }
}

function clonePackage(pkg: PackageDocument): PackageDocument {
  return structuredClone(pkg);
}

function isReadyAudio(pkg: PackageDocument, assetId: string | undefined): assetId is string {
  if (typeof assetId !== 'string' || !isRecord(pkg.assets)) return false;
  const asset = pkg.assets[assetId];
  return isRecord(asset) && asset.kind === 'audio' && asset.status === 'ready';
}

/** Write a graphics recipe's palette and motion energy, keeping every other package field. */
export function applyGraphicsRecipe(pkg: PackageDocument, recipe: GraphicsRecipe): AppliedGraphicsResult {
  assertGraphicsRecipe(recipe);
  const next = clonePackage(pkg);
  const theme = isRecord(next.theme) ? next.theme : {};
  theme.palette = [...recipe.palette];
  next.theme = theme;
  const motion = isRecord(next.motion) ? next.motion : {};
  motion.energy = recipe.energy;
  next.motion = motion;
  return { status: 'applied', package: next, recipeId: recipe.id };
}

/**
 * Swap the music bed to `assetId` only when it is a ready audio asset already in the package.
 * Without one, nothing is edited and the caller gets the bed brief back to search or generate.
 */
export function applyMusicRecipe(pkg: PackageDocument, recipe: MusicRecipe, assetId?: string): MusicApplyResult {
  assertMusicRecipe(recipe);
  if (!isReadyAudio(pkg, assetId)) {
    return {
      status: 'needs_bed',
      recipeId: recipe.id,
      mood: recipe.mood,
      energy: recipe.energy,
      bpm: { min: recipe.bpm.min, max: recipe.bpm.max },
    };
  }
  const next = clonePackage(pkg);
  next.audio = isRecord(next.audio) ? next.audio : {};
  next.audio.music = isRecord(next.audio.music) ? next.audio.music : {};
  next.audio.music.asset = assetId;
  return { status: 'applied', package: next, recipeId: recipe.id, assetId };
}

/** The one dispatcher for a resolved recipe; music may need a ready bed first. */
export function applyRecipe(pkg: PackageDocument, recipe: Recipe, assetId?: string): ApplyRecipeResult {
  return recipe.kind === 'music' ? applyMusicRecipe(pkg, recipe, assetId) : applyGraphicsRecipe(pkg, recipe);
}

const KIND_WORDS: ReadonlyArray<{ kind: RecipeKind; pattern: RegExp }> = [
  { kind: 'music', pattern: /\b(music|audio|soundtrack|score|song|bed|underscore)\b/i },
  { kind: 'graphics', pattern: /\b(graphics?|visuals?|palette|theme|look)\b/i },
];

function namedKind(text: string): RecipeKind | undefined {
  let best: { kind: RecipeKind; index: number } | undefined;
  for (const entry of KIND_WORDS) {
    const match = entry.pattern.exec(text);
    if (match && (best === undefined || match.index < best.index)) {
      best = { kind: entry.kind, index: match.index };
    }
  }
  return best?.kind;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(word)}($|[^a-z0-9_-])`, 'i').test(text);
}

function matchScore(recipe: Recipe, text: string): number {
  let score = 0;
  if (hasWord(text, recipe.id)) score += 1000;
  if (text.includes(recipe.label.toLowerCase())) score += 100;
  for (const keyword of recipe.keywords) {
    if (text.includes(keyword.toLowerCase())) score += 10;
  }
  return score;
}

/**
 * Resolve free text to one recipe. When the text names a kind, only that kind is searched:
 * "cinematic music" is the music recipe whose keywords include cinematic, while
 * "cinematic graphics" (and plain "cinematic") is the graphics recipe with that id.
 * Ties keep catalog order, so the same text always returns the same recipe.
 */
export function resolveRecipe(text: string): Recipe | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  const lower = text.toLowerCase();
  const kind = namedKind(lower);
  const candidates = kind === undefined ? ALL_RECIPES : ALL_RECIPES.filter(recipe => recipe.kind === kind);
  let best: Recipe | undefined;
  let bestScore = 0;
  for (const recipe of candidates) {
    const score = matchScore(recipe, lower);
    if (score > bestScore) {
      best = recipe;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : undefined;
}
