import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  MANIFEST_SCHEMA,
  RECIPE_IDS,
  REQUIRED_CATEGORIES,
  REQUIRED_ITEM_FIELDS,
  VENDORABLE_LICENSES,
  getRecipeHint,
  isVendorable,
  listLicenses,
  loadManifest,
  looksLikeSecret,
  validateManifest,
} from './comfy-workflows.mjs';

const dataUrl = new URL('./data/comfy-workflows.json', import.meta.url);
const moduleUrl = new URL('./comfy-workflows.mjs', import.meta.url);
const manifest = await loadManifest();

function minimalItem(overrides = {}) {
  return {
    id: 'demo-item',
    category: 'interpolation',
    purpose: 'demo purpose',
    model: 'Demo Model',
    codeLicense: 'MIT',
    weightsLicense: 'MIT',
    runtimeOnly: true,
    vendor: false,
    source: 'https://example.com/demo',
    notes: 'demo notes',
    ...overrides,
  };
}

function wrap(items, overrides = {}) {
  return {
    schema: MANIFEST_SCHEMA,
    policy: { vendorableLicenses: [...VENDORABLE_LICENSES], runtimeOnly: true, vendor: false, jobWiring: false },
    items,
    ...overrides,
  };
}

test('manifest loads as the M18 v1 schema', () => {
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.feature, 'MOTION-UPGRADE M18');
  assert.equal(manifest.policy.jobWiring, false);
});

test('shipped manifest validates with zero errors', () => {
  const result = validateManifest(manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('every item carries the M18 fields and the runtime-only shape', () => {
  assert.ok(Array.isArray(manifest.items));
  assert.ok(manifest.items.length >= 7);
  for (const item of manifest.items) {
    for (const field of REQUIRED_ITEM_FIELDS) {
      assert.ok(field in item, `${item.id} is missing ${field}`);
    }
    assert.equal(item.runtimeOnly, true, item.id);
    assert.equal(item.vendor, false, item.id);
    assert.equal(typeof item.category, 'string', item.id);
  }
});

test('every non-vendorable licence is runtime-only and unvendored', () => {
  const flagged = manifest.items.filter((item) => !isVendorable(item.codeLicense) || !isVendorable(item.weightsLicense));
  assert.ok(flagged.length >= 5);
  for (const item of flagged) {
    assert.equal(item.runtimeOnly, true, item.id);
    assert.equal(item.vendor, false, item.id);
  }
  const ids = new Set(flagged.map((item) => item.id));
  for (const id of [
    'film-frame-interpolation',
    'depth-anything-v2-small',
    'realesrgan-x4plus',
    'ltx-video-0-9',
    'ltx-2-community',
    'animatediff-motiondirector',
  ]) {
    assert.ok(ids.has(id), id);
  }
});

test('LTX-2.x is flagged restricted and the validator enforces the flag', () => {
  const item = manifest.items.find((entry) => entry.id === 'ltx-2-community');
  assert.ok(item);
  assert.equal(item.model, 'LTX-2.x');
  assert.equal(item.restricted, true);
  assert.ok(item.notes.toLowerCase().includes('revenue cap'));
  const loosened = structuredClone(manifest);
  const index = loosened.items.findIndex((entry) => entry.id === 'ltx-2-community');
  delete loosened.items[index].restricted;
  const result = validateManifest(loosened);
  assert.ok(result.errors.some((error) => error.path === `items[${index}].restricted`));
});

test('validator flags an LTX-2 model name that lost its restricted flag', () => {
  const result = validateManifest(wrap([minimalItem({ id: 'ltx-2-demo', model: 'LTX-2.0 preview' })]));
  assert.ok(result.errors.some((error) => error.path === 'items[0].restricted'));
});

test('every source is an https URL without credentials', () => {
  for (const item of manifest.items) {
    assert.ok(item.source.startsWith('https://'), item.id);
    const url = new URL(item.source);
    assert.equal(url.protocol, 'https:');
    assert.ok(url.hostname.length > 0);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
  }
});

test('required categories and flagship models are present', () => {
  const categories = new Set(manifest.items.map((item) => item.category));
  for (const category of REQUIRED_CATEGORIES) {
    assert.ok(categories.has(category), category);
  }
  const rife = manifest.items.find((item) => item.id === 'practical-rife-4-25');
  assert.equal(rife.codeLicense, 'MIT');
  assert.equal(rife.weightsLicense, 'MIT');
  const film = manifest.items.find((item) => item.id === 'film-frame-interpolation');
  assert.equal(film.codeLicense, 'Apache-2.0');
  const depth = manifest.items.find((item) => item.id === 'depth-anything-v2-small');
  assert.equal(depth.codeLicense, 'Apache-2.0');
  assert.equal(depth.weightsLicense, 'Apache-2.0');
  assert.ok(manifest.items.some((item) => item.id === 'ltx-video-0-9'));
  assert.ok(manifest.items.some((item) => item.id === 'animatediff-motiondirector'));
  assert.ok(manifest.items.filter((item) => item.category === 'upscale').length >= 1);
  const licenses = listLicenses(manifest);
  assert.ok(licenses.code['Apache-2.0'] >= 3);
  assert.ok(licenses.code['MIT'] >= 1);
  assert.ok(licenses.weights['Apache-2.0'] >= 2);
});

test('every recipe has exactly one prompt/LoRA hint with a bounded prompt', () => {
  const hints = manifest.items.filter((item) => item.category === 'recipe-prompt');
  assert.equal(hints.length, RECIPE_IDS.length);
  const ids = hints.map((hint) => hint.recipeId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [...RECIPE_IDS].sort());
  for (const hint of hints) {
    assert.equal(hint.id, `hint-${hint.recipeId}`);
    assert.ok(hint.prompt.length > 0 && hint.prompt.length <= 240, hint.id);
    assert.ok(hint.lora.length > 0, hint.id);
  }
  assert.ok(getRecipeHint(manifest, 'swiss-grid'));
  assert.equal(getRecipeHint(manifest, 'not-a-recipe'), null);
});

test('validator: non-allowlist licences require runtimeOnly and vendor false', () => {
  const runtime = validateManifest(wrap([minimalItem({ codeLicense: 'Apache-2.0', runtimeOnly: false })]));
  assert.ok(runtime.errors.some((error) => error.path === 'items[0].runtimeOnly' && error.message.includes('non-allowlist')));
  const vendored = validateManifest(wrap([minimalItem({ weightsLicense: 'OpenRAIL-M', vendor: true })]));
  assert.ok(vendored.errors.some((error) => error.path === 'items[0].vendor' && error.message.includes('non-allowlist')));
});

test('validator: even allowlist licences stay runtime-only and unvendored', () => {
  const runtime = validateManifest(wrap([minimalItem({ runtimeOnly: false })]));
  assert.ok(runtime.errors.some((error) => error.path === 'items[0].runtimeOnly'));
  const vendored = validateManifest(wrap([minimalItem({ vendor: true })]));
  assert.ok(vendored.errors.some((error) => error.path === 'items[0].vendor'));
});

test('validator: http sources and embedded credentials are rejected', () => {
  const plain = validateManifest(wrap([minimalItem({ source: 'http://example.com/model' })]));
  assert.ok(plain.errors.some((error) => error.path === 'items[0].source'));
  const credentials = validateManifest(wrap([minimalItem({ source: 'https://user:pass@example.com/model' })]));
  assert.ok(credentials.errors.some((error) => error.path === 'items[0].source' && error.message.includes('credentials')));
});

test('validator: Google Colab wiring and notebook references are rejected', () => {
  const wired = validateManifest(wrap([minimalItem({ notes: 'run through colab.research.google.com' })]));
  assert.ok(wired.errors.some((error) => error.path === 'items[0].notes'));
  const notebook = validateManifest(wrap([minimalItem({ purpose: 'notebook job wiring' })]));
  assert.ok(notebook.errors.some((error) => error.path === 'items[0].purpose'));
});

test('validator: secret-looking values are rejected', () => {
  const fakeKey = `sk-${'A'.repeat(24)}`;
  const result = validateManifest(wrap([minimalItem({ notes: `key ${fakeKey}` })]));
  assert.ok(result.errors.some((error) => error.path === 'items[0].notes' && error.message.includes('secret')));
  assert.equal(looksLikeSecret(fakeKey), true);
  assert.equal(looksLikeSecret('no secrets in this sentence'), false);
});

test('validator: missing fields, duplicate ids and bad id shape are rejected', () => {
  const withoutNotes = minimalItem();
  delete withoutNotes.notes;
  const missing = validateManifest(wrap([minimalItem(), withoutNotes]));
  assert.ok(missing.errors.some((error) => error.path === 'items[1].notes' && error.message.includes('missing required field')));
  const duplicate = validateManifest(wrap([minimalItem(), minimalItem()]));
  assert.ok(duplicate.errors.some((error) => error.path === 'items[1].id' && error.message.includes('duplicate')));
  const badId = validateManifest(wrap([minimalItem({ id: 'Not_Kebab' })]));
  assert.ok(badId.errors.some((error) => error.path === 'items[0].id'));
});

test('validator: schema, policy and category coverage are enforced', () => {
  const badSchema = validateManifest(wrap([], { schema: 'comfyrizz.comfy-workflows/v0' }));
  assert.ok(badSchema.errors.some((error) => error.path === 'schema'));
  const badPolicy = validateManifest(wrap([minimalItem(), ...RECIPE_IDS.map((recipeId) => minimalItem({
    id: `hint-${recipeId}`,
    category: 'recipe-prompt',
    recipeId,
    prompt: 'prompt',
    lora: 'lora',
  }))], { policy: { vendorableLicenses: ['GPL-3.0'], runtimeOnly: true, vendor: false, jobWiring: false } }));
  assert.ok(badPolicy.errors.some((error) => error.path === 'policy.vendorableLicenses'));
  const empty = validateManifest({ schema: MANIFEST_SCHEMA });
  assert.ok(empty.errors.some((error) => error.path === 'items'));
  const partial = validateManifest(wrap([minimalItem({
    id: 'hint-swiss-grid',
    category: 'recipe-prompt',
    recipeId: 'swiss-grid',
    prompt: 'prompt',
    lora: 'lora',
  })]));
  assert.ok(partial.errors.some((error) => error.message.includes('required category "interpolation"')));
  assert.ok(partial.errors.some((error) => error.message.includes('missing a recipe-prompt hint for "editorial-serif"')));
});

test('validator: recipe hints need known ids, bounded prompts and lora text', () => {
  const unknown = validateManifest(wrap([minimalItem({ category: 'recipe-prompt', recipeId: 'unknown-look', prompt: 'p', lora: 'l' })]));
  assert.ok(unknown.errors.some((error) => error.path === 'items[0].recipeId'));
  const longPrompt = validateManifest(wrap([minimalItem({ category: 'recipe-prompt', recipeId: 'swiss-grid', prompt: 'x'.repeat(241), lora: 'l' })]));
  assert.ok(longPrompt.errors.some((error) => error.path === 'items[0].prompt'));
  const noLora = validateManifest(wrap([minimalItem({ category: 'recipe-prompt', recipeId: 'swiss-grid', prompt: 'p' })]));
  assert.ok(noLora.errors.some((error) => error.path === 'items[0].lora'));
});

test('validator does not mutate its input', () => {
  const before = JSON.stringify(manifest);
  validateManifest(manifest);
  assert.equal(JSON.stringify(manifest), before);
});

test('loadManifest supports an injected reader', async () => {
  const fixture = wrap([minimalItem()]);
  let calls = 0;
  const loaded = await loadManifest({
    readFile: async (url, encoding) => {
      calls += 1;
      assert.ok(url instanceof URL);
      assert.equal(encoding, 'utf8');
      return JSON.stringify(fixture);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(loaded, fixture);
});

test('shipped files carry no secrets, Colab wiring or machine-local paths', async () => {
  const moduleSource = await readFile(moduleUrl, 'utf8');
  const data = await readFile(dataUrl, 'utf8');
  const needles = [
    ['/', 'home', '/'].join(''),
    ['/', 'work', 'space', '/'].join(''),
    ['C:', '\\', 'Users'].join(''),
    ['.', 'ts', '.net'].join(''),
  ];
  for (const [label, text] of [['module', moduleSource], ['data', data]]) {
    assert.equal(looksLikeSecret(text), false, `${label} looks secret`);
    const lowered = text.toLowerCase();
    for (const needle of needles) {
      assert.equal(lowered.includes(needle.toLowerCase()), false, `${label} contains ${needle}`);
    }
  }
  assert.equal(data.toLowerCase().includes('colab'), false);
  assert.equal(data.includes('http://'), false);
});
