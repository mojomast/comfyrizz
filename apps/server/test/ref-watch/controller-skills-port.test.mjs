// SP-WIRE: the reference-watch controller uses the SP01 chain default, the SP03
// targeted-edit instruction, and the SP02 Qwen Edit 2511 graph. Scripted fakes
// only: no network, no Comfy, no Google Colab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REF_POLICY_DEFAULTS,
  REF_VERDICT_SCHEMA,
} from '../../../../packages/schema/src/ref-review.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { decide } from '../../src/ref-watch/decide.mjs';
import { estimateRegen } from '../../src/ref-watch/estimate.mjs';
import * as steer from '../../src/ref-watch/steer.mjs';
import { runT0Checks } from '../../src/ref-watch/t0-checks.mjs';
import { createRefWatchController } from '../../src/ref-watch/controller.mjs';

const PROMPT = 'A medium shot of the character standing in warm window light, blue coat buttoned, hands relaxed, face three quarters toward the lens.';
const LOCK = 'Mara has a narrow face, dark cropped hair, and a small scar on her left brow.';
const ITERATION = Object.freeze({ policy: ITERATION_PRESETS.balanced, gpu: 'G4', ceiling: null });
const QWEN_WORKFLOW = 'workflows/qwen_edit_2511_instruct.api.json';

function shaOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

function still(id, extra = {}) {
  return {
    id,
    kind: 'still',
    batch: 'stills',
    outputKind: 'image',
    output: `assets/${id}.png`,
    shotId: id,
    seed: 1000,
    prompt: PROMPT,
    primaryImage: 'assets/hero-primary.png',
    params: { prompt: PROMPT, seed: 1000, reference: 'assets/ref.png' },
    fileInputs: [{ param: 'reference', from: 'package', path: 'assets/ref.png' }],
    dims: { width: 1024, height: 576 },
    characters: [{ characterId: 'hero', identityLock: LOCK, wardrobeState: 'blue coat' }],
    ...extra,
  };
}

function video(id, stillId, extra = {}) {
  return {
    id,
    kind: 'plate',
    batch: 'plates',
    outputKind: 'video',
    output: `assets/${id}.mp4`,
    generator: 'ltx25',
    workflow: 'workflows/ltx25_i2v_2stage.api.json',
    fileInputs: [{ param: 'image', from: 'job', job: stillId, path: `assets/${stillId}.png` }],
    characters: [{ characterId: 'hero', identityLock: LOCK }],
    ...extra,
  };
}

function preview(jobId, digest) {
  return {
    type: 'preview_ready',
    manifest: {
      jobs: [{
        job: jobId,
        status: 'succeeded',
        outputs: [{ relative: `assets/${jobId}.png`, sha256: digest, bytes: 128 }],
      }],
    },
  };
}

const PASS_CHECKS = ['technical', 'identity', 'anatomy', 'framing', 'prompt', 'text_artifact'].map((dimension) => ({
  dimension, pass: true, severity: 'hard', evidence: `${dimension} matches the still`,
}));

function passVerdict(request) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: request.jobId,
    keyframeSha256: request.keyframeSha256,
    reviewer: 'fake',
    overall: 'pass',
    checks: PASS_CHECKS,
    fixHints: [],
  };
}

function textArtifactVerdict(request, hint) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: request.jobId,
    keyframeSha256: request.keyframeSha256,
    reviewer: 'fake',
    overall: 'fail',
    checks: [
      ...PASS_CHECKS.filter((check) => check.dimension !== 'text_artifact'),
      { dimension: 'text_artifact', pass: false, severity: 'hard', evidence: 'the sign has garbled letters' },
    ],
    fixHints: [hint],
  };
}

function ledgerFor(runtimeDir, ledgerId) {
  return createBudgetLedger({
    runtimeDir,
    ledgerId,
    ceiling: 1000,
    userEventId: 'evt_ref_watch_skills_port',
  });
}

test('SP-WIRE: ref-watch still accepts a passing still without any edit job (regression)', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-sp-off-'));
  const jobs = [still('still_plain'), video('video_plain', 'still_plain')];
  const submitted = [];
  const events = [];
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_sp_off', runId: 'run_sp_off', jobs },
    reviewer: async ({ request }) => passVerdict(request),
    t0: runT0Checks,
    decide,
    steer,
    estimate: (input) => estimateRegen(input),
    submitJobs: async (payload) => { submitted.push(payload); },
    budgetLedger: ledgerFor(runtimeDir, 'spoff'),
    onEvent: (event) => { events.push(event); },
    iteration: ITERATION,
    receiptsDir: join(runtimeDir, 'receipts'),
    now: () => '2026-10-30T00:00:00.000Z',
  });
  try {
    await controller.start();
    await controller.handle(preview('still_plain', shaOf('plain')));
    assert.equal(submitted.some((entry) => entry.batch === 'regen'), false);
    assert.equal(submitted.some((entry) => entry.jobs.some((job) => job.generator === 'qwen-edit-2511')), false);
    assert.equal(events.some((event) => event.decision?.action === 'targeted_edit'), false);
    assert.equal(events.some((event) => event.type === 'ref_gate_open' && event.jobId === 'still_plain'), true);
    assert.equal(controller.snapshot().regenJobsUsed, 0);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('SP-WIRE: a text_artifact verdict queues one Qwen edit, re-reviews it, accepts, and counts one regen', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-sp-edit-'));
  const jobs = [still('still_text'), video('video_text', 'still_text')];
  for (let i = 0; i < 7; i += 1) jobs.push(still(`still_pad_${i}`));
  const hint = 'the sign reads OPEN in clean block letters';
  const submitted = [];
  const events = [];
  let textReviews = 0;
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_sp_edit', runId: 'run_sp_edit', jobs },
    reviewer: async ({ request }) => {
      if (request.jobId !== 'still_text') return passVerdict(request);
      textReviews += 1;
      return textReviews === 1 ? textArtifactVerdict(request, hint) : passVerdict(request);
    },
    t0: runT0Checks,
    decide,
    steer,
    estimate: (input) => estimateRegen(input),
    submitJobs: async (payload) => { submitted.push(payload); },
    budgetLedger: ledgerFor(runtimeDir, 'spedit'),
    onEvent: (event) => { events.push(event); },
    iteration: ITERATION,
    receiptsDir: join(runtimeDir, 'receipts'),
    now: () => '2026-10-30T00:00:00.000Z',
  });
  try {
    await controller.start();
    await controller.handle(preview('still_text', shaOf('text-1')));

    const edits = submitted.filter((entry) => entry.jobs.some((job) => job.generator === 'qwen-edit-2511'));
    assert.equal(edits.length, 1, 'exactly one Qwen edit job is queued');
    const edit = edits[0].jobs[0];
    assert.equal(edit.id, 'still_text');
    assert.equal(edit.kind, 'still');
    assert.equal(edit.outputKind, 'image');
    assert.equal(edit.workflow, QWEN_WORKFLOW);
    assert.match(edit.workflowSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      edit.workflowSha256,
      createHash('sha256').update(readFileSync(join(process.cwd(), QWEN_WORKFLOW))).digest('hex'),
    );
    assert.equal(edit.params.instruction, hint);
    assert.equal(edit.params.image, 'assets/still_text.png');
    assert.deepEqual(edit.fileInputs, [{ param: 'image', from: 'package', path: 'assets/still_text.png' }]);
    assert.equal(edit.refEdit.dimension, 'text_artifact');
    assert.match(edit.cacheKey, /^[a-f0-9]{64}$/);

    const afterEdit = controller.snapshot();
    assert.equal(afterEdit.regenJobsUsed, 1, 'the targeted edit counts as one regen');
    assert.equal(afterEdit.states.still_text.attempt, 1);
    assert.equal(afterEdit.states.still_text.editsTried, 1);
    assert.equal(afterEdit.states.still_text.state, 'regenerating');

    const editDecision = events.find((event) => event.jobId === 'still_text' && event.decision?.action === 'targeted_edit');
    assert.ok(editDecision, 'the decision is recorded as targeted_edit');
    assert.equal(editDecision.decision.editInstruction, hint);
    assert.equal(editDecision.decision.attempt, 0);

    await controller.handle(preview('still_text', shaOf('text-2')));

    const accepted = events.find((event) => event.jobId === 'still_text' && event.decision?.action === 'accept');
    assert.ok(accepted, 'the edited still is re-reviewed and accepted');
    const actions = events
      .filter((event) => event.jobId === 'still_text' && event.decision)
      .map((event) => event.decision.action);
    assert.deepEqual(actions, ['targeted_edit', 'accept']);
    const final = controller.snapshot();
    assert.equal(final.regenJobsUsed, 1, 're-review does not add a regen');
    assert.equal(final.states.still_text.editsTried, 1);
    assert.equal(textReviews, 2, 'the edited still went through the same gate');
    assert.equal(submitted.some((entry) => entry.batch === 'video' && entry.jobs.some((job) => job.id === 'video_text')), true);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('SP-WIRE: a chained same-scene shot runs the identity check and falls back to its shot keyframe on failure', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-sp-chain-'));
  const scene = 'scene_01';
  const jobs = [
    still('still_a'),
    video('video_a', 'still_a', { status: 'accepted', shot: { sceneId: scene, index: 0 } }),
    still('still_b'),
    video('video_b', 'still_b', { shot: { sceneId: scene, index: 1 } }),
  ];
  const submitted = [];
  const extracted = [];
  const reviewed = [];
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_sp_chain', runId: 'run_sp_chain', jobs },
    reviewer: async ({ request }) => passVerdict(request),
    t0: runT0Checks,
    decide,
    steer,
    estimate: (input) => estimateRegen(input),
    submitJobs: async (payload) => { submitted.push(payload); },
    budgetLedger: ledgerFor(runtimeDir, 'spchain'),
    onEvent: () => {},
    iteration: ITERATION,
    receiptsDir: join(runtimeDir, 'receipts'),
    now: () => '2026-10-30T00:00:00.000Z',
    extractLastFrame: async (clip) => {
      extracted.push(clip);
      return 'assets/video_a-last.png';
    },
    reviewKeyframe: async (input) => {
      reviewed.push(input);
      return {
        overall: 'pass',
        checks: [{ dimension: 'identity', pass: false, severity: 'hard', evidence: 'face drift' }],
      };
    },
  });
  try {
    await controller.start();
    await controller.handle(preview('still_a', shaOf('chain-a')));
    await controller.handle(preview('still_b', shaOf('chain-b')));

    assert.equal(extracted.length, 1, 'the previous accepted clip is the chain source');
    assert.equal(extracted[0].id, 'video_a');
    assert.equal(reviewed.length, 1, 'the chained frame gets an identity review');
    assert.equal(reviewed[0].kind, 'keyframe');
    assert.equal(reviewed[0].image, 'assets/video_a-last.png');
    assert.deepEqual(reviewed[0].dimensions, ['identity']);
    assert.deepEqual(reviewed[0].characters, [{ characterId: 'hero', identityLock: LOCK }]);

    const videoSubmit = submitted.find((entry) => entry.batch === 'video' && entry.jobs.some((job) => job.id === 'video_b'));
    const videoB = videoSubmit.jobs.find((job) => job.id === 'video_b');
    assert.equal(videoB.chainFromPrevious, true);
    assert.equal(videoB.chainFallback, 'keyframe');
    assert.match(videoB.chainFallbackReason, /identity/i);
    assert.deepEqual(videoB.fileInputs, [{ param: 'image', from: 'job', job: 'still_b', path: 'assets/still_b.png' }]);
    assert.equal(videoB.loadImage, undefined);
    assert.equal(videoB.imgToVideoInplace, undefined);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
