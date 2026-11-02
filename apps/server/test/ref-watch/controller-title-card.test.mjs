// SPW09: an accepted still named by jobsDoc.titleCards queues one BiRefNet
// cutout batch through SPW08's titleCardJobs. Scripted fakes only: no network,
// no Comfy, no Google Colab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { decide } from '../../src/ref-watch/decide.mjs';
import { estimateRegen } from '../../src/ref-watch/estimate.mjs';
import * as steer from '../../src/ref-watch/steer.mjs';
import { runT0Checks } from '../../src/ref-watch/t0-checks.mjs';
import { createRefWatchController } from '../../src/ref-watch/controller.mjs';
import { TITLE_CARD_BATCH } from '../../src/compositing/title-card.mjs';
import {
  SUBJECT_CUTOUT_GENERATOR,
  SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW,
} from '../../src/compositing/subject-cutout.mjs';

const PROMPT = 'A medium shot of the character standing in warm window light, blue coat buttoned, hands relaxed, face three quarters toward the lens.';
const LOCK = 'Mara has a narrow face, dark cropped hair, and a small scar on her left brow.';
const ITERATION = Object.freeze({ policy: ITERATION_PRESETS.balanced, gpu: 'G4', ceiling: null });

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
    scene: 'scene_01',
    sceneIndex: 0,
    characters: [{ characterId: 'hero', identityLock: LOCK, wardrobeState: 'blue coat' }],
    ...extra,
  };
}

function video(id, stillId) {
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

function ledgerFor(runtimeDir, ledgerId) {
  return createBudgetLedger({
    runtimeDir,
    ledgerId,
    ceiling: 1000,
    userEventId: 'evt_ref_watch_title_card',
  });
}

function controllerFor({ runtimeDir, ledgerId, jobs, titleCards, reviewer, submitted, events }) {
  const jobsDoc = { productionId: `prod_${ledgerId}`, runId: `run_${ledgerId}`, jobs };
  if (titleCards !== undefined) jobsDoc.titleCards = titleCards;
  return createRefWatchController({
    jobsDoc,
    reviewer,
    t0: runT0Checks,
    decide,
    steer,
    estimate: (input) => estimateRegen(input),
    submitJobs: async (payload) => { submitted.push(payload); },
    budgetLedger: ledgerFor(runtimeDir, ledgerId),
    onEvent: (event) => { events.push(event); },
    iteration: ITERATION,
    receiptsDir: join(runtimeDir, 'receipts'),
    now: () => '2026-10-30T00:00:00.000Z',
  });
}

test('SPW09: an accepted title still queues one cutouts batch and emits ref_title_cutout_queued', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-title-card-'));
  const submitted = [];
  const events = [];
  const jobs = [still('still_title'), video('video_title', 'still_title')];
  const titleCards = [{ stillJobId: 'still_title', text: 'Harbor Light' }];
  const controller = controllerFor({
    runtimeDir,
    ledgerId: 'titlecard',
    jobs,
    titleCards,
    reviewer: async ({ request }) => passVerdict(request),
    submitted,
    events,
  });
  try {
    await controller.start();
    await controller.handle(preview('still_title', shaOf('title-still-1')));
    await controller.handle(preview('still_title', shaOf('title-still-1')));

    const cutoutBatches = submitted.filter((entry) => entry.batch === TITLE_CARD_BATCH);
    assert.equal(cutoutBatches.length, 1, 'exactly one cutouts batch per accepted still');
    assert.equal(cutoutBatches[0].jobs.length, 1);
    const [cutout] = cutoutBatches[0].jobs;
    assert.equal(cutout.id, 'still_title.cutout');
    assert.equal(cutout.kind, 'still');
    assert.equal(cutout.batch, TITLE_CARD_BATCH);
    assert.equal(cutout.generator, SUBJECT_CUTOUT_GENERATOR);
    assert.equal(cutout.workflow, SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW);
    assert.equal(cutout.output, 'assets/still_title.cutout.png');
    assert.deepEqual(cutout.params, { image: 'still_title' });
    assert.deepEqual(cutout.deps, ['still_title']);
    assert.deepEqual(cutout.fileInputs, [{ param: 'image', from: 'job', job: 'still_title', path: 'assets/still_title.png' }]);

    const queued = events.filter((event) => event.type === 'ref_title_cutout_queued');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].jobId, 'still_title');
    assert.equal(queued[0].cutoutJobId, 'still_title.cutout');

    const videoSubmit = submitted.find((entry) => entry.batch === 'video');
    assert.equal(videoSubmit.jobs.some((job) => job.id === 'video_title'), true, 'videos are not gated on cutouts');
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('SPW09: a held title still queues no cutout', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-title-held-'));
  const submitted = [];
  const events = [];
  const jobs = [still('still_held'), video('video_held', 'still_held')];
  const titleCards = [{ stillJobId: 'still_held', text: 'Held Card' }];
  const controller = controllerFor({
    runtimeDir,
    ledgerId: 'titleheld',
    jobs,
    titleCards,
    reviewer: async () => { throw new Error('reviewer unavailable'); },
    submitted,
    events,
  });
  try {
    await controller.start();
    await controller.handle(preview('still_held', shaOf('held-still-1')));

    assert.equal(events.some((event) => event.type === 'ref_gate_held' && event.jobId === 'still_held'), true);
    assert.equal(submitted.some((entry) => entry.batch === TITLE_CARD_BATCH), false);
    assert.equal(events.some((event) => event.type === 'ref_title_cutout_queued'), false);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('SPW09: no titleCards leaves the controller unchanged', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-title-absent-'));
  const submitted = [];
  const events = [];
  const jobs = [still('still_plain'), video('video_plain', 'still_plain')];
  const controller = controllerFor({
    runtimeDir,
    ledgerId: 'titleabsent',
    jobs,
    reviewer: async ({ request }) => passVerdict(request),
    submitted,
    events,
  });
  try {
    await controller.start();
    await controller.handle(preview('still_plain', shaOf('plain-still-1')));

    assert.equal(events.some((event) => event.type === 'ref_gate_open' && event.jobId === 'still_plain'), true);
    assert.equal(submitted.some((entry) => entry.batch === TITLE_CARD_BATCH), false);
    assert.equal(events.some((event) => event.type === 'ref_title_cutout_queued'), false);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
