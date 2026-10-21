import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCharacter } from '../../src/characters/model.mjs';
import {
  SHEET_BACKEND_ID,
  SHEET_DEFAULT_BUDGET_UNITS,
  SHEET_DEFAULT_NEGATIVE,
  SHEET_DENOISE,
  SHEET_GENERATOR,
  SHEET_MEGAPIXELS,
  SHEET_MODEL,
  SHEET_STEPS,
  SHEET_WORKFLOW,
  SHEET_WORKFLOW_SHA256,
  SheetError,
  buildSheetJob,
  buildSheetPrompt,
} from '../../src/characters/sheet.mjs';
import { planHashFor } from '../../src/run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..', '..');
const NOW = '2026-10-21T12:00:00.000Z';
const PIP_ID = 'chr_1111111111111111';
const sha = (seed) => createHash('sha256').update(String(seed)).digest('hex');
const PIP_SHA = sha('pip-primary-image');

function character(overrides = {}) {
  const base = {
    schema: 'comfyrizz.character/v1',
    id: PIP_ID,
    revision: 3,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    kind: 'fictional',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown, big white eyes, tiny arms',
      negative: 'no human face',
      palette: ['#5b3a1e', '#f4e9dc'],
      wardrobe: [
        { id: 'w1', label: 'plain', prompt: 'plain cotton shirt' },
        { id: 'w2', label: 'barista apron', prompt: 'green apron with a bean logo', default: true },
      ],
      expressions: [
        { id: 'e1', label: 'delighted', prompt: 'wide smile, eyes closed' },
        { id: 'e2', label: 'curious', prompt: 'one eyebrow raised' },
      ],
      images: [{
        imgId: `img_${PIP_SHA.slice(0, 16)}`,
        view: 'front',
        primary: true,
        source: 'upload',
        sha256: PIP_SHA,
        width: 768,
        height: 768,
      }],
    },
    voice: { engine: 'none', sampleLines: [] },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return makeCharacter({
    ...base,
    ...overrides,
    visual: { ...base.visual, ...(overrides.visual ?? {}) },
  });
}

function noImages() {
  return character({ visual: { images: [] } });
}

const workflowParams = () => JSON.parse(
  readFileSync(join(ROOT, 'workflows', 'flux3_klein_ref_edit.api.params.json'), 'utf8'),
);
const workflowGraph = () => JSON.parse(
  readFileSync(join(ROOT, 'workflows', 'flux3_klein_ref_edit.api.json'), 'utf8'),
);

test('CCL1a: a sheet is one flux3_klein_ref_edit still with front/side/back views', () => {
  const result = buildSheetJob(character());

  assert.equal(result.workflow, 'workflows/flux3_klein_ref_edit.api.json');
  assert.equal(result.workflow, SHEET_WORKFLOW);
  assert.equal(result.workflowSha256, SHEET_WORKFLOW_SHA256);
  assert.equal(result.generator, SHEET_GENERATOR);
  assert.equal(result.model, SHEET_MODEL);
  assert.equal(result.job.workflow, result.workflow);
  assert.equal(result.job.workflowSha256, SHEET_WORKFLOW_SHA256);
  assert.equal(result.job.kind, 'still');
  assert.equal(result.job.outputKind, 'image');
  assert.equal(result.job.output, `assets/${result.assetId}.png`);

  const prompt = result.params.prompt;
  assert.match(prompt, /turnaround sheet/i);
  assert.match(prompt, /front view/i);
  assert.match(prompt, /side view/i);
  assert.match(prompt, /back view/i);
  assert.ok(prompt.indexOf('front view') < prompt.indexOf('side view'));
  assert.ok(prompt.indexOf('side view') < prompt.indexOf('back view'));
  assert.match(prompt, /three-quarter view/i);
  assert.match(prompt, /neutral light grey background/i);
  assert.match(prompt, /small round coffee bean/);
  assert.match(prompt, /green apron with a bean logo/, 'the default wardrobe is part of the sheet');
  assert.match(prompt, /delighted/);
  assert.match(prompt, /#5b3a1e/);
});

test('CCL1a: params only use inputs the existing ref_edit workflow declares', () => {
  const result = buildSheetJob(character({ visual: { seed: 123456789 } }));
  const declared = workflowParams().map;
  for (const key of Object.keys(result.params)) {
    assert.ok(declared[key], `params.${key} has no node mapping in the existing workflow`);
  }
  assert.equal(result.params.reference, `img_${PIP_SHA.slice(0, 16)}`);
  assert.equal(result.params.width, undefined, 'the graph sizes from the reference');
  assert.equal(result.params.height, undefined, 'the graph sizes from the reference');
  assert.equal(result.params.seed, 123456789, 'the locked character seed is used');
  assert.equal(result.params.steps, SHEET_STEPS);
  assert.equal(result.params.denoise, SHEET_DENOISE);
  assert.equal(result.params.megapixels, SHEET_MEGAPIXELS);

  const graph = workflowGraph();
  assert.equal(graph['10'].class_type, 'LoadImage');
  assert.equal(graph['12'].class_type, 'ReferenceMultiLatent');
  assert.equal(declared.reference[0], '10');
  assert.equal(declared.megapixels[0], '12');
});

test('CCL1a: a sheet needs its plan hash approved before it can run', () => {
  const result = buildSheetJob(character());

  assert.match(result.planHash, /^[0-9a-f]{64}$/);
  assert.equal(result.planHash, planHashFor({
    backendId: SHEET_BACKEND_ID,
    jobs: result.jobs,
    budgetUnits: SHEET_DEFAULT_BUDGET_UNITS,
  }));
  assert.equal(result.approvalRequired, true);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.approved, false);
  assert.equal(result.backendId, 'colab');
  assert.equal(result.backend.id, 'colab');
  assert.equal(result.budgetUnits, SHEET_DEFAULT_BUDGET_UNITS);
  assert.equal(result.approval.kind, 'approval_required');
  assert.equal(result.approval.required, true);
  assert.equal(result.approval.approvalRequired, true);
  assert.equal(result.approval.requiresApproval, true);
  assert.equal(result.approval.approved, false);
  assert.equal(result.approval.planHash, result.planHash);
  assert.equal(result.approval.budgetUnits, SHEET_DEFAULT_BUDGET_UNITS);

  const cheaper = buildSheetJob(character(), { budgetUnits: 5 });
  assert.notEqual(cheaper.planHash, result.planHash, 'a changed budget needs a new approval card');

  const otherSeed = buildSheetJob(character(), { seed: 7 });
  assert.notEqual(otherSeed.planHash, result.planHash, 'a changed seed needs a new approval card');
});

test('CCL1a: the job is deterministic and does not mutate the character', () => {
  const input = character();
  const before = structuredClone(input);
  const first = buildSheetJob(input);
  const second = buildSheetJob(input);

  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  assert.equal(first.job.cacheKey, second.job.cacheKey);
  assert.match(first.job.cacheKey, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(JSON.stringify(first)).planHash, first.planHash);
});

test('CCL1a: the seed is locked, fallback is stable, and options can override it', () => {
  const locked = buildSheetJob(character({ visual: { seed: 424242 } }));
  assert.equal(locked.seed, 424242);
  assert.equal(locked.params.seed, 424242);

  const sheetSeed = buildSheetJob(character({ visual: { sheet: { status: 'none', genSeed: 31337 } } }));
  assert.equal(sheetSeed.seed, 31337);

  const fallback = buildSheetJob(character());
  assert.ok(Number.isSafeInteger(fallback.seed) && fallback.seed >= 0 && fallback.seed <= 0xffffffff);
  assert.equal(buildSheetJob(character()).seed, fallback.seed);

  const other = buildSheetJob(character({ id: 'chr_2222222222222222' }));
  assert.notEqual(other.seed, fallback.seed, 'a different character gets a different fallback seed');

  const override = buildSheetJob(character(), { seed: 11 });
  assert.equal(override.seed, 11);
  assert.equal(override.params.seed, 11);
});

test('CCL1a: options tune the same graph without adding nodes', () => {
  const result = buildSheetJob(character(), {
    seed: 5,
    steps: 24,
    denoise: 0.8,
    megapixels: 1.5,
    budgetUnits: 12,
    referencePath: 'characters/chr_1111111111111111/images/img_123.png',
  });
  assert.equal(result.params.steps, 24);
  assert.equal(result.params.denoise, 0.8);
  assert.equal(result.params.megapixels, 1.5);
  assert.equal(result.budgetUnits, 12);
  assert.deepEqual(result.job.fileInputs, [{
    param: 'reference',
    from: 'package',
    path: 'characters/chr_1111111111111111/images/img_123.png',
  }]);
  for (const key of Object.keys(result.params)) {
    assert.ok(workflowParams().map[key], `params.${key} is not declared by the workflow`);
  }
});

test('CCL1a: no primary image means no sheet and no spend', () => {
  assert.throws(
    () => buildSheetJob(noImages()),
    (error) => error instanceof SheetError
      && error.code === 'SHEET_NO_PRIMARY_IMAGE'
      && error.field === 'visual.images',
  );
});

test('CCL1a: invalid options fail before a plan exists', () => {
  const cases = [
    [{ seed: -1 }, 'SHEET_INVALID_SEED'],
    [{ seed: 1.5 }, 'SHEET_INVALID_SEED'],
    [{ steps: 0 }, 'SHEET_INVALID_OPTION'],
    [{ denoise: 2 }, 'SHEET_INVALID_OPTION'],
    [{ megapixels: 0 }, 'SHEET_INVALID_OPTION'],
    [{ budgetUnits: -1 }, 'SHEET_INVALID_OPTION'],
    [{ referencePath: '/absolute.png' }, 'SHEET_INVALID_OPTION'],
    [{ referencePath: 'a/../b.png' }, 'SHEET_INVALID_OPTION'],
  ];
  for (const [options, code] of cases) {
    assert.throws(
      () => buildSheetJob(character(), options),
      (error) => error instanceof SheetError && error.code === code,
      JSON.stringify(options),
    );
  }
});

test('CCL1a: the prompt builder is pure and falls back to the summary', () => {
  const bare = character({ visual: { identityPrompt: '', expressions: [] } });
  const prompt = buildSheetPrompt(bare);
  assert.match(prompt, /Round, cheerful coffee-bean mascot/);
  assert.match(prompt, /neutral, happy, surprised and thoughtful/);
  assert.equal(buildSheetPrompt(bare), prompt);
});

test('CCL1a: user negatives are data in the prompt, not graph inputs', () => {
  const result = buildSheetJob(character());
  assert.match(result.params.prompt, /Negative: /);
  assert.match(result.params.prompt, /no human face/);
  assert.match(result.params.prompt, /no watermark/i);
  assert.equal(result.params.negative, undefined);
  assert.equal(result.negative, `no human face, ${SHEET_DEFAULT_NEGATIVE}`);
});

test('CCL1a: building a sheet makes no network calls', () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network is not allowed while building a sheet');
  };
  try {
    const result = buildSheetJob(character());
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = original;
  }
});
