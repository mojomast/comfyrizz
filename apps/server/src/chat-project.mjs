import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { createToolset, conversationPlanSchema, STYLE_PRESET_DEFAULTS, brandTheme } from '../../../packages/agent/dist/src/index.js';
import { sanitizeSvg, renderCheck, SANITIZER_VERSION } from '../../../packages/vector/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compilePackage } from './compile-package.mjs';
import { inlineGeneratedAssets } from '../../renderer/scripts/render-package-lib.mjs';

export function chatProjectResponse(pkg, runtimeDir) {
  return {
    package: pkg, revision: pkg.revision, timeline: compilePackage(pkg, join(runtimeDir, 'packages', pkg.id)),
    generatedAssets: inlineGeneratedAssets(pkg, join(runtimeDir, 'packages')),
    svgAssets: Object.entries(pkg.assets ?? {}).filter(([, asset]) => ['svg', 'vector-anim'].includes(asset.kind)).map(([id]) => id),
    pendingGpu: Object.entries(pkg.assets ?? {}).filter(([, asset]) => asset.status === 'pending' && ['flux3-klein', 'ltx25'].includes(asset.gen?.generator))
      .map(([assetId, asset]) => ({ assetId, generator: asset.gen.generator })),
  };
}

function conflict(message) {
  return Object.assign(new Error(`Project revision conflict: ${message}`), { status: 409 });
}

// A plan is a baseline, not a replacement for the editable project. Only fields
// changed between plans are candidates for an update; divergent manual edits
// require a fresh plan rather than silently losing one side of the edit.
function mergeField(target, key, before, after, label) {
  if (equal(before, after)) return;
  if (!equal(target[key], before) && !equal(target[key], after)) throw conflict(`${label} was manually edited`);
  if (after === undefined) delete target[key];
  else target[key] = structuredClone(after);
}

function planCopy(scene) {
  return {
    headline: scene.headline,
    ...(scene.sub ? { sub: scene.sub } : {}),
    ...(scene.layout === 'hero' && scene.body ? { body: scene.body } : {}),
    ...(scene.layout === 'list' ? { items: scene.items } : {}),
  };
}

function variant(scene, index, length) {
  return scene.layout === 'title' ? (index === length - 1 && index > 0 ? 'outro' : 'centered')
    : scene.layout === 'hero' ? 'split' : 'bullets';
}

function narration(scene) {
  return scene.narration.trim() ? scene.narration : undefined;
}

const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };
const DEFAULT_TRANSITION = { type: 'fade', frames: 12 };

/** Compile model-authored content, merging revisions into the current project. */
export async function buildChatProject({ plan: rawPlan, previous, previousPlan, brand, runtimeDir, signal }) {
  signal?.throwIfAborted();
  const plan = conversationPlanSchema.parse(rawPlan);
  if (previous && !previousPlan) throw conflict('the last built plan is missing');
  const baseline = previous ? conversationPlanSchema.parse(previousPlan) : undefined;
  const aspect = ASPECTS[plan.aspect];
  const defaults = STYLE_PRESET_DEFAULTS[plan.stylePreset];
  const pkg = previous ? structuredClone(previous) : {
    $schema: 'https://comfyrizz.example/schema/package-v1.json', schemaVersion: 1,
    id: `pkg_${randomUUID().replaceAll('-', '')}`, revision: 1,
    createdAt: new Date().toISOString(), assets: {}, datasets: {},
    voice: { enabled: false, engine: 'none' }, compliance: { open_weights_only: false }, renders: [],
  };
  if (!previous) {
    pkg.title = plan.title;
    pkg.format = { width: aspect[0], height: aspect[1], fps: 30 };
    pkg.theme = { palette: defaults.palette, font: defaults.font, ...brandTheme(brand?.kit ?? {}) };
  } else {
    mergeField(pkg, 'title', baseline.title, plan.title, 'title');
    if (baseline.aspect !== plan.aspect) {
      const oldAspect = ASPECTS[baseline.aspect];
      mergeField(pkg.format, 'width', oldAspect[0], aspect[0], 'format.width');
      mergeField(pkg.format, 'height', oldAspect[1], aspect[1], 'format.height');
    }
    if (baseline.stylePreset !== plan.stylePreset) {
      const oldTheme = { ...STYLE_PRESET_DEFAULTS[baseline.stylePreset], ...brandTheme(brand?.kit ?? {}) };
      const newTheme = { ...defaults, ...brandTheme(brand?.kit ?? {}) };
      pkg.theme ??= {};
      for (const key of ['palette', 'font']) mergeField(pkg.theme, key, oldTheme[key], newTheme[key], `theme.${key}`);
    }
  }
  const fps = pkg.format.fps;
  const styleChanged = !!baseline && baseline.stylePreset !== plan.stylePreset;
  const paletteChanged = !!previous && !equal(previous.theme?.palette, pkg.theme?.palette);
  pkg.assets = { ...(brand?.assets ?? {}), ...pkg.assets };
  const oldScenes = new Map(baseline?.scenes.map(scene => [scene.id, scene]) ?? []);
  const currentScenes = new Map(pkg.scenes?.map(scene => [scene.id, scene]) ?? []);
  const newScenes = new Map(plan.scenes.map(scene => [scene.id, scene]));
  const merged = new Map();
  const generate = new Set();

  for (const existing of currentScenes.values()) {
    if (existing.locked && (!equal(previous.format, pkg.format) || !equal(previous.theme, pkg.theme))) {
      throw conflict(`locked scene ${existing.id} cannot be restyled or reformatted`);
    }
    if (oldScenes.has(existing.id) && !newScenes.has(existing.id)) {
      if (existing.locked) throw conflict(`locked scene ${existing.id} cannot be deleted`);
    } else if (!oldScenes.has(existing.id)) {
      if (newScenes.has(existing.id)) throw conflict(`new scene ${existing.id} collides with a manually added scene`);
      merged.set(existing.id, existing);
    }
  }
  plan.scenes.forEach((scene, index) => {
    const existing = currentScenes.get(scene.id);
    const oldPlan = oldScenes.get(scene.id);
    if (oldPlan && !existing) {
      if (!equal(oldPlan, scene)) throw conflict(`scene ${scene.id} was manually deleted`);
      return;
    }
    const visualChanged = !oldPlan || ['visual', 'mediaType', 'svg'].some(key => !equal(oldPlan[key], scene[key]));
    const regenerate = visualChanged || (scene.mediaType === 'image' && styleChanged) || (scene.mediaType === 'svg' && paletteChanged);
    if (existing?.locked) {
      if (!equal(oldPlan, scene) || regenerate || !equal(previous.format, pkg.format) || !equal(previous.theme, pkg.theme)) {
        throw conflict(`locked scene ${scene.id} cannot be modified`);
      }
      merged.set(scene.id, existing);
      return;
    }
    const result = existing ?? {
      id: scene.id, layout: scene.layout, variant: variant(scene, index, plan.scenes.length),
      preferredFrames: Math.round(scene.seconds * fps), copy: planCopy(scene),
      ...(narration(scene) ? { narration: narration(scene) } : {}), notes: scene.visual,
      ...(index < plan.scenes.length - 1 ? { transitionOut: { ...DEFAULT_TRANSITION } } : {}),
    };
    if (oldPlan) {
      const label = key => `scene ${scene.id}.${key}`;
      mergeField(result, 'layout', oldPlan.layout, scene.layout, label('layout'));
      if (oldPlan.layout !== scene.layout) {
        mergeField(result, 'variant', variant(oldPlan, baseline.scenes.indexOf(oldPlan), baseline.scenes.length), variant(scene, index, plan.scenes.length), label('variant'));
      }
      if (oldPlan.seconds !== scene.seconds) {
        mergeField(result, 'preferredFrames', Math.round(oldPlan.seconds * fps), Math.round(scene.seconds * fps), label('preferredFrames'));
      }
      const oldCopy = planCopy(oldPlan);
      const newCopy = planCopy(scene);
      result.copy ??= {};
      for (const key of new Set([...Object.keys(oldCopy), ...Object.keys(newCopy)])) {
        // A layout switch is not a request to erase otherwise unchanged copy.
        if (equal(oldPlan[key], scene[key])) continue;
        mergeField(result.copy, key, oldCopy[key], newCopy[key], label(`copy.${key}`));
      }
      const currentNarration = result.narration;
      mergeField(result, 'narration', narration(oldPlan), narration(scene), label('narration'));
      if (currentNarration !== result.narration) {
        delete result.narration_asset;
        delete result.narration_duration_frames;
        delete result.narration_spoken;
        delete result.spoken_text;
      }
      mergeField(result, 'notes', oldPlan.visual, scene.visual, label('notes'));
    }
    if (regenerate) {
      // Palette/style invalidation replaces generated media, but not the user's
      // background. Explicit visual edits also reset the procedural backdrop.
      if (visualChanged) result.background = { procedural: { pattern: 'mesh', seed: index + 1 } };
      result.foreground = [];
      generate.add(scene.id);
    }
    merged.set(scene.id, result);
  });

  // Compare relative order of surviving plan scenes, so omission alone does
  // not undo a manual reorder. New scenes are inserted by their plan neighbours.
  const common = new Set(plan.scenes.filter(scene => oldScenes.has(scene.id) && merged.has(scene.id)).map(scene => scene.id));
  const oldOrder = baseline?.scenes.filter(scene => common.has(scene.id)).map(scene => scene.id) ?? [];
  const newOrder = plan.scenes.filter(scene => common.has(scene.id)).map(scene => scene.id);
  let order = previous ? previous.scenes.filter(scene => merged.has(scene.id)).map(scene => scene.id) : [];
  if (!equal(oldOrder, newOrder)) {
    // Keep manual scenes in their slots, replacing only the plan-owned slots.
    let cursor = 0;
    order = order.map(id => common.has(id) ? newOrder[cursor++] : id);
  }
  for (let index = 0; index < plan.scenes.length; index += 1) {
    const id = plan.scenes[index].id;
    if (!merged.has(id) || order.includes(id)) continue;
    const next = plan.scenes.slice(index + 1).find(scene => order.includes(scene.id));
    const prior = plan.scenes.slice(0, index).findLast(scene => order.includes(scene.id));
    const position = next ? order.indexOf(next.id) : prior ? order.indexOf(prior.id) + 1 : order.length;
    order.splice(position, 0, id);
  }
  pkg.scenes = order.map(id => merged.get(id));
  if (!pkg.scenes.length) throw conflict('the resulting project has no scenes');
  const last = pkg.scenes.at(-1);
  if (last.transitionOut?.frames > 0 && !['none', 'cut'].includes(last.transitionOut.type)) {
    if (last.locked || (currentScenes.has(last.id) && !oldScenes.has(last.id)) || !equal(last.transitionOut, DEFAULT_TRANSITION)) {
      throw conflict(`scene ${last.id} has a transition that cannot be preserved at the end`);
    }
    delete last.transitionOut;
  }
  // Use the natural timeline (including overlap and layout limits), so target
  // fitting cannot stretch manual timings or count deleted scenes.
  const naturalTimeline = compilePackage({ ...pkg, duration: { mode: 'flexible' } }, join(runtimeDir, 'packages', pkg.id));
  pkg.duration = { mode: 'target', targetFrames: naturalTimeline.durationInFrames };

  signal?.throwIfAborted();
  const assetsDir = join(runtimeDir, 'packages', 'assets');
  mkdirSync(assetsDir, { recursive: true });
  let draft = pkg;
  let activeSvg;
  const tools = createToolset({
    initialPackage: draft, stylePreset: plan.stylePreset,
    ...(brand?.kit ? { brand: brand.kit } : {}),
    onPackageChange: value => { draft = value; },
    persistSvg: (id, svg) => {
      writeFileSync(join(assetsDir, `${id}.svg`), svg);
      return `assets/${id}.svg`;
    },
    generateSvg: () => {
      const sanitized = sanitizeSvg(activeSvg);
      if (!sanitized.ok) throw new Error(`SVG rejected: ${sanitized.errors.map(error => error.code).join(', ')}`);
      const check = renderCheck(sanitized.svg, { width: 512, palette: draft.theme.palette });
      if (!check.ok) throw new Error(`SVG render check failed: ${check.errors.map(error => error.code).join(', ')}`);
      return { svg: sanitized.svg, sanitizerVersion: SANITIZER_VERSION,
        renderCheck: { ...check, version: SANITIZER_VERSION } };
    },
  });
  for (const scene of plan.scenes) {
    signal?.throwIfAborted();
    if (!generate.has(scene.id)) continue;
    if (scene.mediaType === 'svg') {
      activeSvg = scene.svg;
      const result = await tools['assets.generate_svg'].run({ scene_id: scene.id, kind: 'diagram', intent: scene.visual });
      signal?.throwIfAborted();
      const target = draft.scenes.find(item => item.id === scene.id);
      target.foreground = [{ asset: result.asset.id, x: scene.layout === 'hero' ? 0.76 : 0.5, y: scene.layout === 'hero' ? 0.52 : 0.8, w: scene.layout === 'hero' ? 0.35 : 0.12, anim: 'fade-in' }];
    } else if (scene.mediaType === 'image') {
      const result = await tools['assets.generate_image'].run({ scene_id: scene.id, intent: scene.visual, kind: 'illustration', style: plan.stylePreset });
      signal?.throwIfAborted();
      const target = draft.scenes.find(item => item.id === scene.id);
      target.foreground = [{ asset: result.asset.id, x: 0.76, y: 0.5, w: 0.4, anim: 'fade-in' }];
    }
  }
  draft.revision = previous?.revision ?? 1;
  draft.renders = [];
  signal?.throwIfAborted();
  const validation = validatePackage(draft);
  if (!validation.valid) throw new Error(`Project validation failed: ${validation.errors.slice(0, 5).map(error => `${error.path}: ${error.message}`).join('; ')}`);
  compilePackage(draft, join(runtimeDir, 'packages', draft.id));
  return draft;
}
