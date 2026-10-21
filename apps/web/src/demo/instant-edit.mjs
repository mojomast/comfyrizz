/**
 * T09: instant preview edits that never touch a GPU or the server.
 *
 * `applyInstantEdit` patches the package and the compiled timeline in memory,
 * then reports the scene ids that actually changed so the caller can mark only
 * those scenes stale. Both arguments are treated as immutable and the original
 * objects are never modified.
 */

const TEXT_FIELDS = new Map([
  ['headline', 'headline'],
  ['subhead', 'sub'],
  ['caption', 'footnote'],
]);

const PALETTE_ROLES = new Map([
  ['background', 0],
  ['bg', 0],
  ['base', 0],
  ['canvas', 0],
  ['backdrop', 0],
  ['surface', 1],
  ['panel', 1],
  ['secondary', 1],
  ['accent', 2],
  ['highlight', 2],
  ['primary', 2],
  ['text', 3],
  ['foreground', 3],
  ['fg', 3],
]);

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function sceneList(document) {
  return Array.isArray(document?.scenes) ? document.scenes : [];
}

function findScene(document, sceneId) {
  return sceneList(document).find(scene => scene?.id === sceneId) ?? null;
}

function sceneIdOf(edit) {
  const sceneId = edit?.sceneId;
  if (typeof sceneId !== 'string' || sceneId.trim() === '') {
    throw new Error('Instant edit needs a sceneId');
  }
  return sceneId;
}

function requireScene(pkg, timeline, sceneId) {
  const pkgScene = findScene(pkg, sceneId);
  const timelineScene = findScene(timeline, sceneId);
  if (!pkgScene && !timelineScene) throw new Error(`Unknown scene: ${sceneId}`);
  return { pkgScene, timelineScene };
}

function setCopyField(scene, field, value) {
  if (!scene) return false;
  const copy = isRecord(scene.copy) ? scene.copy : {};
  if (copy[field] === value) return false;
  scene.copy = { ...copy, [field]: value };
  return true;
}

function applyText(pkg, timeline, edit, sceneId) {
  const field = edit.field;
  const copyField = TEXT_FIELDS.get(field);
  if (!copyField) throw new Error(`Unknown text field: ${String(field)}`);
  if (typeof edit.value !== 'string') throw new Error(`Text value for ${field} must be a string`);

  const { pkgScene, timelineScene } = requireScene(pkg, timeline, sceneId);
  let changed = setCopyField(pkgScene, copyField, edit.value);
  changed = setCopyField(timelineScene, copyField, edit.value) || changed;
  return changed;
}

function parseChartValue(value) {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new Error('Chart value must be a finite number');
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error('Chart value must be a finite number');
}

function applyChart(pkg, timeline, edit, sceneId) {
  const { pkgScene, timelineScene } = requireScene(pkg, timeline, sceneId);
  const datasetId = pkgScene?.data?.dataset ?? timelineScene?.data?.dataset;
  if (typeof datasetId !== 'string' || datasetId === '') {
    throw new Error(`Scene ${sceneId} has no chart dataset`);
  }

  const dataset = isRecord(pkg.datasets) ? pkg.datasets[datasetId] : null;
  if (!isRecord(dataset) || !Array.isArray(dataset.values)) {
    throw new Error(`Unknown dataset for scene ${sceneId}: ${datasetId}`);
  }

  const index = edit.index;
  if (!Number.isInteger(index) || index < 0 || index >= dataset.values.length) {
    throw new Error(`Unknown chart index ${String(index)} for scene ${sceneId}`);
  }

  const value = parseChartValue(edit.value);
  let changed = false;

  const point = isRecord(dataset.values[index]) ? dataset.values[index] : {};
  if (point.value !== value) changed = true;
  dataset.values[index] = { ...point, value };

  const timelineData = timelineScene?.data;
  if (isRecord(timelineData) && Array.isArray(timelineData.values) && isRecord(timelineData.values[index])) {
    if (timelineData.values[index].value !== value) changed = true;
    timelineData.values[index] = { ...timelineData.values[index], value };
  }

  return changed;
}

function paletteRole(role) {
  if (typeof role === 'number' && Number.isInteger(role) && role >= 0) return role;
  if (typeof role !== 'string') return null;
  const token = role.trim().toLowerCase();
  if (!token) return null;
  if (/^\d+$/.test(token)) return Number(token);
  const match = /^(?:palette|colour|color|role)(?:\[|\.|_|-)?(\d+)\]?$/.exec(token);
  if (match) return Number(match[1]);
  return PALETTE_ROLES.get(token) ?? null;
}

function ensurePalette(scene, pkg) {
  const background = isRecord(scene.background) ? scene.background : null;
  const procedural = isRecord(background?.procedural) ? background.procedural : null;
  if (!procedural) throw new Error(`Scene ${scene.id} has no colour palette`);

  if (!Array.isArray(procedural.palette)) {
    const themePalette = Array.isArray(pkg.theme?.palette) ? pkg.theme.palette.filter(hex => typeof hex === 'string') : [];
    procedural.palette = themePalette.length > 0
      ? themePalette.slice()
      : ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'];
  }
  return procedural.palette;
}

function applyColour(pkg, timeline, edit, sceneId) {
  const hex = edit.hex;
  if (typeof hex !== 'string' || !HEX_COLOUR.test(hex)) {
    throw new Error(`Invalid hex colour: ${String(hex)}`);
  }

  const { pkgScene, timelineScene } = requireScene(pkg, timeline, sceneId);
  const index = paletteRole(edit.role);
  if (index === null) throw new Error(`Unknown colour role: ${String(edit.role)}`);

  let changed = false;
  for (const scene of [pkgScene, timelineScene]) {
    if (!scene) continue;
    const palette = ensurePalette(scene, pkg);
    while (palette.length <= index) palette.push('#000000');
    if (palette[index] !== hex) changed = true;
    palette[index] = hex;
  }

  return changed;
}

/**
 * Apply one in-memory edit and return the patched documents.
 *
 * @param {object} pkg a `comfyrizz.package` object (never mutated)
 * @param {object} timeline a compiled timeline object (never mutated)
 * @param {object} edit one of:
 *   `{kind:'text', sceneId, field:'headline'|'subhead'|'caption', value}`,
 *   `{kind:'chart', sceneId, index, value}` or
 *   `{kind:'colour', sceneId, role, hex}`
 * @returns {{pkg: object, timeline: object, changedScenes: string[]}}
 */
export function applyInstantEdit(pkg, timeline, edit) {
  if (!isRecord(pkg)) throw new Error('applyInstantEdit needs a package object');
  if (!isRecord(timeline)) throw new Error('applyInstantEdit needs a timeline object');
  if (!isRecord(edit)) throw new Error('applyInstantEdit needs an edit object');

  const sceneId = sceneIdOf(edit);
  const nextPkg = clone(pkg);
  const nextTimeline = clone(timeline);

  let changed;
  switch (edit.kind) {
    case 'text':
      changed = applyText(nextPkg, nextTimeline, edit, sceneId);
      break;
    case 'chart':
      changed = applyChart(nextPkg, nextTimeline, edit, sceneId);
      break;
    case 'colour':
      changed = applyColour(nextPkg, nextTimeline, edit, sceneId);
      break;
    default:
      throw new Error(`Unknown edit kind: ${String(edit.kind)}`);
  }

  return {
    pkg: nextPkg,
    timeline: nextTimeline,
    changedScenes: changed ? [sceneId] : [],
  };
}
