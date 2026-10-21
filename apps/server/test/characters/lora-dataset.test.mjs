import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeCharacter } from '../../src/characters/model.mjs';
import {
  ALLOWED_KINDS,
  HASH_ALGORITHM,
  LORA_DATASET_SCHEMA,
  LORA_DATASET_VERSION,
  MAX_IMAGES,
  MIN_IMAGES,
  buildLoraDataset,
  hashManifest,
  manifestHash,
  serializeDataset,
  stableStringify,
} from '../../src/characters/lora-dataset.mjs';

const NOW = '2026-10-21T12:00:00.000Z';
const ID = 'chr_0123456789abcdef';
const sha = (seed) => createHash('sha256').update(String(seed)).digest('hex');
const VIEWS = ['front', 'three_quarter', 'side', 'back', 'expression', 'full_body', 'other', 'front'];

function image(seed, index = 0) {
  const digest = sha(seed);
  return {
    imgId: `img_${digest.slice(0, 16)}`,
    view: VIEWS[index % VIEWS.length],
    primary: index === 0,
    source: 'upload',
    sha256: digest,
    width: 768,
    height: 768,
  };
}

function images(count = MIN_IMAGES, offset = 0) {
  return Array.from({ length: count }, (_, index) => image(`pip-${offset + index}`, index));
}

function base(overrides = {}) {
  const { visual, voice, bible, ...rest } = overrides;
  return {
    id: ID,
    revision: 3,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    kind: 'fictional',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown, big white eyes, tiny arms',
      negative: 'no human face, no text',
      style: 'flat 3D, soft studio light',
      wardrobe: [{ id: 'w1', label: 'barista apron', prompt: 'green apron with bean logo', default: true }],
      expressions: [{ id: 'e1', label: 'delighted', prompt: 'wide smile, eyes closed' }],
      images: images(),
      ...visual,
    },
    voice: { engine: 'none', sampleLines: [], ...voice },
    bible: { personality: 'upbeat', speakingStyle: 'short sentences', ...bible },
    tags: ['coffee'],
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  };
}

function character(overrides = {}) {
  return makeCharacter(base(overrides));
}

function plain(overrides = {}) {
  return structuredClone(base(overrides));
}

function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reordered(entry)]));
  }
  return value;
}

function throwsCode(fn, code, message) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, message);
    assert.equal(error.name, 'LoraDatasetError');
    return true;
  });
}

test('CCL3a: builds captions and an image list from a character', () => {
  const pip = character();
  const dataset = buildLoraDataset(pip, { imageExtension: 'jpg' });

  assert.equal(dataset.schema, LORA_DATASET_SCHEMA);
  assert.equal(dataset.version, LORA_DATASET_VERSION);
  assert.deepEqual(dataset.character, {
    id: ID,
    name: 'Pip',
    handle: 'pip',
    revision: 3,
    kind: 'fictional',
  });
  assert.equal(dataset.trigger, 'cchr_pip');
  assert.equal(dataset.negative, 'no human face, no text');
  assert.equal(dataset.imageCount, MIN_IMAGES);
  assert.equal(dataset.captionCount, MIN_IMAGES);
  assert.equal(dataset.images.length, MIN_IMAGES);
  assert.equal(dataset.captions.length, MIN_IMAGES);
  assert.deepEqual(dataset.captions, dataset.images.map((entry) => entry.caption));

  for (const entry of dataset.images) {
    assert.match(entry.imgId, /^img_[0-9a-f]{16}$/);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.filename, `${entry.imgId}.jpg`);
    assert.ok(entry.caption.startsWith('cchr_pip, '));
    assert.match(entry.caption, /small round coffee bean/);
    assert.match(entry.caption, /green apron with bean logo/);
  }

  const front = dataset.images.find((entry) => entry.view === 'front');
  const expression = dataset.images.find((entry) => entry.view === 'expression');
  assert.match(front.caption, /front view/);
  assert.match(expression.caption, /expression close-up/);
  assert.match(expression.caption, /wide smile, eyes closed/);

  assert.equal(dataset.hash.algorithm, HASH_ALGORITHM);
  assert.match(dataset.manifestHash, /^[0-9a-f]{64}$/);
  assert.equal(dataset.hash.value, dataset.manifestHash);
  assert.equal(dataset.datasetHash, dataset.manifestHash);
  assert.ok(Object.isFrozen(dataset));
  assert.ok(Object.isFrozen(dataset.images));
  assert.ok(Object.isFrozen(dataset.images[0]));
});

test('CCL3a: image order and object key order do not change the manifest hash', () => {
  const forward = character();
  const reversed = character({ visual: { images: images().slice().reverse() } });
  const first = buildLoraDataset(forward);
  const second = buildLoraDataset(reversed);

  assert.deepEqual(first.images, second.images);
  assert.deepEqual(first.captions, second.captions);
  assert.equal(first.manifestHash, second.manifestHash);

  const keyShuffled = reordered(plain());
  const third = buildLoraDataset(keyShuffled);
  assert.equal(first.manifestHash, third.manifestHash);
  assert.equal(manifestHash(first), first.manifestHash);
  assert.equal(hashManifest(third), third.manifestHash);
  assert.equal(stableStringify(first), serializeDataset(first).trim());
});

test('CCL3a: fewer than the minimum images fails with LORA_TOO_FEW_IMAGES', () => {
  const short = character({ visual: { images: images(MIN_IMAGES - 1) } });
  throwsCode(() => buildLoraDataset(short), 'LORA_TOO_FEW_IMAGES', '7 images must be rejected');

  assert.throws(
    () => buildLoraDataset(character({ visual: { images: [] } })),
    (error) => {
      assert.equal(error.code, 'LORA_TOO_FEW_IMAGES');
      assert.equal(error.required, MIN_IMAGES);
      assert.equal(error.actual, 0);
      return true;
    },
  );

  assert.throws(
    () => buildLoraDataset(short),
    (error) => {
      assert.equal(error.code, 'LORA_TOO_FEW_IMAGES');
      assert.equal(error.actual, MIN_IMAGES - 1);
      return true;
    },
  );
});

test('CCL3a: more than the maximum images fails with LORA_TOO_MANY_IMAGES', () => {
  const tooMany = plain({ visual: { images: images(MAX_IMAGES + 1) } });
  throwsCode(() => buildLoraDataset(tooMany), 'LORA_TOO_MANY_IMAGES', '9 images must be rejected');
});

test('CCL3a: fictional characters are accepted and real_authorized needs consent', () => {
  const fictional = character();
  assert.equal(buildLoraDataset(fictional).character.kind, 'fictional');
  assert.deepEqual(ALLOWED_KINDS, ['fictional', 'real_authorized']);

  const real = plain({ kind: 'real_authorized' });
  throwsCode(() => buildLoraDataset(real), 'LORA_CONSENT_REQUIRED', 'real characters need consent');

  const consented = buildLoraDataset(real, {
    consent: {
      assertedBy: 'Authorized Representative',
      assertedAt: NOW,
      scope: 'lora-training',
      likenessWarningShown: true,
    },
  });
  assert.equal(consented.character.kind, 'real_authorized');
  assert.deepEqual(consented.consent, {
    assertedBy: 'Authorized Representative',
    assertedAt: NOW,
    scope: 'lora-training',
    likenessWarningShown: true,
  });

  throwsCode(
    () => buildLoraDataset(real, {
      consent: {
        assertedBy: 'Authorized Representative',
        assertedAt: NOW,
        scope: 'lora-training',
        likenessWarningShown: false,
      },
    }),
    'LORA_CONSENT_REQUIRED',
    'the likeness warning must be shown',
  );

  throwsCode(
    () => buildLoraDataset(plain({ kind: 'public_figure' })),
    'LORA_KIND_UNSUPPORTED',
    'unknown kinds are rejected',
  );
});

test('CCL3a: duplicate and malformed images are rejected', () => {
  const duplicate = images();
  duplicate[7] = { ...duplicate[6] };
  throwsCode(
    () => buildLoraDataset(plain({ visual: { images: duplicate } })),
    'LORA_DUPLICATE_IMAGE',
    'duplicate sha256 values are rejected',
  );

  const badSha = images();
  badSha[2] = { ...badSha[2], sha256: 'not-a-digest' };
  throwsCode(
    () => buildLoraDataset(plain({ visual: { images: badSha } })),
    'LORA_INVALID_IMAGE',
    'invalid sha256 values are rejected',
  );

  const badView = images();
  badView[1] = { ...badView[1], view: 'profile' };
  throwsCode(
    () => buildLoraDataset(plain({ visual: { images: badView } })),
    'LORA_INVALID_IMAGE',
    'unknown views are rejected',
  );
});

test('CCL3a: trigger and extension options are validated', () => {
  const pip = character();
  const custom = buildLoraDataset(pip, { trigger: 'sks-pip' });
  assert.equal(custom.trigger, 'sks-pip');
  assert.ok(custom.captions.every((caption) => caption.startsWith('sks-pip, ')));
  assert.equal(custom.manifestHash, buildLoraDataset(pip, { trigger: 'sks-pip' }).manifestHash);
  assert.notEqual(custom.manifestHash, buildLoraDataset(pip).manifestHash);

  throwsCode(() => buildLoraDataset(pip, { trigger: 'not a trigger' }), 'LORA_INVALID_TRIGGER');
  throwsCode(() => buildLoraDataset(pip, { imageExtension: 'gif' }), 'LORA_INVALID_OPTIONS');
});

test('CCL3a: the builder does not mutate its input and emits no secret values', () => {
  const pip = plain();
  const before = structuredClone(pip);
  const dataset = buildLoraDataset(pip);
  assert.deepEqual(pip, before);

  const text = serializeDataset(dataset);
  assert.doesNotMatch(text, /api[_-]?key|authorization|bearer\s|secret|token/i);
  assert.equal(JSON.parse(text).manifestHash, dataset.manifestHash);
});
