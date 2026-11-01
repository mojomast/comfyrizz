// Judge loop (JUDGE_RESEARCH.md, 2026-11-01): second opinion, targeted edits off, concurrent reviews.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';
import { createRefWatchController } from '../../src/ref-watch/controller.mjs';

const PROMPT = 'A medium shot of the character standing in warm window light, blue coat buttoned, hands relaxed, face three quarters toward the lens.';
const DIMS = ['technical', 'identity', 'anatomy', 'framing', 'prompt', 'text_artifact'];
const sha = (text) => createHash('sha256').update(text).digest('hex');

function still(id) {
  return { id, kind: 'still', batch: 'stills', outputKind: 'image', output: `assets/${id}.png`, shotId: id, seed: 7, prompt: PROMPT,
    params: { prompt: PROMPT, seed: 7 }, dims: { width: 1024, height: 576 } };
}
function video(id, dep, index) {
  return { id, kind: 'plate', batch: 'plates', outputKind: 'video', output: `assets/${id}.mp4`, generator: 'ltx25',
    workflow: 'workflows/ltx25_i2v_2stage.api.json', fileInputs: [{ param: 'image', from: 'job', job: dep, path: `assets/${dep}.png` }],
    shot: { sceneId: `s${index}`, index } };
}
const preview = (id) => ({ type: 'preview_ready', manifest: { jobs: [{ job: id, status: 'succeeded', outputs: [{ relative: `assets/${id}.png`, sha256: sha(id), bytes: 64 }] }] } });
function verdict(request, failing = null) {
  return { schema: REF_VERDICT_SCHEMA, jobId: request.jobId, keyframeSha256: request.keyframeSha256, reviewer: 'fake',
    overall: failing ? 'fail' : 'pass',
    checks: DIMS.map((dimension) => ({ dimension, pass: dimension !== failing, severity: 'hard', evidence: `${dimension} evidence` })),
    fixHints: failing ? [`fix the ${failing}`] : [] };
}
function setup(reviewer, options = {}) {
  const ids = ['still_a', 'still_b', 'still_c'];
  const jobs = [...ids.map(still), ...ids.map((id, index) => video(`video_${id.slice(-1)}`, id, index))];
  const submitted = [];
  const events = [];
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_judge', runId: 'run_judge', jobs }, reviewer,
    submitJobs: async (payload) => { submitted.push(payload); }, onEvent: (event) => { events.push(event); },
    now: () => '2026-11-01T00:00:00.000Z', liveSession: true, regenBudgetUnits: 0.6, ...options,
  });
  return { controller, submitted, events };
}

test('a lone text_artifact hard fail that a second review passes is downgraded to soft and accepted', async () => {
  const calls = [];
  const { controller, events } = setup(async ({ request }) => { calls.push(request.jobId); return verdict(request, calls.length === 1 ? 'text_artifact' : null); },
    { secondOpinion: true });
  await controller.start();
  await controller.handle(preview('still_a'));
  assert.equal(calls.length, 2);
  const final = events.filter((event) => event.type === 'ref_review_verdict').at(-1);
  assert.equal(final.decision.action, 'accept');
  assert.equal(final.verdict.checks.find((check) => check.dimension === 'text_artifact').severity, 'soft');
});

test('both reviews failing text_artifact still acts on the hard fail', async () => {
  let calls = 0;
  const { controller, events } = setup(async ({ request }) => { calls += 1; return verdict(request, 'text_artifact'); }, { secondOpinion: true });
  await controller.start();
  await controller.handle(preview('still_a'));
  assert.equal(calls, 2);
  assert.ok(events.some((event) => event.type === 'ref_regen_queued' && event.jobId === 'still_a'));
});

test('an identity hard fail gets no second opinion', async () => {
  let calls = 0;
  const { controller } = setup(async ({ request }) => { calls += 1; return calls === 1 ? verdict(request, 'identity') : verdict(request); }, { secondOpinion: true });
  await controller.start();
  await controller.handle(preview('still_a'));
  assert.equal(calls, 1);
});

test('with targeted edits off a text_artifact fail regenerates the still instead of a Qwen edit', async () => {
  let calls = 0;
  const { controller, submitted } = setup(async ({ request }) => { calls += 1; return calls === 1 ? verdict(request, 'text_artifact') : verdict(request); },
    { targetedEdits: false });
  await controller.start();
  await controller.handle(preview('still_a'));
  const regen = submitted.find((entry) => entry.batch === 'regen');
  assert.ok(regen, 'a regen was queued');
  assert.notEqual(regen.jobs[0].generator, 'qwen-edit-2511');
});

test('one preview batch of three stills is reviewed concurrently', async () => {
  let active = 0;
  let peak = 0;
  const { controller } = setup(async ({ request }) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return verdict(request);
  }, { reviewConcurrency: 4 });
  await controller.start();
  const jobs = ['still_a', 'still_b', 'still_c'].flatMap((id) => preview(id).manifest.jobs);
  await controller.handle({ type: 'preview_ready', manifest: { jobs } });
  assert.equal(peak, 3);
});
