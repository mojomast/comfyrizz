import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { createToolset, conversationPlanSchema, STYLE_PRESET_DEFAULTS, brandTheme } from '../../../packages/agent/dist/src/index.js';
import { sanitizeSvg, renderCheck, SANITIZER_VERSION } from '../../../packages/vector/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { inlineGeneratedAssets } from '../../renderer/scripts/render-package-lib.mjs';

export function chatProjectResponse(pkg, runtimeDir) {
  return {
    package: pkg, revision: pkg.revision, timeline: compileTimeline(pkg),
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

const DATA_LAYOUTS = new Set(['stat', 'chart']);
const PLATE_LAYOUTS = new Set(['split', 'compare']);

function planCopy(scene) {
  if (scene.layout === 'code') {
    return {
      ...(scene.headline ? { headline: scene.headline } : {}),
      ...(scene.sub ? { sub: scene.sub } : {}),
    };
  }
  return {
    ...(scene.headline ? { headline: scene.headline } : {}),
    ...(scene.sub ? { sub: scene.sub } : {}),
    ...(['hero', 'stat'].includes(scene.layout) && scene.body ? { body: scene.body } : {}),
    ...(scene.layout === 'list' && scene.items.length ? { items: scene.items } : {}),
    ...(DATA_LAYOUTS.has(scene.layout) && scene.footnote ? { footnote: scene.footnote } : {}),
  };
}

function planData(scene) {
  if (!scene.data) return undefined;
  // Copy the author's reference verbatim: the package schema owns the display default.
  return {
    dataset: scene.data.dataset,
    ...(scene.data.display ? { display: scene.data.display } : {}),
  };
}

function variant(scene, index, length) {
  if (scene.layout === 'title') return index === length - 1 && index > 0 ? 'outro' : 'centered';
  if (scene.layout === 'hero') return 'split';
  if (scene.layout === 'list') return 'bullets';
  if (scene.layout === 'chart') return 'bar';
  return undefined;
}

function narration(scene) {
  return scene.narration.trim() ? scene.narration : undefined;
}

function proceduralPlate(plate) {
  return {
    procedural: {
      pattern: plate.pattern ?? 'mesh',
      ...(plate.seed !== undefined ? { seed: plate.seed } : {}),
      ...(plate.palette ? { palette: plate.palette } : {}),
    },
    ...(plate.label ? { label: plate.label } : {}),
  };
}

function allPlatesProcedural(scene) {
  return (scene.plates ?? []).every(plate => plate.mediaType === 'procedural');
}

function proceduralMedia(scene) {
  if (!PLATE_LAYOUTS.has(scene.layout) || !allPlatesProcedural(scene)) return undefined;
  return scene.plates.map(proceduralPlate);
}

/** Outgoing transition the plan asks for. The actual final scene drops it after ordering. */
function planTransition(scene) {
  const transition = scene.transition ?? scene.transitionOut;
  if (!transition) return { ...DEFAULT_TRANSITION };
  const frames = transition.frames ?? (transition.type === 'none' || transition.type === 'cut' ? 0 : 12);
  return {
    type: transition.type,
    frames,
    ...(transition.direction ? { direction: transition.direction } : {}),
  };
}

/** Field-level motion merge, so a plan can change one token without erasing manual work. */
function mergeMotion(result, oldMotion, newMotion, label) {
  const keys = new Set([...Object.keys(oldMotion ?? {}), ...Object.keys(newMotion ?? {})]);
  if (!keys.size) return;
  if (!result.motion && newMotion) result.motion = {};
  if (!result.motion) return;
  for (const key of keys) {
    const before = oldMotion?.[key];
    const after = newMotion?.[key];
    if (equal(before, after)) continue;
    if (!equal(result.motion[key], before) && !equal(result.motion[key], after)) throw conflict(`${label}.${key} was manually edited`);
    if (after === undefined) delete result.motion[key];
    else result.motion[key] = structuredClone(after);
  }
  if (Object.keys(result.motion).length === 0) delete result.motion;
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
    createdAt: new Date().toISOString(), assets: {}, datasets: structuredClone(plan.datasets ?? {}),
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
    const visualChanged = !oldPlan || ['visual', 'mediaType', 'svg', 'plates'].some(key => !equal(oldPlan[key], scene[key]));
    const platesNeeded = PLATE_LAYOUTS.has(scene.layout) && (!oldPlan || oldPlan.layout !== scene.layout || !equal(oldPlan.plates, scene.plates));
    const platesMissing = PLATE_LAYOUTS.has(scene.layout) && (!existing?.media || existing.media.length !== 2);
    const plateTypes = new Set((scene.plates ?? []).map(plate => plate.mediaType));
    const imageMedia = scene.mediaType === 'image' || plateTypes.has('image');
    const svgMedia = scene.mediaType === 'svg' || plateTypes.has('svg');
    const regenerate = visualChanged || platesNeeded || platesMissing || (imageMedia && styleChanged) || (svgMedia && paletteChanged);
    if (existing?.locked) {
      if (!equal(oldPlan, scene) || regenerate || !equal(previous.format, pkg.format) || !equal(previous.theme, pkg.theme)) {
        throw conflict(`locked scene ${scene.id} cannot be modified`);
      }
      merged.set(scene.id, existing);
      return;
    }
    const sceneVariant = variant(scene, index, plan.scenes.length);
    const sceneData = planData(scene);
    const sceneTransition = planTransition(scene);
    const sceneMedia = proceduralMedia(scene);
    const result = existing ?? {
      id: scene.id, layout: scene.layout, ...(sceneVariant ? { variant: sceneVariant } : {}),
      preferredFrames: Math.round(scene.seconds * fps), copy: planCopy(scene),
      ...(sceneData ? { data: structuredClone(sceneData) } : {}),
      ...(scene.code ? { code: structuredClone(scene.code) } : {}),
      ...(sceneMedia ? { media: structuredClone(sceneMedia) } : {}),
      ...(scene.motion ? { motion: structuredClone(scene.motion) } : {}),
      ...(narration(scene) ? { narration: narration(scene) } : {}), notes: scene.visual,
      ...(sceneTransition ? { transitionOut: sceneTransition } : {}),
    };
    if (oldPlan) {
      const label = key => `scene ${scene.id}.${key}`;
      mergeField(result, 'layout', oldPlan.layout, scene.layout, label('layout'));
      if (oldPlan.layout !== scene.layout) {
        mergeField(result, 'variant', variant(oldPlan, baseline.scenes.indexOf(oldPlan), baseline.scenes.length), sceneVariant, label('variant'));
      }
      if (oldPlan.seconds !== scene.seconds) {
        mergeField(result, 'preferredFrames', Math.round(oldPlan.seconds * fps), Math.round(scene.seconds * fps), label('preferredFrames'));
      }
      const oldCopy = planCopy(oldPlan);
      const newCopy = planCopy(scene);
      result.copy ??= {};
      const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
      for (const key of new Set([...Object.keys(oldCopy), ...Object.keys(newCopy)])) {
        const oldVisible = owns(oldCopy, key);
        const newVisible = owns(newCopy, key);
        const current = result.copy[key];
        if (!oldVisible && !newVisible) continue;
        if (oldVisible && newVisible) {
          // Both layouts show the field. Preserve a manual value when the plan
          // itself has not changed it.
          if (equal(oldCopy[key], newCopy[key])) continue;
          mergeField(result.copy, key, oldCopy[key], newCopy[key], label(`copy.${key}`));
        } else if (oldVisible && !newVisible) {
          // The field becomes hidden. Keep a manual hidden value; otherwise the
          // plan-owned value can leave the copy object.
          if (!owns(result.copy, key) || !equal(current, oldCopy[key])) continue;
          delete result.copy[key];
        } else {
          // The field becomes visible for the first time. Add it even when the
          // raw plan value was already present but hidden (hero items -> list).
          if (!owns(result.copy, key) || equal(current, newCopy[key]) || (owns(oldPlan, key) && equal(current, oldPlan[key]))) {
            result.copy[key] = structuredClone(newCopy[key]);
          }
          // A different existing value is a manual edit to hidden content.
        }
      }
      mergeField(result, 'data', planData(oldPlan), sceneData, label('data'));
      mergeField(result, 'code', oldPlan.code, scene.code, label('code'));
      mergeMotion(result, oldPlan.motion, scene.motion, label('motion'));
      // The plan's final scene has no next scene, but a manual scene may follow it.
      // Keep its existing transition here; the post-order pass removes it only when
      // it really is last. A scene moving out of the final slot now gets a transition.
      if (index < plan.scenes.length - 1) {
        const oldWasFinal = baseline.scenes.indexOf(oldPlan) === baseline.scenes.length - 1;
        // A transition manually placed on a formerly-final scene becomes a real
        // boundary when a new scene follows. Preserve it unless the plan names one.
        if (!(oldWasFinal && !(scene.transition ?? scene.transitionOut) && result.transitionOut !== undefined)) {
          mergeField(result, 'transitionOut', oldWasFinal ? undefined : planTransition(oldPlan), sceneTransition, label('transitionOut'));
        }
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
      if (PLATE_LAYOUTS.has(scene.layout)) delete result.media;
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
  if (baseline) {
    // Datasets are shared, so a dataset owned by the plan is removed only when no
    // surviving manual scene still cites it. Provenance is copied verbatim.
    pkg.datasets ??= {};
    const oldDatasets = baseline.datasets ?? {};
    const newDatasets = plan.datasets ?? {};
    const referenced = new Set(pkg.scenes.flatMap(scene => scene.data?.dataset ? [scene.data.dataset] : []));
    const lockedByDataset = new Map(pkg.scenes.filter(scene => scene.locked && scene.data?.dataset).map(scene => [scene.data.dataset, scene.id]));
    for (const id of new Set([...Object.keys(oldDatasets), ...Object.keys(newDatasets)])) {
      const before = oldDatasets[id];
      const after = newDatasets[id];
      if (equal(before, after)) continue;
      if (lockedByDataset.has(id) && !equal(pkg.datasets[id], after)) throw conflict(`locked scene ${lockedByDataset.get(id)} cannot use a changed dataset ${id}`);
      if (after === undefined) {
        // A manual provenance edit is user data. Keep it when the plan drops the
        // dataset, even if its last plan scene was also removed. Only an
        // unchanged plan-owned dataset can disappear.
        if (referenced.has(id) || !equal(pkg.datasets[id], before)) continue;
      }
      mergeField(pkg.datasets, id, before, after, `dataset ${id}`);
    }
  }
  const last = pkg.scenes.at(-1);
  if (last.transitionOut?.frames > 0 && !['none', 'cut'].includes(last.transitionOut.type)) {
    const finalPlanScene = plan.scenes.at(-1);
    const planFinalId = finalPlanScene?.id;
    const plannedFinal = finalPlanScene ? planTransition(finalPlanScene) : undefined;
    // Recognise the transition this same scene owned in the previous plan, not
    // just the previous final scene's. A reordered former-middle scene is still
    // plan-owned when its own old transition is what remains.
    const oldOwnPlan = oldScenes.get(last.id);
    const oldOwnPlanned = oldOwnPlan ? planTransition(oldOwnPlan) : undefined;
    // The timeline rejects any outgoing transition on the true last scene. Drop a
    // plan/default transition there; a divergent manual or locked one is preserved
    // by refusing the revision rather than silently erasing it.
    if (last.locked) {
      throw conflict(`scene ${last.id} has a transition that cannot be preserved at the end`);
    } else if (last.id === planFinalId) {
      if (equal(last.transitionOut, DEFAULT_TRANSITION) || equal(last.transitionOut, plannedFinal) || equal(last.transitionOut, oldOwnPlanned)) delete last.transitionOut;
      else throw conflict(`scene ${last.id} has a transition that cannot be preserved at the end`);
    } else if ((currentScenes.has(last.id) && !oldScenes.has(last.id)) || !equal(last.transitionOut, DEFAULT_TRANSITION)) {
      throw conflict(`scene ${last.id} has a transition that cannot be preserved at the end`);
    } else {
      delete last.transitionOut;
    }
  }
  // Use the natural timeline (including overlap and layout limits), so target
  // fitting cannot stretch manual timings or count deleted scenes.
  const naturalTimeline = compileTimeline({ ...pkg, duration: { mode: 'flexible' } });
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
  const generatedVisuals = new Map();
  for (const scene of plan.scenes) {
    signal?.throwIfAborted();
    if (!generate.has(scene.id)) continue;
    if (PLATE_LAYOUTS.has(scene.layout)) {
      const media = [];
      for (const [plateIndex, plate] of (scene.plates ?? []).entries()) {
        signal?.throwIfAborted();
        const intent = plate.visual ?? `${scene.visual} — ${plate.label ?? `plate ${plateIndex + 1}`}`;
        if (plate.mediaType === 'svg') {
          activeSvg = plate.svg;
          const result = await tools['assets.generate_svg'].run({ scene_id: scene.id, kind: 'diagram', intent });
          signal?.throwIfAborted();
          media.push({ asset: result.asset.id, ...(plate.label ? { label: plate.label } : {}) });
        } else if (plate.mediaType === 'image') {
          const result = await tools['assets.generate_image'].run({ scene_id: scene.id, intent, kind: 'illustration', style: plan.stylePreset });
          signal?.throwIfAborted();
          media.push({ asset: result.asset.id, ...(plate.label ? { label: plate.label } : {}) });
        } else {
          media.push(proceduralPlate(plate));
        }
      }
      // Generate tools mutate their own snapshot; apply the authored placement after
      // the loop so a later tool call cannot overwrite this scene.
      generatedVisuals.set(scene.id, { foreground: [], media });
    } else if (scene.mediaType === 'svg') {
      activeSvg = scene.svg;
      const result = await tools['assets.generate_svg'].run({ scene_id: scene.id, kind: 'diagram', intent: scene.visual });
      signal?.throwIfAborted();
      generatedVisuals.set(scene.id, { foreground: [{ asset: result.asset.id, x: scene.layout === 'hero' ? 0.76 : 0.5, y: scene.layout === 'hero' ? 0.52 : 0.8, w: scene.layout === 'hero' ? 0.35 : 0.12, anim: 'fade-in' }] });
    } else if (scene.mediaType === 'image') {
      const result = await tools['assets.generate_image'].run({ scene_id: scene.id, intent: scene.visual, kind: 'illustration', style: plan.stylePreset });
      signal?.throwIfAborted();
      generatedVisuals.set(scene.id, { foreground: [{ asset: result.asset.id, x: 0.76, y: 0.5, w: 0.4, anim: 'fade-in' }] });
    }
  }
  if (generatedVisuals.size) {
    draft.scenes = draft.scenes.map(scene => {
      const visual = generatedVisuals.get(scene.id);
      return visual ? { ...scene, ...visual } : scene;
    });
  }
  draft.revision = previous?.revision ?? 1;
  draft.renders = [];
  signal?.throwIfAborted();
  const validation = validatePackage(draft);
  if (!validation.valid) throw new Error(`Project validation failed: ${validation.errors.slice(0, 5).map(error => `${error.path}: ${error.message}`).join('; ')}`);
  compileTimeline(draft);
  return draft;
}
