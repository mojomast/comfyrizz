/**
 * M16: agent tools for the MOTION_UPGRADE style-recipe library.
 *
 * The 24 recipe documents, the variety engine, the compiler and the look score
 * already live in `scripts/motionkit/`. This module only reads that committed
 * data at runtime (the same candidate-URL trick `skills/index.ts` uses) and
 * exposes three tools: `style.list`, `style.suggest` and `style.apply`.
 *
 * No network, no GPU and no import-time filesystem access. Every call is
 * deterministic for the same inputs and seed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import type { AgentTool } from './tools.js';

export interface StyleRecipe {
  schema: string;
  id: string;
  label: string;
  taxonomy: { era: string; finish: string; energy: string; geometry: string; type: string };
  palette: Array<{ role: string; hex: string }>;
  fonts: { display: string; text: string; mono?: string };
  easing: { personality: string; entry: string; exit: string; spring: string };
  entries: string[];
  emphasis?: string[];
  transitions: { primary: string; accent: string[] };
  storyRecipe?: string;
  background: { pattern: string };
  finish: Array<string | { id: string; params?: Record<string, unknown>; cpuFallback?: boolean }>;
  rules?: { do: string[]; dont: string[] };
  prompt?: string;
}

export interface StyleSuggestion {
  id: string;
  recipeId: string;
  label: string;
  reason: string;
  energy: string;
  baseFit: number;
  weight: number;
}

export interface StyleSuggestInput {
  tone?: string | string[];
  goal?: string;
  energy?: string;
  history?: unknown[];
  seed?: number;
}

export interface StyleApplyInput {
  recipeId: string;
  seed?: number;
}

export interface StyleScore {
  score: number;
  parts: Record<string, number>;
  ratios: Record<string, number>;
  findings: Array<{ code: string; severity: string; part: string; scene: string | null; message: string }>;
}

export interface StyleApplyResult {
  recipeId: string;
  recipe: StyleRecipe;
  package: Record<string, any>;
  /** Alias for `package`, matching the compiler's own return field. */
  pkg: Record<string, any>;
  look: Record<string, any>;
  /** The 0-100 look score (the same number `scoreLook` returns). */
  score: number;
  /** The full M14 report: score, parts, ratios and scene findings. */
  lookScore: StyleScore;
  scoreReport: StyleScore;
  parts: Record<string, number>;
  findings: StyleScore['findings'];
}

const CANDIDATE_ROOTS = [
  new URL('../../../scripts/motionkit/', import.meta.url),
  new URL('../../../../scripts/motionkit/', import.meta.url),
];

const RECIPE_ORDER = [
  'swiss-grid', 'editorial-serif', 'neo-brutalist', 'kinetic-poster', 'bauhaus-play', 'mono-terminal',
  'blueprint', 'isometric-saas', 'glassmorphism', 'clay-soft', 'paper-collage', 'risograph',
  'cinematic-noir', 'film-35mm', 'vhs-retro', 'crt-arcade', 'y2k-chrome', 'synthwave',
  'vaporwave', 'organic-hand', 'data-journalism', 'luxury-minimal', 'neon-cyber', 'documentary-archive',
] as const;

let recipeCache: StyleRecipe[] | undefined;

/** All 24 committed recipes, in the spec section 3.3 order. */
export function loadStyleRecipes(): StyleRecipe[] {
  if (recipeCache) return recipeCache.map(recipe => structuredClone(recipe));
  let dir: URL | undefined;
  for (const root of CANDIDATE_ROOTS) {
    try {
      readdirSync(new URL('data/recipes/', root));
      dir = new URL('data/recipes/', root);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!dir) throw new Error('Missing motionkit recipes');
  const files = readdirSync(dir).filter(file => file.endsWith('.json')).sort();
  const loaded = files.map(file => JSON.parse(readFileSync(new URL(file, dir!), 'utf8')) as StyleRecipe);
  const byId = new Map(loaded.map(recipe => [recipe.id, recipe]));
  const ordered = RECIPE_ORDER.map(id => byId.get(id)).filter((recipe): recipe is StyleRecipe => Boolean(recipe));
  for (const recipe of loaded) if (!ordered.includes(recipe)) ordered.push(recipe);
  recipeCache = ordered;
  return recipeCache.map(recipe => structuredClone(recipe));
}

const moduleCache = new Map<string, Promise<any>>();

async function loadMotionkitModule(name: string): Promise<any> {
  const cached = moduleCache.get(name);
  if (cached) return cached;
  const loading = (async () => {
    let lastError: unknown;
    for (const root of CANDIDATE_ROOTS) {
      try {
        return await import(new URL(name, root).href);
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw error;
      }
    }
    throw lastError;
  })();
  moduleCache.set(name, loading);
  try {
    return await loading;
  } catch (error) {
    moduleCache.delete(name);
    throw error;
  }
}

function catalogLine(recipe: StyleRecipe): string {
  const primary = recipe.transitions?.primary ?? 'cut';
  const accent = (recipe.transitions?.accent ?? []).slice(0, 2).join('+');
  const line = `${recipe.id} — ${recipe.label} · ${recipe.easing.personality} · ${primary}${accent ? ` +${accent}` : ''} · ${recipe.taxonomy.energy} · ${recipe.fonts.display}/${recipe.fonts.text}`;
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** The M15 catalog card: one line per recipe, each <= 120 characters. */
export function styleCatalog(recipes: StyleRecipe[] = loadStyleRecipes()): string {
  return recipes.map(catalogLine).join('\n');
}

function recipeIds(recipes: StyleRecipe[]): Map<string, StyleRecipe> {
  return new Map(recipes.map(recipe => [recipe.id, recipe]));
}

function normalizeHistory(history: unknown, byId: Map<string, StyleRecipe>): Array<Record<string, any>> {
  if (!Array.isArray(history)) return [];
  const out: Array<Record<string, any>> = [];
  for (const item of history) {
    if (typeof item === 'string') {
      const recipe = byId.get(item);
      if (recipe) out.push({ recipeId: item, recipe });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, any>;
    const id = typeof entry.recipeId === 'string'
      ? entry.recipeId
      : typeof entry.recipe?.id === 'string' ? entry.recipe.id : undefined;
    const recipe = entry.recipe && typeof entry.recipe === 'object'
      ? entry.recipe
      : id ? byId.get(id) : undefined;
    out.push(recipe ? { ...entry, recipeId: id ?? recipe.id, recipe } : entry);
  }
  return out;
}

function toneList(tone: StyleSuggestInput['tone']): string[] {
  if (typeof tone === 'string') return tone.length > 0 ? [tone] : [];
  return Array.isArray(tone) ? tone.filter(value => typeof value === 'string' && value.length > 0) : [];
}

function reasonFor(recipe: StyleRecipe, input: StyleSuggestInput): string {
  const bits: string[] = [];
  const tones = toneList(input.tone);
  if (tones.length > 0) bits.push(`fits ${tones.join('/')} tone`);
  if (typeof input.goal === 'string' && input.goal.length > 0) bits.push(`serves the ${input.goal} goal`);
  bits.push(`${recipe.taxonomy.energy} energy`);
  bits.push(`${recipe.easing.personality} easing, ${recipe.transitions.primary} primary`);
  return bits.join('; ');
}

/**
 * Pick up to three distinct recipes with `pickRecipe`, adding each pick to the
 * history so the next draw is forced away from it. A seed reproduces the list.
 */
export async function suggestStyles(input: StyleSuggestInput = {}): Promise<{
  suggestions: StyleSuggestion[];
  recipeIds: string[];
  ids: string[];
}> {
  const recipes = loadStyleRecipes();
  const { pickRecipe } = await loadMotionkitModule('variety.mjs');
  const byId = recipeIds(recipes);
  const tones = toneList(input.tone);
  const seed = Number.isInteger(input.seed) && (input.seed as number) >= 0 ? (input.seed as number) : 0x9e3779b9;
  const history = normalizeHistory(input.history, byId);
  const suggestions: StyleSuggestion[] = [];
  const used = new Set<string>();

  for (let index = 0; index < 3; index += 1) {
    const pick = pickRecipe(recipes, {
      tone: tones,
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.energy !== undefined ? { energy: input.energy } : {}),
      history,
      seed: (seed + Math.imul(index, 0x85ebca6b)) >>> 0,
    });
    const recipe = pick?.recipe as StyleRecipe | null;
    if (!recipe || used.has(recipe.id)) continue;
    used.add(recipe.id);
    suggestions.push({
      id: recipe.id,
      recipeId: recipe.id,
      label: recipe.label,
      reason: reasonFor(recipe, { ...input, tone: tones }),
      energy: recipe.taxonomy.energy,
      baseFit: Number(pick.baseFit ?? 0),
      weight: Number(pick.weight ?? 0),
    });
    history.push({ recipeId: recipe.id, recipe, distance: pick.distanceToLast });
  }

  const pickedIds = suggestions.map(suggestion => suggestion.id);
  return { suggestions, recipeIds: pickedIds, ids: pickedIds };
}

function fallbackPackage(): Record<string, any> {
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_style0000001',
    title: 'Style recipe preview',
    createdAt: '2026-01-01T00:00:00.000Z',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#0d0f14', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    datasets: {},
    scenes: [
      { id: 's1', layout: 'title', variant: 'centered', preferredFrames: 150, copy: { headline: 'One look, every frame', sub: 'A style recipe preview' } },
      { id: 's2', layout: 'hero', variant: 'full-bleed', preferredFrames: 210, copy: { headline: 'Palette, type and motion agree' } },
      { id: 's3', layout: 'list', variant: 'bullets', preferredFrames: 180, copy: { headline: 'What the recipe controls', items: ['Palette and type pair', 'Entries and emphasis', 'Transition grammar'] } },
    ],
    assets: {},
    compliance: { open_weights_only: true },
    renders: [],
  };
}

/**
 * Compile a recipe into the current package (or a small preview package when
 * there is no draft yet) and score the result with the M14 look score.
 */
export async function applyStyle(
  pkg: Record<string, any> | undefined,
  input: StyleApplyInput,
): Promise<StyleApplyResult> {
  const recipes = loadStyleRecipes();
  const recipe = recipes.find(item => item.id === input.recipeId);
  if (!recipe) throw new Error(`unknown style recipe: ${input.recipeId}`);
  const seed = Number.isInteger(input.seed) && (input.seed as number) >= 0 ? (input.seed as number) : 0;
  const { compileRecipe } = await loadMotionkitModule('compile.mjs');
  const { scoreLook } = await loadMotionkitModule('look-score.mjs');
  const source = pkg && Array.isArray(pkg.scenes) && pkg.scenes.length > 0 ? pkg : fallbackPackage();
  const compiled = compileRecipe(source, recipe, { seed, variation: 0 });
  const lookScore = scoreLook(compiled.pkg, recipe) as StyleScore;
  return {
    recipeId: recipe.id,
    recipe,
    package: compiled.pkg,
    pkg: compiled.pkg,
    look: compiled.look,
    score: lookScore.score,
    lookScore,
    scoreReport: lookScore,
    parts: lookScore.parts,
    findings: lookScore.findings,
  };
}

const emptyStyleSchema = z.object({}).passthrough();

export const styleSuggestInputSchema = z.object({
  tone: z.union([z.string().min(1), z.array(z.string().min(1)).max(12)]).optional(),
  goal: z.string().min(1).max(120).optional(),
  energy: z.enum(['calm', 'medium', 'high']).optional(),
  history: z.array(z.unknown()).max(100).optional(),
  seed: z.number().int().min(0).optional(),
}).passthrough();

export const styleApplyInputSchema = z.object({
  recipeId: z.string().min(1),
  seed: z.number().int().min(0).optional(),
}).passthrough();

export const styleSuggestSchema = styleSuggestInputSchema;
export const styleApplySchema = styleApplyInputSchema;
export const styleListSchema = emptyStyleSchema;
export const listStyleRecipes = loadStyleRecipes;

function styleParameters(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const styleList: AgentTool = {
  definition: {
    name: 'style.list',
    description: 'List the 24 motion style recipes as a compact catalog card (one line per look) for choosing a recipe id.',
    parameters: styleParameters({}, []),
  },
  schema: emptyStyleSchema,
  run: () => styleCatalog(),
};

export const styleSuggest: AgentTool = {
  definition: {
    name: 'style.suggest',
    description: 'Suggest up to three motion style recipe ids with reasons, weighted by tone and goal and avoiding the last eight looks in history.',
    parameters: styleParameters({
      tone: { type: 'array', items: { type: 'string' } },
      goal: { type: 'string' },
      history: { type: 'array', items: { type: 'object' } },
      seed: { type: 'integer' },
    }, []),
  },
  schema: styleSuggestInputSchema,
  run: (args: StyleSuggestInput) => suggestStyles(args ?? {}),
};

/**
 * Bind `style.apply` to the toolset's current draft. The compiler never mutates
 * its input, so the previous package is safe if compilation fails.
 */
export function styleApplyFor(
  getPackage: () => Record<string, any> | undefined,
  setPackage: (pkg: Record<string, any>) => void,
): AgentTool {
  return {
    definition: {
      name: 'style.apply',
      description: 'Compile a style recipe into the current package: palette, type, entries/emphasis, transitions and background pattern, plus a look sidecar and the 0-100 look score.',
      parameters: styleParameters({
        recipeId: { type: 'string' },
        seed: { type: 'integer' },
      }, ['recipeId']),
    },
    schema: styleApplyInputSchema,
    run: async (args: StyleApplyInput) => {
      const result = await applyStyle(getPackage(), args);
      setPackage(result.package);
      return result;
    },
  };
}

/** Stateless form of `style.apply`; the toolset binds it to its current draft. */
export const styleApply: AgentTool = styleApplyFor(() => undefined, () => {});
