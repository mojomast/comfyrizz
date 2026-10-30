import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../packages/planner/dist/src/index.js';
import { createSelfRepairController } from '../src/self-repair.mjs';

const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const clone = value => structuredClone(value);
const renderId = n => `r_${n.toString(16).padStart(12, '0')}`;
const input = (changes = {}) => ({ repairId: 'repair_example', packageId: 'pkg_example', expectedRevision: 4,
  renderId: renderId(1), conversationId: 'conv_example', maxRepairs: 2, ...changes });

function packageFixture() {
  return { id: 'pkg_example', revision: 4, title: 'Preserve every authored field',
    assets: { video: { kind: 'video', status: 'ready', sha256: 'a'.repeat(64),
      gen: { generator: 'fasth3-omni', direction: { dialogue: { text: 'Exactly these words.' } } } } },
    scenes: [{ id: 'scene_one', preferredFrames: 120, background: { asset: 'video', loop: false, speed: 1, muted: false } },
      { id: 'scene_two', preferredFrames: 120, background: { asset: 'video', loop: false, speed: 1, muted: false } }] };
}

function reportFixture(pkg, id, { statuses = ['needs_review', 'needs_review'], salt = id, fault, unknown = false } = {}) {
  const speech = { status: unknown ? 'unavailable' : 'measured', provider: 'synthetic-fixture', uncertaintySeconds: 0.05,
    segments: [{ start: 0.4 + (pkg.revision - 4) * 0.1, end: 2.5, text: 'Exactly these words.' },
      { start: 4.4, end: 6.5, text: 'Exactly these words.' }] };
  const findings = [
    ...['duration', 'video_duration', 'frame_count', 'frame_rate', 'resolution', 'audio_stream'].map(check => ({ check, status: fault === check ? 'fail' : 'pass' })),
    ...pkg.scenes.flatMap((scene, i) => [
      { check: 'native_source_contribution', sceneId: scene.id, assetId: 'video', slot: 'background', status: fault === 'native_source_contribution' ? 'fail' : 'pass' },
      { check: 'detected_speech_coverage', sceneId: scene.id, status: statuses[i] },
      { check: 'speech_transition_overlap', sceneId: scene.id, status: 'pass' },
      { check: 'asr_text_comparison', sceneId: scene.id, status: 'needs_review', matchObserved: true },
    ]),
    { check: 'speech_evidence', status: unknown ? 'unknown' : 'needs_review' },
    { check: 'visual_quality', status: 'unknown' },
  ];
  return { reviewId: `rr_${hash({ id, salt, revision: pkg.revision })}`, packageId: pkg.id, packageRevision: pkg.revision,
    packageHash: hash(pkg), artifact: { renderId: id, videoSha256: hash({ video: salt }), timelineHash: hash({ timeline: pkg }) },
    speech, windows: pkg.scenes.map((scene, i) => ({ sceneId: scene.id, startSeconds: i * 4, endSeconds: i * 4 + 4, segments: [speech.segments[i]] })),
    findings, checksStatus: fault ? 'fail' : 'needs_review', capabilities: { finalRender: 'inspected', renderProbe: 'measured',
      contribution: 'receipt_verified', speechTiming: speech.status, visual: 'unavailable', humanAcceptance: 'not_assessed' }, acceptance: 'not_assessed' };
}

function harness(t, overrides = {}) {
  const runtimeDir = mkdtempSync('/tmp/opencode/self-repair-test-');
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const state = { pkg: packageFixture(), turns: [], renders: [], inspections: [] };
  const callbacks = {
    readPackage: () => clone(state.pkg),
    inspectRender: async (pkg, request, options) => {
      state.inspections.push({ pkg, request, options });
      return reportFixture(pkg, request.renderId, { statuses: pkg.revision === 4 ? ['needs_review', 'needs_review'] : ['pass', 'pass'] });
    },
    chatTurn: async turn => {
      state.turns.push(turn);
      for (const scene of state.pkg.scenes.filter(scene => turn.sceneIds.includes(scene.id))) scene.background.trim = { startSeconds: turn.attempt * 0.25 };
      state.pkg.revision++;
    },
    renderCurrent: async request => { state.renders.push(request); return { renderId: renderId(state.renders.length + 1) }; },
  };
  const dependencies = { runtimeDir, ...callbacks, ...overrides(state, callbacks) };
  return { state, runtimeDir, dependencies, controller: createSelfRepairController(dependencies) };
}

test('changed ASR provider, uncertainty or mode cannot establish repair improvement', async t => {
  for (const change of ['provider', 'uncertaintySeconds', 'analyzer', 'timingGranularity']) await t.test(change, async t => {
    const { controller, state } = harness(t, (_state, callbacks) => ({
      inspectRender: async (...args) => {
        const report = await callbacks.inspectRender(...args);
        if (report.packageRevision > 4) report.speech[change] = change === 'provider' ? 'different-model'
          : change === 'uncertaintySeconds' ? 0.01 : change === 'timingGranularity' ? 'word' : { vadFilter: true };
        return report;
      },
    }));
    const result = await controller.run(input());
    assert.equal(result.reason, 'analyzer_changed');
    assert.equal(result.checksSatisfied, false);
    assert.equal(state.turns.length, 1);
    assert.equal(result.reports.length, 2);
  });
});

test('a verified historical run can be inspected, while new exports still require ordinary render IDs', async t => {
  const { controller } = harness(t, () => ({}));
  const result = await controller.run(input({ renderId: 'run_123456abcdef' }));
  assert.equal(result.reason, 'scoped_checks_satisfied');
  assert.equal(result.reports[0].renderId, 'run_123456abcdef');
  assert.match(result.reports[1].renderId, /^r_/);
  const bad = harness(t, () => ({ renderCurrent: async () => ({ renderId: 'run_123456abcdef' }) }));
  const refused = await bad.controller.run(input());
  assert.equal(refused.reason, 'render_failed');
  assert.equal(refused.error.code, 'SELF_REPAIR_RENDER');
});

test('Pi callback commits a source-in edit; fresh output is inspected without claiming acceptance', async t => {
  const { controller, state } = harness(t, () => ({}));
  const result = await controller.run(input());
  assert.equal(result.status, 'completed');
  assert.equal(result.reason, 'scoped_checks_satisfied');
  assert.equal(result.checksSatisfied, true);
  assert.equal(result.acceptance, 'not_assessed');
  assert.equal(result.reports.at(-1).checksStatus, 'needs_review');
  assert.equal(result.attempts, 1);
  assert.equal(result.renders, 1);
  assert.equal(result.currentRevision, 5);
  assert.notEqual(result.beforeVideoSha256, result.afterVideoSha256);
  assert.deepEqual(state.turns[0].sceneIds, ['scene_one', 'scene_two']);
  assert.equal(Object.isFrozen(state.turns[0].pkg.scenes[0]), true);
  assert.equal(Object.isFrozen(state.turns[0].report), true);
  assert.equal(state.turns[0].conversationId, 'conv_example');
  assert.equal(state.renders[0].expectedRevision, 5);
  assert.deepEqual(state.inspections.map(item => item.request.expectedRevision), [4, 5]);
  assert.ok(result.history.some(item => item.type === 'edit_observed' && item.validation === 'source_in_only'));
  assert.deepEqual(controller.get(input().repairId), result);
});

test('strict input rejects extra controls and unsafe IDs before any callback', async t => {
  const { controller, state } = harness(t, () => ({}));
  for (const value of [input({ extra: true }), input({ maxRepairs: 3 }), input({ repairId: 'repair_../bad' }),
    input({ renderId: 'r_bad' }), input({ packageId: '../package' }), input({ expectedRevision: -1 }), input({ conversationId: '' })]) {
    await assert.rejects(controller.run(value), { code: 'SELF_REPAIR_INVALID' });
  }
  assert.equal(state.inspections.length, 0);
  assert.equal(controller.get('repair_unknown'), null);
});

test('no-op and revision-only turns stop before rendering', async t => {
  for (const revise of [false, true]) await t.test(String(revise), async t => {
    const { controller, state } = harness(t, state => ({ chatTurn: () => { if (revise) state.pkg.revision++; } }));
    const result = await controller.run(input());
    assert.equal(result.reason, 'no_op');
    assert.equal(result.packageRoundsReserved, 1);
    assert.equal(state.renders.length, 0);
  });
});

test('out-of-scope saved candidates are recorded and never rendered or rolled back', async t => {
  const mutations = {
    dialogue: pkg => { pkg.assets.video.gen.direction.dialogue.text = 'Rewritten'; },
    speed: pkg => { pkg.scenes[0].background.speed = 2; },
    end: pkg => { pkg.scenes[0].background.trim.endSeconds = 10; },
    otherScene: pkg => { pkg.scenes[1].background.trim = { startSeconds: 1 }; },
    duration: pkg => { pkg.scenes[0].preferredFrames++; },
    approval: pkg => { pkg.approved = true; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
    const { controller, state } = harness(t, state => ({
      inspectRender: (pkg, request) => reportFixture(pkg, request.renderId, { statuses: ['needs_review', 'pass'] }),
      chatTurn: () => { state.pkg.scenes[0].background.trim = { startSeconds: 0.25 }; mutate(state.pkg); state.pkg.revision++; },
    }));
    const result = await controller.run(input());
    assert.equal(result.reason, 'out_of_scope_edit');
    assert.equal(result.currentRevision, 5);
    assert.equal(state.renders.length, 0);
    assert.equal(state.pkg.revision, 5);
  });
});

test('preserves existing trim end but permits changing source-in', async t => {
  const { controller, state } = harness(t, state => ({ chatTurn: () => {
    state.pkg.scenes.forEach(scene => { scene.background.trim.startSeconds = 0.5; }); state.pkg.revision++;
  } }));
  state.pkg.scenes.forEach(scene => { scene.background.trim = { startSeconds: 0.25, endSeconds: 9 }; });
  assert.equal((await controller.run(input())).status, 'completed');
  assert.equal(state.pkg.scenes[0].background.trim.endSeconds, 9);
});

test('stale initial, pre-turn, post-turn, and post-render revisions stop', async t => {
  for (const when of ['initial', 'inspection', 'turn', 'render']) await t.test(when, async t => {
    const { controller, state } = harness(t, (state, callbacks) => ({
      inspectRender: async (...args) => { const report = await callbacks.inspectRender(...args); if (when === 'inspection') state.pkg.revision++; return report; },
      chatTurn: async args => { await callbacks.chatTurn(args); if (when === 'turn') state.pkg.revision++; },
      renderCurrent: async args => { const rendered = await callbacks.renderCurrent(args); if (when === 'render') state.pkg.revision++; return rendered; },
    }));
    if (when === 'initial') state.pkg.revision++;
    const result = await controller.run(input());
    assert.equal(result.reason, 'stale_package');
    assert.equal(state.renders.length, when === 'render' ? 1 : 0);
  });
});

test('evidence absence and source/staging faults never invoke Pi', async t => {
  const cases = {
    missingSpeech: report => { delete report.speech; },
    unavailableSpeech: report => { report.speech.status = 'unavailable'; },
    missingWindow: report => { report.windows = []; },
    fabricatedWindow: report => { report.windows[0].segments[0] = { start: 1, end: 2, text: 'different' }; },
    missingContribution: report => { report.findings.find(item => item.check === 'native_source_contribution').status = 'fail'; },
    missingMedia: report => { report.findings.push({ check: 'missing_media', status: 'fail' }); },
    unknownCoverage: report => { report.findings.find(item => item.check === 'detected_speech_coverage').status = 'unknown'; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async t => {
    const { controller, state } = harness(t, () => ({ inspectRender: (pkg, request) => {
      const report = reportFixture(pkg, request.renderId); mutate(report); return report;
    } }));
    const result = await controller.run(input());
    assert.ok(['unavailable_evidence', 'source_or_staging_fault'].includes(result.reason));
    assert.equal(state.turns.length, 0);
    assert.equal(result.attempts, 0);
  });
});

test('observed matching text alone never authorizes a trim', async t => {
  const { controller, state } = harness(t, () => ({ inspectRender: (pkg, request) =>
    reportFixture(pkg, request.renderId, { statuses: ['pass', 'pass'] }) }));
  const result = await controller.run(input());
  assert.equal(state.turns.length, 0);
  assert.equal(result.reason, 'scoped_checks_satisfied');
  assert.equal(result.acceptance, 'not_assessed');
});

test('missing word despite passing coverage invokes Pi source inspection and false-to-true is improvement', async t => {
  const { controller, state } = harness(t, () => ({ inspectRender: (pkg, request) => {
    const report = reportFixture(pkg, request.renderId, { statuses: ['pass', 'pass'] });
    const text = report.findings.find(finding => finding.check === 'asr_text_comparison' && finding.sceneId === 'scene_one');
    text.matchObserved = pkg.revision > 4;
    if (pkg.revision === 4) {
      report.speech.segments[0].text = 'these words.';
      report.windows[0].segments[0].text = 'these words.';
    }
    return report;
  } }));
  const result = await controller.run(input());
  assert.equal(result.reason, 'scoped_checks_satisfied');
  assert.equal(result.acceptance, 'not_assessed');
  assert.equal(state.turns.length, 1);
  assert.deepEqual(state.turns[0].sceneIds, ['scene_one']);
  assert.equal(state.renders.length, 1);
  assert.equal(result.reports[0].findings.find(finding => finding.check === 'asr_text_comparison').matchObserved, false);
});

test('unknown text comparison or wholly unobserved line blocks satisfaction and repair', async t => {
  for (const mode of ['null', 'omitted', 'unobserved']) await t.test(mode, async t => {
    const { controller, state } = harness(t, () => ({ inspectRender: (pkg, request) => {
      const report = reportFixture(pkg, request.renderId, { statuses: ['pass', 'pass'] });
      const text = report.findings.find(finding => finding.check === 'asr_text_comparison');
      if (mode === 'omitted') delete text.matchObserved;
      else text.matchObserved = mode === 'unobserved' ? false : null;
      if (mode === 'unobserved') report.windows[0].segments = [];
      return report;
    } }));
    const result = await controller.run(input());
    assert.equal(result.reason, 'unavailable_evidence');
    assert.equal(result.checksSatisfied, false);
    assert.equal(state.turns.length, 0);
  });
});

test('observed text match regressing to mismatch or unknown stops despite improved coverage', async t => {
  for (const matchObserved of [false, null]) await t.test(String(matchObserved), async t => {
    const { controller, state } = harness(t, () => ({ inspectRender: (pkg, request) => {
      const report = reportFixture(pkg, request.renderId, { statuses: pkg.revision === 4 ? ['needs_review', 'pass'] : ['pass', 'pass'] });
      if (pkg.revision > 4) report.findings.find(finding => finding.check === 'asr_text_comparison').matchObserved = matchObserved;
      return report;
    } }));
    const result = await controller.run(input());
    assert.equal(result.reason, 'regression');
    assert.equal(result.checksSatisfied, false);
    assert.equal(state.turns.length, 1);
    assert.equal(state.renders.length, 1);
  });
});

test('regression, unchanged observations, and no improvement stop after one render', async t => {
  for (const mode of ['regression', 'repeated', 'no_improvement']) await t.test(mode, async t => {
    let original;
    const { controller, state } = harness(t, () => ({ inspectRender: (pkg, request) => {
      const report = reportFixture(pkg, request.renderId, { fault: pkg.revision > 4 && mode === 'regression' ? 'audio_stream' : undefined });
      if (pkg.revision === 4) original = clone(report);
      if (pkg.revision > 4 && mode === 'repeated') {
        report.speech = original.speech; report.windows = original.windows;
      }
      return report;
    } }));
    const result = await controller.run(input());
    assert.equal(result.reason, mode === 'repeated' ? 'repeated_evidence' : mode);
    assert.equal(state.turns.length, 1);
    assert.equal(state.renders.length, 1);
    assert.equal(state.pkg.revision, 5);
  });
});

test('per-run bound and two-render ceiling permit only improving rounds', async t => {
  for (const maxRepairs of [1, 2]) await t.test(String(maxRepairs), async t => {
    const { controller, state } = harness(t, () => ({ inspectRender: (pkg, request) => reportFixture(pkg, request.renderId,
      { statuses: pkg.revision === 4 ? ['fail', 'fail'] : pkg.revision === 5 ? ['needs_review', 'fail'] : ['pass', 'fail'] }) }));
    const result = await controller.run(input({ maxRepairs }));
    assert.equal(result.reason, 'attempts_exhausted');
    assert.equal(result.attempts, maxRepairs);
    assert.equal(state.renders.length, maxRepairs);
    assert.equal(state.turns.length, maxRepairs);
  });
});

test('second Pi turn receives durable exact trims and paired review evidence', async t => {
  const { controller, state, runtimeDir } = harness(t, () => ({ inspectRender: (pkg, request) => reportFixture(pkg, request.renderId,
    { statuses: pkg.revision === 4 ? ['fail', 'fail'] : pkg.revision === 5 ? ['needs_review', 'fail'] : ['pass', 'pass'] }) }));
  state.pkg.scenes[0].background.trim = { startSeconds: 0.1 };
  const result = await controller.run(input());
  assert.deepEqual(state.turns[0].priorAttempts, []);
  const [prior] = state.turns[1].priorAttempts;
  assert.equal(state.turns[1].priorAttempts.length, 1);
  assert.equal(Object.isFrozen(prior.sourceTrimChanges[0].after), true);
  assert.equal(prior.repairId, input().repairId);
  assert.equal(prior.attempt, 1);
  assert.equal(prior.beforeRevision, 4);
  assert.equal(prior.afterRevision, 5);
  assert.equal(prior.validation, 'source_in_only');
  assert.deepEqual(prior.sourceTrimChanges, [
    { sceneId: 'scene_one', before: { startSeconds: 0.1 }, after: { startSeconds: 0.25 } },
    { sceneId: 'scene_two', before: null, after: { startSeconds: 0.25 } },
  ]);
  for (const [summary, report] of [[prior.before, result.reports[0]], [prior.after, result.reports[1]]]) {
    for (const field of ['reviewId', 'renderId', 'packageRevision', 'packageHash', 'timelineHash', 'videoSha256']) assert.equal(summary[field], report[field]);
    assert.ok(summary.findings.some(finding => finding.check === 'detected_speech_coverage'));
    assert.ok(summary.findings.some(finding => finding.check === 'asr_text_comparison'));
    assert.ok(summary.findings.every(finding => finding.check !== 'visual_quality'));
  }
  const durable = JSON.parse(readFileSync(join(runtimeDir, 'self-repairs/repair_example.json')));
  assert.deepEqual(durable.history.find(item => item.type === 'edit_observed').sourceTrimChanges, prior.sourceTrimChanges);
  assert.equal(result.reason, 'scoped_checks_satisfied');
});

test('prior attempts survive a new controller, repair ID, and conversation', async t => {
  const { controller, state, dependencies } = harness(t, () => ({ inspectRender: (pkg, request) => reportFixture(pkg, request.renderId,
    { statuses: pkg.revision === 4 ? ['fail', 'fail'] : pkg.revision === 5 ? ['needs_review', 'fail'] : ['pass', 'pass'] }) }));
  const first = await controller.run(input({ maxRepairs: 1 }));
  assert.equal(first.reason, 'attempts_exhausted');
  const second = createSelfRepairController(dependencies);
  await second.run(input({ repairId: 'repair_other', conversationId: 'conv_other', expectedRevision: 5, renderId: renderId(2), maxRepairs: 1 }));
  const [prior] = state.turns[1].priorAttempts;
  assert.equal(prior.repairId, first.repairId);
  assert.equal(prior.conversationId, 'conv_example');
  assert.equal(prior.runReason, 'attempts_exhausted');
  assert.equal(prior.before.reviewId, first.reports[0].reviewId);
  assert.equal(prior.after.reviewId, first.reports[1].reviewId);
  assert.deepEqual(prior.sourceTrimChanges, first.history.find(item => item.type === 'edit_observed').sourceTrimChanges);
});

test('unobserved failed turn is distinct from an observed no-op in prior context', async t => {
  for (const fail of [false, true]) await t.test(String(fail), async t => {
    const { controller, dependencies } = harness(t, () => ({ chatTurn: () => { if (fail) throw new Error('unknown tool effect'); } }));
    await controller.run(input());
    let prior;
    const second = createSelfRepairController({ ...dependencies, chatTurn: turn => { prior = turn.priorAttempts[0]; } });
    await second.run(input({ repairId: 'repair_retry', conversationId: 'conv_other' }));
    assert.equal(prior.after, null);
    assert.ok(prior.before.reviewId);
    assert.deepEqual(prior.sourceTrimChanges, fail ? null : []);
    assert.equal(prior.validation, fail ? 'not_observed' : 'no_op');
  });
});

test('lower-third overlap alone is informational and never starts a repair', async t => {
  for (const status of ['needs_review', 'unknown', 'fail']) await t.test(status, async t => {
    const { controller, state } = harness(t, () => ({ inspectRender: (pkg, request) => {
      const report = reportFixture(pkg, request.renderId, { statuses: ['pass', 'pass'] });
      report.findings.push({ check: 'speech_lower_third_overlap', sceneId: 'scene_one', status });
      return report;
    } }));
    const result = await controller.run(input());
    assert.equal(result.reason, 'scoped_checks_satisfied');
    assert.equal(result.acceptance, 'not_assessed');
    assert.equal(state.turns.length, 0);
    assert.equal(state.renders.length, 0);
  });
});

test('lower-third observations retain conservative regressions but cannot justify another round', async t => {
  for (const mode of ['regression', 'no_improvement']) await t.test(mode, async t => {
    const { controller, state } = harness(t, () => ({ inspectRender: (pkg, request) => {
      const report = reportFixture(pkg, request.renderId,
        { statuses: pkg.revision > 4 && mode === 'regression' ? ['pass', 'pass'] : ['needs_review', 'needs_review'] });
      report.findings.push({ check: 'speech_lower_third_overlap', sceneId: 'scene_one',
        status: (pkg.revision === 4) === (mode === 'regression') ? 'pass' : 'needs_review' });
      return report;
    } }));
    const result = await controller.run(input());
    assert.equal(result.reason, mode);
    assert.equal(state.turns.length, 1);
    assert.equal(state.renders.length, 1);
  });
});

test('persistent package budget cannot be reset by repair ID, conversation or controller', async t => {
  const { controller, dependencies, runtimeDir } = harness(t, () => ({ chatTurn: () => {} }));
  assert.equal((await controller.run(input({ repairId: 'repair_one' }))).reason, 'no_op');
  const restarted = createSelfRepairController(dependencies);
  assert.equal((await restarted.run(input({ repairId: 'repair_two', conversationId: 'conv_other' }))).reason, 'no_op');
  const third = await restarted.run(input({ repairId: 'repair_three', conversationId: 'conv_third' }));
  assert.equal(third.reason, 'package_budget_exhausted');
  assert.equal(third.attempts, 0);
  const budget = JSON.parse(readFileSync(join(runtimeDir, 'self-repairs/packages/pkg_example.json')));
  assert.deepEqual(budget.reservations.map(item => item.repairId), ['repair_one', 'repair_two']);
});

test('tool/render failures retain committed changes, stage and consumed reservation', async t => {
  for (const where of ['tool', 'render']) await t.test(where, async t => {
    const { controller, state } = harness(t, (state, callbacks) => ({
      chatTurn: async args => { await callbacks.chatTurn(args); if (where === 'tool') throw new Error('tool failed after commit'); },
      renderCurrent: () => { throw new Error('CPU export failed'); },
    }));
    const result = await controller.run(input());
    assert.equal(result.reason, `${where}_failed`);
    assert.equal(result.stage, where === 'tool' ? 'chat_turn' : 'render');
    assert.equal(result.observedRevision, 5);
    assert.equal(result.effectUncertain, true);
    assert.equal(result.packageRoundsReserved, 1);
    assert.equal(state.pkg.revision, 5);
  });
});

test('cancellation before start and after Pi commit cannot render or silently retry', async t => {
  for (const when of ['before', 'during']) await t.test(when, async t => {
    const abort = new AbortController();
    const { controller, state } = harness(t, (state, callbacks) => ({ chatTurn: async args => {
      await callbacks.chatTurn(args); abort.abort(new Error('user cancelled'));
    } }));
    if (when === 'before') abort.abort();
    const result = await controller.run(input(), { signal: abort.signal });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.reason, 'cancelled');
    assert.equal(result.attempts, when === 'before' ? 0 : 1);
    assert.equal(state.renders.length, 0);
    assert.deepEqual(await controller.run(input()), result);
  });
});

test('aborted uncooperative callback keeps per-package lock until it settles', async t => {
  let resolveTurn, started;
  const ready = new Promise(resolve => { started = resolve; });
  const abort = new AbortController();
  const { controller, dependencies } = harness(t, () => ({ chatTurn: () => new Promise(resolve => { resolveTurn = resolve; started(); }) }));
  const running = controller.run(input(), { signal: abort.signal });
  await ready;
  const second = createSelfRepairController(dependencies);
  await assert.rejects(second.run(input({ repairId: 'repair_parallel' })), { code: 'SELF_REPAIR_BUSY' });
  abort.abort();
  assert.equal((await running).status, 'cancelled');
  await assert.rejects(second.run(input({ repairId: 'repair_parallel' })), { code: 'SELF_REPAIR_BUSY' });
  resolveTurn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.get(input().repairId).status, 'cancelled');
});

test('15-minute deadline aborts a turn and never starts a render', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started, resolveTurn;
  const ready = new Promise(resolve => { started = resolve; });
  const { controller, state } = harness(t, () => ({ chatTurn: () => new Promise(resolve => { resolveTurn = resolve; started(); }) }));
  const running = controller.run(input());
  await ready;
  t.mock.timers.tick(15 * 60 * 1000);
  const result = await running;
  assert.equal(result.reason, 'run_budget_exhausted');
  assert.equal(result.attempts, 1);
  assert.equal(state.renders.length, 0);
  resolveTurn();
  await new Promise(resolve => setImmediate(resolve));
});

test('idempotency replays records, rejects conflicts, and restart never resumes effects', async t => {
  const { controller, dependencies, state, runtimeDir } = harness(t, () => ({}));
  const result = await controller.run(input());
  const restarted = createSelfRepairController(dependencies);
  assert.deepEqual(await restarted.run(input()), result);
  await assert.rejects(restarted.run(input({ maxRepairs: 1 })), { code: 'SELF_REPAIR_CONFLICT' });
  assert.equal(state.turns.length, 1);
  // Model a process that died after reservation and before the Pi turn returned.
  const file = join(runtimeDir, 'self-repairs/repair_example.json');
  const interrupted = { ...result, status: 'running', reason: null, stage: 'chat_turn', ownerPid: 2147483647 };
  writeFileSync(file, JSON.stringify(interrupted));
  const recovered = restarted.get('repair_example');
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.reason, 'restart_interrupted');
  assert.equal(recovered.stage, 'chat_turn');
  assert.equal(recovered.effectUncertain, true);
  assert.equal(recovered.reports.length, 2);
  assert.equal(recovered.history.at(-1).type, 'interrupted');
  assert.deepEqual(await restarted.run(input()), recovered);
  assert.equal(state.turns.length, 1);
  assert.equal(state.renders.length, 1);
});
