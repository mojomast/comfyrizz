// CCL2a: the PuLID-Flux identity still is a real ComfyUI API graph and its
// params map names every job input without touching the existing workflows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const workflowPath = join(root, 'workflows', 'character_identity_pulid.api.json');
const paramsPath = join(root, 'workflows', 'character_identity_pulid.api.params.json');
const workflowText = readFileSync(workflowPath, 'utf8');
const paramsText = readFileSync(paramsPath, 'utf8');
const graph = JSON.parse(workflowText);
const params = JSON.parse(paramsText);

// The parameters a still job may carry into this graph. They are a subset of
// the planner's still parameters so the Python workflow contract also accepts
// the map; anything else is a fixed graph literal.
const JOB_INPUTS = ['prompt', 'image', 'reference', 'width', 'height', 'seed', 'steps', 'denoise'];
const STILL_PARAMS = new Set([
  'prompt', 'image', 'reference', 'mask', 'audio',
  'width', 'height', 'seed', 'steps', 'denoise', 'megapixels', 'cutout',
]);
const OUTPUT_COUNTS = {
  UNETLoader: 1,
  DualCLIPLoader: 2,
  VAELoader: 1,
  CLIPTextEncode: 1,
  LoadImage: 2,
  EmptySD3LatentImage: 1,
  FluxGuidance: 1,
  PulidFluxModelLoader: 1,
  PulidFluxInsightFaceLoader: 1,
  PulidFluxEvaClipLoader: 1,
  ApplyPulidFlux: 1,
  KSampler: 1,
  VAEDecode: 1,
  SaveImage: 1,
};
const REQUIRED_CLASSES = [
  'UNETLoader',
  'DualCLIPLoader',
  'VAELoader',
  'CLIPTextEncode',
  'FluxGuidance',
  'EmptySD3LatentImage',
  'KSampler',
  'VAEDecode',
  'SaveImage',
  'LoadImage',
  'PulidFluxModelLoader',
  'PulidFluxInsightFaceLoader',
  'PulidFluxEvaClipLoader',
  'ApplyPulidFlux',
];

function nodeOfClass(classType) {
  const found = Object.entries(graph).filter(([, node]) => node.class_type === classType);
  assert.equal(found.length, 1, `expected exactly one ${classType} node, found ${found.length}`);
  return found[0];
}

function targetsOf(target) {
  assert.ok(Array.isArray(target) && target.length > 0, `bad map target ${JSON.stringify(target)}`);
  return Array.isArray(target[0]) ? target : [target];
}

function isLink(value) {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === 'string'
    && Number.isInteger(value[1])
    && value[1] >= 0;
}

function classOf(nodeId) {
  return graph[nodeId]?.class_type;
}

test('the workflow is a ComfyUI API document, not a UI export', () => {
  assert.ok(graph && typeof graph === 'object' && !Array.isArray(graph));
  assert.ok(Object.keys(graph).length > 0);
  for (const key of ['nodes', 'links', 'last_node_id', 'last_link_id', 'extra', 'version']) {
    assert.equal(key in graph, false, `UI export key ${key} is present`);
  }
  for (const [id, node] of Object.entries(graph)) {
    assert.match(id, /^\d+$/, `node id ${id} is not numeric`);
    assert.equal(typeof node.class_type, 'string', `node ${id} has no class_type`);
    assert.equal(typeof node.inputs, 'object', `node ${id} has no inputs object`);
    assert.notEqual(node.inputs, null);
    assert.equal(Array.isArray(node.inputs), false, `node ${id} inputs is an array`);
  }
});

test('every linked input points at a real node and a real output', () => {
  for (const [id, node] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value)) continue;
      assert.ok(isLink(value), `${id}.${field} is not a [node_id, output_index] link`);
      const [source, output] = value;
      assert.ok(graph[source], `${id}.${field} links to missing node ${source}`);
      assert.notEqual(source, id, `${id}.${field} links to itself`);
      const count = OUTPUT_COUNTS[classOf(source)];
      if (count !== undefined) {
        assert.ok(output < count, `${id}.${field} uses output ${output} of ${classOf(source)}, which has ${count}`);
      }
    }
  }
});

test('the PuLID face lock is wired from the portrait through to the sampler', () => {
  const classes = Object.values(graph).map((node) => node.class_type);
  for (const required of REQUIRED_CLASSES) {
    assert.ok(classes.includes(required), `missing ${required} node`);
  }
  assert.equal(classes.filter((name) => name === 'ApplyPulidFlux').length, 1);
  assert.equal(classes.filter((name) => name === 'LoadImage').length, 1);
  assert.equal(classes.filter((name) => name === 'KSampler').length, 1);
  assert.equal(classes.filter((name) => name === 'SaveImage').length, 1);

  const [applyId, apply] = nodeOfClass('ApplyPulidFlux');
  const [loadId, load] = nodeOfClass('LoadImage');
  const [unetId] = nodeOfClass('UNETLoader');
  const [pulidId] = nodeOfClass('PulidFluxModelLoader');
  const [evaId] = nodeOfClass('PulidFluxEvaClipLoader');
  const [faceId] = nodeOfClass('PulidFluxInsightFaceLoader');
  const [samplerId, sampler] = nodeOfClass('KSampler');
  const [guidanceId] = nodeOfClass('FluxGuidance');
  const [latentId] = nodeOfClass('EmptySD3LatentImage');
  const [decodeId] = nodeOfClass('VAEDecode');
  const [saveId] = nodeOfClass('SaveImage');

  assert.deepEqual(apply.inputs.image, [loadId, 0]);
  assert.equal(load.class_type, 'LoadImage');
  assert.equal(load.inputs.image, 'input.png');
  assert.deepEqual(apply.inputs.model, [unetId, 0]);
  assert.deepEqual(apply.inputs.pulid_flux, [pulidId, 0]);
  assert.deepEqual(apply.inputs.eva_clip, [evaId, 0]);
  assert.deepEqual(apply.inputs.face_analysis, [faceId, 0]);
  assert.ok(apply.inputs.weight > 0 && apply.inputs.weight < 5, 'PuLID weight must be a usable strength');
  assert.equal(apply.inputs.start_at, 0);
  assert.equal(apply.inputs.end_at, 1);

  assert.deepEqual(sampler.inputs.model, [applyId, 0], 'the sampler must use the PuLID-patched model');
  assert.deepEqual(sampler.inputs.positive, [guidanceId, 0]);
  assert.equal(graph[guidanceId].class_type, 'FluxGuidance');
  assert.deepEqual(sampler.inputs.latent_image, [latentId, 0]);
  assert.equal(graph[latentId].class_type, 'EmptySD3LatentImage');
  assert.equal(sampler.inputs.cfg, 1);
  assert.equal(sampler.inputs.denoise, 1);

  assert.deepEqual(graph[decodeId].inputs.samples, [samplerId, 0]);
  assert.deepEqual(graph[saveId].inputs.images, [decodeId, 0]);
});

test('the params file names every job input and maps it at a real node input', () => {
  assert.equal(params.v, 1);
  assert.equal(params.generator, 'pulid-flux');
  assert.equal(params.kind, 'still');
  assert.ok(params.map && typeof params.map === 'object' && !Array.isArray(params.map));
  assert.ok(Array.isArray(params.files));
  assert.ok(Array.isArray(params.inputs));

  assert.deepEqual(new Set(params.inputs), new Set(Object.keys(params.map)));
  assert.equal(new Set(params.inputs).size, params.inputs.length, 'params.inputs contains a duplicate');
  for (const name of JOB_INPUTS) {
    assert.ok(name in params.map, `params.map is missing ${name}`);
    assert.ok(params.inputs.includes(name), `params.inputs is missing ${name}`);
  }
  for (const name of Object.keys(params.map)) {
    assert.ok(STILL_PARAMS.has(name), `params.map uses ${name}, which is not a still job parameter`);
  }
  for (const name of params.files) {
    assert.ok(name in params.map, `files declares ${name}, which has no map entry`);
  }

  for (const [name, target] of Object.entries(params.map)) {
    for (const pair of targetsOf(target)) {
      assert.ok(pair.length === 2 || pair.length === 3, `${name} -> ${JSON.stringify(pair)} is not [node, field]`);
      const [nodeId, field] = pair;
      assert.ok(graph[nodeId], `${name} points at missing node ${nodeId}`);
      assert.ok(field in graph[nodeId].inputs, `${name} points at ${nodeId}.${field}, which is not an input`);
      if (pair.length === 3) {
        assert.deepEqual(Object.keys(pair[2]), ['mul']);
        assert.equal(typeof graph[nodeId].inputs[field], 'number');
      }
    }
  }

  const promptTarget = targetsOf(params.map.prompt)[0];
  assert.equal(classOf(promptTarget[0]), 'CLIPTextEncode');
  assert.equal(promptTarget[1], 'text');
  for (const name of ['width', 'height']) {
    const [nodeId, field] = targetsOf(params.map[name])[0];
    assert.equal(classOf(nodeId), 'EmptySD3LatentImage');
    assert.ok(['width', 'height'].includes(field));
  }
  for (const name of ['seed', 'steps', 'denoise']) {
    const [nodeId, field] = targetsOf(params.map[name])[0];
    assert.equal(classOf(nodeId), 'KSampler');
    assert.equal(field, name);
  }
});

test('the portrait is a declared file input and both aliases land on LoadImage', () => {
  const [loadId, load] = nodeOfClass('LoadImage');
  assert.deepEqual(new Set(params.files), new Set(['image', 'reference']));
  for (const name of ['image', 'reference']) {
    const targets = targetsOf(params.map[name]);
    assert.equal(targets.length, 1, `${name} must have one target`);
    assert.deepEqual(targets[0], [loadId, 'image']);
  }
  assert.equal(load.inputs.image, 'input.png', 'the graph keeps the upload placeholder');
  for (const name of ['unet_name', 'vae_name', 'clip_name1', 'clip_name2', 'pulid_file']) {
    const value = Object.values(graph).map((node) => node.inputs[name]).find((entry) => entry !== undefined);
    assert.equal(typeof value, 'string', `${name} must name a model file`);
    assert.doesNotMatch(value, /[\\/]/, `${name} must be a bare server-side filename`);
  }
});

test('injecting a planned still fills every mapped input and leaves literals alone', () => {
  const values = {
    prompt: 'Character Pip: small round coffee bean, glossy brown, barista apron',
    image: 'a_chr_0123456789abcdef.png',
    reference: 'a_chr_0123456789abcdef.png',
    width: 1024,
    height: 1024,
    seed: 424242,
    steps: 20,
    denoise: 1,
  };
  const injected = structuredClone(graph);
  for (const [name, value] of Object.entries(values)) {
    for (const [nodeId, field] of targetsOf(params.map[name])) {
      injected[nodeId].inputs[field] = value;
    }
  }
  assert.equal(injected['4'].inputs.text, values.prompt);
  assert.equal(injected['10'].inputs.image, values.image);
  assert.equal(injected['6'].inputs.width, values.width);
  assert.equal(injected['6'].inputs.height, values.height);
  assert.equal(injected['7'].inputs.seed, values.seed);
  assert.equal(injected['7'].inputs.steps, values.steps);
  assert.equal(injected['7'].inputs.denoise, values.denoise);

  assert.equal(injected['7'].inputs.sampler_name, graph['7'].inputs.sampler_name);
  assert.equal(injected['23'].inputs.weight, graph['23'].inputs.weight);
  assert.equal(injected['11'].inputs.guidance, graph['11'].inputs.guidance);
  assert.equal(injected['5'].inputs.text, graph['5'].inputs.text);
});

test('the workflow and params carry no secrets, URLs or absolute paths', () => {
  for (const [name, text] of [['workflow', workflowText], ['params', paramsText]]) {
    assert.doesNotMatch(text, /\b(?:hf_[A-Za-z0-9]{6,}|sk-[A-Za-z0-9]{6,}|ghp_[A-Za-z0-9]{6,})\b/, `${name} looks like it contains a token`);
    assert.doesNotMatch(text, /\bBearer\s+[A-Za-z0-9._-]{8,}/i, `${name} contains a bearer token`);
    assert.doesNotMatch(text, /(?:api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*["']?\s*[:=]/i, `${name} names a credential`);
    assert.doesNotMatch(text, /https?:\/\/[^\s"'<>]*@/i, `${name} contains a credentialed URL`);
    assert.doesNotMatch(text, /(?:^|["'\s:])\/(?:[A-Za-z0-9._-]+\/)+/m, `${name} contains an absolute POSIX path`);
    assert.doesNotMatch(text, /\b[A-Za-z]:\\/, `${name} contains an absolute Windows path`);
  }
});

test('the existing Klein identity workflows are unchanged', () => {
  const pinned = {
    'flux3_klein_t2i.api.json': 'e83ba017e5be8e16c72474af4702b862a286e94bf7947edaa2beac7afe967689',
    'flux3_klein_ref_edit.api.json': 'ecf1b281737c8f3bad5afe7be79e76d7aa3595146b97a8df3e8098c21c080e09',
  };
  for (const [name, sha] of Object.entries(pinned)) {
    const bytes = readFileSync(join(root, 'workflows', name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha, `${name} was edited`);
  }
});
