// CCL1a: a turnaround-sheet prompt preset for the Klein reference-edit graph.
//
// A sheet is one still, not a new pipeline: the character's primary image is the
// reference, the prompt asks for front / three-quarter / side / back views plus
// expression studies, and the request goes through the same Colab spend approval
// as any other run. Nothing here talks to the network or the filesystem; the
// caller resolves the image id to a file and posts these params.
import { createHash } from 'node:crypto';
import { cacheKeyFor } from '../../../../packages/jobs/src/index.mjs';
import { planHashFor } from '../run.mjs';
import { makeCharacter, primaryImage } from './model.mjs';
import {
  REF_EDIT_WORKFLOW,
  REF_EDIT_WORKFLOW_SHA256,
  CHARACTER_ASSET_PREFIX,
} from './build.mjs';

export const SHEET_WORKFLOW = REF_EDIT_WORKFLOW;
export const SHEET_WORKFLOW_SHA256 = REF_EDIT_WORKFLOW_SHA256;
export const SHEET_GENERATOR = 'flux3-klein';
export const SHEET_MODEL = 'flux-3-image-klein';
export const SHEET_KIND = 'character_sheet';
export const SHEET_BACKEND_ID = 'colab';
export const SHEET_DEFAULT_BUDGET_UNITS = 100;
export const SHEET_MEGAPIXELS = 1;
export const SHEET_STEPS = 16;
export const SHEET_DENOISE = 1;
export const SHEET_PROMPT_VERSION = 'turnaround/v1';
export const SHEET_OUTPUT_KIND = 'image';

export const SHEET_DEFAULT_NEGATIVE = [
  'no text',
  'no labels',
  'no captions',
  'no watermark',
  'no signature',
  'no extra characters',
  'no cropped head',
  'no cropped feet',
  'no different outfit between views',
  'no different character between views',
  'no perspective distortion',
].join(', ');

// Aliases keep the names discoverable from either side of the feature.
export const WORKFLOW = SHEET_WORKFLOW;
export const WORKFLOW_SHA256 = SHEET_WORKFLOW_SHA256;

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class SheetError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'SheetError';
    this.code = code;
    this.field = field;
    this.path = field;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new SheetError(code, field, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function uniqueClauses(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const text = part.trim().replace(/[.;]+$/, '');
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function defaultWardrobe(visual) {
  const wardrobe = Array.isArray(visual?.wardrobe) ? visual.wardrobe : [];
  return wardrobe.find((item) => item && item.default === true) ?? null;
}

function expressionLabels(visual) {
  const expressions = Array.isArray(visual?.expressions) ? visual.expressions : [];
  const labels = [];
  for (const expression of expressions) {
    if (!expression) continue;
    const label = typeof expression.label === 'string' && expression.label.trim()
      ? expression.label.trim()
      : (typeof expression.prompt === 'string' ? expression.prompt.trim() : '');
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= 4) break;
  }
  return labels;
}

function identityText(character) {
  const visual = character.visual ?? {};
  if (typeof visual.identityPrompt === 'string' && visual.identityPrompt.trim()) {
    return visual.identityPrompt.trim();
  }
  if (typeof character.summary === 'string' && character.summary.trim()) {
    return character.summary.trim();
  }
  return `a fictional ${character.role}`;
}

export function buildSheetPrompt(character) {
  const snapshot = makeCharacter(character, { now: () => '1970-01-01T00:00:00.000Z' });
  const visual = snapshot.visual ?? {};
  const wardrobe = defaultWardrobe(visual);
  const expressions = expressionLabels(visual);
  const palette = Array.isArray(visual.palette) ? visual.palette : [];

  const parts = [
    `Character turnaround sheet and model sheet of ${snapshot.name}: ${identityText(snapshot)}.`,
    'A single composite reference sheet on a neutral light grey background.',
    'Views left to right: front view, three-quarter view, side view and back view, full body.',
    'The same character in every view with identical height, build, face, markings, colours and outfit.',
    wardrobe?.prompt ? `Outfit in every view: ${wardrobe.prompt}.` : 'The same outfit in every view.',
    'Relaxed A-pose with arms slightly away from the body.',
    'Soft, even studio lighting, flat orthographic camera, no perspective distortion.',
  ];
  if (expressions.length) {
    parts.push(`Expression studies along the bottom: ${expressions.join(', ')}.`);
  } else {
    parts.push('Expression studies along the bottom: neutral, happy, surprised and thoughtful.');
  }
  if (palette.length) {
    parts.push(`Palette: ${palette.join(', ')}.`);
  }
  parts.push('Keep the silhouette and proportions consistent across all views.');
  return parts.join(' ');
}

function combinedNegative(character) {
  const visual = character.visual ?? {};
  return uniqueClauses([
    ...String(visual.negative ?? '').split(','),
    ...SHEET_DEFAULT_NEGATIVE.split(','),
  ]).join(', ');
}

export function promptWithNegative(prompt, negative) {
  const base = typeof prompt === 'string' ? prompt.trim() : '';
  const clause = typeof negative === 'string' ? negative.trim() : '';
  if (!clause) return base;
  if (/negative:/i.test(base)) return base;
  return `${base} Negative: ${clause}.`;
}

function seedFrom(character, requested) {
  if (requested !== undefined && requested !== null) {
    if (!Number.isSafeInteger(requested) || requested < 0) {
      fail('SHEET_INVALID_SEED', 'seed', 'seed must be a non-negative integer');
    }
    return requested;
  }
  const visual = character.visual ?? {};
  if (Number.isSafeInteger(visual.seed) && visual.seed >= 0) return visual.seed;
  if (Number.isSafeInteger(visual.sheet?.genSeed) && visual.sheet.genSeed >= 0) {
    return visual.sheet.genSeed;
  }
  return createHash('sha256')
    .update(`${character.id}\u0000${character.revision}\u0000${SHEET_PROMPT_VERSION}`)
    .digest()
    .readUInt32BE(0);
}

function positiveNumber(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('SHEET_INVALID_OPTION', field, `${field} must be a positive number`);
  }
  return value;
}

function integerOption(value, field, fallback, { min = 1 } = {}) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    fail('SHEET_INVALID_OPTION', field, `${field} must be an integer of at least ${min}`);
  }
  return value;
}

function budgetUnitsValue(value) {
  if (value === undefined || value === null) return SHEET_DEFAULT_BUDGET_UNITS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('SHEET_INVALID_OPTION', 'budgetUnits', 'budgetUnits must be a non-negative number');
  }
  return value;
}

function backendIdValue(value) {
  if (value === undefined || value === null) return SHEET_BACKEND_ID;
  if (typeof value !== 'string' || value.trim() === '' || CONTROL_RE.test(value)) {
    fail('SHEET_INVALID_OPTION', 'backendId', 'backendId must be a non-empty string');
  }
  return value.trim();
}

function relativePath(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '' || CONTROL_RE.test(value)) {
    fail('SHEET_INVALID_OPTION', field, `${field} must be a relative path`);
  }
  const text = value.trim().replace(/\\/g, '/');
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.split('/').includes('..')) {
    fail('SHEET_INVALID_OPTION', field, `${field} must be a relative path`);
  }
  return text;
}

function primaryImageOf(character) {
  const image = primaryImage(character);
  if (!image) {
    fail(
      'SHEET_NO_PRIMARY_IMAGE',
      'visual.images',
      'a turnaround sheet needs a primary character image to edit from',
    );
  }
  return image;
}

function assetIdFor(character) {
  return `${CHARACTER_ASSET_PREFIX}sheet_${character.id.slice('chr_'.length)}`;
}

/**
 * Build the ref_edit request for a character turnaround sheet.
 *
 * Pure: same character and options always produce the same job, params, cache
 * key and plan hash. The primary image is passed by imgId, because the caller
 * owns the image file; pass `referencePath` when the job is sent to a runner.
 *
 * @param {object} character a `comfyrizz.character/v1` record
 * @param {object} [options]
 * @param {number} [options.seed] override the character's locked seed
 * @param {number} [options.steps]
 * @param {number} [options.denoise]
 * @param {number} [options.megapixels]
 * @param {number} [options.budgetUnits]
 * @param {string} [options.backendId]
 * @param {string} [options.referencePath] relative path staged next to jobs.json
 * @returns {object} frozen job params plus the approval card fields
 */
export function buildSheetJob(character, options = {}) {
  const snapshot = makeCharacter(character, { now: () => '1970-01-01T00:00:00.000Z' });
  if (!isObject(options)) fail('SHEET_INVALID_OPTION', 'options', 'options must be an object');
  const image = primaryImageOf(snapshot);
  const seed = seedFrom(snapshot, options.seed);
  const steps = integerOption(options.steps, 'steps', SHEET_STEPS);
  const denoise = positiveNumber(options.denoise, 'denoise', SHEET_DENOISE);
  if (denoise > 1) fail('SHEET_INVALID_OPTION', 'denoise', 'denoise must be between 0 and 1');
  const megapixels = positiveNumber(options.megapixels, 'megapixels', SHEET_MEGAPIXELS);
  const budgetUnits = budgetUnitsValue(options.budgetUnits);
  const backendId = backendIdValue(options.backendId);
  const referencePath = relativePath(
    options.referencePath ?? options.imagePath,
    'referencePath',
  );

  const prompt = promptWithNegative(buildSheetPrompt(snapshot), combinedNegative(snapshot));
  const params = {
    prompt,
    reference: image.imgId,
    seed,
    steps,
    denoise,
    megapixels,
  };
  const assetId = assetIdFor(snapshot);
  const job = {
    id: `${assetId}.still`,
    kind: 'still',
    batch: 'stills',
    asset: assetId,
    scene: null,
    sceneIndex: null,
    generator: SHEET_GENERATOR,
    workflow: SHEET_WORKFLOW,
    workflowSha256: SHEET_WORKFLOW_SHA256,
    model: SHEET_MODEL,
    modelRevision: null,
    deps: [],
    output: `assets/${assetId}.png`,
    outputKind: SHEET_OUTPUT_KIND,
    params,
    seed,
    cacheKey: cacheKeyFor({
      workflowSha256: SHEET_WORKFLOW_SHA256,
      generator: SHEET_GENERATOR,
      model: SHEET_MODEL,
      modelRevision: null,
      params,
      seed,
      width: null,
      height: null,
      frames: null,
    }),
    ...(referencePath
      ? { fileInputs: [{ param: 'reference', from: 'package', path: referencePath }] }
      : {}),
  };
  const jobs = [job];
  const planHash = planHashFor({ backendId, jobs, budgetUnits });
  const approval = {
    kind: 'approval_required',
    required: true,
    approvalRequired: true,
    requiresApproval: true,
    approved: false,
    backendId,
    budgetUnits,
    planHash,
    reason: 'Generating a turnaround sheet is a paid Colab run and needs plan approval.',
  };
  const primary = {
    imgId: image.imgId,
    sha256: image.sha256,
    view: image.view,
    width: image.width,
    height: image.height,
    source: image.source,
  };

  return deepFreeze({
    ok: true,
    kind: SHEET_KIND,
    version: SHEET_PROMPT_VERSION,
    characterId: snapshot.id,
    revision: snapshot.revision,
    workflow: SHEET_WORKFLOW,
    workflowSha256: SHEET_WORKFLOW_SHA256,
    workflow_sha256: SHEET_WORKFLOW_SHA256,
    generator: SHEET_GENERATOR,
    model: SHEET_MODEL,
    assetId,
    seed,
    prompt,
    negative: combinedNegative(snapshot),
    params,
    jobParams: params,
    reference: image.imgId,
    primary,
    image: primary,
    job,
    jobs,
    backend: { id: backendId },
    backendId,
    budgetUnits,
    planHash,
    approvalRequired: true,
    requiresApproval: true,
    approved: false,
    approval,
  });
}

export const buildSheet = buildSheetJob;
export const sheetPrompt = buildSheetPrompt;
export const makeSheetJob = buildSheetJob;
