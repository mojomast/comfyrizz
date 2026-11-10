/**
 * Money shot: frame 0 of a render is a finished hero, not a fade from black.
 *
 * The composition clock does not move. Narration, music and captions stay on
 * the frames the planner compiled. The opening scene is drawn at the local
 * frame where its entrance has already settled, and held there until the real
 * clock catches up. When a later scene scores higher, that settled frame is
 * also shown on top for the same short hold (a picture-only cold open). Audio
 * is not delayed and no frames are inserted, so export length checks still
 * match the timeline.
 */
import { codeExitStart, DEFAULT_CHARS_PER_SECOND } from '../../../packages/schema/src/code-layout.mjs';
import { staggerFrames, STAGGER_SECONDS } from './motion/index.js';
import { kineticPlan } from './recipes/kinetic.js';
import { resolveRecipe } from './recipes/model.js';
import { mergeScenes } from './timeline-model.js';

const LAYOUT_SCORE = {
  hero: 80,
  title: 48,
  stat: 36,
  chart: 34,
  split: 32,
  compare: 32,
  list: 26,
  code: 24,
};

/** Default on. `false` or COMFYRIZZ_MONEY_SHOT=0|false|off|no turns it off. */
export function moneyShotEnabled(value, env = typeof process === 'undefined' ? {} : process.env) {
  if (value === false) return false;
  if (value === true) return true;
  const flag = String(env?.COMFYRIZZ_MONEY_SHOT ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false;
  return true;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Higher is a stronger thumbnail. Earlier scenes win an exact tie. */
export function scoreScene(scene, index = 0) {
  const copy = scene?.copy ?? {};
  const headline = text(copy.headline);
  let score = LAYOUT_SCORE[scene?.layout] ?? 12;
  // Planner-designated hero (`scene.hero`). Layout "hero" is only the fallback.
  if (scene?.hero === true) score += 100;
  if (headline) score += 28;
  if (text(copy.kicker)) score += 4;
  if (text(copy.sub)) score += 6;
  if (text(copy.body)) score += 4;
  if (text(scene?.lower_third?.text)) score += 8;
  if (scene?.background?.asset || scene?.background?.procedural) score += 16;
  if ((scene?.foreground ?? []).some(item => item?.asset)) score += 12;
  if (scene?.drawing?.elements?.length) score += 10;
  if (scene?.variant === 'outro') score -= 50;
  if (scene?.media_only === true && !headline && !text(scene?.lower_third?.text)) score -= 12;
  score += Math.max(0, 5 - index);
  return score;
}

function sceneFrames(scene) {
  const duration = Number(scene?.durationInFrames ?? scene?.preferredFrames);
  return Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 90;
}

function kineticSettle(scene, fps, duration) {
  if (resolveRecipe(scene).recipe !== 'kinetic') return 0;
  const headline = text(scene?.copy?.headline);
  if (!headline) return 0;
  const recipe = resolveRecipe(scene);
  const plan = kineticPlan({
    headline,
    phrases: recipe.cuePhrases,
    cues: recipe.cueSeconds,
    fps,
    sceneFrames: duration,
    seed: recipe.seed,
  });
  const reveal = Math.max(1, Math.round(fps * 0.47));
  return plan.words.reduce((max, word) => Math.max(max, word.start + reveal), 0);
}

/**
 * Local frame at which this scene looks finished: headline and hook readable,
 * foreground in, drawing or code complete. Capped inside the scene.
 */
export function entranceSettleFrame(scene, fps = 30) {
  const duration = sceneFrames(scene);
  const rate = fps > 0 ? fps : 30;
  const showsLayout = !scene?.drawing && scene?.media_only !== true;
  const entry = scene?.motion?.entry;
  let settle = 0;
  if (showsLayout && entry !== 'none') {
    if (entry === 'countUp') settle = 4 + 30;
    else if (entry === 'pop' || entry === 'maskRise') settle = 2 + 26;
    else if (entry === 'waterfall') {
      const words = text(scene?.copy?.headline).split(/\s+/).filter(Boolean).length;
      settle = 2 + 22 + Math.max(0, words - 1) * Math.round(0.09 * rate);
    } else settle = 2 + 22;
  }
  if (showsLayout) {
    settle = Math.max(settle, kineticSettle(scene, rate, duration));
    if (scene?.layout === 'title') {
      if (text(scene?.copy?.sub)) settle = Math.max(settle, 10 + 22);
      if (text(scene?.copy?.cta)) settle = Math.max(settle, 22 + 24);
    }
    if (scene?.layout === 'hero' && text(scene?.copy?.body)) settle = Math.max(settle, 12 + 22);
    if (scene?.layout === 'list' && Array.isArray(scene?.copy?.items) && scene.copy.items.length > 0) {
      const last = scene.copy.items.length - 1;
      settle = Math.max(settle, 8 + staggerFrames(last, STAGGER_SECONDS.listItem, rate) + 18);
    }
    if (scene?.layout === 'chart') settle = Math.max(settle, 10 + staggerFrames(5, 0.08, rate, 0.4) + 26);
    if (scene?.layout === 'split' || scene?.layout === 'compare') {
      settle = Math.max(settle, Math.min(18, Math.round(0.5 * rate)));
    }
    if (scene?.layout === 'code' && text(scene?.code?.code)) {
      const charsPerSecond = scene.code?.typing?.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND;
      const typed = Math.ceil((scene.code.code.length / charsPerSecond) * rate);
      const exitAt = codeExitStart(scene.code.code, rate, charsPerSecond);
      settle = Math.max(settle, Math.min(typed, Math.max(0, exitAt - 1)));
    }
  }
  if ((scene?.foreground ?? []).some(item => item?.asset && item.anim !== 'none')) settle = Math.max(settle, 26);
  if (text(scene?.lower_third?.text)) {
    const start = Number(scene.lower_third.start_frame ?? 8);
    settle = Math.max(settle, (Number.isFinite(start) ? start : 8) + 20);
  }
  if (scene?.drawing?.elements?.length) {
    for (const element of scene.drawing.elements) {
      const end = Number(element?.end ?? element?.start ?? 0);
      if (Number.isFinite(end)) settle = Math.max(settle, end);
    }
  }
  return Math.max(0, Math.min(settle, duration - 1));
}

function disabled(reason) {
  return {
    enabled: false,
    sceneId: null,
    settleFrame: 0,
    holdFrames: 0,
    openingSettle: 0,
    coldOpen: false,
    score: 0,
    reason,
  };
}

/**
 * Pick the money shot for a compiled package.
 * `moneyShot: false` or COMFYRIZZ_MONEY_SHOT=0 disables it.
 */
export function selectMoneyShot(pkg, timeline, options = {}) {
  if (!moneyShotEnabled(options.moneyShot, options.env)) return disabled('disabled');
  const scenes = mergeScenes(pkg, timeline);
  if (scenes.length === 0) return disabled('empty');
  const fps = timeline?.fps || pkg?.format?.fps || 30;
  let best = null;
  scenes.forEach((scene, index) => {
    const score = scoreScene(scene, index);
    const settleFrame = entranceSettleFrame(scene, fps);
    if (!best || score > best.score || (score === best.score && index < best.index)) {
      best = { scene, index, score, settleFrame };
    }
  });
  const opening = scenes[0];
  const openingSettle = entranceSettleFrame(opening, fps);
  const heroIsOpening = best.scene.id === opening.id;
  let holdFrames = 0;
  if (!heroIsOpening) {
    const openingDuration = sceneFrames(opening);
    const wanted = Math.max(openingSettle, best.settleFrame, Math.min(12, Math.max(0, openingDuration - 1)));
    holdFrames = Math.max(0, Math.min(wanted, openingDuration - 1, Math.round((fps > 0 ? fps : 30) * 1.5)));
  }
  const enabled = openingSettle > 0 || holdFrames > 0;
  if (!enabled) return { ...disabled('already-settled'), sceneId: best.scene.id, score: best.score };
  return {
    enabled: true,
    sceneId: best.scene.id,
    settleFrame: best.settleFrame,
    holdFrames,
    openingSettle,
    coldOpen: holdFrames > 0,
    score: best.score,
    reason: holdFrames > 0 ? 'cold-open' : 'opening-settled',
  };
}
