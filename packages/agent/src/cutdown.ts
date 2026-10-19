/**
 * X1: cut a package down to 6, 15 or 30 seconds.
 *
 * Picks a scene subset, rewrites each kept line so the spoken estimate fits the
 * slot, and re-voices through the injected voice (the CPU stub by default: word
 * timing, no model, no GPU). The package is then put in the planner's target
 * duration mode so the compiled film lands on the target.
 *
 * Presenter clips (H17, in progress) are never run. A clip whose narration did
 * not change is kept. A clip whose narration changed is recorded as a plan only:
 * the stale clip is detached so a later jobs pass can make a new one, and this
 * function does not submit anything.
 */
import { estimateNarrationSeconds } from './brief.js';

export const CUTDOWN_SECONDS = [6, 15, 30] as const;
export type CutdownSeconds = (typeof CUTDOWN_SECONDS)[number];

/** Layout floors and ceilings, in frames at 30 fps. Mirrors the planner. */
const LAYOUT_LIMITS: Record<string, { min: number; max: number }> = {
  title: { min: 30, max: 450 },
  hero: { min: 45, max: 600 },
  stat: { min: 30, max: 300 },
  chart: { min: 45, max: 450 },
  list: { min: 45, max: 600 },
  split: { min: 45, max: 600 },
  compare: { min: 45, max: 600 },
  code: { min: 45, max: 600 },
};

const PACKAGE_ID = /^pkg_[A-Za-z0-9_-]{4,64}$/;

export interface VoiceInput {
  sceneId: string;
  text: string;
  language: 'en' | 'fr';
  voice?: string;
  speed?: number;
}

export interface VoiceChunk {
  text: string;
  seconds: number;
}

export interface VoiceResult {
  engine: string;
  text: string;
  seconds: number;
  chunks: VoiceChunk[];
}

export type VoiceFn = (input: VoiceInput) => VoiceResult;

export interface PresenterPlan {
  sceneId: string;
  action: 'keep' | 'plan' | 'drop';
  /** Always false: a cutdown never runs a presenter clip. */
  run: false;
  reason: string;
  narration?: string;
  assetId?: string;
}

export interface CutdownResult {
  targetSeconds: number;
  targetFrames: number;
  frames: number;
  sceneIds: string[];
  package: Record<string, any>;
  voiced: Array<{ sceneId: string; text: string; seconds: number; engine: string }>;
  /** Compile options for the exporter. `{}` re-estimates captions from the rewritten lines. */
  narration: Record<string, unknown>;
  presenter: { ran: false; plans: PresenterPlan[] };
}

interface ScenePlan {
  scene: Record<string, any>;
  duration: number;
  transitionOut: number;
  min: number;
  max: number;
}

export function isCutdownSeconds(value: unknown): value is CutdownSeconds {
  return value === 6 || value === 15 || value === 30;
}

/** Same rounding the planner's `targetFramesForSeconds` uses. */
export function targetFramesForSeconds(seconds: number, fps = 30): number {
  const rate = Number.isFinite(fps) && fps > 0 ? Math.floor(fps) : 30;
  return Math.max(1, Math.round(seconds * rate));
}

function limitFor(layout: string): { min: number; max: number } {
  return LAYOUT_LIMITS[layout] ?? LAYOUT_LIMITS.hero;
}

function languageOf(pkg: Record<string, any>): 'en' | 'fr' {
  const tag = String(pkg.voice?.language ?? pkg.voice?.lang ?? 'en').toLowerCase();
  return tag.startsWith('fr') ? 'fr' : 'en';
}

function transitionFrames(scene: Record<string, any>): number {
  const transition = scene.transitionOut;
  if (!transition || transition.type === 'none' || transition.type === 'cut') return 0;
  const frames = Math.floor(Number(transition.frames) || 0);
  return frames > 0 ? frames : 0;
}

function totalFrames(plans: ScenePlan[]): number {
  const sum = plans.reduce((acc, plan) => acc + plan.duration, 0);
  const overlaps = plans.slice(0, -1).reduce((acc, plan) => acc + plan.transitionOut, 0);
  return sum - overlaps;
}

function clampTransitions(plans: ScenePlan[]): void {
  for (let i = 0; i < plans.length; i += 1) {
    if (i === plans.length - 1) {
      plans[i].transitionOut = 0;
      continue;
    }
    plans[i].transitionOut = Math.min(plans[i].transitionOut, plans[i].duration, plans[i + 1].duration);
  }
}

/** Minimum timeline length of these scenes at their layout floors. */
function minimumFrames(scenes: Record<string, any>[]): number {
  const plans: ScenePlan[] = scenes.map(scene => {
    const limit = limitFor(scene.layout);
    return { scene, duration: limit.min, transitionOut: transitionFrames(scene), min: limit.min, max: limit.max };
  });
  clampTransitions(plans);
  return totalFrames(plans);
}

/**
 * 6 s keeps the hook. 15 s keeps the hook, one proof scene and the close.
 * 30 s keeps the film and only drops a middle scene when the floors cannot fit.
 */
export function pickCutdownScenes(scenes: Record<string, any>[], targetSeconds: number, fps = 30): Record<string, any>[] {
  if (scenes.length <= 1) return scenes.slice();
  const first = scenes[0];
  const last = scenes[scenes.length - 1];
  const middle = scenes.slice(1, -1);
  const targetFrames = targetFramesForSeconds(targetSeconds, fps);
  let desired: Record<string, any>[];
  if (targetSeconds <= 8) {
    desired = [first];
  } else if (targetSeconds <= 20) {
    const proof = middle.find(scene => scene.layout === 'chart' || scene.layout === 'stat') ?? middle[0];
    desired = proof ? [first, proof, last] : [first, last];
  } else {
    desired = scenes.slice();
  }
  const ids = new Set(desired.map(scene => scene.id));
  let chosen = scenes.filter(scene => ids.has(scene.id));
  while (chosen.length > 1 && minimumFrames(chosen) > targetFrames) {
    if (chosen.length > 2) chosen.splice(chosen.length - 2, 1);
    else chosen = [chosen[0]];
  }
  return chosen;
}

/**
 * Set each scene's length so the overlapped total equals `targetFrames`.
 * Grows from the layout floor, then shrinks the longest scene if a floor
 * overshoots (the caller has already dropped scenes that cannot fit).
 */
function fitPlans(scenes: Record<string, any>[], targetFrames: number): ScenePlan[] {
  const plans: ScenePlan[] = scenes.map(scene => {
    const limit = limitFor(scene.layout);
    return {
      scene,
      duration: limit.min,
      transitionOut: transitionFrames(scene),
      min: limit.min,
      max: limit.max,
    };
  });
  clampTransitions(plans);
  let guard = 0;
  while (totalFrames(plans) < targetFrames && guard < 200000) {
    guard += 1;
    const growable = plans.filter(plan => plan.duration < plan.max);
    if (growable.length === 0) break;
    for (const plan of growable) {
      if (totalFrames(plans) >= targetFrames) break;
      plan.duration += 1;
    }
  }
  while (totalFrames(plans) > targetFrames && guard < 400000) {
    guard += 1;
    const shrinkable = plans.filter(plan => plan.duration > plan.min);
    if (shrinkable.length === 0) break;
    shrinkable.sort((a, b) => b.duration - a.duration);
    shrinkable[0].duration -= 1;
    clampTransitions(plans);
  }
  clampTransitions(plans);
  return plans;
}

/** Shorten a line to the words that fit the scene, keeping a sentence ending. */
export function fitNarration(text: string, headline: string, sceneSeconds: number, language: 'en' | 'fr'): string {
  const rate = language === 'fr' ? 2.1 : 2.5;
  const budgetSeconds = Math.max(0.8, sceneSeconds - 0.45);
  const words = Math.max(2, Math.floor(budgetSeconds * rate));
  const source = (text || headline || '').replace(/\s+/g, ' ').trim();
  const parts = source.split(' ').filter(Boolean);
  const body = (parts.length === 0 ? ['Here is the short version.'] : parts.slice(0, words)).join(' ');
  return /[.!?]$/.test(body) ? body : `${body}.`;
}

/**
 * CPU stub voice. Duration is the same words-per-second estimate the brief
 * uses, so tests never load Kokoro weights and never call a model.
 */
export function stubVoice(input: VoiceInput): VoiceResult {
  const seconds = Math.max(0.4, estimateNarrationSeconds(input.text, input.language) || 0.4);
  return {
    engine: 'stub',
    text: input.text,
    seconds,
    chunks: [{ text: input.text, seconds }],
  };
}

function presenterCoverage(pkg: Record<string, any>, scene: Record<string, any>, index: number, total: number): boolean {
  if (scene.presenter === 'off') return false;
  if (scene.presenter_asset) return true;
  const presenter = pkg.presenter;
  if (!presenter || presenter.enabled !== true) return false;
  const scenes = presenter.scenes ?? 'bookends';
  if (scenes === 'all') return true;
  if (scenes === 'bookends') return index === 0 || index === total - 1;
  return Array.isArray(scenes) && scenes.includes(scene.id);
}

function planPresenter(original: Record<string, any>, kept: Record<string, any>[]): PresenterPlan[] {
  const originalScenes: Record<string, any>[] = Array.isArray(original.scenes) ? original.scenes : [];
  const keptIds = new Set(kept.map(scene => scene.id));
  const plans: PresenterPlan[] = [];
  originalScenes.forEach((scene, index) => {
    const covered = presenterCoverage(original, scene, index, originalScenes.length);
    if (!covered && !scene.presenter_asset) return;
    if (!keptIds.has(scene.id)) {
      plans.push({ sceneId: scene.id, action: 'drop', run: false, reason: 'scene omitted from the cutdown; its clip is not re-run' });
      return;
    }
    const next = kept.find(item => item.id === scene.id)!;
    const before = typeof scene.narration === 'string' ? scene.narration : '';
    const after = typeof next.narration === 'string' ? next.narration : '';
    if (before === after && scene.presenter_asset) {
      plans.push({
        sceneId: scene.id,
        action: 'keep',
        run: false,
        reason: 'narration unchanged; the existing presenter clip still matches',
        assetId: scene.presenter_asset,
      });
      return;
    }
    if (before !== after) {
      plans.push({
        sceneId: scene.id,
        action: 'plan',
        run: false,
        reason: 'narration changed; a new presenter clip is planned and not run',
        narration: after,
      });
      delete next.presenter_asset;
      if (next.presenter && next.presenter !== 'off') next.presenter = 'off';
    }
  });
  return plans;
}

function applyPlans(plans: ScenePlan[]): Record<string, any>[] {
  return plans.map((plan, index) => {
    const scene = structuredClone(plan.scene);
    scene.preferredFrames = plan.duration;
    const isLast = index === plans.length - 1;
    if (isLast) {
      scene.transitionOut = { type: 'none', frames: 0 };
    } else if (plan.transitionOut !== transitionFrames(plan.scene)) {
      const previous = scene.transitionOut && typeof scene.transitionOut === 'object' ? scene.transitionOut : { type: 'fade' };
      scene.transitionOut = { ...previous, frames: plan.transitionOut };
    }
    return scene;
  });
}

/**
 * Build a cutdown package. Pure aside from the voice function, which the
 * default stub implements with no I/O. `voice` must be synchronous.
 */
export function cutdownPackage(pkg: Record<string, any>, targetSeconds: number, options: { voice?: VoiceFn } = {}): CutdownResult {
  if (!isCutdownSeconds(targetSeconds)) {
    throw new Error(`cutdown target must be one of ${CUTDOWN_SECONDS.join(', ')} seconds`);
  }
  if (!pkg || !Array.isArray(pkg.scenes) || pkg.scenes.length === 0) {
    throw new Error('cutdown needs a package with at least one scene');
  }
  const voice = options.voice ?? stubVoice;
  const fps = Number.isFinite(pkg.format?.fps) && pkg.format.fps > 0 ? Math.floor(pkg.format.fps) : 30;
  const targetFrames = targetFramesForSeconds(targetSeconds, fps);
  const chosen = pickCutdownScenes(pkg.scenes, targetSeconds, fps);
  const plans = fitPlans(chosen, targetFrames);
  const language = languageOf(pkg);
  const voiced: CutdownResult['voiced'] = [];
  for (const plan of plans) {
    const headline = typeof plan.scene.copy?.headline === 'string' ? plan.scene.copy.headline : '';
    const original = typeof plan.scene.narration === 'string' ? plan.scene.narration : '';
    const text = fitNarration(original, headline, plan.duration / fps, language);
    const spoken = voice({
      sceneId: plan.scene.id,
      text,
      language,
      ...(typeof pkg.voice?.voice === 'string' ? { voice: pkg.voice.voice } : {}),
      ...(typeof pkg.voice?.speed === 'number' ? { speed: pkg.voice.speed } : {}),
    });
    if (!spoken || spoken.engine === undefined || typeof spoken.seconds !== 'number') {
      throw new Error(`voice returned nothing for scene ${plan.scene.id}`);
    }
    plan.scene = { ...plan.scene, narration: spoken.text || text };
    voiced.push({ sceneId: plan.scene.id, text: plan.scene.narration, seconds: spoken.seconds, engine: spoken.engine });
  }
  const scenes = applyPlans(plans);
  if (Math.abs(totalFrames(plans) - targetFrames) > Math.round(0.5 * fps)) {
    throw new Error(`cutdown of ${targetSeconds}s is ${totalFrames(plans)} frames, outside ±0.5s of ${targetFrames}`);
  }
  // applyPlans clones again from plan.scene, which already has the new narration.
  const next: Record<string, any> = structuredClone(pkg);
  next.scenes = scenes;
  next.duration = { mode: 'target', targetFrames };
  next.revision = Math.min(1_000_000, Math.max(1, Math.floor(Number(pkg.revision) || 1) + 1));
  const id = `${pkg.id}-${targetSeconds}s`;
  if (PACKAGE_ID.test(id)) next.id = id;
  if (Array.isArray(next.presenter?.scenes)) {
    const ids = new Set(scenes.map(scene => scene.id));
    const remaining = next.presenter.scenes.filter((sceneId: string) => ids.has(sceneId));
    next.presenter = { ...next.presenter, scenes: remaining.length > 0 ? remaining : 'bookends' };
  }
  const presenterPlans = planPresenter(pkg, scenes);
  const frames = totalFrames(plans);
  return {
    targetSeconds,
    targetFrames,
    frames,
    sceneIds: scenes.map(scene => scene.id),
    package: next,
    voiced,
    narration: {},
    presenter: { ran: false, plans: presenterPlans },
  };
}
