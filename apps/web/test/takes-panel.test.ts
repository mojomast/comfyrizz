// The web package typecheck has no @types/node; these node:test-only imports
// are not typechecked, like the other web tests that use node:test.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_FIELDS,
  TakePanelController,
  activeTakeId,
  buildCorrectionChange,
  computeGenDiff,
  emptyCorrectionForm,
  escapeHtml,
  formatDiffValue,
  formatEstimate,
  isAllowedInputKey,
  nextTakeIndex,
  renderTakePanel,
  sanitizeInputs,
  takeDiff,
  verdictLabel,
} from '../src/takes/panel.ts';

const PACKAGE_ID = 'pkg_demo';
const CLIP_ID = 's1:a_plate1';
const TAKE_1 = 'tk_111111111111';
const TAKE_2 = 'tk_222222222222';
const TAKE_3 = 'tk_333333333333';
const PLAN_HASH = 'a'.repeat(64);

function take(n, overrides = {}) {
  return {
    takeId: `tk_${String(n).repeat(12)}`,
    assetId: 'a_plate1',
    n,
    file: `takes/a_plate1/take-${n}.mp4`,
    sha256: String(n).repeat(64),
    bytes: 1024 * n,
    media: { fps: 24, frames: 48, durationInSeconds: 2 },
    gen: { generator: 'comfyui', prompt: `plate take ${n}`, seed: 7 + n, inputs: { strength: 0.4 + n / 10 } },
    createdAt: `2026-10-20T12:0${n}:00.000Z`,
    verdict: 'unreviewed',
    ...overrides,
  };
}

function clipSummary(overrides = {}) {
  return {
    clipId: CLIP_ID,
    sceneId: 's1',
    assetId: 'a_plate1',
    slot: 'background',
    kind: 'plate',
    from: 0,
    durationInFrames: 90,
    state: 'review',
    selected: TAKE_1,
    selectedN: 1,
    takeCount: 3,
    newTakes: 0,
    lastJob: null,
    queued: false,
    ...overrides,
  };
}

function takesResponse(takes = [take(1), take(2), take(3)], overrides = {}) {
  return {
    packageId: PACKAGE_ID,
    revision: 4,
    clip: clipSummary(),
    assetId: 'a_plate1',
    selected: TAKE_1,
    takes,
    history: [],
    lastJob: null,
    queued: null,
    ...overrides,
  };
}

function fakeTakesApi(seedData, options = {}) {
  const data = structuredClone(seedData);
  const calls = {
    gets: [],
    regenerate: [],
    approve: [],
    select: [],
    revert: [],
    verdict: [],
  };

  const api = {
    async getTakes(packageId, clipId) {
      calls.gets.push({ packageId, clipId });
      if (options.getTakesError) throw options.getTakesError;
      return structuredClone(data);
    },
    async regenerate(packageId, clipId, input) {
      calls.regenerate.push({ packageId, clipId, input });
      if (typeof options.regenerate === 'function') {
        return options.regenerate(packageId, clipId, input, calls.regenerate.length);
      }
      return options.regenerate ?? {
        kind: 'started',
        clipId,
        assetId: 'a_plate1',
        diff: [],
        correction: input.change,
        runId: 'run_1',
        status: 'starting',
        planHash: null,
        estimate: null,
        budget: null,
      };
    },
    async approve(planHash) {
      calls.approve.push(planHash);
      if (typeof options.approve === 'function') return options.approve(planHash);
      return { planHash, approved: true };
    },
    async select(packageId, clipId, takeId) {
      calls.select.push({ packageId, clipId, takeId });
      data.selected = takeId;
      return {
        kind: 'selected',
        packageId,
        revision: 5,
        clip: { ...data.clip, selected: takeId, selectedN: data.takes.find(item => item.takeId === takeId)?.n ?? null },
        takeId,
      };
    },
    async revert(packageId, clipId) {
      calls.revert.push({ packageId, clipId });
      const takeId = options.revertTo ?? TAKE_1;
      data.selected = takeId;
      return {
        kind: 'reverted',
        packageId,
        revision: 6,
        clip: { ...data.clip, selected: takeId },
        takeId,
      };
    },
    async verdict(packageId, clipId, verdict, verdictOptions = {}) {
      calls.verdict.push({ packageId, clipId, verdict, ...verdictOptions });
      const target = data.takes.find(item => item.takeId === verdictOptions.takeId);
      if (target) {
        target.verdict = verdict;
        if (verdictOptions.note) target.verdictNote = verdictOptions.note;
      }
      return {
        kind: 'verdict',
        packageId,
        clip: { ...data.clip, state: verdict === 'approved' ? 'approved' : 'rejected' },
        takeId: verdictOptions.takeId,
        verdict,
      };
    },
    async takeUrl() {
      return '/api/media/testticket';
    },
  };
  return { api, calls, data };
}

function controllerFor(fake, options = {}) {
  const previews = [];
  const controller = new TakePanelController({
    api: fake.api,
    packageId: PACKAGE_ID,
    clipId: CLIP_ID,
    onPreview: id => previews.push(id),
    ...options,
  });
  return { controller, previews };
}

test('loading takes renders a take strip, verdict chips and the selected take', async () => {
  const fake = fakeTakesApi(takesResponse());
  const { controller } = controllerFor(fake);
  await controller.load();

  assert.deepEqual(fake.calls.gets, [{ packageId: PACKAGE_ID, clipId: CLIP_ID }]);
  const state = controller.getState();
  assert.equal(state.data.takes.length, 3);
  assert.equal(state.loading, false);
  assert.equal(activeTakeId(state), TAKE_1);

  const html = renderTakePanel(state, { idPrefix: 'demo' });
  assert.match(html, /<section class="take-panel" data-take-panel/);
  assert.match(html, /aria-labelledby="demo-title"/);
  assert.equal((html.match(/data-take-preview="tk_/g) ?? []).length, 3);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /data-take-preview="tk_111111111111"[^>]*aria-pressed="true"/);
  assert.match(html, /class="take-verdict take-verdict-unreviewed"/);
  assert.match(html, /data-take-count[^>]*>3</);
  assert.match(html, /data-take-state>needs review</);
  assert.match(html, /Take 2/);
  assert.match(html, /0:02s|2s/, 'the strip shows the take duration');
  assert.match(html, /data-take-verdicts/);
});

test('the diff prefers the recorded correction and falls back to a gen field diff', async () => {
  const takes = [
    take(1, { verdict: 'approved' }),
    take(2, {
      correction: {
        note: '<script>alert(1)</script>',
        by: 'user',
        diff: [{ path: 'gen.prompt', before: '<b>old</b>', after: '<img src=x onerror="alert(1)">' }],
      },
      gen: { generator: 'comfyui', prompt: 'new plate', seed: 8, inputs: { strength: 0.5 } },
    }),
    take(3, {
      correction: { note: 'seed change', by: 'user', diff: [] },
      gen: { generator: 'comfyui', prompt: 'third plate', seed: 9, inputs: { strength: 0.7 } },
    }),
  ];
  const fake = fakeTakesApi(takesResponse(takes, { selected: TAKE_2 }));
  const { controller } = controllerFor(fake);
  await controller.load();
  controller.preview(TAKE_2);

  let html = renderTakePanel(controller.getState());
  assert.match(html, /data-take-diff/);
  assert.match(html, /data-diff-path="gen.prompt"/);
  assert.match(html, /Correction: &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x onerror="alert(1)">'));
  assert.match(html, /&lt;b&gt;old&lt;\/b&gt;/);
  assert.equal((html.match(/data-diff-path=/g) ?? []).length, 1, 'the recorded diff is used as-is');

  controller.preview(TAKE_3);
  html = renderTakePanel(controller.getState());
  assert.match(html, /data-diff-path="gen.prompt"/);
  assert.match(html, /data-diff-path="gen.seed"/);
  assert.match(html, /data-diff-path="gen.inputs.strength"/);
  assert.match(html, /Changes from take 2/);

  assert.deepEqual(takeDiff(takes[0], undefined), []);
  const computed = computeGenDiff(takes[1].gen, takes[2].gen);
  assert.deepEqual(computed.map(row => row.path), ['gen.inputs.strength', 'gen.prompt', 'gen.seed']);
  assert.equal(formatDiffValue(undefined), '—');
  assert.equal(formatDiffValue(null), 'null');
  assert.equal(formatDiffValue(0.5), '0.5');
  assert.match(formatDiffValue({ b: 1, a: 2 }), /^\{"a":2,"b":1\}$/);
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('the correction form offers only allow-listed inputs and builds a scoped change', () => {
  const form = emptyCorrectionForm();
  assert.deepEqual(Object.keys(form.inputs).sort(), INPUT_FIELDS.map(field => field.key).sort());

  assert.equal(isAllowedInputKey('reference'), true);
  assert.equal(isAllowedInputKey('reference_10'), true);
  assert.equal(isAllowedInputKey('reference_11'), false);
  assert.equal(isAllowedInputKey('image'), true);
  assert.equal(isAllowedInputKey('strength'), true);
  assert.equal(isAllowedInputKey('denoise'), true);
  assert.equal(isAllowedInputKey('motion.zoom'), true);
  assert.equal(isAllowedInputKey('motion'), false);
  assert.equal(isAllowedInputKey('evil'), false);

  assert.deepEqual(
    sanitizeInputs({
      reference: 'ref_1',
      reference_11: 'nope',
      image: 'img_2',
      strength: '0.65',
      denoise: '',
      'motion.zoom': '2',
      'motion.pan': 'left',
      evil: 'x',
    }),
    { reference: 'ref_1', image: 'img_2', strength: 0.65, 'motion.zoom': 2, 'motion.pan': 'left' },
  );

  const empty = buildCorrectionChange(form);
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? '' : empty.error, /Add a correction note/);

  form.note = '  slower push-in, keep the logo readable  ';
  form.promptAppend = 'clean negative space top-right';
  form.negativeAppend = 'people, busy background';
  form.seedMode = 'custom';
  form.seedValue = '42';
  form.inputs.strength = '0.65';
  form.inputs.reference_11 = 'ignored';
  const built = buildCorrectionChange(form);
  assert.equal(built.ok, true);
  assert.equal(built.ok ? built.change.note : '', 'slower push-in, keep the logo readable');
  assert.equal(built.ok ? built.change.promptAppend : '', 'clean negative space top-right');
  assert.equal(built.ok ? built.change.negativeAppend : '', 'people, busy background');
  assert.equal(built.ok ? built.change.seed : null, 42);
  assert.deepEqual(built.ok ? built.change.inputs : {}, { strength: 0.65 });
  assert.equal(built.ok ? built.change.by : '', 'user');

  form.seedValue = 'not-a-number';
  const badSeed = buildCorrectionChange(form);
  assert.equal(badSeed.ok, false);
  assert.match(badSeed.ok ? '' : badSeed.error, /whole seed number/);

  form.seedMode = 'new';
  form.seedValue = '';
  const newSeed = buildCorrectionChange(form);
  assert.equal(newSeed.ok, true);
  assert.equal(newSeed.ok ? newSeed.change.seed : null, 'new');

  const fake = fakeTakesApi(takesResponse());
  const { controller } = controllerFor(fake);
  assert.equal(controller.setInput('evil', 'x'), false);
  assert.equal(controller.setInput('motion.zoom', '1.5'), true);
  assert.equal(controller.setSeedMode('sometimes'), false);
  assert.equal(controller.setField('note', 'x'.repeat(1200)), true);
  assert.equal(controller.getState().form.note.length, 1000);
  assert.equal(controller.setField('not-a-field', 'x'), false);

  const html = renderTakePanel(controller.getState());
  assert.match(html, /data-input-field="reference"/);
  assert.match(html, /data-input-field="reference_10"/);
  assert.match(html, /data-input-field="motion.zoom"/);
  assert.ok(!html.includes('data-input-field="evil"'));
  assert.match(html, /Allowed inputs: reference, reference_2 to reference_10, image, strength, denoise and motion\.\*/);
});

test('regenerate shows the estimate and only charges after an explicit approval', async () => {
  const fake = fakeTakesApi(takesResponse(), {
    regenerate: (_packageId, clipId, input, call) => {
      if (call === 1) {
        return {
          kind: 'approval',
          approvalRequired: true,
          clipId,
          assetId: 'a_plate1',
          diff: [{ path: 'gen.seed', before: 8, after: 11 }],
          correction: input.change,
          planHash: PLAN_HASH,
          estimate: { gpuMinutes: 2, overheadMinutes: 1 },
          budget: { allowed: true, required: 3 },
          backend: { id: 'colab' },
          jobs: 1,
        };
      }
      return {
        kind: 'started',
        clipId,
        assetId: 'a_plate1',
        diff: [],
        correction: input.change,
        runId: 'run_2',
        status: 'starting',
        planHash: PLAN_HASH,
        estimate: { gpuMinutes: 2, overheadMinutes: 1 },
        budget: { allowed: true, required: 3 },
      };
    },
  });
  const { controller } = controllerFor(fake, { backendId: 'colab' });
  await controller.load();
  controller.setField('note', 'cleaner background');

  const pending = await controller.regenerate();
  assert.equal(pending.kind, 'approval');
  assert.equal(fake.calls.regenerate[0].input.change.inputs, undefined);
  assert.equal(fake.calls.regenerate[0].input.change.note, 'cleaner background');
  assert.equal(fake.calls.regenerate[0].input.change.seed, 'new');
  assert.equal(fake.calls.regenerate[0].input.backendId, 'colab');
  assert.equal(fake.calls.approve.length, 0, 'regenerate alone does not approve spend');

  const state = controller.getState();
  assert.equal(state.approval.planHash, PLAN_HASH);
  const html = renderTakePanel(state);
  assert.match(html, /data-take-approval/);
  assert.match(html, /data-take-estimate>2 GPU min · 1 min overhead · 3 budget units</);
  assert.match(html, /data-take-approve-spend>Approve and regenerate</);
  assert.match(html, /data-take-cancel-approval/);
  assert.equal(formatEstimate({ gpuMinutes: 2, overheadMinutes: 1 }, { allowed: true, required: 3 }), '2 GPU min · 1 min overhead · 3 budget units');
  assert.equal(formatEstimate(null, null), 'Estimate unavailable.');

  const approved = await controller.approveSpend();
  assert.equal(approved, true);
  assert.deepEqual(fake.calls.approve, [PLAN_HASH]);
  assert.equal(fake.calls.regenerate.length, 2);
  assert.equal(fake.calls.regenerate[1].input.approved, true);
  assert.equal(fake.calls.regenerate[1].input.change.note, 'cleaner background');
  assert.equal(controller.getState().approval, null);
  assert.match(controller.getState().message, /Regeneration started \(run run_2\)/);
});

test('a declined spend approval sends nothing and keeps the estimate on screen', async () => {
  const fake = fakeTakesApi(takesResponse(), {
    regenerate: (_packageId, clipId, input) => ({
      kind: 'approval',
      approvalRequired: true,
      clipId,
      assetId: 'a_plate1',
      diff: [],
      correction: input.change,
      planHash: PLAN_HASH,
      estimate: { gpuMinutes: 1 },
      budget: { allowed: true, required: 1 },
      backend: null,
      jobs: 1,
    }),
    approve: planHash => ({ planHash, approved: false }),
  });
  const { controller } = controllerFor(fake);
  await controller.load();
  controller.setField('note', 'warmer light');
  await controller.regenerate();

  assert.equal(await controller.approveSpend(), false);
  assert.equal(fake.calls.regenerate.length, 1, 'nothing is re-sent without approval');
  assert.ok(controller.getState().approval, 'the approval step stays available');
  assert.match(controller.getState().message, /was not approved/);
});

test('approve, reject, select and revert call exactly their routes', async () => {
  const fake = fakeTakesApi(takesResponse());
  const { controller, previews } = controllerFor(fake);
  await controller.load();

  assert.equal(await controller.approve(TAKE_2), true);
  assert.deepEqual(fake.calls.verdict.at(-1), {
    packageId: PACKAGE_ID,
    clipId: CLIP_ID,
    verdict: 'approved',
    takeId: TAKE_2,
  });
  assert.equal(controller.getState().data.takes.find(item => item.takeId === TAKE_2).verdict, 'approved');
  assert.match(controller.getState().message, /Take 2 approved/);

  controller.setField('note', 'logo is hidden');
  assert.equal(await controller.reject(TAKE_2), true);
  assert.deepEqual(fake.calls.verdict.at(-1), {
    packageId: PACKAGE_ID,
    clipId: CLIP_ID,
    verdict: 'rejected',
    takeId: TAKE_2,
    note: 'logo is hidden',
  });
  assert.equal(controller.getState().data.takes.find(item => item.takeId === TAKE_2).verdict, 'rejected');

  assert.equal(await controller.selectTake(TAKE_2), true);
  assert.deepEqual(fake.calls.select, [{ packageId: PACKAGE_ID, clipId: CLIP_ID, takeId: TAKE_2 }]);
  assert.equal(controller.getState().data.selected, TAKE_2);
  assert.equal(controller.getState().previewTakeId, null);
  assert.deepEqual(previews, [null], 'selecting clears the preview');

  assert.equal(await controller.revert(), true);
  assert.deepEqual(fake.calls.revert, [{ packageId: PACKAGE_ID, clipId: CLIP_ID }]);
  assert.equal(controller.getState().data.selected, TAKE_1);
  assert.match(controller.getState().message, /Reverted to take 1/);
});

test('preview and A/B cycling pass the take id to the host and clear it again', async () => {
  const fake = fakeTakesApi(takesResponse());
  const { controller, previews } = controllerFor(fake);
  await controller.load();

  assert.equal(controller.preview(TAKE_2), true);
  assert.equal(activeTakeId(controller.getState()), TAKE_2);
  assert.equal(controller.preview('tk_doesnotexist'), false);

  const next = controller.cyclePreview(1);
  assert.equal(next, TAKE_3);
  assert.equal(controller.cyclePreview(1), TAKE_1, 'cycling wraps');
  assert.equal(controller.cyclePreview(-1), TAKE_3);

  const previewHtml = renderTakePanel(controller.getState());
  assert.match(previewHtml, /data-take-clear-preview/);
  assert.match(previewHtml, /Preview selected take/);

  controller.clearPreview();
  assert.equal(activeTakeId(controller.getState()), TAKE_1, 'clearing A/B restores the selected take');
  assert.deepEqual(previews, [TAKE_2, TAKE_3, TAKE_1, TAKE_3, null]);

  const html = renderTakePanel(controller.getState());
  assert.ok(!html.includes('data-take-clear-preview'), 'the A/B reset only appears while previewing a take');
});

test('keyboard navigation wraps, supports [ ] and Home/End, and every action is a button', async () => {
  assert.equal(nextTakeIndex(3, 0, ']'), 1);
  assert.equal(nextTakeIndex(3, 2, ']'), 0);
  assert.equal(nextTakeIndex(3, 0, '['), 2);
  assert.equal(nextTakeIndex(3, 1, 'ArrowRight'), 2);
  assert.equal(nextTakeIndex(3, 1, 'ArrowLeft'), 0);
  assert.equal(nextTakeIndex(3, 1, 'Home'), 0);
  assert.equal(nextTakeIndex(3, 1, 'End'), 2);
  assert.equal(nextTakeIndex(3, 1, 'x'), 1);
  assert.equal(nextTakeIndex(0, 0, ']'), -1);

  const fake = fakeTakesApi(takesResponse());
  const { controller } = controllerFor(fake);
  await controller.load();
  const html = renderTakePanel(controller.getState());

  assert.match(html, /data-take-step="-1" aria-label="Previous take" aria-keyshortcuts="\["/);
  assert.match(html, /data-take-step="1" aria-label="Next take" aria-keyshortcuts="\]"/);
  assert.match(html, /data-take-approve aria-keyshortcuts="A"/);
  assert.match(html, /<button type="button" class="take-card/);
  assert.match(html, /data-take-select/);
  assert.match(html, /data-take-reject/);
  assert.match(html, /data-take-revert/);
  assert.match(html, /<kbd>\[<\/kbd>/);
  assert.ok(!/<div[^>]*data-take-preview/.test(html), 'takes are native buttons, not clickable divs');
  assert.match(html, /aria-live="polite"/);
});

test('verdict chips label every take and an unknown verdict is unreviewed', () => {
  assert.equal(verdictLabel('approved'), 'approved');
  assert.equal(verdictLabel('rejected'), 'rejected');
  assert.equal(verdictLabel('mystery'), 'unreviewed');
  assert.equal(verdictLabel(undefined), 'unreviewed');
});

test('load failures and server messages are escaped, and the response package id is adopted', async () => {
  const failing = fakeTakesApi(takesResponse(), {
    getTakesError: new Error('<img src=x onerror="alert(1)">'),
  });
  const { controller } = controllerFor(failing);
  await controller.load();
  const html = renderTakePanel(controller.getState());
  assert.ok(!html.includes('<img src=x onerror'));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /class="take-status is-error"/);

  const fake = fakeTakesApi(takesResponse());
  const { controller: noPackage } = controllerFor(fake, { packageId: '' });
  await noPackage.load();
  assert.equal(fake.calls.gets.length, 1);
  assert.equal(noPackage.getState().data.packageId, PACKAGE_ID);
  assert.equal(noPackage.packageId, PACKAGE_ID, 'the package id from the response is used for later calls');
  noPackage.setField('note', 'warmer light');
  await noPackage.regenerate();
  assert.equal(fake.calls.regenerate[0].packageId, PACKAGE_ID);
});
