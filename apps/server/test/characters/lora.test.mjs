import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCharacter } from '../../src/characters/model.mjs';
import { KLEIN_REF_WORKFLOW, KLEIN_REF_WORKFLOW_SHA } from '../../src/characters/identity.mjs';
import {
  LORA_DEFAULT_STRENGTH,
  LORA_GENERATOR,
  LORA_MODEL,
  LORA_REASONS,
  LORA_WORKFLOW,
  LORA_WORKFLOW_SHA256,
  LoraError,
  pickLoraJob,
} from '../../src/characters/lora.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const workflowPath = join(root, 'workflows', 'character_lora_klein.api.json');
const paramsPath = join(root, 'workflows', 'character_lora_klein.api.params.json');
const workflowText = readFileSync(workflowPath, 'utf8');
const paramsText = readFileSync(paramsPath, 'utf8');
const graph = JSON.parse(workflowText);
const params = JSON.parse(paramsText);

const NOW = '2026-10-21T12:00:00.000Z';
const sha = (seed) => createHash('sha256').update(String(seed)).digest('hex');
const FRONT_SHA = sha('pip-front');
const LORA_SHA = sha('pip-lora');
const IMAGE_ID = `img_${FRONT_SHA.slice(0, 16)}`;

const OUTPUT_COUNTS = {
  UNETLoader: 1,
  CLIPLoader: 1,
  VAELoader: 1,
  CLIPTextEncode: 1,
  ConditioningZeroOut: 1,
  KSampler: 1,
  VAEDecode: 1,
  SaveImage: 1,
  LoadImage: 2,
  ReferenceMultiLatent: 3,
  LoraLoaderModelOnly: 1,
};

function isLink(value) {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === 'string'
    && Number.isInteger(value[1])
    && value[1] >= 0;
}

function nodeOfClass(classType) {
  const found = Object.entries(graph).filter(([, node]) => node.class_type === classType);
  assert.equal(found.length, 1, `expected exactly one ${classType} node, found ${found.length}`);
  return found[0];
}

function character(overrides = {}) {
  return makeCharacter({
    id: 'chr_1111111111111111',
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown, big white eyes, tiny arms',
      negative: 'no human face, no text',
      identity: { method: 'lora', strength: 0.65, loraFile: 'character_lora.safetensors' },
      images: [{
        sha256: FRONT_SHA,
        width: 768,
        height: 768,
        view: 'front',
        source: 'upload',
        primary: true,
      }],
      seed: 123456789,
      ...(overrides.visual ?? {}),
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'visual')),
  });
}

function trainedRun(overrides = {}) {
  return {
    schema: 'comfyrizz.lora-run/v1',
    ok: true,
    character: { id: 'chr_1111111111111111', revision: 3, name: 'Pip', kind: 'fictional' },
    dataset: { schema: 'comfyrizz.lora-dataset/v1', images: 8, datasetSha256: sha('dataset') },
    lora: {
      path: 'character_lora.safetensors',
      sha256: LORA_SHA,
      bytes: 4096,
      format: 'safetensors',
      tensors: 8,
      ...overrides,
    },
  };
}

test('CCL3c: the workflow is an API graph with the LoRA patching the Klein model', () => {
  assert.ok(graph && typeof graph === 'object' && !Array.isArray(graph));
  for (const key of ['nodes', 'links', 'last_node_id', 'last_link_id', 'extra', 'version']) {
    assert.equal(key in graph, false, `UI export key ${key} is present`);
  }
  for (const [id, node] of Object.entries(graph)) {
    assert.match(id, /^\d+$/, `node id ${id} is not numeric`);
    assert.equal(typeof node.class_type, 'string');
    assert.equal(typeof node.inputs, 'object');
  }
  const [unetId] = nodeOfClass('UNETLoader');
  const [loraId, lora] = nodeOfClass('LoraLoaderModelOnly');
  const [samplerId, sampler] = nodeOfClass('KSampler');
  assert.deepEqual(lora.inputs.model, [unetId, 0]);
  assert.deepEqual(sampler.inputs.model, [loraId, 0]);
  assert.equal(lora.inputs.lora_name, 'character_lora.safetensors');
  assert.ok(lora.inputs.strength_model > 0 && lora.inputs.strength_model <= 1);
  assert.deepEqual(sampler.inputs.positive, ['12', 0]);
  assert.deepEqual(sampler.inputs.negative, ['12', 1]);
  assert.deepEqual(sampler.inputs.latent_image, ['12', 2]);
  assert.equal(typeof samplerId, 'string');
});

test('CCL3c: every linked input and params target exists', () => {
  for (const [id, node] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value)) continue;
      assert.ok(isLink(value), `${id}.${field} is not a [node_id, output_index] link`);
      const [source, output] = value;
      assert.ok(graph[source], `${id}.${field} links to missing node ${source}`);
      const count = OUTPUT_COUNTS[graph[source].class_type];
      if (count !== undefined) {
        assert.ok(output < count, `${id}.${field} uses output ${output} of ${graph[source].class_type}`);
      }
    }
  }

  assert.equal(params.v, 1);
  assert.equal(params.generator, LORA_GENERATOR);
  assert.equal(params.kind, 'still');
  assert.ok(params.map && typeof params.map === 'object' && !Array.isArray(params.map));
  assert.deepEqual(new Set(params.inputs), new Set(Object.keys(params.map)));
  for (const name of params.files) {
    assert.ok(name in params.map, `files declares ${name}, which has no map entry`);
  }
  for (const [name, targetValue] of Object.entries(params.map)) {
    const targets = Array.isArray(targetValue[0]) ? targetValue : [targetValue];
    for (const target of targets) {
      const [nodeId, field] = target;
      assert.ok(graph[nodeId], `${name} points at missing node ${nodeId}`);
      assert.ok(field in graph[nodeId].inputs, `${name} points at ${nodeId}.${field}, which does not exist`);
    }
  }
  assert.deepEqual(params.map.lora, ['13', 'lora_name']);
  assert.deepEqual(params.map.lora_strength, ['13', 'strength_model']);
});

test('CCL3c: the committed workflow hashes to the constant the loader records', () => {
  assert.equal(
    createHash('sha256').update(workflowText).digest('hex'),
    LORA_WORKFLOW_SHA256,
  );
});

test('CCL3c: a trained LoRA asset becomes the LoRA job', () => {
  const job = pickLoraJob(character(), { run: trainedRun(), strength: 0.7 });

  assert.equal(job.method, 'lora');
  assert.equal(job.tier, 'lora');
  assert.equal(job.requestedMethod, 'lora');
  assert.equal(job.workflow, LORA_WORKFLOW);
  assert.equal(job.workflowPath, LORA_WORKFLOW);
  assert.equal(job.workflowSha256, LORA_WORKFLOW_SHA256);
  assert.equal(job.generator, LORA_GENERATOR);
  assert.equal(job.model, LORA_MODEL);
  assert.equal(job.reason, LORA_REASONS.READY);
  assert.equal(job.fallback, false);
  assert.equal(job.fallbackReason, null);
  assert.equal(job.reference, IMAGE_ID);
  assert.equal(job.referenceSha256, FRONT_SHA);

  assert.equal(job.lora.file, 'character_lora.safetensors');
  assert.equal(job.lora.sha256, LORA_SHA);
  assert.equal(job.lora.bytes, 4096);
  assert.equal(job.lora.strength, 0.7);
  assert.equal(job.loraFile, 'character_lora.safetensors');
  assert.equal(job.loraSha256, LORA_SHA);
  assert.equal(job.strength, 0.7);
  assert.equal(job.params.lora, 'character_lora.safetensors');
  assert.equal(job.params.lora_strength, 0.7);
  assert.equal(job.params.image, IMAGE_ID);
  assert.equal(job.params.reference, IMAGE_ID);
  assert.equal(job.params.seed, 123456789);
  assert.equal(job.params.prompt, 'small round coffee bean, glossy brown, big white eyes, tiny arms');
  for (const key of Object.keys(job.params)) {
    assert.ok(key in params.map, `params.${key} has no workflow mapping`);
  }
  assert.equal(job.plan.workflow, LORA_WORKFLOW);
  assert.equal(job.job.workflow, LORA_WORKFLOW);
  assert.equal(job.job.lora, 'character_lora.safetensors');
  assert.equal(job.inputs, job.params);
  assert.equal(job.network, false);
  assert.equal(job.secrets, 'none');
  assert.equal(Object.isFrozen(job), true);
  assert.equal(Object.isFrozen(job.params), true);
  assert.equal(Object.isFrozen(job.lora), true);
  assert.equal(Object.isFrozen(job.plan), true);
  assert.equal(Object.isFrozen(job.job), true);
});

test('CCL3c: a plain asset object uses the default strength and no invented hash', () => {
  const job = pickLoraJob(character(), {
    lora: { file: 'character_lora.safetensors', trigger: 'cchr_pip' },
  });

  assert.equal(job.method, 'lora');
  assert.equal(job.lora.sha256, null);
  assert.equal(job.lora.trigger, 'cchr_pip');
  assert.equal(job.strength, 0.65);
  assert.equal(job.params.lora_strength, 0.65);
});

test('CCL3c: without a trained asset the job falls back to the Klein reference', () => {
  const job = pickLoraJob(character());

  assert.equal(job.method, 'klein_ref');
  assert.equal(job.tier, 'klein_ref');
  assert.equal(job.requestedMethod, 'lora');
  assert.equal(job.workflow, KLEIN_REF_WORKFLOW);
  assert.equal(job.workflowSha256, KLEIN_REF_WORKFLOW_SHA);
  assert.equal(job.reason, LORA_REASONS.MISSING);
  assert.equal(job.fallback, true);
  assert.equal(job.fallbackReason, LORA_REASONS.MISSING);
  assert.equal(job.lora, null);
  assert.equal(job.loraFile, null);
  assert.equal(job.strength, null);
  assert.equal('lora' in job.params, false);
  assert.equal('lora_strength' in job.params, false);
  assert.equal(job.params.image, IMAGE_ID);
  assert.equal(job.plan.method, 'klein_ref');
  assert.equal(job.plan.fallback, true);
  assert.equal(job.job.workflow, KLEIN_REF_WORKFLOW);
  assert.equal(job.network, false);
  assert.equal(job.secrets, 'none');
});

test('CCL3c: a disabled or explicitly non-LoRA tier keeps the Klein fallback', () => {
  const disabled = pickLoraJob(character(), { loraEnabled: false, run: trainedRun() });
  assert.equal(disabled.method, 'klein_ref');
  assert.equal(disabled.reason, LORA_REASONS.DISABLED);
  assert.equal(disabled.fallback, true);
  assert.equal(disabled.lora, null);

  const klein = pickLoraJob(character(), { method: 'klein_ref', run: trainedRun() });
  assert.equal(klein.method, 'klein_ref');
  assert.equal(klein.reason, LORA_REASONS.NOT_REQUESTED);
  assert.equal(klein.fallback, true);
  assert.equal(klein.lora, null);
});

test('CCL3c: unsafe asset paths are refused instead of reaching a job', () => {
  for (const file of ['/absolute/character_lora.safetensors', '../character_lora.safetensors', 'https://example.invalid/lora.safetensors', 'model\\lora.safetensors']) {
    assert.throws(
      () => pickLoraJob(character(), { lora: { file } }),
      (error) => error instanceof LoraError
        && error.code === 'LORA_INVALID_ASSET'
        && error.field === 'file',
      file,
    );
  }
});

test('CCL3c: an invalid digest or strength is refused', () => {
  assert.throws(
    () => pickLoraJob(character(), { lora: { file: 'character_lora.safetensors', sha256: 'not-a-digest' } }),
    (error) => error instanceof LoraError && error.code === 'LORA_INVALID_ASSET',
  );
  assert.throws(
    () => pickLoraJob(character(), { lora: { file: 'character_lora.safetensors' }, strength: 2 }),
    (error) => error instanceof LoraError && error.code === 'LORA_INVALID_STRENGTH',
  );
});

test('CCL3c: the default strength is a usable model weight', () => {
  assert.equal(LORA_DEFAULT_STRENGTH, 0.8);
  const job = pickLoraJob(character({ visual: { identity: { method: 'lora' } } }), { lora: 'character_lora.safetensors' });
  assert.equal(job.strength, LORA_DEFAULT_STRENGTH);
});

test('CCL3c: the job output carries no credential-shaped fields', () => {
  const job = pickLoraJob(character(), { run: trainedRun() });
  const rendered = JSON.stringify(job).toLowerCase();
  for (const name of ['authorization', 'bearer', 'password', 'api_key', 'apikey', 'token=']) {
    assert.equal(rendered.includes(name), false, `job output contains ${name}`);
  }
});
