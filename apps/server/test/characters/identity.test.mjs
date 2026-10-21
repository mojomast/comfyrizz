import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeCharacter } from '../../src/characters/model.mjs';
import {
  DEFAULT_PULID_STRENGTH,
  IDENTITY_REASONS,
  IdentityError,
  KLEIN_REF_WORKFLOW,
  KLEIN_REF_WORKFLOW_SHA,
  PULID_REQUIRED_MODELS,
  PULID_WORKFLOW,
  pickIdentityJob,
  pulidEnabled,
  pulidModelsPresent,
} from '../../src/characters/identity.mjs';

const NOW = '2026-10-21T12:00:00.000Z';
const sha = (seed) => createHash('sha256').update(String(seed)).digest('hex');
const BACK_SHA = sha('pip-back');
const FRONT_SHA = sha('pip-front');

const image = (overrides = {}) => ({
  sha256: FRONT_SHA,
  width: 768,
  height: 768,
  view: 'front',
  source: 'upload',
  primary: true,
  ...overrides,
});

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
      images: [image()],
      seed: 123456789,
      ...(overrides.visual ?? {}),
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'visual')),
  });
}

function pulidCharacter(overrides = {}) {
  return character({
    ...overrides,
    visual: {
      identity: { method: 'pulid', strength: 0.75 },
      ...(overrides.visual ?? {}),
    },
  });
}

test('CCL2c: a character without a tier uses the Klein reference workflow', () => {
  const job = pickIdentityJob(character());

  assert.equal(job.method, 'klein_ref');
  assert.equal(job.tier, 'klein_ref');
  assert.equal(job.requestedMethod, 'klein_ref');
  assert.equal(job.workflow, KLEIN_REF_WORKFLOW);
  assert.equal(job.workflowPath, KLEIN_REF_WORKFLOW);
  assert.equal(job.workflowSha256, KLEIN_REF_WORKFLOW_SHA);
  assert.equal(job.plan.workflow, KLEIN_REF_WORKFLOW);
  assert.equal(job.job.workflow, KLEIN_REF_WORKFLOW);
  assert.equal(job.reference, `img_${FRONT_SHA.slice(0, 16)}`);
  assert.equal(job.params.image, job.reference);
  assert.equal(job.params.reference, job.reference);
  assert.equal(job.params.prompt, 'small round coffee bean, glossy brown, big white eyes, tiny arms');
  assert.equal(job.params.negative, 'no human face, no text');
  assert.equal(job.params.seed, 123456789);
  assert.equal(job.strength, null);
  assert.equal('strength' in job.params, false);
  assert.equal(job.reason, IDENTITY_REASONS.KLEIN_DEFAULT);
  assert.equal(job.fallback, false);
  assert.equal(job.network, false);
  assert.equal(job.secrets, 'none');

  assert.equal(Object.isFrozen(job), true);
  assert.equal(Object.isFrozen(job.params), true);
  assert.equal(Object.isFrozen(job.plan), true);
  assert.equal(Object.isFrozen(job.job), true);
  assert.equal(job.inputs, job.params);
});

test('CCL2c: PuLID is selected only when enabled and the identity models are present', () => {
  const job = pickIdentityJob(pulidCharacter(), {
    pulidEnabled: true,
    models: ['pulid_flux_v0.9.1.safetensors'],
  });

  assert.equal(job.method, 'pulid');
  assert.equal(job.requestedMethod, 'pulid');
  assert.equal(job.workflow, PULID_WORKFLOW);
  assert.equal(job.plan.workflow, PULID_WORKFLOW);
  assert.equal(job.job.workflow, PULID_WORKFLOW);
  assert.equal(job.workflowSha256, null);
  assert.equal(job.reason, IDENTITY_REASONS.PULID_ENABLED);
  assert.equal(job.fallback, false);
  assert.equal(job.strength, 0.75);
  assert.equal(job.params.strength, 0.75);
  assert.equal(job.params.image, `img_${FRONT_SHA.slice(0, 16)}`);
  assert.equal('reference' in job.params, false);
  assert.equal(job.network, false);
});

test('CCL2c: a PuLID character falls back to Klein when the tier is disabled', () => {
  const job = pickIdentityJob(pulidCharacter(), {
    pulidEnabled: false,
    models: PULID_REQUIRED_MODELS,
  });

  assert.equal(job.method, 'klein_ref');
  assert.equal(job.workflow, KLEIN_REF_WORKFLOW);
  assert.equal(job.reason, IDENTITY_REASONS.PULID_DISABLED);
  assert.equal(job.fallback, true);
  assert.equal(job.fallbackReason, IDENTITY_REASONS.PULID_DISABLED);
  assert.equal(job.params.reference, `img_${FRONT_SHA.slice(0, 16)}`);
  assert.equal('strength' in job.params, false);
});

test('CCL2c: a PuLID character falls back to Klein when models are missing', () => {
  for (const models of [undefined, [], {}, { present: false }]) {
    const job = pickIdentityJob(pulidCharacter(), { pulidEnabled: true, models });
    assert.equal(job.method, 'klein_ref');
    assert.equal(job.workflow, KLEIN_REF_WORKFLOW);
    assert.equal(job.reason, IDENTITY_REASONS.PULID_MODELS_MISSING);
    assert.equal(job.fallback, true);
  }
});

test('CCL2c: the character chooses the tier, not the availability of PuLID', () => {
  const job = pickIdentityJob(character(), {
    pulidEnabled: true,
    models: PULID_REQUIRED_MODELS,
  });

  assert.equal(job.method, 'klein_ref');
  assert.equal(job.workflow, KLEIN_REF_WORKFLOW);
  assert.equal(job.reason, IDENTITY_REASONS.KLEIN_DEFAULT);
  assert.equal(job.fallback, false);
});

test('CCL2c: unavailable tiers fall back to Klein with a reason', () => {
  assert.equal(
    pickIdentityJob(character({ visual: { identity: { method: 'ip_adapter' } } })).reason,
    IDENTITY_REASONS.IP_ADAPTER_UNAVAILABLE,
  );
  assert.equal(
    pickIdentityJob(character({ visual: { identity: { method: 'lora' } } })).reason,
    IDENTITY_REASONS.LORA_UNAVAILABLE,
  );
  const unknown = pickIdentityJob({
    kind: 'fictional',
    name: 'Pip',
    visual: { identity: { method: 'face_id' }, images: [] },
  });
  assert.equal(unknown.method, 'klein_ref');
  assert.equal(unknown.reason, IDENTITY_REASONS.UNKNOWN_METHOD);
  assert.equal(unknown.fallback, true);
});

test('CCL2c: an explicit tier request is honoured before the character default', () => {
  const pulid = pickIdentityJob(character(), {
    method: 'pulid',
    pulidEnabled: true,
    modelsPresent: true,
  });
  assert.equal(pulid.method, 'pulid');
  assert.equal(pulid.requestedMethod, 'pulid');

  const klein = pickIdentityJob(pulidCharacter(), {
    method: 'klein_ref',
    pulidEnabled: true,
    modelsPresent: true,
  });
  assert.equal(klein.method, 'klein_ref');
  assert.equal(klein.reason, IDENTITY_REASONS.KLEIN_REQUESTED);
});

test('CCL2c: model presence accepts runtime lists, maps, locks and explicit flags', () => {
  assert.equal(pulidModelsPresent({}), false);
  assert.equal(pulidModelsPresent({ models: [] }), false);
  assert.equal(pulidModelsPresent({ modelsPresent: true }), true);
  assert.equal(pulidModelsPresent({ models: ['pulid_flux_v0.9.1.safetensors'] }), true);
  assert.equal(pulidModelsPresent({ pulidModels: ['pulid_flux_v0.9.1.safetensors'] }), true);
  assert.equal(pulidModelsPresent({ modelsAvailable: true }), true);
  assert.equal(pulidModelsPresent({ models: new Set(['face-model.onnx']) }), true);
  assert.equal(pulidModelsPresent({ models: { 'pulid_flux_v0.9.1.safetensors': true } }), true);
  assert.equal(pulidModelsPresent({ pulid: { enabled: true, models: { pulid: true } } }), true);
  assert.equal(pulidModelsPresent({
    models: [{ target: 'custom_nodes/ComfyUI_PuLID_Flux/pulid_flux_v0.9.1.safetensors' }],
  }), true);
  assert.equal(pulidModelsPresent({
    modelLock: {
      files: [
        { target: 'models/pulid/pulid_flux_v0.9.1.safetensors' },
        { target: 'models/face/antelopev2/glintr100.onnx' },
      ],
    },
  }), true);
  assert.equal(pulidModelsPresent({
    models: ['pulid_flux_v0.9.1.safetensors'],
    requiredModels: ['pulid_flux_v0.9.1.safetensors', 'antelopev2'],
  }), false);
  assert.equal(pulidModelsPresent({
    models: ['pulid_flux_v0.9.1.safetensors', 'antelopev2'],
    requiredModels: ['pulid_flux_v0.9.1.safetensors', 'antelopev2'],
  }), true);
});

test('CCL2c: PuLID options accept the documented spellings', () => {
  assert.equal(pulidEnabled({}), false);
  assert.equal(pulidEnabled({ pulidEnabled: true }), true);
  assert.equal(pulidEnabled({ usePulid: true }), true);
  assert.equal(pulidEnabled({ pulid: true }), true);
  assert.equal(pulidEnabled({ pulid: { enabled: true } }), true);
  assert.equal(pulidEnabled({ features: { pulid: true } }), true);
  assert.equal(pulidEnabled({ enabled: true }), true);
  assert.equal(pulidEnabled({ pulidEnabled: 'false' }), false);
});

test('CCL2c: seed, strength and reference can be overridden without mutating the character', () => {
  const source = character({
    visual: {
      images: [
        image(),
        image({ sha256: BACK_SHA, view: 'back', primary: false }),
      ],
      identity: { method: 'klein_ref', strength: 0.4 },
    },
  });
  const before = structuredClone(source);
  const backId = `img_${BACK_SHA.slice(0, 16)}`;

  const job = pickIdentityJob(source, { seed: 0, strength: 0.6, reference: backId });

  assert.equal(job.params.seed, 0);
  assert.equal(job.seed, 0);
  assert.equal(job.params.strength, 0.6);
  assert.equal(job.strength, 0.6);
  assert.equal(job.reference, backId);
  assert.equal(job.referenceSha256, BACK_SHA);
  assert.equal(job.params.reference, backId);
  assert.deepEqual(source, before);
});

test('CCL2c: the primary image wins by default and a ready sheet is the fallback', () => {
  const twoImages = character({
    visual: {
      images: [
        image({ primary: false }),
        image({ sha256: BACK_SHA, view: 'back', primary: true }),
      ],
    },
  });
  assert.equal(pickIdentityJob(twoImages).reference, `img_${BACK_SHA.slice(0, 16)}`);

  const noImage = makeCharacter({
    id: 'chr_2222222222222222',
    name: 'Mocha',
    handle: 'mocha',
    role: 'narrator',
    summary: 'Warm, patient narrator',
    visual: { identityPrompt: 'tall cocoa-coloured cat', images: [] },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const bare = pickIdentityJob(noImage);
  assert.equal(bare.reference, null);
  assert.equal(bare.params.prompt, 'tall cocoa-coloured cat');
  assert.equal('image' in bare.params, false);
});

test('CCL2c: a cast snapshot plans the same identity job', () => {
  const source = pulidCharacter();
  const direct = pickIdentityJob(source, { pulidEnabled: true, modelsPresent: true });
  const entry = pickIdentityJob({ castId: 'c_pip', snapshot: source }, {
    pulidEnabled: true,
    modelsPresent: true,
  });

  assert.deepEqual(entry, direct);
  assert.equal(entry.characterId, source.id);
  assert.equal(entry.name, 'Pip');
  assert.equal(entry.handle, 'pip');
});

test('CCL2c: PuLID gets a default strength when the character has none', () => {
  const source = character({ visual: { identity: { method: 'pulid' } } });
  const job = pickIdentityJob(source, { pulidEnabled: true, modelsPresent: true });
  assert.equal(job.strength, DEFAULT_PULID_STRENGTH);
  assert.equal(job.params.strength, DEFAULT_PULID_STRENGTH);
});

test('CCL2c: invalid input and non-fictional characters are rejected', () => {
  assert.throws(
    () => pickIdentityJob(null),
    (error) => error instanceof IdentityError && error.code === 'IDENTITY_INVALID_CHARACTER',
  );
  assert.throws(
    () => pickIdentityJob(character(), { method: 7 }),
    (error) => error instanceof IdentityError && error.code === 'IDENTITY_INVALID_METHOD',
  );
  assert.throws(
    () => pickIdentityJob({ kind: 'real_authorized', name: 'Someone', visual: {} }),
    (error) => error instanceof IdentityError && error.code === 'IDENTITY_UNSUPPORTED_KIND',
  );
  assert.throws(
    () => pickIdentityJob(character(), 'enabled'),
    (error) => error instanceof IdentityError && error.code === 'IDENTITY_INVALID_OPTIONS',
  );
});

test('CCL2c: planning is deterministic and uses no network or filesystem IO', () => {
  const source = pulidCharacter();
  const opts = { pulidEnabled: true, modelsPresent: true };
  const first = pickIdentityJob(source, opts);
  const second = pickIdentityJob(source, opts);
  assert.deepEqual(first, second);

  const sourceCode = readFileSync(new URL('../../src/characters/identity.mjs', import.meta.url), 'utf8');
  assert.equal(/from ['"]node:(?:fs|net|http|https|tls|dns)['"]/.test(sourceCode), false);
  assert.equal(/\bfetch\s*\(/.test(sourceCode), false);
  assert.equal(sourceCode.includes('process.env'), false);
});

test('CCL2c: the plan never carries credentials', () => {
  const job = pickIdentityJob(pulidCharacter(), { pulidEnabled: true, modelsPresent: true });
  const serialized = JSON.stringify(job);
  assert.equal(/(?:hf_|sk-|Bearer\s|ya29\.)/.test(serialized), false);
  assert.equal(serialized.includes('process.env'), false);
});
