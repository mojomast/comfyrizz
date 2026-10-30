import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const url = (name) => new URL(`../../../workflows/${name}`, import.meta.url);
const read = (name) => JSON.parse(readFileSync(url(name), 'utf8'));
const text = (name) => readFileSync(url(name), 'utf8');

const TRANSPARENT = 'birefnet_image_transparent.api.json';
const TRANSPARENT_PARAMS = 'birefnet_image_transparent.api.params.json';
const SOLID = 'birefnet_image_solid.api.json';
const SOLID_PARAMS = 'birefnet_image_solid.api.params.json';

const CORE_CLASS_TYPES = new Set([
  'LoadImage',
  'LoadBackgroundRemovalModel',
  'RemoveBackground',
  'InvertMask',
  'JoinImageWithAlpha',
  'GetImageSize',
  'EmptyImage',
  'ImageCompositeMasked',
  'SaveImage',
]);

const OUTPUT_COUNTS = {
  LoadImage: 2,
  LoadBackgroundRemovalModel: 1,
  RemoveBackground: 1,
  InvertMask: 1,
  JoinImageWithAlpha: 1,
  GetImageSize: 2,
  EmptyImage: 1,
  ImageCompositeMasked: 1,
};

const isLink = (value) => Array.isArray(value)
  && value.length === 2
  && typeof value[0] === 'string'
  && Number.isInteger(value[1])
  && value[1] >= 0;

function targetsOf(target) {
  assert.ok(Array.isArray(target) && target.length > 0, `bad map target ${JSON.stringify(target)}`);
  return Array.isArray(target[0]) ? target : [target];
}

function assertApiGraph(graph) {
  assert.ok(graph && typeof graph === 'object' && !Array.isArray(graph));
  assert.ok(Object.keys(graph).length > 0);
  for (const key of ['nodes', 'links', 'last_node_id', 'last_link_id', 'extra', 'version']) {
    assert.equal(key in graph, false, `UI export key ${key} is present`);
  }
  for (const [id, node] of Object.entries(graph)) {
    assert.match(id, /^\d+$/, `node id ${id} is not numeric`);
    assert.equal(typeof node.class_type, 'string', `node ${id} has no class_type`);
    assert.ok(CORE_CLASS_TYPES.has(node.class_type), `node ${id} uses non-core class_type ${node.class_type}`);
    assert.equal(typeof node.inputs, 'object', `node ${id} has no inputs object`);
    assert.notEqual(node.inputs, null);
    assert.equal(Array.isArray(node.inputs), false, `node ${id} inputs is an array`);
  }
}

function assertLinksResolve(graph) {
  for (const [id, node] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value)) continue;
      assert.ok(isLink(value), `${id}.${field} is not a [node_id, output_index] link`);
      const [source, output] = value;
      assert.ok(graph[source], `${id}.${field} links to missing node ${source}`);
      assert.notEqual(source, id, `${id}.${field} links to itself`);
      const count = OUTPUT_COUNTS[graph[source].class_type];
      if (count !== undefined) {
        assert.ok(output < count, `${id}.${field} uses output ${output} of ${graph[source].class_type}`);
      }
    }
  }
}

function assertParamsResolve(graph, params, expectedMap, expectedFiles, generator) {
  assert.equal(params.v, 1);
  assert.equal(params.generator, generator);
  assert.equal(params.kind, 'still');
  assert.deepEqual(params.files, expectedFiles);
  assert.deepEqual(params.map, expectedMap);
  assert.deepEqual(new Set(params.inputs), new Set(Object.keys(params.map)));
  assert.equal(new Set(params.inputs).size, params.inputs.length, 'params.inputs contains a duplicate');
  for (const name of params.files) {
    assert.ok(name in params.map, `files declares ${name}, which has no map entry`);
  }
  for (const [name, target] of Object.entries(params.map)) {
    for (const pair of targetsOf(target)) {
      assert.equal(pair.length, 2, `${name} -> ${JSON.stringify(pair)} is not [node, field]`);
      const [nodeId, field] = pair;
      assert.ok(graph[nodeId], `${name} points at missing node ${nodeId}`);
      assert.ok(field in graph[nodeId].inputs, `${name} points at ${nodeId}.${field}, which is not an input`);
    }
  }
}

function inject(graph, params, values) {
  const next = structuredClone(graph);
  for (const [name, value] of Object.entries(values)) {
    const [nodeId, field] = targetsOf(params.map[name])[0];
    next[nodeId].inputs[field] = value;
  }
  return next;
}

test('the transparent graph is a core-only ComfyUI API document', () => {
  const graph = read(TRANSPARENT);
  assertApiGraph(graph);
  assert.deepEqual(
    new Set(Object.values(graph).map((node) => node.class_type)),
    new Set(['LoadImage', 'LoadBackgroundRemovalModel', 'RemoveBackground', 'InvertMask', 'JoinImageWithAlpha', 'SaveImage']),
  );
  assertLinksResolve(graph);
});

test('the transparent graph saves RGBA through JoinImageWithAlpha', () => {
  const graph = read(TRANSPARENT);
  assert.equal(graph['1'].class_type, 'LoadImage');
  assert.equal(graph['1'].inputs.image, '');
  assert.equal(graph['2'].class_type, 'LoadBackgroundRemovalModel');
  assert.equal(graph['2'].inputs.bg_removal_name, 'birefnet.safetensors');
  assert.equal(graph['3'].class_type, 'RemoveBackground');
  assert.deepEqual(graph['3'].inputs.bg_removal_model, ['2', 0]);
  assert.deepEqual(graph['3'].inputs.image, ['1', 0]);
  assert.equal(graph['4'].class_type, 'InvertMask');
  assert.deepEqual(graph['4'].inputs.mask, ['3', 0]);
  assert.equal(graph['5'].class_type, 'JoinImageWithAlpha');
  assert.deepEqual(graph['5'].inputs.image, ['1', 0]);
  assert.deepEqual(graph['5'].inputs.alpha, ['4', 0]);
  assert.equal(graph['9'].class_type, 'SaveImage');
  assert.deepEqual(graph['9'].inputs.images, ['5', 0]);
  assert.equal(graph['9'].inputs.filename_prefix, 'background-removal/transparent');
});

test('the transparent params resolve image onto the upload node', () => {
  const graph = read(TRANSPARENT);
  const params = read(TRANSPARENT_PARAMS);
  assertParamsResolve(graph, params, { image: ['1', 'image'] }, ['image'], 'birefnet');
  assert.equal('colour' in params.map, false, 'the transparent graph has no colour parameter');
  const injected = inject(graph, params, { image: 'a_still.png' });
  assert.equal(injected['1'].inputs.image, 'a_still.png');
  assert.equal(injected['7'], undefined);
});

test('the solid graph is core-only and composites the cutout over the colour fill', () => {
  const graph = read(SOLID);
  assertApiGraph(graph);
  assert.deepEqual(
    new Set(Object.values(graph).map((node) => node.class_type)),
    new Set(['LoadImage', 'LoadBackgroundRemovalModel', 'RemoveBackground', 'GetImageSize', 'EmptyImage', 'ImageCompositeMasked', 'SaveImage']),
  );
  assertLinksResolve(graph);
  assert.equal(graph['1'].class_type, 'LoadImage');
  assert.equal(graph['1'].inputs.image, '');
  assert.equal(graph['2'].inputs.bg_removal_name, 'birefnet.safetensors');
  assert.deepEqual(graph['3'].inputs.bg_removal_model, ['2', 0]);
  assert.deepEqual(graph['3'].inputs.image, ['1', 0]);
  assert.equal(graph['6'].class_type, 'GetImageSize');
  assert.deepEqual(graph['6'].inputs.image, ['1', 0]);
  assert.equal(graph['7'].class_type, 'EmptyImage');
  assert.deepEqual(graph['7'].inputs.width, ['6', 0]);
  assert.deepEqual(graph['7'].inputs.height, ['6', 1]);
  assert.equal(graph['7'].inputs.batch_size, 1);
  assert.equal(typeof graph['7'].inputs.color, 'number');
  assert.equal(graph['8'].class_type, 'ImageCompositeMasked');
  assert.deepEqual(graph['8'].inputs.destination, ['7', 0]);
  assert.deepEqual(graph['8'].inputs.source, ['1', 0]);
  assert.deepEqual(graph['8'].inputs.mask, ['3', 0]);
  assert.equal(graph['8'].inputs.x, 0);
  assert.equal(graph['8'].inputs.y, 0);
  assert.equal(graph['8'].inputs.resize_source, false);
  assert.equal(graph['9'].class_type, 'SaveImage');
  assert.deepEqual(graph['9'].inputs.images, ['8', 0]);
  assert.equal(graph['9'].inputs.filename_prefix, 'background-removal/flat');
});

test('the solid params resolve image and colour', () => {
  const graph = read(SOLID);
  const params = read(SOLID_PARAMS);
  assertParamsResolve(graph, params, { image: ['1', 'image'], colour: ['7', 'color'] }, ['image'], 'birefnet');
  const injected = inject(graph, params, { image: 'a_still.png', colour: 255 });
  assert.equal(injected['1'].inputs.image, 'a_still.png');
  assert.equal(injected['7'].inputs.color, 255);
  assert.equal(injected['7'].inputs.batch_size, 1);
});

test('the bundled files carry no secrets, URLs or absolute paths', () => {
  for (const name of [TRANSPARENT, TRANSPARENT_PARAMS, SOLID, SOLID_PARAMS]) {
    const body = text(name);
    assert.doesNotMatch(body, /\b(?:hf_[A-Za-z0-9]{6,}|sk-[A-Za-z0-9]{6,}|ghp_[A-Za-z0-9]{6,})\b/, `${name} looks like it contains a token`);
    assert.doesNotMatch(body, /\bBearer\s+[A-Za-z0-9._-]{8,}/i, `${name} contains a bearer token`);
    assert.doesNotMatch(body, /(?:api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*["']?\s*[:=]/i, `${name} names a credential`);
    assert.doesNotMatch(body, /https?:\/\//i, `${name} contains a URL`);
    assert.doesNotMatch(body, /(?:^|["'\s:])\/(?:[A-Za-z0-9._-]+\/)+/m, `${name} contains an absolute POSIX path`);
    assert.doesNotMatch(body, /\b[A-Za-z]:\\/, `${name} contains an absolute Windows path`);
    assert.doesNotMatch(body, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, `${name} contains an IP address`);
  }
});
