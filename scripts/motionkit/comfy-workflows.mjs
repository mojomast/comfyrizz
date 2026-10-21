import { readFile as fsReadFile } from 'node:fs/promises';

export const MANIFEST_SCHEMA = 'comfyrizz.comfy-workflows/v1';

export const VENDORABLE_LICENSES = Object.freeze(['MIT', 'ISC', 'CC0-1.0', 'OFL-1.1']);

export const REQUIRED_ITEM_FIELDS = Object.freeze([
  'id', 'purpose', 'model', 'codeLicense', 'weightsLicense', 'runtimeOnly', 'vendor', 'source', 'notes',
]);

export const REQUIRED_CATEGORIES = Object.freeze([
  'interpolation', 'depth-parallax', 'upscale', 'motion-control', 'recipe-prompt',
]);

export const RECIPE_IDS = Object.freeze([
  'swiss-grid', 'editorial-serif', 'neo-brutalist', 'kinetic-poster', 'bauhaus-play', 'mono-terminal',
  'blueprint', 'isometric-saas', 'glassmorphism', 'clay-soft', 'paper-collage', 'risograph',
  'cinematic-noir', 'film-35mm', 'vhs-retro', 'crt-arcade', 'y2k-chrome', 'synthwave',
  'vaporwave', 'organic-hand', 'data-journalism', 'luxury-minimal', 'neon-cyber', 'documentary-archive',
]);

const DEFAULT_MANIFEST_URL = new URL('./data/comfy-workflows.json', import.meta.url);
const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LTX_2_PATTERN = /ltx[-_ ]?2/i;
const SECRET_PATTERN = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\b(?:hf|ghp|gho|ghu|ghs|glpat|xoxb|xoxp)_[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._-]{16,}|\beyJ[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const FORBIDDEN_TEXT = Object.freeze([
  { pattern: /colab/i, message: 'Google Colab references do not belong in this data-only manifest' },
  { pattern: /notebook/i, message: 'notebook wiring does not belong in this data-only manifest' },
  { pattern: /http:\/\//i, message: 'plain http URLs are not allowed; use https' },
  { pattern: SECRET_PATTERN, message: 'value looks like a secret and must not appear in the manifest' },
]);
const TEXT_FIELDS = Object.freeze(['id', 'category', 'purpose', 'model', 'codeLicense', 'weightsLicense', 'source', 'notes']);

export function isVendorable(license) {
  return typeof license === 'string' && VENDORABLE_LICENSES.includes(license.trim());
}

export function looksLikeSecret(text) {
  return typeof text === 'string' && SECRET_PATTERN.test(text);
}

export function getItemsByCategory(manifest, category) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.items)) return [];
  return manifest.items.filter((item) => isPlainObject(item) && item.category === category);
}

export function getRecipeHint(manifest, recipeId) {
  return getItemsByCategory(manifest, 'recipe-prompt').find((item) => item.recipeId === recipeId) ?? null;
}

export function listLicenses(manifest) {
  const tally = { code: {}, weights: {} };
  if (!isPlainObject(manifest) || !Array.isArray(manifest.items)) return tally;
  for (const item of manifest.items) {
    if (!isPlainObject(item)) continue;
    for (const [bucket, field] of [['code', 'codeLicense'], ['weights', 'weightsLicense']]) {
      const licence = item[field];
      if (typeof licence === 'string') tally[bucket][licence] = (tally[bucket][licence] ?? 0) + 1;
    }
  }
  return tally;
}

export function validateManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    pushError(errors, '', 'manifest must be an object');
    return { ok: false, errors };
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    pushError(errors, 'schema', `schema must be "${MANIFEST_SCHEMA}"`);
  }
  validatePolicy(manifest.policy, errors);
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    pushError(errors, 'items', 'items must be a non-empty array');
    scanStrings(manifest, '', errors);
    return { ok: false, errors };
  }
  const seenIds = new Map();
  const seenRecipes = new Map();
  const categories = new Set();
  manifest.items.forEach((item, index) => {
    validateItem(item, `items[${index}]`, errors, seenIds, seenRecipes);
    if (isPlainObject(item) && typeof item.category === 'string') categories.add(item.category);
  });
  for (const category of REQUIRED_CATEGORIES) {
    if (!categories.has(category)) {
      pushError(errors, 'items', `manifest is missing items for required category "${category}"`);
    }
  }
  for (const recipeId of RECIPE_IDS) {
    if (!seenRecipes.has(recipeId)) {
      pushError(errors, 'items', `manifest is missing a recipe-prompt hint for "${recipeId}"`);
    }
  }
  scanStrings(manifest, '', errors);
  return { ok: errors.length === 0, errors };
}

export async function loadManifest({ readFile = fsReadFile, url = DEFAULT_MANIFEST_URL } = {}) {
  const text = await readFile(url, 'utf8');
  return JSON.parse(text);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function validatePolicy(policy, errors) {
  if (!isPlainObject(policy)) {
    pushError(errors, 'policy', 'policy must be an object');
    return;
  }
  const list = policy.vendorableLicenses;
  if (!Array.isArray(list)) {
    pushError(errors, 'policy.vendorableLicenses', 'vendorableLicenses must be an array');
  } else {
    const actual = list.map((entry) => String(entry)).sort().join(',');
    const expected = [...VENDORABLE_LICENSES].sort().join(',');
    if (actual !== expected) {
      pushError(errors, 'policy.vendorableLicenses', `vendorableLicenses must match ${VENDORABLE_LICENSES.join(', ')}`);
    }
  }
  if (policy.runtimeOnly !== true) pushError(errors, 'policy.runtimeOnly', 'policy.runtimeOnly must be true');
  if (policy.vendor !== false) pushError(errors, 'policy.vendor', 'policy.vendor must be false');
  if (policy.jobWiring !== false) pushError(errors, 'policy.jobWiring', 'policy.jobWiring must be false');
}

function validateItem(item, path, errors, seenIds, seenRecipes) {
  if (!isPlainObject(item)) {
    pushError(errors, path, 'item must be an object');
    return;
  }
  for (const field of REQUIRED_ITEM_FIELDS) {
    if (!(field in item)) pushError(errors, `${path}.${field}`, `missing required field "${field}"`);
  }
  if (!('category' in item)) pushError(errors, `${path}.category`, 'missing required field "category"');
  for (const field of TEXT_FIELDS) {
    if (field in item && (typeof item[field] !== 'string' || item[field].trim() === '')) {
      pushError(errors, `${path}.${field}`, `"${field}" must be a non-empty string`);
    }
  }
  if (typeof item.id === 'string') {
    if (!KEBAB_CASE.test(item.id)) pushError(errors, `${path}.id`, 'id must be kebab-case');
    if (seenIds.has(item.id)) pushError(errors, `${path}.id`, `duplicate id "${item.id}"`);
    else seenIds.set(item.id, path);
  }
  const nonVendorable = [];
  for (const field of ['codeLicense', 'weightsLicense']) {
    const licence = item[field];
    if (typeof licence === 'string' && licence.trim() !== '' && !isVendorable(licence)) {
      nonVendorable.push(`${field}="${licence}"`);
    }
  }
  if (item.runtimeOnly !== true) {
    pushError(errors, `${path}.runtimeOnly`, nonVendorable.length
      ? `runtimeOnly must be true for non-allowlist licence ${nonVendorable.join(', ')}`
      : 'runtimeOnly must be true (this manifest is runtime-only data)');
  }
  if (item.vendor !== false) {
    pushError(errors, `${path}.vendor`, nonVendorable.length
      ? `vendor must be false for non-allowlist licence ${nonVendorable.join(', ')}`
      : 'vendor must be false (nothing in this manifest is vendored)');
  }
  if ('restricted' in item && typeof item.restricted !== 'boolean') {
    pushError(errors, `${path}.restricted`, 'restricted must be a boolean');
  }
  const mentionsLtx2 = LTX_2_PATTERN.test(`${item.id ?? ''} ${item.model ?? ''}`);
  if (mentionsLtx2 && item.restricted !== true) {
    pushError(errors, `${path}.restricted`, 'LTX-2.x entries must be flagged restricted: true');
  }
  validateSource(item, path, errors);
  if (item.category === 'recipe-prompt') validateRecipeHint(item, path, errors, seenRecipes);
}

function validateRecipeHint(item, path, errors, seenRecipes) {
  const recipeId = item.recipeId;
  if (typeof recipeId !== 'string' || recipeId.trim() === '') {
    pushError(errors, `${path}.recipeId`, 'recipe-prompt items require a recipeId');
  } else if (!RECIPE_IDS.includes(recipeId)) {
    pushError(errors, `${path}.recipeId`, `unknown recipeId "${recipeId}"`);
  } else if (seenRecipes.has(recipeId)) {
    pushError(errors, `${path}.recipeId`, `duplicate recipe-prompt hint for "${recipeId}"`);
  } else {
    seenRecipes.set(recipeId, path);
  }
  const prompt = item.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    pushError(errors, `${path}.prompt`, 'recipe-prompt items require a non-empty prompt');
  } else if (prompt.length > 240) {
    pushError(errors, `${path}.prompt`, 'prompt must be at most 240 characters');
  }
  if (typeof item.lora !== 'string' || item.lora.trim() === '') {
    pushError(errors, `${path}.lora`, 'recipe-prompt items require a non-empty lora hint');
  }
}

function validateSource(item, path, errors) {
  const source = item.source;
  if (typeof source !== 'string' || source.trim() === '') return;
  if (!source.startsWith('https://')) {
    pushError(errors, `${path}.source`, 'source must be an https URL');
    return;
  }
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    pushError(errors, `${path}.source`, 'source must be a parseable URL');
    return;
  }
  if (parsed.protocol !== 'https:') pushError(errors, `${path}.source`, 'source must be an https URL');
  if (!parsed.hostname) pushError(errors, `${path}.source`, 'source must include a host');
  if (parsed.username || parsed.password) pushError(errors, `${path}.source`, 'source must not embed credentials');
}

function scanStrings(value, path, errors) {
  if (typeof value === 'string') {
    for (const { pattern, message } of FORBIDDEN_TEXT) {
      if (pattern.test(value)) pushError(errors, path, message);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanStrings(entry, `${path}[${index}]`, errors));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      scanStrings(entry, path ? `${path}.${key}` : key, errors);
    }
  }
}
