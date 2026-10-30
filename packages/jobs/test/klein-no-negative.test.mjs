import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const KLEIN_GRAPHS = [
  'workflows/flux3_klein_t2i.api.json',
  'workflows/flux3_klein_img2img.api.json',
  'workflows/flux3_klein_ref_edit.api.json',
  'workflows/flux3_klein_ref2_edit.api.json',
];
const NEGATIVE_INPUT = 'negative';
const SAMPLER_NODES = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']);
const TEXT_NODES = new Set(['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeFlux']);
const ZERO_OUT_NODES = new Set(['ConditioningZeroOut']);

const readGraph = path => JSON.parse(readFileSync(`${ROOT}${path}`, 'utf8'));
const isLink = value => Array.isArray(value) && value.length === 2
  && typeof value[0] === 'string' && typeof value[1] === 'number';

function negativeLinks(graph) {
  const links = [];
  for (const [id, node] of Object.entries(graph)) {
    if (SAMPLER_NODES.has(node.class_type) || Object.hasOwn(node.inputs ?? {}, NEGATIVE_INPUT)) {
      const link = node.inputs?.[NEGATIVE_INPUT];
      if (isLink(link)) links.push({ from: id, link });
    }
  }
  return links;
}

// A negative conditioning is empty only when it is zeroed, or when every text
// conditioning reachable from it is an empty string. Anything else is a
// negative text prompt, which distilled FLUX 3 Image Klein at cfg 1 cannot use.
function negativeTextProblems(graph) {
  const problems = [];

  function inspect(link, trail) {
    const [nodeId, output] = link;
    const node = graph[nodeId];
    if (!node) {
      problems.push(`${trail}->${nodeId}: missing node`);
      return;
    }
    const here = `${trail}->${nodeId}(${node.class_type})`;
    if (ZERO_OUT_NODES.has(node.class_type)) return;
    if (TEXT_NODES.has(node.class_type)) {
      const text = node.inputs?.text;
      if (typeof text !== 'string' || text.trim() !== '') {
        problems.push(`${here} output ${output} carries non-empty negative text ${JSON.stringify(text)}`);
      }
      return;
    }
    const inputs = node.inputs ?? {};
    const next = ['negative', 'conditioning', 'conditioning_to']
      .map(name => inputs[name])
      .filter(isLink);
    if (next.length === 0) {
      problems.push(`${here} output ${output} has no empty-text or zeroed negative source`);
      return;
    }
    for (const link of next) inspect(link, here);
  }

  const links = negativeLinks(graph);
  if (links.length === 0) problems.push('graph has no negative conditioning link');
  for (const { from, link } of links) inspect(link, `${from}.negative`);
  return problems;
}

test('no Klein graph feeds non-empty negative text', () => {
  for (const path of KLEIN_GRAPHS) {
    const problems = negativeTextProblems(readGraph(path));
    assert.deepEqual(problems, [], `${path}\n${problems.join('\n')}`);
  }
});

test('every Klein graph keeps a negative conditioning link on its sampler', () => {
  for (const path of KLEIN_GRAPHS) {
    const graph = readGraph(path);
    const samplers = Object.values(graph).filter(node => SAMPLER_NODES.has(node.class_type));
    assert.ok(samplers.length > 0, `${path} has no sampler`);
    for (const sampler of samplers) {
      assert.ok(isLink(sampler.inputs?.negative), `${path} sampler has no negative link`);
    }
  }
});
