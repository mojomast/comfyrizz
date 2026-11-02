import { refGateOpen } from '../../../../packages/schema/src/ref-review.mjs';

export const SUBJECT_CUTOUT_PURPOSES = Object.freeze(['title', 'composite']);
export const SUBJECT_CUTOUT_GENERATOR = 'birefnet';
export const SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW = 'workflows/birefnet_image_transparent.api.json';
export const SUBJECT_CUTOUT_SOLID_WORKFLOW = 'workflows/birefnet_image_solid.api.json';
export const SUBJECT_CUTOUT_OUTPUT_SUFFIX = '.cutout.png';

function fail(message) {
  throw new Error(`Subject cutout: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stillIdOf(still) {
  return typeof still?.id === 'string' && still.id.trim() ? still.id.trim() : null;
}

function colourOf(background) {
  if (background === undefined || background === null || background === '') return null;
  if (Number.isInteger(background) && background >= 0 && background <= 0xffffff) return background;
  if (typeof background !== 'string') fail('background must be an RGB colour');
  const text = background.trim();
  const match = /^(?:#|0x)?([0-9a-f]{6})$/i.exec(text);
  if (!match) fail('background must be a #RRGGBB colour or a 0xRRGGBB number');
  return Number.parseInt(match[1], 16);
}

export function planSubjectCutout({ still, purpose = 'title', background } = {}) {
  if (!isObject(still)) fail('still is required');
  const stillId = stillIdOf(still);
  if (!stillId) fail('still needs an id');
  const state = still.status;
  if (!refGateOpen(state)) {
    fail(`still must be accepted or overridden by ref-watch, got ${JSON.stringify(state ?? null)}`);
  }
  if (!SUBJECT_CUTOUT_PURPOSES.includes(purpose)) {
    fail(`purpose must be one of ${SUBJECT_CUTOUT_PURPOSES.join('|')}`);
  }

  const colour = colourOf(background);
  const transparent = colour === null;
  const params = { image: stillId, ...(transparent ? {} : { colour }) };

  return {
    id: `${stillId}.cutout`,
    kind: 'cutout',
    purpose,
    generator: SUBJECT_CUTOUT_GENERATOR,
    workflow: transparent ? SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW : SUBJECT_CUTOUT_SOLID_WORKFLOW,
    inputs: { ...params },
    params,
    deps: [stillId],
    output: `${stillId}${SUBJECT_CUTOUT_OUTPUT_SUFFIX}`,
  };
}

export function cutoutLayer({ cutout, titleLayer } = {}) {
  if (!isObject(cutout)) fail('cutout layer is required');
  if (!isObject(titleLayer)) fail('titleLayer is required');
  const candidate = titleLayer.background;
  const background = isObject(candidate) ? candidate : { role: 'background', kind: 'plate' };
  return [background, titleLayer, cutout];
}
