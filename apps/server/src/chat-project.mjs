import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { createToolset, conversationPlanSchema, STYLE_PRESET_DEFAULTS, brandTheme } from '../../../packages/agent/dist/src/index.js';
import { sanitizeSvg, renderCheck, SANITIZER_VERSION } from '../../../packages/vector/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compilePackage } from './compile-package.mjs';
import { toPackageInputs, validateAssignment } from './references/assign.mjs';
import { applyCast } from './characters/build.mjs';
import { inlineGeneratedAssets } from '../../renderer/scripts/render-package-lib.mjs';

export function chatProjectResponse(pkg, runtimeDir) {
  return {
    package: pkg, revision: pkg.revision, timeline: compilePackage(pkg, join(runtimeDir, 'packages')),
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


// R13: confirmed reference assignments become ordinary package assets, so the
// jobs planner and both Comfy backends need no reference-specific code. The
// helper is deliberately tolerance-first: an assignment whose scene or
// reference disappeared is skipped and noted, never applied half-way.
const REFERENCE_SLOTS = ['style_reference', 'subject_reference', 'start_frame', 'background_plate', 'logo_overlay', 'motion_reference'];
const KLEIN_SLOT_CAP = 10;
const TEXT_CAP = 1000;

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function capText(value, max = TEXT_CAP) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function confirmedOnly(assignments) {
  return asList(assignments).filter(assignment => assignment && typeof assignment === 'object'
    && (assignment.status === undefined || assignment.status === null || assignment.status === 'confirmed'));
}

function referenceState(references) {
  if (!references || typeof references !== 'object') return null;
  const refs = typeof references.list === 'function'
    ? references.list()
    : typeof references.refs === 'function' ? references.refs() : references.refs ?? references.references ?? [];
  const assignments = typeof references.assignments === 'function'
    ? references.assignments()
    : references.assignments ?? [];
  return {
    source: references,
    refs: asList(refs).filter(ref => ref && typeof ref === 'object'),
    assignments: asList(assignments).filter(assignment => assignment && typeof assignment === 'object'),
  };
}

function sceneAssetIds(scene) {
  const ids = [];
  if (typeof scene?.background?.asset === 'string') ids.push(scene.background.asset);
  for (const item of Array.isArray(scene?.foreground) ? scene.foreground : []) {
    if (typeof item?.asset === 'string') ids.push(item.asset);
  }
  for (const plate of Array.isArray(scene?.media) ? scene.media : []) {
    if (typeof plate?.asset === 'string') ids.push(plate.asset);
  }
  return [...new Set(ids)];
}

function generatedAssetsFor(assets, scene, slot) {
  const ids = sceneAssetIds(scene).filter(id => {
    const asset = assets?.[id];
    return asset?.origin === 'generated' && typeof asset.gen?.generator === 'string';
  });
  if (slot === 'style_reference' || slot === 'subject_reference') {
    return ids.filter(id => assets[id].gen.generator === 'flux3-klein');
  }
  if (slot === 'start_frame' || slot === 'motion_reference') {
    const plates = ids.filter(id => assets[id].gen.generator === 'ltx25' || assets[id].gen.generator === 'ltx25-a2v');
    return plates.length ? plates : ids.filter(id => assets[id].gen.generator === 'flux3-klein');
  }
  return ids;
}

function referenceInputList(inputs) {
  const refs = [];
  if (typeof inputs.reference === 'string' && inputs.reference) refs.push(inputs.reference);
  for (let index = 2; index <= KLEIN_SLOT_CAP; index += 1) {
    const value = inputs[`reference_${index}`] ?? inputs[`_reference_${index}`];
    if (typeof value === 'string' && value) refs.push(value);
  }
  return refs;
}

function writeReferenceInputList(inputs, refs) {
  delete inputs.reference;
  for (let index = 2; index <= KLEIN_SLOT_CAP; index += 1) {
    delete inputs[`reference_${index}`];
    delete inputs[`_reference_${index}`];
  }
  refs.slice(0, KLEIN_SLOT_CAP).forEach((refId, index) => {
    if (index === 0) inputs.reference = refId;
    else inputs[`reference_${index + 1}`] = refId;
  });
}

function assetIdFromFile(file) {
  return basename(file ?? '').replace(/\.[^.]+$/, '');
}

function frameFor(ref, index) {
  const frames = Array.isArray(ref?.frames) ? ref.frames : [];
  return frames.find(frame => Number(frame?.index) === index) ?? frames[index] ?? null;
}

function selectedFrameIndex(assignment, ref) {
  if (ref?.kind !== 'video') return undefined;
  return assignment.slot === 'motion_reference' ? 0 : (assignment.frameIndex ?? 0);
}

function referenceSourceFile(references, ref, frameIndex) {
  if (typeof references?.sourcePath === 'function') return references.sourcePath(ref, frameIndex);
  const dir = references?.dir;
  const filesDir = references?.filesDir ?? (dir ? join(dir, 'files') : undefined);
  const framesDir = references?.framesDir ?? (dir ? join(dir, 'frames') : undefined);

  if (frameIndex !== undefined) {
    const frame = frameFor(ref, frameIndex);
    if (typeof frame?.file === 'string' && frame.file) {
      if (isAbsolute(frame.file)) return frame.file;
      return dir ? join(dir, frame.file) : frame.file;
    }
    if (framesDir) return join(framesDir, ref.id, `${frameIndex}.png`);
    throw new Error(`reference ${ref.id} frame ${frameIndex} has no readable file`);
  }

  if (typeof ref.file === 'string' && isAbsolute(ref.file)) return ref.file;
  if (filesDir && typeof ref.file === 'string' && ref.file) return join(filesDir, basename(ref.file));
  if (typeof ref.file === 'string' && ref.file) return ref.file;
  throw new Error(`reference ${ref.id} has no readable file`);
}

function readReferenceBytes(references, sourceFile) {
  const reader = references?.readFile ?? references?.readFileSync ?? references?.fs?.readFileSync;
  if (typeof reader === 'function') return reader(sourceFile);
  return readFileSync(sourceFile);
}

function appliedReferenceAsset(draft, result) {
  const assetId = assetIdFromFile(result.packageAsset.file);
  draft.assets[assetId] = structuredClone(result.packageAsset);
  return assetId;
}

function applyReferenceAssignment(draft, assignment, ref, result, sceneHasStartFrame) {
  const scene = draft.scenes.find(candidate => candidate.id === assignment.sceneId);
  if (!scene) return null;
  const assetId = appliedReferenceAsset(draft, result);

  if (assignment.slot === 'style_reference' || assignment.slot === 'subject_reference') {
    for (const targetId of generatedAssetsFor(draft.assets, scene, assignment.slot)) {
      const asset = draft.assets[targetId];
      asset.gen ??= {};
      asset.gen.inputs = { ...(asset.gen.inputs ?? {}) };
      const refs = referenceInputList(asset.gen.inputs);
      if (!refs.includes(assetId)) {
        if (refs.length >= KLEIN_SLOT_CAP) continue;
        if (assignment.slot === 'style_reference') refs.unshift(assetId);
        else refs.push(assetId);
      }
      writeReferenceInputList(asset.gen.inputs, refs);
    }
  } else if (assignment.slot === 'start_frame') {
    for (const targetId of generatedAssetsFor(draft.assets, scene, 'start_frame')) {
      const asset = draft.assets[targetId];
      asset.gen ??= {};
      asset.gen.inputs = { ...(asset.gen.inputs ?? {}), image: assetId };
    }
  } else if (assignment.slot === 'motion_reference') {
    for (const targetId of generatedAssetsFor(draft.assets, scene, 'motion_reference')) {
      const asset = draft.assets[targetId];
      asset.gen ??= {};
      const inputs = { ...(asset.gen.inputs ?? {}) };
      if (result.promptHint) {
        inputs.prompt = typeof inputs.prompt === 'string' && inputs.prompt.trim()
          ? `${inputs.prompt.trimEnd()}\n\n${result.promptHint}`
          : result.promptHint;
      }
      if (!sceneHasStartFrame && !inputs.image) inputs.image = assetId;
      asset.gen.inputs = inputs;
    }
  } else if (assignment.slot === 'background_plate') {
    const fit = scene.background?.fit;
    scene.background = { ...(fit ? { fit } : {}), asset: assetId };
  } else if (assignment.slot === 'logo_overlay') {
    draft.theme ??= {};
    draft.theme.logo_asset = assetId;
  }
  return assetId;
}

function referenceSidecar({ pkg, used, skipped }) {
  const notes = new Map();
  for (const entry of used) {
    if (notes.has(entry.ref.id)) continue;
    notes.set(entry.ref.id, {
      refId: entry.ref.id,
      label: capText(entry.ref.label, 80),
      kind: entry.ref.kind,
      role: entry.ref.role ?? 'other',
      note: capText(entry.ref.note, TEXT_CAP),
    });
  }
  return {
    schema: 'comfyrizz.references/v1',
    packageId: pkg.id,
    packageRevision: pkg.revision,
    assignments: used.map(entry => ({
      ...(entry.assignment.id ? { id: entry.assignment.id } : {}),
      refId: entry.ref.id,
      sceneId: entry.assignment.sceneId,
      slot: entry.assignment.slot,
      ...(entry.assignment.frameIndex !== undefined ? { frameIndex: entry.assignment.frameIndex } : {}),
      status: 'confirmed',
      ...(entry.assignment.reason ? { reason: capText(entry.assignment.reason, 512) } : {}),
      assetId: entry.assetId,
      assetFile: entry.result.packageAsset.file,
      ...(entry.result.promptHint ? { promptHint: capText(entry.result.promptHint, 1200) } : {}),
    })),
    notes: [...notes.values()],
    ...(skipped.length ? { skipped } : {}),
  };
}

function applyReferenceAssignments({ draft, references, runtimeDir }) {
  const state = referenceState(references);
  if (!state) return null;
  const confirmed = confirmedOnly(state.assignments);
  if (!confirmed.length) return null;

  const refs = new Map(state.refs.map(ref => [ref.id, ref]));
  const scenes = draft.scenes.map(scene => ({ id: scene.id }));
  const ordered = confirmed
    .map((assignment, index) => ({ assignment, index }))
    .sort((left, right) => {
      const a = REFERENCE_SLOTS.indexOf(left.assignment.slot);
      const b = REFERENCE_SLOTS.indexOf(right.assignment.slot);
      return (a === -1 ? REFERENCE_SLOTS.length : a) - (b === -1 ? REFERENCE_SLOTS.length : b) || left.index - right.index;
    })
    .map(entry => entry.assignment);

  const startFrameScenes = new Set(ordered
    .filter(assignment => assignment.slot === 'start_frame')
    .map(assignment => assignment.sceneId));
  const used = [];
  const skipped = [];
  const assetsDir = join(runtimeDir, 'packages', 'assets');
  mkdirSync(assetsDir, { recursive: true });

  for (const assignment of ordered) {
    const ref = refs.get(assignment.refId);
    if (!ref) {
      skipped.push({ refId: assignment.refId, sceneId: assignment.sceneId, slot: assignment.slot, reason: 'unknown reference' });
      continue;
    }
    if (!scenes.some(scene => scene.id === assignment.sceneId)) {
      skipped.push({ refId: assignment.refId, sceneId: assignment.sceneId, slot: assignment.slot, reason: 'unknown scene' });
      continue;
    }
    try {
      const validated = validateAssignment(assignment, { refs: state.refs, scenes, assignments: confirmed });
      const applied = {
        ...validated,
        ...(typeof assignment.id === 'string' && assignment.id ? { id: assignment.id } : {}),
        ...(typeof assignment.reason === 'string' && assignment.reason.trim() ? { reason: assignment.reason.trim() } : {}),
      };
      const result = toPackageInputs(applied, ref);
      const frameIndex = selectedFrameIndex(applied, ref);
      const sourceFile = referenceSourceFile(state.source, ref, frameIndex);
      const bytes = readReferenceBytes(state.source, sourceFile);
      writeFileSync(join(assetsDir, basename(result.packageAsset.file)), bytes, { mode: 0o600 });
      const assetId = applyReferenceAssignment(draft, applied, ref, result, startFrameScenes.has(applied.sceneId));
      if (assetId) used.push({ assignment: applied, ref, result, assetId });
    } catch (error) {
      skipped.push({
        refId: assignment.refId,
        sceneId: assignment.sceneId,
        slot: assignment.slot,
        reason: capText(error?.message ?? 'reference could not be applied', 512),
      });
    }
  }

  if (!used.length) return null;
  const sidecar = referenceSidecar({ pkg: draft, used, skipped });
  const sidecarPath = join(runtimeDir, 'packages', 'references.json');
  const temp = `${sidecarPath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, sidecarPath);
  return sidecar;
}

// CC14: project cast snapshots become ordinary package assets through applyCast.
// The state is deliberately tolerant like references: an entry that cannot be
// built is reported in characters.json rather than failing the whole project.
function characterBuildState(characters) {
  if (!characters || typeof characters !== 'object') return null;
  const cast = Array.isArray(characters)
    ? characters
    : characters.cast ?? characters.entries ?? characters.projectCast;
  if (!Array.isArray(cast) || !cast.length) return null;
  const placements = Array.isArray(characters)
    ? []
    : characters.placements ?? characters.castPlacements ?? [];
  const files = Array.isArray(characters)
    ? {}
    : characters.files ?? characters.characterFiles ?? {};
  const options = Array.isArray(characters) || !characters.options || typeof characters.options !== 'object'
    ? {}
    : characters.options;
  return {
    cast,
    placements: Array.isArray(placements) ? placements : [],
    files: files && typeof files === 'object' ? files : {},
    options,
  };
}

function writeCharacterCopy(copy, assetsDir) {
  const destination = join(assetsDir, basename(copy?.to ?? ''));
  if (!destination || destination === assetsDir) return false;
  let bytes = copy?.bytes;
  if (bytes === undefined || bytes === null) {
    const source = copy?.from;
    if (typeof source !== 'string' || !source) return false;
    try {
      bytes = readFileSync(source);
    } catch {
      return false;
    }
  }
  writeFileSync(destination, bytes, { mode: 0o600 });
  return true;
}

function applyCharacterBuild({ draft, characters, runtimeDir }) {
  const state = characterBuildState(characters);
  if (!state) return null;
  let result;
  try {
    result = applyCast(draft, state.cast, state.placements, state.files, state.options);
  } catch (error) {
    throw new Error(`Character cast could not be applied: ${error?.message ?? 'invalid cast'}`);
  }
  const assetsDir = join(runtimeDir, 'packages', 'assets');
  mkdirSync(assetsDir, { recursive: true });
  for (const copy of Array.isArray(result.copies) ? result.copies : []) {
    writeCharacterCopy(copy, assetsDir);
  }
  const sidecarPath = join(runtimeDir, 'packages', 'characters.json');
  const temp = `${sidecarPath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(result.characters, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, sidecarPath);
  return result;
}

const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };
const DEFAULT_TRANSITION = { type: 'fade', frames: 12 };

/** Compile model-authored content, merging revisions into the current project. */
export async function buildChatProject({ plan: rawPlan, previous, previousPlan, brand, runtimeDir, signal, references, characters, cast, placements, characterFiles }) {
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
  const naturalTimeline = compilePackage({ ...pkg, duration: { mode: 'flexible' } }, join(runtimeDir, 'packages'));
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
  applyReferenceAssignments({ draft, references, runtimeDir });
  signal?.throwIfAborted();
  const characterState = characters ?? (cast ? { cast, placements, files: characterFiles } : null);
  const castResult = applyCharacterBuild({ draft, characters: characterState, runtimeDir });
  if (castResult?.pkg) draft = castResult.pkg;
  signal?.throwIfAborted();
  const validation = validatePackage(draft);
  if (!validation.valid) throw new Error(`Project validation failed: ${validation.errors.slice(0, 5).map(error => `${error.path}: ${error.message}`).join('; ')}`);
  compilePackage(draft, join(runtimeDir, 'packages'));
  return draft;
}
