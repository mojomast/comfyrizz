// MS5: the agent picks motion parameters from the MS2 vocabulary and never writes
// animation code.
//
// The token lists are read from packages/schema/package-v1.schema.json at load
// time (the package contract). Duration bands, the reading-hold numbers and the
// transition budget come from the schema package's motion linter, which is the
// same function the tests call. Nothing here is a second hardcoded copy of those
// enums.
//
// Ideas re-expressed from research (no code copied):
// - whaleyxbt/claude-motion (MIT, Copyright (c) 2026 whaleyxbt): shot-list shape,
//   one hero moment, reading holds, exits faster than entries.
// - heygen-com/hyperframes motion skills (Apache-2.0, Copyright HeyGen): one
//   current direction, 2-3 transition types with one primary, no idle wobble,
//   stillness before the climax.
// - howseen-ai/claude-motion-design (MIT, Copyright (c) 2026 Howseen AI):
//   illustrative numbers labelled as example data; critique scores each scene
//   /10 and fixes only the weak ones; the judge is not the builder.
import { existsSync, readFileSync } from 'node:fs';
import { piRequest } from '../pi-runtime.js';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STYLE_PRESETS, type StylePreset } from '../brief.js';
import type { ChatModel, ChatRequest } from '../types.js';

/** Research §4.5: pause between an action and its result. Not a schema field. */
const STILLNESS_BEFORE_CLIMAX = { minSeconds: 0.3, maxSeconds: 0.75 };
/** Research §4.2: an exit is about half to three quarters of its entry. */
const EXIT_TO_ENTRY = 'about half to three quarters of the entry';

export interface MotionVocabulary {
  easing: readonly string[];
  springs: readonly string[];
  energies: readonly string[];
  directions: readonly string[];
  staggers: readonly string[];
  entries: readonly string[];
  emphasis: readonly string[];
  transitionTypes: readonly string[];
  transitionDirections: readonly string[];
}

interface MotionLintOp {
  op: 'set' | 'delete';
  path: string;
  value?: unknown;
}

export interface MotionLintFinding {
  code: string;
  severity: string;
  scene: string | null;
  path: string;
  message: string;
  autofix: null | { description: string; ops: MotionLintOp[] };
}

interface MotionLintModule {
  lintMotion: (doc: unknown, options?: { fps?: number }) => MotionLintFinding[];
  TRANSITIONS: Record<string, { axis: string | null; minSeconds: number; maxSeconds: number }>;
  ENERGY_TRANSITIONS: Record<string, readonly string[]>;
  READING: {
    minHoldSeconds: number;
    freeWords: number;
    perExtraWordSeconds: number;
    finalHoldSeconds: number;
  };
  MAX_TRANSITION_TYPES: number;
  MOTION_DEFAULTS: { energy: string; direction: string; depthDirection: string; fps: number };
}

interface AnimationCatalogueModule {
  ANIMATION_RECIPES: readonly { id: string; layouts: readonly string[] }[];
}

export interface MotionFixInstruction {
  code: string;
  severity: string;
  scene: string | null;
  tool: 'storyboard.edit';
  args: { scene_id: string; patch: Record<string, unknown> };
  /** One line the model can follow on its next tool call. */
  text: string;
}

export interface CritiqueSceneInput {
  id: string;
  headline?: string;
}

export interface CritiqueSceneScore {
  id: string;
  readability: number;
  rhythm: number;
  continuity: number;
  brand: number;
  /** Lowest axis. The fix / leave rule uses this score. */
  score: number;
  action: 'fix' | 'leave' | 'hold';
  note?: string;
}

export interface CritiqueRubric {
  ok: boolean;
  round: number;
  maxRounds: number;
  scenes: CritiqueSceneScore[];
  /** Scenes scoring at or below the fix line. Only these may be edited. */
  fixSceneIds: string[];
  /** Scenes scoring at or above the leave line. Do not touch them. */
  leaveSceneIds: string[];
  /**
   * True when the caller must not start another judge round: the round cap is
   * reached, or nothing scored at or below the fix line.
   */
  stop: boolean;
  error?: string;
}

export interface ImageInputDeclaration {
  imageInput?: boolean;
  capabilities?: { imageInput?: boolean };
}

const CRITIQUE_AXES = ['readability', 'rhythm', 'continuity', 'brand'] as const;

/** Fix a scene at or below this score. Leave a scene at or above the leave line. */
export const MOTION_CRITIQUE_FIX_AT_OR_BELOW = 7;
export const MOTION_CRITIQUE_LEAVE_AT_OR_ABOVE = 9;
export const MOTION_CRITIQUE_MAX_ROUNDS = 2;

/**
 * Default package `motion.energy` for each style preset (research §4.5: calm is
 * a slow crossfade, medium is an explainer, high is a launch). A brief that
 * asks for a calmer or a harder film overrides the preset.
 */
export const STYLE_PRESET_ENERGY: Record<StylePreset, string> = {
  clay: 'calm',
  glass: 'calm',
  'editorial-flat': 'medium',
  'isometric-tech': 'medium',
  'paper-cut': 'medium',
  'cinematic-dark': 'high',
};

const STYLE_PRESET_ENERGY_REASON: Record<StylePreset, string> = {
  clay: 'soft studio light, slow crossfades',
  glass: 'frosted and restrained',
  'editorial-flat': 'editorial explainer',
  'isometric-tech': 'technical explainer',
  'paper-cut': 'layered explainer',
  'cinematic-dark': 'launch or promo grade',
};

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'packages', 'schema', 'package-v1.schema.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('package-v1.schema.json not found from the agent motion prompt');
}

function schemaDir(): string {
  return join(repoRoot(), 'packages', 'schema');
}

interface SchemaNode {
  enum?: unknown;
  $ref?: string;
  properties?: Record<string, SchemaNode>;
}

function readEnum(schema: { $defs?: Record<string, SchemaNode> }, defName: string, prop?: string): string[] {
  const def = schema.$defs?.[defName];
  if (!def) throw new Error(`schema $defs.${defName} is missing`);
  const node: SchemaNode | undefined = prop ? def.properties?.[prop] : def;
  if (!node) throw new Error(`schema $defs.${defName}.${prop ?? ''} is missing`);
  if (Array.isArray(node.enum) && node.enum.every(item => typeof item === 'string')) return [...node.enum];
  if (prop && typeof node.$ref === 'string') {
    const target = node.$ref.split('/').pop();
    if (!target) throw new Error(`schema $ref ${node.$ref} has no name`);
    return readEnum(schema, target);
  }
  throw new Error(`schema enum missing at ${prop ? `${defName}.${prop}` : defName}`);
}

function loadVocabulary(schema: Parameters<typeof readEnum>[0]): MotionVocabulary {
  return {
    easing: readEnum(schema, 'easingToken'),
    springs: readEnum(schema, 'springPreset'),
    energies: readEnum(schema, 'motionEnergy'),
    directions: readEnum(schema, 'motionDirection'),
    staggers: readEnum(schema, 'sceneMotion', 'stagger'),
    entries: readEnum(schema, 'sceneMotion', 'entry'),
    emphasis: readEnum(schema, 'sceneMotion', 'emphasis'),
    transitionTypes: readEnum(schema, 'transitionType'),
    transitionDirections: readEnum(schema, 'transitionDirection'),
  };
}

const packageSchema = JSON.parse(readFileSync(join(schemaDir(), 'package-v1.schema.json'), 'utf8'));
const VOCABULARY: MotionVocabulary = loadVocabulary(packageSchema);

for (const preset of STYLE_PRESETS) {
  const energy = STYLE_PRESET_ENERGY[preset];
  if (!energy || !VOCABULARY.energies.includes(energy)) {
    throw new Error(`style preset ${preset} has no motion.energy in the schema (${VOCABULARY.energies.join(', ')})`);
  }
}

const motionLint: MotionLintModule = await import(pathToFileURL(join(schemaDir(), 'src', 'motion.mjs')).href);
const animationCatalogue: AnimationCatalogueModule = await import(pathToFileURL(join(schemaDir(), 'src', 'animation.mjs')).href);

for (const type of VOCABULARY.transitionTypes) {
  if (!motionLint.TRANSITIONS[type]) throw new Error(`schema transition ${type} has no linter duration band`);
}
for (const energy of VOCABULARY.energies) {
  if (!motionLint.ENERGY_TRANSITIONS[energy]) throw new Error(`schema energy ${energy} has no linter transition family`);
}

/** Schema enums the prompt and the tool schema are built from. */
export function motionVocabulary(): MotionVocabulary {
  return VOCABULARY;
}

/** The MS2 linter. Findings are advisory; the helper below turns them into edits. */
export function lintPackageMotion(doc: unknown, options?: { fps?: number }): MotionLintFinding[] {
  return motionLint.lintMotion(doc, options);
}

function list(values: readonly string[]): string {
  return values.join(' | ');
}

function band(type: string): string {
  const spec = motionLint.TRANSITIONS[type];
  if (!spec || (spec.minSeconds === 0 && spec.maxSeconds === 0)) return `${type}: 0 s`;
  return `${type}: ${spec.minSeconds}-${spec.maxSeconds} s`;
}

/**
 * The motion section of the agent system prompt. Token lists are the schema
 * enums, so a new transition type shows up here without a second edit.
 */
export function motionSystemSection(): string {
  const reading = motionLint.READING;
  const defaults = motionLint.MOTION_DEFAULTS;
  const budget = motionLint.MAX_TRANSITION_TYPES;
  const presetLines = STYLE_PRESETS.map(preset => `- ${preset} → ${STYLE_PRESET_ENERGY[preset]} (${STYLE_PRESET_ENERGY_REASON[preset]})`);
  const familyLines = VOCABULARY.energies.map(energy => {
    const types = motionLint.ENERGY_TRANSITIONS[energy] ?? [];
    return `- ${energy}: ${types.join(', ')}`;
  });
  const bands = VOCABULARY.transitionTypes.map(type => band(type));
  const recipeLines = animationCatalogue.ANIMATION_RECIPES.map(recipe => `- ${recipe.id}: ${recipe.layouts.join(', ')}`);
  return [
    '## Motion',
    'You pick motion parameters. You never write animation code: no Remotion, no CSS, no tweens, no springs written out as numbers. The renderer already implements every token below. Set package `motion` and each scene\'s `motion` and `transitionOut` with `storyboard.propose` and `storyboard.edit`.',
    'Shot list, in this order, before you fill scenes:',
    '1. Length and format: seconds, aspect, and fps.',
    '2. Look: background, type, and one accent. The accent means something (the change, the answer, the winner). Do not add a second accent colour.',
    '3. Beats in order.',
    '4. Motion verbs, expressed only as vocabulary tokens: counts up is entry `countUp`, draws on is entry `drawOn`, wipes in is transition `wipe`, a push is transition `push`. A slow push-in is one `zoom` in or one `push`, not a camera path.',
    `5. Final hold: the last scene stays readable for at least ${reading.finalHoldSeconds} s after it settles. Hold the final frame.`,
    'Auto motion route (only when motion_model is auto):',
    '- FastH3: character acting, dialogue and native sound. LTX-2.5: scenery, establishing, B-roll and camera-led shots.',
    '- Character evidence is characterCount together with the shot subject or the action, never the composition or camera text. characterCount 0 is LTX unless the shot has dialogue or native sound.',
    '- characterCount 1 or more with a person, a role noun (keeper, fisherman, diver) or a he/she/they subject or actor plus an acted verb (places, lifts, carries, guides, rows, reaches, kneels) is FastH3. The acted verb may sit in the subject or the action. Camera drift words never outrank a character acting.',
    '- Reef, water, weather and other scenery nouns never override a character acting: subject "the same woman guiding the boat over the reef" with a scenery action is still FastH3, while a scenery-only shot is LTX-2.5.',
    '- Example LTX-2.5: subject "the boat", action "scenery drifting past the hull", camera "a slow wide drift", characterCount 0.',
    '- Example FastH3: subject "the same woman", action "she places the lantern", characterCount 1.',
    '- Example FastH3: subject "the same woman guiding the boat over the reef", action "scenery drifting past the reef", characterCount 1.',
    '- Example LTX-2.5: subject "the cliff", action "the camera pans left past the cottage", composition mentions a woman, characterCount 1.',
    'Recipe by story purpose, never random variety: process or cause/effect → technical-flow; mechanism → sketch; before/after → morph or a compare layout; evidence/detail → focus; hook/chapter/conclusion → kinetic; history/profile/community → paper-cut.',
    'Recommended recipe layouts (from the shared capability catalogue):',
    ...recipeLines,
    '- For a process, prefer technical-flow on list with editable items as nodes. scenes[].motion.diagram: flow | hub (connected steps or a shared hub).',
    '- Bounded recipe fields: focus is {x,y,width,height}, normalized to the whole frame; x/y are 0..1, width/height are positive, and x + width <= 1 and y + height <= 1. morph is {from,to} using circle | square | triangle | blob only, not arbitrary media. seed is an integer 1..2147483647; intensity is 0..1.',
    '- Timing cues: cue_phrases contains up to 6 exact phrases copied from that scene\'s narration in spoken order. Resolve them after narration timing; never invent alignment or claim estimated timing is forced alignment. Explicit scene-local cue_seconds take precedence over cue_phrases; clear stale seconds when switching to phrases.',
    '- All meaningful text stays native, editable Remotion copy (including lower_third), never lettering baked into AI-generated pixels. Full typography requires media_only:false. media_only:true is for footage plus lower thirds/non-text decor, not full-layout typography.',
    'Vocabulary (these lists are the package schema enums; do not invent tokens):',
    `- motion.energy: ${list(VOCABULARY.energies)}. Default ${defaults.energy}.`,
    `- motion.direction, the film's one current: ${list(VOCABULARY.directions)}. Default ${defaults.direction}. Reserve up for a conclusion.`,
    `- scenes[].motion.entry: ${list(VOCABULARY.entries)}. countUp needs data.dataset. drawOn needs an svg or vector-anim asset. Omitted uses the layout default.`,
    `- scenes[].motion.ease: ${list(VOCABULARY.easing)}. linear is only for continuous motion, never an entrance.`,
    `- scenes[].motion.spring: ${list(VOCABULARY.springs)}. elastic at most once per film.`,
    `- scenes[].motion.stagger: ${list(VOCABULARY.staggers)}.`,
    `- scenes[].motion.emphasis: ${list(VOCABULARY.emphasis)}. keyword needs highlight text that appears in that scene's copy. hero is the film's one hero moment, and it is not the first scene.`,
    `- transitionOut.type: ${list(VOCABULARY.transitionTypes)}.`,
    `- transitionOut.direction: ${list(VOCABULARY.transitionDirections)}. slide, push and wipe use left, right, up or down. zoom and iris use in or out (in is deeper, out is arrival). none, cut, fade and blur take no direction. A cut has 0 frames.`,
    'Numeric rules:',
    '- One focal point per frame. Decide what the viewer notices first, and do not animate a second element at the same time.',
    `- Reading hold, after the entrance settles: at least ${reading.minHoldSeconds} s, plus ${reading.perExtraWordSeconds} s for every word beyond ${reading.freeWords}. The final scene holds at least ${reading.finalHoldSeconds} s. Text that is meant to be read stays still.`,
    '- Hard cuts (cut, 0 frames) are the default; use another transition only when it expresses the relationship between adjacent beats. The actual final scene in scenes[] has no outgoing transition: omit transitionOut; never give it a positive-duration transition.',
    `- If using non-cut transitions, use ${budget - 1}-${budget} transition types in one film (none and cut do not count). One primary type covers most cuts; one or two accents are enough. Never a different type on every scene.`,
    '- One current direction for ordinary next-point cuts. Do not reverse it on the next cut. up means conclusion, zoom in means deeper, zoom out means arrival.',
    '- One expressive gesture per scene: one recipe or motion idea carries the beat; do not stack effects for variety.',
    '- One hero moment. Build to it.',
    `- Stillness before the climax: hold ${STILLNESS_BEFORE_CLIMAX.minSeconds}-${STILLNESS_BEFORE_CLIMAX.maxSeconds} s between an action and its result.`,
    '- No idle wobble. Do not bob, breathe, or float a foreground element to fill time. A plate or a procedural background may drift; the type stays still while it is read.',
    `- Exits are faster than entries (${EXIT_TO_ENTRY}).`,
    '- Do not invent numbers. A figure with no source in the brief is labelled "Example data".',
    'Style preset → default motion.energy (use this when the brief names a look):',
    ...presetLines,
    'Transition length at the package fps, in seconds (frames = round(seconds × fps), inside the band):',
    ...bands.map(line => `- ${line}`),
    'Energy picks a transition family. A type outside the family reads as a mismatch:',
    ...familyLines,
    'When a tool result includes motion_fixes, apply each one with storyboard.edit on the next turn. Do not answer a lint finding by writing animation code.',
  ].join('\n');
}

function stripNulls(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined) out[key] = item;
  }
  return out;
}

/** Keep schema-known motion fields. Unknown tokens are dropped, not rewritten. */
export function normalizeSceneMotion(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const allow: Record<string, readonly string[]> = {
    recipe: ['sketch', 'paper-cut', 'morph', 'technical-flow', 'focus', 'kinetic'],
    diagram: ['flow', 'hub'],
    entry: VOCABULARY.entries,
    ease: VOCABULARY.easing,
    spring: VOCABULARY.springs,
    stagger: VOCABULARY.staggers,
    emphasis: VOCABULARY.emphasis,
    energy: VOCABULARY.energies,
  };
  const out: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(allow)) {
    const value = src[key];
    if (typeof value === 'string' && values.includes(value)) out[key] = value;
  }
  if (typeof src.highlight === 'string') {
    const text = src.highlight.trim();
    if (text.length >= 1 && text.length <= 60) out.highlight = text;
  }
  if (Number.isInteger(src.seed) && Number(src.seed) >= 1 && Number(src.seed) <= 2147483647) out.seed = src.seed;
  if (typeof src.intensity === 'number' && Number.isFinite(src.intensity) && src.intensity >= 0 && src.intensity <= 1) out.intensity = src.intensity;
  if (Array.isArray(src.cue_phrases)) {
    const phrases = src.cue_phrases
      .filter((phrase): phrase is string => typeof phrase === 'string')
      .map(phrase => phrase.trim())
      .filter(phrase => phrase.length > 0 && phrase.length <= 600)
      .slice(0, 6);
    if (phrases.length > 0) out.cue_phrases = phrases;
  }
  if (Array.isArray(src.cue_seconds)) {
    const seconds = src.cue_seconds
      .filter((second): second is number => typeof second === 'number' && Number.isFinite(second) && second >= 0 && second <= 20)
      .slice(0, 6);
    if (seconds.length > 0) out.cue_seconds = seconds;
  }
  if (src.focus && typeof src.focus === 'object' && !Array.isArray(src.focus)) {
    const focus = src.focus as Record<string, unknown>;
    const values = ['x', 'y', 'width', 'height'].map(key => focus[key]);
    if (values.every(value => typeof value === 'number' && Number.isFinite(value))) {
      const [x, y, width, height] = values as number[];
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && width > 0 && width <= 1 && height > 0 && height <= 1 && x + width <= 1 + 1e-9 && y + height <= 1 + 1e-9) {
        out.focus = { x, y, width, height };
      }
    }
  }
  if (src.morph && typeof src.morph === 'object' && !Array.isArray(src.morph)) {
    const morph = src.morph as Record<string, unknown>;
    const shapes = ['circle', 'square', 'triangle', 'blob'];
    if (typeof morph.from === 'string' && shapes.includes(morph.from) && typeof morph.to === 'string' && shapes.includes(morph.to)) {
      out.morph = { from: morph.from, to: morph.to };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep a package-level energy and current when they are schema tokens. */
export function normalizePackageMotion(raw: unknown): { energy?: string; direction?: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: { energy?: string; direction?: string } = {};
  if (typeof src.energy === 'string' && VOCABULARY.energies.includes(src.energy)) out.energy = src.energy;
  if (typeof src.direction === 'string' && VOCABULARY.directions.includes(src.direction)) out.direction = src.direction;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep a transition whose type is in the schema enum. */
export function normalizeTransitionOut(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  if (typeof src.type !== 'string' || !VOCABULARY.transitionTypes.includes(src.type)) return undefined;
  const out: Record<string, unknown> = { type: src.type };
  if (typeof src.frames === 'number' && Number.isInteger(src.frames)) out.frames = Math.max(0, Math.min(120, src.frames));
  if (typeof src.direction === 'string' && VOCABULARY.transitionDirections.includes(src.direction)) out.direction = src.direction;
  return out;
}

/**
 * Merge a storyboard.edit patch into a scene before normalization.
 * `motion` and a partial `transitionOut` deep-merge. A `transitionOut` that
 * names `type` replaces the whole transition, which is what a budget fix does.
 * A null value deletes that key.
 */
export function mergeScenePatch(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current, ...patch };
  if (patch.copy && typeof patch.copy === 'object') {
    const base = current.copy && typeof current.copy === 'object' ? current.copy as Record<string, unknown> : {};
    merged.copy = { ...base, ...(patch.copy as Record<string, unknown>) };
  }
  if (patch.motion && typeof patch.motion === 'object') {
    const base = current.motion && typeof current.motion === 'object' ? current.motion as Record<string, unknown> : {};
    merged.motion = stripNulls({ ...base, ...(patch.motion as Record<string, unknown>) });
  }
  if (patch.transitionOut && typeof patch.transitionOut === 'object') {
    const incoming = patch.transitionOut as Record<string, unknown>;
    const base = typeof incoming.type === 'string'
      ? {}
      : (current.transitionOut && typeof current.transitionOut === 'object' ? current.transitionOut as Record<string, unknown> : {});
    merged.transitionOut = stripNulls({ ...base, ...incoming });
  }
  return merged;
}

function patchFromOps(ops: MotionLintOp[]): Record<string, unknown> | null {
  const patch: Record<string, any> = {};
  for (const op of ops) {
    const parts = op.path.split('/').filter(part => part.length > 0);
    if (parts[0] !== 'scenes' || parts.length < 3) return null;
    const rest = parts.slice(2);
    const key = rest[0];
    if (!key) return null;
    if (rest.length === 1) {
      patch[key] = op.op === 'delete' ? null : structuredClone(op.value);
      continue;
    }
    if (typeof patch[key] !== 'object' || patch[key] === null || Array.isArray(patch[key])) patch[key] = {};
    let node = patch[key] as Record<string, any>;
    const leaf = rest.slice(1);
    for (let i = 0; i < leaf.length - 1; i += 1) {
      const part = leaf[i];
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node = node[part];
    }
    const last = leaf[leaf.length - 1];
    if (!last) return null;
    node[last] = op.op === 'delete' ? null : structuredClone(op.value);
  }
  return patch;
}

/**
 * Turn lint findings into short storyboard.edit instructions. Errors and
 * warnings with an autofix become the next tool call. Info findings stay
 * advisory and are not edits.
 */
export function motionFixInstructions(findings: MotionLintFinding[]): MotionFixInstruction[] {
  const instructions: MotionFixInstruction[] = [];
  for (const finding of findings) {
    if (finding.severity !== 'error' && finding.severity !== 'warning') continue;
    if (!finding.autofix || !Array.isArray(finding.autofix.ops) || finding.autofix.ops.length === 0) continue;
    if (!finding.scene || finding.scene.startsWith('#')) continue;
    const patch = patchFromOps(finding.autofix.ops);
    if (!patch) continue;
    const args = { scene_id: finding.scene, patch };
    const text = `storyboard.edit ${JSON.stringify(args)} — ${finding.code}: ${finding.message}`;
    instructions.push({
      code: finding.code,
      severity: finding.severity,
      scene: finding.scene,
      tool: 'storyboard.edit',
      args,
      text,
    });
  }
  return instructions;
}

/** True only when the provider declares that it accepts image input. */
export function providerDeclaresImageInput(provider: ImageInputDeclaration | null | undefined): boolean {
  if (!provider) return false;
  if (provider.imageInput === true) return true;
  return provider.capabilities?.imageInput === true;
}

/**
 * Rubric for a separate judge call over an MS4 contact sheet. The judge scores;
 * it does not build the package and it is not given the builder's tools.
 */
export function critiqueRubricPrompt(input: { scenes: CritiqueSceneInput[]; sheetPath?: string; round?: number }): string {
  const round = input.round ?? 1;
  const sceneLines = input.scenes.map(scene => `- ${scene.id}${scene.headline ? `: ${scene.headline}` : ''}`);
  return [
    '## Motion critique',
    'You are the critique judge, a separate call from the builder. You do not edit the package and you do not call tools. You only score the contact sheet.',
    'The sheet is an MS4 contact sheet: labelled tiles for each scene (settled frame, mid-hold, and the frames around each transition). Score the scene, not each tile.',
    input.sheetPath ? `Contact sheet: ${input.sheetPath}` : 'Contact sheet: the image attached to this call.',
    `Round ${round} of ${MOTION_CRITIQUE_MAX_ROUNDS}.`,
    round >= MOTION_CRITIQUE_MAX_ROUNDS ? 'This is the last round. Do not expect another look at the sheet.' : 'One more round is allowed after this one if a scene still scores at or below the fix line.',
    'Score each scene from 1 to 10 on readability, rhythm, continuity, and brand. The scene score is the lowest of the four.',
    `Fix only scenes whose score is ${MOTION_CRITIQUE_FIX_AT_OR_BELOW} or below. Leave scenes scoring ${MOTION_CRITIQUE_LEAVE_AT_OR_ABOVE} or above alone. Do not propose a change for a scene you were told to leave.`,
    'Readability: one focal point, type that holds still long enough to read, nothing cut off.',
    'Rhythm: entries, a hold, then a faster exit; stillness before the climax; no idle wobble.',
    'Continuity: one current direction, two or three transition types, no ping-pong.',
    'Brand: the preset\'s one accent, used on the thing that matters.',
    'Scenes to score:',
    ...sceneLines,
    'Reply with one JSON object and nothing else:',
    '{"scenes":[{"id":"s1","readability":8,"rhythm":8,"continuity":8,"brand":8,"note":"short reason"}]}',
  ].join('\n');
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('critique reply has no JSON object');
  return JSON.parse(raw.slice(start, end + 1));
}

function axisScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 10) return null;
  return value;
}

/**
 * Parse a judge reply into fix / leave / hold. The scene score is the lowest
 * axis, so a single weak axis cannot hide behind a high overall.
 */
export function parseCritiqueReply(text: string, round = 1): CritiqueRubric {
  const safeRound = Number.isInteger(round) && round > 0 ? round : 1;
  const empty = (error: string): CritiqueRubric => ({
    ok: false,
    round: safeRound,
    maxRounds: MOTION_CRITIQUE_MAX_ROUNDS,
    scenes: [],
    fixSceneIds: [],
    leaveSceneIds: [],
    stop: true,
    error,
  });
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (error) {
    return empty(error instanceof Error ? error.message : String(error));
  }
  const rows = parsed && typeof parsed === 'object' && Array.isArray((parsed as { scenes?: unknown }).scenes)
    ? (parsed as { scenes: unknown[] }).scenes
    : null;
  if (!rows) return empty('critique reply has no scenes array');
  const scenes: CritiqueSceneScore[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : typeof record.scene === 'string' ? record.scene : '';
    if (!id) continue;
    const scores = CRITIQUE_AXES.map(axis => axisScore(record[axis]));
    if (scores.some(score => score === null)) continue;
    const [readability, rhythm, continuity, brand] = scores as number[];
    const score = Math.min(readability, rhythm, continuity, brand);
    const action: CritiqueSceneScore['action'] = score <= MOTION_CRITIQUE_FIX_AT_OR_BELOW
      ? 'fix'
      : score >= MOTION_CRITIQUE_LEAVE_AT_OR_ABOVE
        ? 'leave'
        : 'hold';
    const note = typeof record.note === 'string' && record.note.trim() ? record.note.trim() : undefined;
    scenes.push({
      id,
      readability,
      rhythm,
      continuity,
      brand,
      score,
      action,
      ...(note ? { note } : {}),
    });
  }
  if (scenes.length === 0) return empty('critique reply scored no scenes');
  const fixSceneIds = scenes.filter(scene => scene.action === 'fix').map(scene => scene.id);
  const leaveSceneIds = scenes.filter(scene => scene.action === 'leave').map(scene => scene.id);
  return {
    ok: true,
    round: safeRound,
    maxRounds: MOTION_CRITIQUE_MAX_ROUNDS,
    scenes,
    fixSceneIds,
    leaveSceneIds,
    stop: safeRound >= MOTION_CRITIQUE_MAX_ROUNDS || fixSceneIds.length === 0,
  };
}

export type MotionCritiqueResult =
  | { enabled: false; reason: string }
  | { enabled: true; raw: string; rubric: CritiqueRubric; request: ChatRequest };

/**
 * Optional vision pass. Disabled unless the provider declares image input, so a
 * text-only model (DeepSeek v4.1 and the scripted model) never receives the sheet.
 * The judge call is separate from the builder: its own system prompt and no tools.
 */
export async function runMotionCritique(options: {
  provider: ChatModel & ImageInputDeclaration;
  scenes: CritiqueSceneInput[];
  sheetPath?: string;
  round?: number;
  signal?: AbortSignal;
}): Promise<MotionCritiqueResult> {
  if (!providerDeclaresImageInput(options.provider)) {
    return { enabled: false, reason: 'provider does not declare image input' };
  }
  const round = options.round ?? 1;
  if (round > MOTION_CRITIQUE_MAX_ROUNDS) {
    return {
      enabled: true,
      raw: '',
      request: {
        system: critiqueRubricPrompt({ scenes: options.scenes, sheetPath: options.sheetPath, round }),
        messages: [],
        tools: [],
        signal: options.signal ?? new AbortController().signal,
        sessionId: 'motion-critique',
      },
      rubric: {
        ok: false,
        round,
        maxRounds: MOTION_CRITIQUE_MAX_ROUNDS,
        scenes: [],
        fixSceneIds: [],
        leaveSceneIds: [],
        stop: true,
        error: `critique stops after ${MOTION_CRITIQUE_MAX_ROUNDS} rounds`,
      },
    };
  }
  const system = critiqueRubricPrompt({ scenes: options.scenes, sheetPath: options.sheetPath, round });
  const sheetLine = options.sheetPath
    ? `Score the MS4 contact sheet at ${options.sheetPath}.`
    : 'Score the MS4 contact sheet attached to this call.';
  const request: ChatRequest = {
    system,
    messages: [{
      role: 'user',
      content: `${sheetLine} Scenes: ${options.scenes.map(scene => scene.id).join(', ')}.`,
      ...(options.sheetPath ? { images: [{ path: options.sheetPath, mediaType: 'image/png' as const }] } : {}),
    }],
    tools: [],
    signal: options.signal ?? new AbortController().signal,
    sessionId: 'motion-critique',
  };
  let raw = '';
  await piRequest(options.provider, request, chunk => {
    if (chunk.type === 'text') raw += chunk.delta;
    else if (chunk.type === 'error') {
      raw = raw || '{}';
    }
  });
  return { enabled: true, raw, request, rubric: parseCritiqueReply(raw, round) };
}
