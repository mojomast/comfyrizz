// RW08: reference watch controller. Fake Google Colab backend, fake Comfy, scripted Pi reviewer.
// No network, no GPU. The production regen cap is refRegenJobCap(stillCount).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REF_EVENTS,
  REF_POLICY_DEFAULTS,
  REF_VERDICT_SCHEMA,
  refRegenJobCap,
} from '../../../../packages/schema/src/ref-review.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { estimateRegen } from '../../src/ref-watch/estimate.mjs';
import { runT0Checks } from '../../src/ref-watch/t0-checks.mjs';
import { decide } from '../../src/ref-watch/decide.mjs';
import * as steer from '../../src/ref-watch/steer.mjs';
import { createRefWatchController } from '../../src/ref-watch/controller.mjs';

const PROMPT = 'A medium shot of the character standing in warm window light, blue coat buttoned, hands relaxed at their sides, five fingers clearly visible, face turned three quarters toward the lens.';
const LOCK = 'Mara is a woman in her thirties with a narrow face, dark cropped hair, and a small scar on her left brow.';
const SECRET = 'super-secret-key';
const ITERATION = Object.freeze({ policy: ITERATION_PRESETS.balanced, gpu: 'G4', ceiling: null });

function shaOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

function still(id, extra = {}) {
  const reference = extra.reference ?? 'assets/ref.png';
  return {
    id,
    kind: 'still',
    batch: 'stills',
    outputKind: 'image',
    output: `assets/${id}.png`,
    shotId: id,
    seed: 1000,
    prompt: PROMPT,
    primaryImage: extra.primaryImage ?? 'assets/hero-primary.png',
    params: { prompt: PROMPT, seed: 1000, reference },
    fileInputs: [{ param: 'reference', from: 'package', path: reference }],
    dims: { width: 1024, height: 576 },
    characters: extra.characters ?? [{ characterId: 'hero', identityLock: LOCK, wardrobeState: 'blue coat' }],
    ...(extra.currentKeyframeSha256 ? { currentKeyframeSha256: extra.currentKeyframeSha256 } : {}),
  };
}

function video(id, stillId) {
  return {
    id,
    kind: 'plate',
    batch: 'plates',
    outputKind: 'video',
    output: `assets/${id}.mp4`,
    fileInputs: [{ param: 'image', from: 'job', job: stillId, path: `assets/${stillId}.png` }],
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

function passVerdict(request) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: request.jobId,
    keyframeSha256: request.keyframeSha256,
    reviewer: 'fake',
    overall: 'pass',
    checks: ['technical', 'identity', 'anatomy', 'framing', 'prompt', 'text_artifact'].map((dimension) => ({
      dimension, pass: true, severity: 'hard', evidence: `${dimension} matches the still`,
    })),
    fixHints: [],
  };
}

function failVerdict(request, dimension) {
  const hint = dimension === 'anatomy'
    ? 'five fingers clearly visible on each hand'
    : 'the face matches the identity lock exactly';
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: request.jobId,
    keyframeSha256: request.keyframeSha256,
    reviewer: 'fake',
    overall: 'fail',
    checks: [
      { dimension, pass: false, severity: 'hard', evidence: `${dimension} does not match the still` },
      { dimension: 'framing', pass: true, severity: 'soft', evidence: 'the frame holds the subject' },
    ],
    fixHints: [hint],
  };
}

function holdOf(sample) {
  return sample.units.high;
}

function ledgerFor(runtimeDir, ledgerId, ceiling) {
  return createBudgetLedger({
    runtimeDir,
    ledgerId,
    ceiling,
    userEventId: 'evt_ref_watch',
  });
}

function deps(videoId, jobs) {
  const job = jobs.find((entry) => entry.id === videoId);
  return (job?.fileInputs ?? []).filter((input) => input?.from === 'job').map((input) => input.job);
}

test('four scripted stills: pass, anatomy regen, identity replace_ref then escalate, reviewer error held', async () => {
  assert.equal(refRegenJobCap(4), 1);
  assert.equal(refRegenJobCap(12), 3);
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network disabled'); };

  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-'));
  const receiptsDir = join(runtimeDir, 'receipts');
  const sample = estimateRegen({
    decision: { action: 'reprompt', attempt: 0, jobId: 'still_anatomy' },
    shot: { id: 'still_anatomy', kind: 'still' },
    regenJobsUsed: 0,
    stillCount: 12,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });
  const hold = holdOf(sample);
  let ceiling = 0;
  for (let i = 0; i < 3; i += 1) ceiling = Number((ceiling + hold).toPrecision(12));
  const budgetLedger = ledgerFor(runtimeDir, 'refwatch12', ceiling);

  const jobs = [
    still('still_pass'),
    video('video_pass', 'still_pass'),
    still('still_anatomy'),
    video('video_anatomy', 'still_anatomy'),
    still('still_identity', {
      reference: 'assets/villain-old.png',
      primaryImage: 'assets/villain-primary.png',
      characters: [{ characterId: 'villain', identityLock: LOCK, wardrobeState: 'black coat' }],
    }),
    video('video_identity', 'still_identity'),
    still('still_error'),
    video('video_error', 'still_error'),
  ];
  for (let i = 0; i < 8; i += 1) jobs.push(still(`still_cap_${i}`));

  const comfy = [];
  const timeline = [];
  const estimates = [];
  let tick = 0;
  const calls = { anatomy: 0, identity: 0, error: 0, pi: 0 };

  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_watch', runId: 'run_watch', jobs },
    reviewer: async ({ request }) => {
      calls.pi += 1;
      if (request.jobId === 'still_error') {
        calls.error += 1;
        throw new Error(`reviewer blew up OPENCODE_GO_API_KEY=${SECRET}`);
      }
      if (request.jobId === 'still_pass' || request.jobId.startsWith('still_cap_')) return passVerdict(request);
      if (request.jobId === 'still_anatomy') {
        calls.anatomy += 1;
        return calls.anatomy === 1 ? failVerdict(request, 'anatomy') : passVerdict(request);
      }
      calls.identity += 1;
      return failVerdict(request, 'identity');
    },
    t0: runT0Checks,
    decide,
    steer,
    estimate: (input) => {
      const result = estimateRegen(input);
      estimates.push(result);
      return result;
    },
    submitJobs: async ({ jobs: batchJobs, batch }) => {
      for (const job of batchJobs) comfy.push({ id: job.id, seed: job.seed, batch });
      timeline.push({ kind: 'submit', batch, ids: batchJobs.map((job) => job.id), jobs: batchJobs });
    },
    budgetLedger,
    onEvent: (event) => { timeline.push({ kind: 'event', ...event }); },
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
    receiptsDir,
    now: () => new Date(Date.UTC(2026, 9, 30, 0, 0, 0, tick++)).toISOString(),
    reviewTimeoutMs: 1000,
  });

  try {
    await controller.start();
    await controller.handle(preview('still_pass', shaOf('pass')));
    await controller.handle(preview('still_anatomy', shaOf('anatomy-1')));
    await controller.handle(preview('still_anatomy', shaOf('anatomy-2')));
    await controller.handle(preview('still_identity', shaOf('identity-1')));
    await controller.handle(preview('still_identity', shaOf('identity-2')));
    await controller.handle(preview('still_identity', shaOf('identity-3')));
    await controller.handle(preview('still_error', shaOf('error')));

    const submits = timeline.filter((entry) => entry.kind === 'submit');
    assert.equal(submits[0].batch, 'stills');
    assert.ok(submits[0].ids.includes('still_pass'));
    assert.ok(submits[0].ids.includes('still_anatomy'));
    assert.ok(submits[0].ids.includes('still_identity'));
    assert.ok(submits[0].ids.includes('still_error'));
    assert.equal(submits[0].ids.some((id) => id.startsWith('video_')), false);

    const videos = submits.filter((entry) => entry.batch === 'video').flatMap((entry) => entry.ids);
    assert.deepEqual(videos, ['video_pass', 'video_anatomy']);

    const opened = new Set();
    for (const entry of timeline) {
      if (entry.kind === 'event' && entry.type === 'ref_gate_open') opened.add(entry.jobId);
      if (entry.kind === 'submit' && entry.batch === 'video') {
        for (const id of entry.ids) {
          for (const dep of deps(id, jobs)) assert.ok(opened.has(dep), `${id} ran before ${dep} was accepted`);
        }
      }
    }

    const regens = submits.filter((entry) => entry.batch === 'regen');
    assert.equal(regens.length, 3);
    assert.equal(regens.filter((entry) => entry.ids[0] === 'still_anatomy').length, 1);
    assert.equal(regens.filter((entry) => entry.ids[0] === 'still_identity').length, 2);
    assert.ok(regens.length <= refRegenJobCap(12));
    const perStill = { still_anatomy: 0, still_identity: 0, still_pass: 0, still_error: 0 };
    for (const entry of regens) perStill[entry.ids[0]] += 1;
    assert.ok(Object.values(perStill).every((count) => count <= REF_POLICY_DEFAULTS.maxRegensPerStill));

    const anatomyRegen = regens.find((entry) => entry.ids[0] === 'still_anatomy').jobs[0];
    assert.notEqual(anatomyRegen.seed, 1000);
    assert.deepEqual(anatomyRegen.fileInputs, jobs[2].fileInputs);
    assert.equal(anatomyRegen.params.prompt.includes('<steer>'), false);

    const identityRegens = regens.filter((entry) => entry.ids[0] === 'still_identity');
    assert.deepEqual(identityRegens[0].jobs[0].fileInputs, jobs[4].fileInputs);
    assert.equal(identityRegens[1].jobs[0].fileInputs[0].path, 'assets/villain-primary.png');
    assert.notEqual(identityRegens[0].jobs[0].seed, identityRegens[1].jobs[0].seed);

    const identityActions = timeline
      .filter((entry) => entry.kind === 'event' && entry.jobId === 'still_identity' && entry.decision)
      .map((entry) => entry.decision.action);
    assert.deepEqual(identityActions, ['reprompt', 'replace_ref', 'escalate']);

    const anatomyActions = timeline
      .filter((entry) => entry.kind === 'event' && entry.jobId === 'still_anatomy' && entry.decision)
      .map((entry) => entry.decision.action);
    assert.deepEqual(anatomyActions, ['reprompt', 'accept']);

    assert.equal(timeline.some((entry) => entry.jobId === 'still_error' && entry.type === 'ref_review_error'), true);
    assert.equal(timeline.some((entry) => entry.jobId === 'still_error' && entry.type === 'ref_gate_held'), true);
    assert.equal(timeline.some((entry) => entry.jobId === 'still_error' && entry.type === 'ref_gate_open'), false);
    assert.equal(timeline.some((entry) => entry.jobId === 'still_identity' && entry.type === 'ref_gate_open'), false);

    for (const entry of regens) {
      const prior = timeline.slice(0, timeline.indexOf(entry)).reverse().find((item) => item.jobId === entry.ids[0] && (item.type === 'ref_regen_estimate' || item.type === 'ref_regen_queued' || item.type === 'ref_review_verdict'));
      assert.equal(prior.type, 'ref_regen_estimate');
      assert.match(prior.estimate.label, /estimate/);
    }
    assert.equal(estimates.length, 3);
    assert.equal(estimates.every((result) => result.blocked === false), true);

    const status = budgetLedger.status();
    assert.ok(status.committed + status.spent <= status.ceiling);
    assert.equal(status.openReservations.length, 3);

    const events = timeline.filter((entry) => entry.kind === 'event');
    for (const event of events) {
      assert.ok(REF_EVENTS.includes(event.type) || event.type === 'ref_regen_estimate', event.type);
      assert.equal(event.productionId, 'prod_watch');
      assert.equal(typeof event.jobId, 'string');
      assert.match(event.keyframeSha256, /^[a-f0-9]{64}$/);
    }
    const byJob = new Map();
    for (const event of events) {
      if (!REF_EVENTS.includes(event.type)) continue;
      const list = byJob.get(event.jobId) ?? [];
      list.push(event.type);
      byJob.set(event.jobId, list);
    }
    for (const [jobId, types] of byJob) {
      let last = -1;
      for (const type of types) {
        const index = REF_EVENTS.indexOf(type);
        if (type === 'ref_review_started') {
          last = index;
          continue;
        }
        assert.ok(index >= last, `${jobId} emitted ${type} out of REF_EVENTS order`);
        last = index;
      }
    }

    const evidenceNames = [
      shaOf('pass'), shaOf('anatomy-1'), shaOf('anatomy-2'),
      shaOf('identity-1'), shaOf('identity-2'), shaOf('identity-3'), shaOf('error'),
    ];
    const dumped = [];
    for (const name of evidenceNames) {
      const body = JSON.parse(readFileSync(join(receiptsDir, 'ref-review', `${name}.json`), 'utf8'));
      dumped.push(JSON.stringify(body));
      assert.equal(body.imageSha256, name);
      assert.equal(body.keyframeSha256, name);
      assert.ok(body.decision);
      assert.ok(Array.isArray(body.verdicts) && body.verdicts.length > 0);
    }
    const blob = `${JSON.stringify(timeline)}\n${dumped.join('\n')}\n${JSON.stringify(comfy)}`;
    assert.equal(blob.includes(SECRET), false);
    assert.equal(calls.pi > 0, true);
    assert.equal(comfy.some((job) => job.id.startsWith('video_') && job.batch !== 'video'), false);
  } finally {
    globalThis.fetch = fetch;
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('a four-still production queues only one regen', async () => {
  assert.equal(refRegenJobCap(4), 1);
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-cap-'));
  const sample = estimateRegen({
    decision: { action: 'reprompt', attempt: 0, jobId: 'still_a' },
    shot: { id: 'still_a', kind: 'still' },
    regenJobsUsed: 0,
    stillCount: 4,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });
  const budgetLedger = ledgerFor(runtimeDir, 'refwatch4', sample.units.high * 10);
  const jobs = [];
  for (const id of ['still_a', 'still_b', 'still_c', 'still_d']) {
    jobs.push(still(id), video(`video_${id}`, id));
  }
  const submitted = [];
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_cap', runId: 'run_cap', jobs },
    reviewer: async ({ request }) => failVerdict(request, 'anatomy'),
    t0: runT0Checks,
    decide,
    steer,
    estimate: (input) => estimateRegen(input),
    submitJobs: async (payload) => { submitted.push(payload); },
    budgetLedger,
    onEvent: () => {},
    iteration: ITERATION,
    receiptsDir: join(runtimeDir, 'receipts'),
    now: () => '2026-10-30T00:00:00.000Z',
  });
  try {
    await controller.start();
    for (const id of ['still_a', 'still_b', 'still_c', 'still_d']) {
      await controller.handle(preview(id, shaOf(id)));
    }
    const regens = submitted.filter((entry) => entry.batch === 'regen');
    assert.equal(regens.length, 1);
    assert.ok(regens.length <= refRegenJobCap(4));
    assert.equal(submitted.some((entry) => entry.batch === 'video'), false);
    const status = budgetLedger.status();
    assert.ok(status.committed + status.spent <= status.ceiling);
    assert.equal(status.openReservations.length, 1);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('a T0 hard fail skips Pi and a reviewer timeout holds only that shot', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-t0-'));
  const budgetLedger = ledgerFor(runtimeDir, 'refwatcht0', 1000);
  let piCalls = 0;
  const events = [];
  const submitted = [];
  const jobs = [
    still('still_flat', { dims: { width: 1024, height: 576 } }),
    video('video_flat', 'still_flat'),
    still('still_slow'),
    video('video_slow', 'still_slow'),
    still('still_ok'),
    video('video_ok', 'still_ok'),
  ];
  // Pad to keep the production cap from being the subject of this test.
  for (let i = 0; i < 8; i += 1) jobs.push(still(`still_pad_${i}`));

  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_t0', runId: 'run_t0', jobs },
    reviewer: ({ request }) => {
      piCalls += 1;
      if (request.jobId === 'still_flat') throw new Error('Pi must not run after a T0 hard fail');
      if (request.jobId === 'still_slow') return new Promise(() => {});
      return passVerdict(request);
    },
    t0: runT0Checks,
    decide,
    steer,
    estimate: (input) => estimateRegen(input),
    submitJobs: async (payload) => { submitted.push(payload); },
    budgetLedger,
    onEvent: (event) => { events.push(event); },
    iteration: ITERATION,
    receiptsDir: join(runtimeDir, 'receipts'),
    now: () => '2026-10-30T00:00:00.000Z',
    reviewTimeoutMs: 30,
    measure: ({ job }) => {
      if (job.id === 'still_flat') return { width: 100, height: 100, stats: { mean: 10, stddev: 12 } };
      return { width: 1024, height: 576, stats: { mean: 40, stddev: 12 } };
    },
  });
  try {
    await controller.start();
    await controller.handle(preview('still_flat', shaOf('flat')));
    assert.equal(piCalls, 0);
    assert.equal(events.some((event) => event.jobId === 'still_flat' && event.verdict?.reviewer === 't0'), true);

    await controller.handle({
      type: 'preview_ready',
      manifest: {
        jobs: [
          { job: 'still_slow', status: 'succeeded', outputs: [{ relative: 'assets/still_slow.png', sha256: shaOf('slow'), bytes: 8 }] },
          { job: 'still_ok', status: 'succeeded', outputs: [{ relative: 'assets/still_ok.png', sha256: shaOf('ok'), bytes: 8 }] },
        ],
      },
    });
    assert.equal(events.some((event) => event.jobId === 'still_slow' && event.type === 'ref_review_error'), true);
    assert.equal(events.some((event) => event.jobId === 'still_slow' && event.type === 'ref_gate_open'), false);
    assert.ok(submitted.some((entry) => entry.batch === 'video' && entry.jobs.some((job) => job.id === 'video_ok')));
    assert.equal(submitted.some((entry) => entry.batch === 'video' && entry.jobs.some((job) => job.id === 'video_slow')), false);
    assert.equal(submitted.some((entry) => entry.batch === 'video' && entry.jobs.some((job) => job.id === 'video_flat')), false);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('a stale keyframe sha refuses the video job', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-stale-'));
  const budgetLedger = ledgerFor(runtimeDir, 'refwatchstale', 1000);
  const current = 'b'.repeat(64);
  const jobs = [
    still('still_stale', { currentKeyframeSha256: current }),
    video('video_stale', 'still_stale'),
  ];
  const submitted = [];
  const events = [];
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_stale', runId: 'run_stale', jobs },
    reviewer: async ({ request }) => passVerdict(request),
    t0: runT0Checks,
    decide,
    steer,
    estimate: (input) => estimateRegen(input),
    submitJobs: async (payload) => { submitted.push(payload); },
    budgetLedger,
    onEvent: (event) => { events.push(event); },
    iteration: ITERATION,
    receiptsDir: join(runtimeDir, 'receipts'),
    now: () => '2026-10-30T00:00:00.000Z',
  });
  try {
    await controller.start();
    await controller.handle(preview('still_stale', shaOf('stale-frame')));
    assert.equal(events.some((event) => event.jobId === 'still_stale' && event.type === 'ref_gate_open'), true);
    assert.equal(submitted.some((entry) => entry.batch === 'video'), false);
    const held = events.find((event) => event.jobId === 'video_stale' && event.type === 'ref_gate_held');
    assert.equal(held.refusal.code, 'KEYFRAME_STALE');
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('a budget ceiling blocks the regen and holds the gate', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-budget-'));
  const sample = estimateRegen({
    decision: { action: 'reprompt', attempt: 0, jobId: 'still_budget' },
    shot: { id: 'still_budget', kind: 'still' },
    regenJobsUsed: 0,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });
  const budgetLedger = ledgerFor(runtimeDir, 'refwatchbudget', sample.units.high / 2);
  const jobs = [still('still_budget'), video('video_budget', 'still_budget')];
  for (let i = 0; i < 7; i += 1) jobs.push(still(`still_pad_${i}`));
  const submitted = [];
  const events = [];
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_budget', runId: 'run_budget', jobs },
    reviewer: async ({ request }) => failVerdict(request, 'anatomy'),
    t0: runT0Checks,
    decide,
    steer,
    estimate: (input) => estimateRegen(input),
    submitJobs: async (payload) => { submitted.push(payload); },
    budgetLedger,
    onEvent: (event) => { events.push(event); },
    iteration: ITERATION,
    receiptsDir: join(runtimeDir, 'receipts'),
    now: () => '2026-10-30T00:00:00.000Z',
  });
  try {
    await controller.start();
    await controller.handle(preview('still_budget', shaOf('budget')));
    assert.equal(submitted.some((entry) => entry.batch === 'regen'), false);
    assert.equal(events.some((event) => event.type === 'ref_regen_estimate'), true);
    assert.equal(events.some((event) => event.jobId === 'still_budget' && event.type === 'ref_gate_held'), true);
    const status = budgetLedger.status();
    assert.equal(status.openReservations.length, 0);
    assert.ok(status.committed + status.spent <= status.ceiling);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
