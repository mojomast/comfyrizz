import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GRAPH_PATH = 'workflows/qwen_edit_2511_instruct.api.json';
const PARAMS_PATH = 'workflows/qwen_edit_2511_instruct.api.params.json';

// Every node in this graph must come from ComfyUI core (ComfyUI is cloned at
// runtime, never vendored). Any custom-node class here would break a stock box.
const CORE_CLASS_TYPES = new Set([
  'CFGNorm',
  'CLIPLoader',
  'FluxKontextMultiReferenceLatentMethod',
  'ImageScaleToTotalPixels',
  'KSampler',
  'LoadImage',
  'ModelSamplingAuraFlow',
  'SaveImage',
  'TextEncodeQwenImageEditPlus',
  'UNETLoader',
  'VAEDecode',
  'VAEEncode',
  'VAELoader',
]);

const read = path => JSON.parse(readFileSync(`${ROOT}${path}`, 'utf8'));
const isLink = value => Array.isArray(value) && value.length === 2
  && typeof value[0] === 'string' && typeof value[1] === 'number';

function encoderFor(graph, link) {
  let id = link?.[0];
  const seen = new Set();
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    const node = graph[id];
    if (!node) return null;
    if (node.class_type === 'TextEncodeQwenImageEditPlus') return id;
    const next = node.inputs?.conditioning;
    if (!isLink(next)) return null;
    id = next[0];
  }
  return null;
}

// The pack fix 49b3cab: positive must trace to the encode node whose `prompt`
// is the params instruction slot, negative to the encode node with empty text.
function wiringProblems(graph, params) {
  const problems = [];
  const [instructionNode, instructionField] = params?.map?.instruction ?? [];
  if (!instructionNode) return ['params.map.instruction is missing'];
  if (!graph[instructionNode] || graph[instructionNode].class_type !== 'TextEncodeQwenImageEditPlus') {
    problems.push(`instruction slot does not point at a TextEncodeQwenImageEditPlus node: ${instructionNode}`);
  }
  if (instructionField !== 'prompt') problems.push(`instruction slot field is ${JSON.stringify(instructionField)}, expected "prompt"`);

  const sampler = Object.entries(graph).find(([, node]) => node.class_type === 'KSampler')?.[1];
  if (!sampler) return [...problems, 'graph has no KSampler'];
  const positive = sampler.inputs?.positive;
  const negative = sampler.inputs?.negative;
  if (!isLink(positive)) problems.push('KSampler positive is not a link');
  if (!isLink(negative)) problems.push('KSampler negative is not a link');
  if (!isLink(positive) || !isLink(negative)) return problems;

  const positiveEncoder = encoderFor(graph, positive);
  const negativeEncoder = encoderFor(graph, negative);
  if (!positiveEncoder) {
    problems.push(`positive ${JSON.stringify(positive)} does not reach a TextEncodeQwenImageEditPlus node`);
  } else if (positiveEncoder !== instructionNode) {
    problems.push(`positive reaches encoder ${positiveEncoder}, expected instruction encoder ${instructionNode}`);
  }
  if (!negativeEncoder) {
    problems.push(`negative ${JSON.stringify(negative)} does not reach a TextEncodeQwenImageEditPlus node`);
  } else if (negativeEncoder === instructionNode) {
    problems.push(`negative reaches the instruction encoder ${instructionNode}`);
  }
  if (negativeEncoder && typeof graph[negativeEncoder].inputs?.prompt !== 'string') {
    problems.push(`negative encoder ${negativeEncoder} has no prompt string`);
  }
  if (negativeEncoder && graph[negativeEncoder].inputs.prompt.trim() !== '') {
    problems.push(`negative encoder ${negativeEncoder} carries non-empty text ${JSON.stringify(graph[negativeEncoder].inputs.prompt)}`);
  }
  return problems;
}

test('shipped Qwen Edit 2511 graph wires positive to the instruction encoder and negative to the empty encoder', () => {
  const graph = read(GRAPH_PATH);
  const params = read(PARAMS_PATH);
  assert.deepEqual(wiringProblems(graph, params), []);
});

test('the pos/neg check fails on the pre-fix swapped copy', () => {
  const graph = read(GRAPH_PATH);
  const params = read(PARAMS_PATH);
  const sampler = Object.values(graph).find(node => node.class_type === 'KSampler');
  [sampler.inputs.positive, sampler.inputs.negative] = [sampler.inputs.negative, sampler.inputs.positive];
  const problems = wiringProblems(graph, params);
  assert.notDeepEqual(problems, [], 'a swapped sampler must be rejected');
  assert.ok(problems.some(problem => problem.includes('expected instruction encoder')),
    `swap must name the expected instruction encoder, got: ${problems.join('; ')}`);
  assert.ok(problems.some(problem => problem.includes('negative reaches the instruction encoder')),
    `swap must flag the negative instruction path, got: ${problems.join('; ')}`);
});

test('every class_type is a ComfyUI core node', () => {
  const graph = read(GRAPH_PATH);
  const unknown = Object.entries(graph)
    .filter(([, node]) => !CORE_CLASS_TYPES.has(node.class_type))
    .map(([id, node]) => `${id}:${node.class_type}`);
  assert.deepEqual(unknown, []);
});

test('params slots resolve to real node inputs and file slots map to the loader', () => {
  const graph = read(GRAPH_PATH);
  const params = read(PARAMS_PATH);
  assert.equal(params.v, 1);
  assert.ok(Array.isArray(params.files));
  for (const name of params.files) {
    assert.ok(Object.hasOwn(params.map, name), `${name} is listed in files but not mapped`);
  }
  for (const [name, target] of Object.entries(params.map)) {
    assert.ok(Array.isArray(target) && target.length === 2, `${name} must map to [node, input]`);
    const [nodeId, field] = target;
    const node = graph[nodeId];
    assert.ok(node, `${name} maps to missing node ${nodeId}`);
    assert.ok(Object.hasOwn(node.inputs ?? {}, field), `${name} maps to missing input ${nodeId}.${field}`);
  }
  for (const name of ['image', 'instruction', 'seed', 'steps', 'cfg']) {
    assert.ok(Object.hasOwn(params.map, name), `params.map is missing ${name}`);
  }
  const [imageNode, imageField] = params.map.image;
  assert.equal(graph[imageNode].class_type, 'LoadImage');
  assert.equal(imageField, 'image');
  const [instructionNode, instructionField] = params.map.instruction;
  assert.equal(graph[instructionNode].class_type, 'TextEncodeQwenImageEditPlus');
  assert.equal(instructionField, 'prompt');
});
