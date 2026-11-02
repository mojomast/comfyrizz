// judge-workflow v3: per-shot regen caps keep one stubborn still from starving the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';
import { createRefWatchController } from '../../src/ref-watch/controller.mjs';

const PROMPT = 'A wide shot of the character standing in warm window light, blue coat buttoned, hands relaxed, face three quarters toward the lens.';
const DIMS = ['technical', 'identity', 'anatomy', 'framing', 'prompt', 'text_artifact'];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const still = (id) => ({ id, kind: 'still', batch: 'stills', outputKind: 'image', output: `assets/${id}.png`, shotId: id, scene: 's1', seed: 7, prompt: PROMPT, params: { prompt: PROMPT, seed: 7 }, dims: { width: 1024, height: 576 } });
const video = (id, dep, index) => ({ id, kind: 'plate', batch: 'plates', outputKind: 'video', output: `assets/${id}.mp4`, generator: 'ltx25', workflow: 'workflows/ltx25_i2v_2stage.api.json', params: { seed: 11 }, fileInputs: [{ param: 'image', from: 'job', job: dep, path: `assets/${dep}.png` }], shot: { sceneId: `x${index}`, index } });
const preview = (id, text = id) => ({ type: 'preview_ready', manifest: { jobs: [{ job: id, status: 'succeeded', outputs: [{ relative: `assets/${id}.png`, sha256: sha(text), bytes: 64 }] }] } });
const failing = (request) => ({ schema: REF_VERDICT_SCHEMA, jobId: request.jobId, keyframeSha256: request.keyframeSha256, reviewer: 'fake', overall: 'fail', checks: DIMS.map((dimension) => ({ dimension, pass: dimension !== 'framing', severity: 'hard', evidence: `${dimension} evidence` })), fixHints: ['full body visible from head to toe'] });

function setup({ regenBudgetUnits = 2, clock, ...options } = {}) {
  const submitted = []; const events = [];
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'p', runId: 'r', jobs: [still('still_a'), still('still_b'), video('video_a', 'still_a', 0), video('video_b', 'still_b', 1)] },
    submitJobs: async (payload) => { submitted.push(payload); }, onEvent: (event) => { events.push(event); },
    now: () => new Date(clock?.() ?? Date.parse('2026-11-02T00:00:00.000Z')).toISOString(),
    liveSession: true, regenBudgetUnits, targetedEdits: false, reviewer: async ({ request }) => failing(request),
    estimate: async () => ({ label: 'regen', units: 1 }), ...options,
  });
  const regens = (id) => submitted.filter((entry) => entry.batch === 'regen' && entry.jobs[0].id === id).length;
  return { controller, events, regens };
}

test('a shot cannot take more than its share of the regen allowance', async () => {
  const { controller, events, regens } = setup({ regenBudgetUnits: 2 });
  await controller.start();
  await controller.handle(preview('still_a'));
  await controller.handle(preview('still_a', 'a2'));
  assert.equal(regens('still_a'), 1, 'first regen allowed, second would exceed the 40% share (0.8 of 2)');
  assert.ok(events.some((event) => event.type === 'ref_shot_capped' && event.jobId === 'still_a' && /budget cap/.test(event.reason)));
  await controller.handle(preview('still_b'));
  assert.equal(regens('still_b'), 1, 'the other shot still gets its regen');
  assert.deepEqual(controller.snapshot().shotRegenUnits, { still_a: 1, still_b: 1 });
});

test('a shot stops regenerating once its wall-clock window has passed', async () => {
  let t = Date.parse('2026-11-02T00:00:00.000Z');
  const { controller, events, regens } = setup({ regenBudgetUnits: 100, clock: () => t });
  await controller.start();
  await controller.handle(preview('still_a'));
  assert.equal(regens('still_a'), 1);
  t += 13 * 60000;
  await controller.handle(preview('still_a', 'a2'));
  assert.equal(regens('still_a'), 1);
  assert.ok(events.some((event) => event.type === 'ref_shot_capped' && /time cap/.test(event.reason)));
});

test('a package can loosen or disable the per-shot caps', async () => {
  let t = Date.parse('2026-11-02T00:00:00.000Z');
  const submitted = [];
  const c2 = createRefWatchController({
    jobsDoc: { productionId: 'p', runId: 'r', jobs: [still('still_a'), video('video_a', 'still_a', 0)], refWatchPolicy: { perShotRegenShare: 0, perShotWallMinutes: 0 } },
    submitJobs: async (payload) => { submitted.push(payload); }, onEvent: () => {}, now: () => new Date(t).toISOString(),
    liveSession: true, regenBudgetUnits: 2, targetedEdits: false, reviewer: async ({ request }) => failing(request), estimate: async () => ({ label: 'regen', units: 1 }),
  });
  await c2.start();
  await c2.handle(preview('still_a'));
  t += 30 * 60000;
  await c2.handle(preview('still_a', 'a2'));
  assert.equal(submitted.filter((entry) => entry.batch === 'regen').length, 2);
});
