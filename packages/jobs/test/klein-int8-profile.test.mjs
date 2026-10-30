import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BF16_PATH = 'workflows/flux3_klein_t2i.api.json';
const INT8_PATH = 'workflows/flux3_klein_t2i_int8.api.json';

const INT8_UNET = 'flux3-image-klein-int8-convrot.safetensors';
const INT8_CLIP = 'qwen3vl_4b_int8_convrot.safetensors';
const LOADER_CLASS_TYPES = new Set(['UNETLoader', 'CLIPLoader', 'VAELoader']);

const readGraph = path => JSON.parse(readFileSync(`${ROOT}${path}`, 'utf8'));
const isLink = value => Array.isArray(value) && value.length === 2
  && typeof value[0] === 'string' && typeof value[1] === 'number';

function leafDiff(a, b, prefix = '') {
  if (a === b) return [];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return [prefix];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const paths = [];
  for (const key of keys) {
    paths.push(...leafDiff(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  }
  return paths;
}

test('int8 graph mirrors the BF16 graph nodes and links exactly', () => {
  const bf16 = readGraph(BF16_PATH);
  const int8 = readGraph(INT8_PATH);

  assert.deepEqual(Object.keys(int8).sort(), Object.keys(bf16).sort(), 'node ids match');
  for (const id of Object.keys(bf16)) {
    assert.equal(int8[id].class_type, bf16[id].class_type, `node ${id} class_type matches`);
  }

  const linksOf = graph => {
    const links = [];
    for (const [id, node] of Object.entries(graph)) {
      for (const [input, value] of Object.entries(node.inputs ?? {})) {
        if (isLink(value)) links.push(`${id}.${input}<-${value[0]}:${value[1]}`);
      }
    }
    return links.sort();
  };
  assert.deepEqual(linksOf(int8), linksOf(bf16), 'links match');
});

test('only the two loader names differ from the BF16 graph', () => {
  const bf16 = readGraph(BF16_PATH);
  const int8 = readGraph(INT8_PATH);

  assert.deepEqual(
    leafDiff(bf16, int8).sort(),
    ['1.inputs.unet_name', '2.inputs.clip_name'],
    'exactly the transformer and text-encoder filenames differ',
  );
});

test('int8 loaders use the official Comfy filenames and keep defaults', () => {
  const bf16 = readGraph(BF16_PATH);
  const int8 = readGraph(INT8_PATH);

  assert.equal(int8['1'].class_type, 'UNETLoader');
  assert.equal(int8['1'].inputs.unet_name, INT8_UNET);
  assert.equal(int8['1'].inputs.weight_dtype, bf16['1'].inputs.weight_dtype);
  assert.equal(int8['2'].class_type, 'CLIPLoader');
  assert.equal(int8['2'].inputs.clip_name, INT8_CLIP);
  assert.equal(int8['2'].inputs.type, 'flux3');
  assert.equal(int8['2'].inputs.device, bf16['2'].inputs.device);
  assert.equal(int8['3'].inputs.vae_name, 'flux2-vae.safetensors');
});

test('int8 graph keeps the 16-step / cfg 1 / euler / simple sampler', () => {
  const int8 = readGraph(INT8_PATH);
  const samplers = Object.values(int8).filter(node => node.class_type === 'KSampler');
  assert.equal(samplers.length, 1);
  assert.equal(samplers[0].inputs.steps, 16);
  assert.equal(samplers[0].inputs.cfg, 1);
  assert.equal(samplers[0].inputs.sampler_name, 'euler');
  assert.equal(samplers[0].inputs.scheduler, 'simple');
});

test('no int8 loader input names a BF16 file', () => {
  const int8 = readGraph(INT8_PATH);
  for (const [id, node] of Object.entries(int8)) {
    if (!LOADER_CLASS_TYPES.has(node.class_type)) continue;
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (typeof value !== 'string') continue;
      assert.ok(!value.toLowerCase().includes('bf16'), `node ${id}.${input} must not name bf16: ${value}`);
    }
  }
});
