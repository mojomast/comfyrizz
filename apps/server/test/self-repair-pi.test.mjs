import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { recordGenerationReceipts } from '../../../packages/jobs/src/model-contribution.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';
import { createProjectChat } from '../src/agent-chat.mjs';
import { PackageStore } from '../src/store.mjs';
import { publishRenderArtifact, readRenderArtifact } from '../src/render-artifacts.mjs';
import { createRenderReviewer } from '../src/render-review.mjs';
import { createSelfRepairController } from '../src/self-repair.mjs';
import { createSelfRepairAdapters } from '../src/self-repair-integration.mjs';

// Real local MP4/ffprobe, receipt validation, Pi scheduling, chat tools and CAS.
// Speech timing and generation provenance are explicitly synthetic contracts:
// these test-pattern pixels and sine tones are NOT H3 generation or real speech.
// The render callback is a CPU fixture encoder, not the production compositor.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const line = 'It was in my pocket.';
const initialRenderId = 'r_111111abcdef';
const correctedRenderId = 'r_222222abcdef';
const conversationId = 'chat_self_repair_pi_001';
const speech = (start, end, text = line) => ({ provider: 'explicit-synthetic-self-repair-ASR', uncertaintySeconds: 0.1,
  segments: [{ start, end, text }] });
const finding = (report, check) => report.findings.find(item => item.check === check);
const toolResults = request => request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
const timing = pkg => {
  const timeline = compileTimeline(pkg);
  return { fps: timeline.fps, durationInFrames: timeline.durationInFrames,
    scenes: timeline.scenes.map(scene => [scene.id, scene.from, scene.durationInFrames, scene.transitionInFrames, scene.transitionOutFrames]) };
};

function fixture(t) {
  const runtimeDir = mkdtempSync('/tmp/opencode/self-repair-pi-');
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const rendersDir = join(runtimeDir, 'renders');
  mkdirSync(join(store.dir, 'assets')); mkdirSync(rendersDir);
  const sourceFile = join(store.dir, 'assets/native.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '8',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourceFile]);
  const sourceBytes = readFileSync(sourceFile);
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url)));
  Object.assign(pkg, { id: 'pkg_self_repair_pi', revision: 25, title: 'Explicit synthetic Pi repair fixture',
    format: { width: 320, height: 180, fps: 24 }, duration: { mode: 'target', targetFrames: 144, exact: true },
    voice: { enabled: false, engine: 'none' }, datasets: {}, assets: {}, renders: [],
    theme: { palette: ['#0d0f14', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    scenes: [{ id: 's1', layout: 'hero', preferredFrames: 144, copy: { headline: 'The confession', kicker: 'Evidence' },
      background: { asset: 'a_native', muted: false, loop: false, speed: 1 },
      lower_third: { text: 'CASE CLOSED', start_frame: 0 } }] });
  collectMockContribution(pkg, store.dir);
  const workflow = 'workflows/fasth3_omni_ref2va.api.json';
  const graph = readFileSync(new URL(`../../../${workflow}`, import.meta.url));
  writeFileSync(join(store.dir, 'assets/native.workflow.api.json'), graph);
  pkg.assets.a_native = { kind: 'video', origin: 'generated', status: 'ready', file: 'assets/native.mp4',
    sha256: sha(sourceBytes), bytes: sourceBytes.length,
    license: { id: 'LicenseRef-MiniMax-H3-Community' }, model_license: { id: 'LicenseRef-MiniMax-H3-Community' },
    media: { width: 320, height: 180, fps: 24, frames: 192, durationSeconds: 8, audio: 'present' },
    gen: { generator: 'fasth3-omni', workflow, workflow_sha256: sha(graph), inputs: { fps: 24, frames: 192, seed: 1 },
      direction: { subject: 'Synthetic fixture subject', composition: 'Medium interview shot', action: 'Speaks',
        camera: 'Locked', soundscape: 'Office room tone', characterCount: 1,
        dialogue: { text: line, conditioningText: line, language: 'English', voice: 'af_heart', delivery: 'Deadpan' } } } };
  const jobsDoc = { hash: sha('explicit-synthetic-self-repair-job'),
    jobs: [{ id: 'native', generator: 'fasth3-omni', workflow, workflowSha256: sha(graph) }] };
  const manifest = { run_id: 'synthetic-pi-repair-run', jobsHash: jobsDoc.hash,
    jobs: [{ job: 'native', status: 'succeeded', job_id: 'synthetic-job', attempt_id: 'synthetic-attempt',
      outputs: [{ relative: 'assets/native.mp4', sha256: sha(sourceBytes), bytes: sourceBytes.length,
        workflow_submitted: true, measured: pkg.assets.a_native.media }] }] };
  assert.equal(recordGenerationReceipts({ manifest, jobsDoc, outputDir: store.dir, backend: 'byo-comfyui' }).length, 1);
  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  store.write(pkg);
  mkdirSync(join(runtimeDir, 'conversations'));
  writeFileSync(join(runtimeDir, 'conversations', `${conversationId}.json`), JSON.stringify({ id: conversationId,
    revision: 0, projectId: pkg.id, projectRevision: pkg.revision, plan: null, phase: 'built',
    messages: [{ role: 'user', content: 'Preserve the complete spoken line and all authored copy and timing. Apply bounded source-in repairs and rerender existing media.' }] }));

  const observations = [];
  const speechInspector = async input => {
    assert.deepEqual(Object.keys(input).sort(), ['durationSeconds', 'file', 'sha256', 'signal']);
    assert.equal(input.sha256, sha(readFileSync(input.file)));
    observations.push({ file: input.file, sha256: input.sha256 });
    if (input.file === sourceFile) return speech(4.4, 6.62);
    if (input.file === join(rendersDir, `${initialRenderId}.mp4`)) return speech(4.4, 5.95, 'It was in my');
    assert.equal(input.file, join(rendersDir, `${correctedRenderId}.mp4`));
    return speech(3.65, 5.87);
  };
  function publish(candidate, renderId) {
    const file = join(rendersDir, `${renderId}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-ss', String(candidate.scenes[0].background.trim?.startSeconds ?? 0),
      '-i', sourceFile, '-t', '6', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    const timeline = compileTimeline(candidate);
    const metadata = publishRenderArtifact({ renderId, rendersDir, receiptDir: store.dir, staged: { packageDir: store.dir },
      snapshot: { intent: 'final', package: candidate, timeline }, result: { output: file },
      revision: candidate.revision, preflight: { final: true, fixture: 'synthetic CPU encoder; not production render admission' } });
    return { metadata, file, bytes: readFileSync(file) };
  }
  const initial = publish(pkg, initialRenderId);
  const reviewer = createRenderReviewer({ runtimeDir, packageDir: store.dir, transcribe: speechInspector });
  const inspectInput = { packageId: pkg.id, expectedRevision: pkg.revision, renderId: initialRenderId };
  const requests = [], failures = [];
  const providerSettings = {
    snapshot: () => ({ active: { provider: 'custom', model: 'scripted-self-repair-fixture' } }),
    resolve: () => ({ model: 'scripted-self-repair-fixture' }), redact: value => value,
  };
  let factoryCalls = 0;
  function chatWith(script, hooks) {
    let step = 0;
    const model = { id: 'scripted-self-repair-fixture', async *stream(request) {
      requests.push(request);
      try {
        assert.ok(step < script.length, 'Pi must not request an unplanned model step');
        const entry = script[step++];
        const output = typeof entry === 'function' ? entry(request) : entry;
        if (typeof output === 'string') yield { type: 'text', delta: output };
        else for (const [index, call] of (Array.isArray(output) ? output : [output]).entries()) {
          yield { type: 'tool_call', id: `call_${step}_${index}`, ...call };
        }
        yield { type: 'done' };
      } catch (error) { failures.push(error); throw error; }
    } };
    return createProjectChat({ runtimeDir, store, prepareBrand: () => null, skillsEnabled: false, speechInspector,
      providerSettings,
      modelFactory: () => { factoryCalls++; return model; }, hooks });
  }
  const repairInput = { repairId: 'repair_pi_round_001', packageId: pkg.id, expectedRevision: pkg.revision,
    renderId: initialRenderId, conversationId, maxRepairs: 2 };
  return { runtimeDir, store, rendersDir, sourceFile, sourceBytes, pkg, initial, reviewer, observations,
    requests, failures, providerSettings, chatWith, publish, inspectInput, repairInput, factoryCalls: () => factoryCalls };
}

test('actual embedded Pi inspects, stages and commits one source-only repair before final MP4 reinspection', { timeout: 60000 }, async t => {
  const ctx = fixture(t);
  let sourceReport, chatCalls = 0, renderCalls = 0, chatResult, finalArtifact;
  const phases = [];
  const chat = ctx.chatWith([
    request => {
      const context = request.messages.find(message => message.content?.startsWith('<repair_context>'));
      assert.ok(context, 'trusted final-render evidence must reach the actual Pi model request');
      const data = JSON.parse(context.content.match(/<repair_context>\s*([\s\S]*?)\s*<\/repair_context>/)[1]);
      assert.equal(data.report.artifact.renderId, initialRenderId);
      assert.equal(data.report.artifact.videoSha256, ctx.initial.metadata.videoSha256);
      assert.equal(finding(data.report, 'detected_speech_coverage').status, 'needs_review');
      assert.equal(finding(data.report, 'asr_text_comparison').matchObserved, false);
      assert.deepEqual(data.sceneIds, ['s1']); assert.equal(data.requirements[0].dialogue, line);
      assert.equal(data.report.acceptance, 'not_assessed');
      for (const name of ['project_update_plan', 'project_patch_plan', 'production_command', 'clip_select_take']) {
        assert.equal(request.tools.some(tool => tool.name === name), false, `${name} must not be advertised`);
      }
      return { name: 'project_inspect_source', args: { packageId: ctx.pkg.id, expectedRevision: 25, sceneId: 's1' } };
    },
    request => {
      sourceReport = toolResults(request).find(result => result.inspectionId);
      assert.ok(sourceReport); assert.equal(sourceReport.source.fps, 24);
      assert.equal(sourceReport.source.sha256, sha(ctx.sourceBytes));
      assert.equal(sourceReport.suggestedInFrame, 18);
      assert.equal(finding(sourceReport, 'detected_speech_coverage').status, 'fail');
      return { name: 'project_edit_package', args: { packageId: ctx.pkg.id, expectedRevision: 25,
        edits: [{ sceneId: 's1', backgroundSourceIn: { inspectionId: sourceReport.inspectionId, inFrame: sourceReport.suggestedInFrame } }] } };
    },
    request => {
      const staged = toolResults(request).at(-1);
      assert.equal(staged.staged, true);
      assert.deepEqual(staged.diff, [{ path: 'scenes.s1.background.trim', before: null, after: { startSeconds: 0.75 } }]);
      assert.deepEqual(ctx.store.read(ctx.pkg.id), ctx.pkg, 'staging must not save the package');
      return { name: 'project_build', args: {} };
    },
    request => {
      assert.equal(toolResults(request).at(-1).revision, 26);
      assert.equal(ctx.store.read(ctx.pkg.id).revision, 25, 'Pi build result precedes the journal/CAS commit');
      assert.deepEqual(request.tools, []);
      return 'Applied the source-only correction. Final-render verification is still pending; human acceptance is not assessed.';
    },
  ], { beforePackageSave: () => phases.push('commit') });
  const adapters = createSelfRepairAdapters({ store: ctx.store, projectChat: chat, providerSettings: ctx.providerSettings });
  const controller = createSelfRepairController({ runtimeDir: ctx.runtimeDir, readPackage: id => ctx.store.read(id),
    inspectRender: (pkg, input, options) => {
      phases.push(`inspect:${input.renderId}`);
      return ctx.reviewer.inspect(pkg, input, options);
    },
    chatTurn: async input => {
      chatCalls++; phases.push('pi');
      chatResult = await adapters.chatTurn(input);
      return chatResult;
    },
    renderCurrent: async ({ packageId, expectedRevision, signal }) => {
      signal.throwIfAborted(); renderCalls++; phases.push('render');
      assert.equal(expectedRevision, 26);
      const saved = ctx.store.read(packageId);
      assert.equal(saved.revision, expectedRevision);
      assert.deepEqual(saved.scenes[0].background.trim, { startSeconds: 0.75 });
      assert.equal(chat.get(conversationId).conversation.sourceRepairBatches[packageId], 1, 'chat commit must be durable before render');
      finalArtifact = ctx.publish(saved, correctedRenderId);
      return { renderId: correctedRenderId };
    } });
  const outcome = await controller.run(ctx.repairInput);
  assert.deepEqual(ctx.failures, []);
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  assert.equal(outcome.reason, 'scoped_checks_satisfied');
  assert.equal(outcome.checksSatisfied, true); assert.equal(outcome.acceptance, 'not_assessed');
  assert.equal(outcome.attempts, 1); assert.equal(outcome.renders, 1);
  assert.equal(chatCalls, 1); assert.equal(ctx.factoryCalls(), 1); assert.equal(renderCalls, 1);
  assert.equal(ctx.requests.length, 4, 'one Pi repair turn with three tool steps and its summary; no second repair turn');
  assert.equal(chatResult.built, true);
  assert.deepEqual(chatResult.conversation.trace.tools.map(({ name, ok }) => [name, ok]),
    [['project_inspect_source', true], ['project_edit_package', true], ['project_build', true]]);
  assert.deepEqual(phases, [`inspect:${initialRenderId}`, 'pi', 'commit', 'render', `inspect:${correctedRenderId}`]);
  const expected = structuredClone(ctx.pkg);
  expected.revision++; expected.scenes[0].background.trim = { startSeconds: 0.75 };
  const saved = ctx.store.read(ctx.pkg.id);
  assert.deepEqual(saved, expected, 'all copy, assets, generation inputs, authored timing and other fields are preserved');
  assert.deepEqual(timing(saved), timing(ctx.pkg));
  assert.deepEqual(readFileSync(ctx.sourceFile), ctx.sourceBytes);
  assert.deepEqual(readFileSync(ctx.initial.file), ctx.initial.bytes, 'old render bytes must remain intact');
  assert.notDeepEqual(finalArtifact.bytes, ctx.initial.bytes);
  const [before, after] = outcome.reports;
  assert.equal(outcome.reports.length, 2); assert.notEqual(before.reviewId, after.reviewId);
  assert.notEqual(before.videoSha256, after.videoSha256); assert.notEqual(before.timelineHash, after.timelineHash);
  assert.equal(before.packageRevision, 25); assert.equal(after.packageRevision, 26);
  assert.equal(finding(before, 'detected_speech_coverage').status, 'needs_review');
  assert.equal(finding(after, 'detected_speech_coverage').status, 'pass');
  assert.equal(finding(before, 'asr_text_comparison').matchObserved, false);
  assert.equal(finding(after, 'asr_text_comparison').matchObserved, true);
  for (const report of outcome.reports) {
    assert.equal(report.acceptance, 'not_assessed'); assert.equal(report.capabilities.humanAcceptance, 'not_assessed');
    assert.equal(finding(report, 'visual_quality').status, 'unknown');
    const artifact = readRenderArtifact({ renderId: report.renderId, rendersDir: ctx.rendersDir, receiptDir: ctx.store.dir });
    assert.equal(sha(artifact.bytes), report.videoSha256);
    assert.equal(artifact.metadata.revision, report.packageRevision);
  }
  assert.equal(readdirSync(join(ctx.runtimeDir, 'render-reviews')).length, 2);
  assert.equal(readdirSync(join(ctx.runtimeDir, 'source-reviews')).length, 1);
  assert.deepEqual(ctx.observations.map(item => item.file), [ctx.initial.file, ctx.sourceFile, finalArtifact.file]);
  assert.deepEqual(await controller.run(ctx.repairInput), outcome, 'idempotent replay reuses the completed outcome');
  assert.equal(chatCalls, 1); assert.equal(renderCalls, 1); assert.equal(ctx.requests.length, 4);
});

test('actual Pi repair turn refuses copy, draft, approval and premature build calls without mutation', { timeout: 60000 }, async t => {
  const ctx = fixture(t);
  const report = await ctx.reviewer.inspect(ctx.pkg, ctx.inspectInput);
  const forbidden = [
    { name: 'project_edit_package', args: { packageId: ctx.pkg.id, expectedRevision: 25,
      edits: [{ sceneId: 's1', copy: { headline: 'UNAUTHORIZED' } }] } },
    { name: 'project_patch_plan', args: { title: 'UNAUTHORIZED' } },
    { name: 'project_update_plan', args: { title: 'UNAUTHORIZED' } },
    { name: 'production_command', args: { kind: 'delivery.accept', payload: {} } },
    { name: 'production_command', args: { kind: 'plan.approve', payload: {} } },
    { name: 'project_build', args: {} },
  ];
  const chat = ctx.chatWith([forbidden, 'These operations were refused. No changes were applied.']);
  const beforeConversation = chat.get(conversationId).conversation;
  const adapters = createSelfRepairAdapters({ store: ctx.store, projectChat: chat, providerSettings: ctx.providerSettings });
  await assert.rejects(adapters.chatTurn({ pkg: ctx.pkg, report, sceneIds: ['s1'], attempt: 1, conversationId,
    signal: new AbortController().signal }), { code: 'SELF_REPAIR_TOOL' });
  const result = chat.get(conversationId);
  assert.deepEqual(ctx.failures, []); assert.equal(result.built, false);
  assert.equal(ctx.requests.length, 2, 'Pi receives the refusal results before returning its summary');
  const results = toolResults(ctx.requests.at(-1));
  assert.equal(results.length, forbidden.length);
  for (const result of results) {
    assert.equal(result.code, 'REPAIR_SCOPE'); assert.ok(result.error);
  }
  assert.deepEqual(result.conversation, beforeConversation, 'failed repair tools must not commit even conversation state');
  assert.deepEqual(ctx.store.read(ctx.pkg.id), ctx.pkg);
  assert.equal(result.conversation.packageEdit ?? null, null);
  assert.equal(result.conversation.sourceRepairBatches?.[ctx.pkg.id] ?? 0, 0);
  assert.deepEqual(readFileSync(ctx.initial.file), ctx.initial.bytes);
});

test('a stale final artifact blocks the controller and internal repair context before any Pi model request', { timeout: 60000 }, async t => {
  const ctx = fixture(t);
  const report = await ctx.reviewer.inspect(ctx.pkg, ctx.inspectInput);
  const chat = ctx.chatWith([]);
  const adapters = createSelfRepairAdapters({ store: ctx.store, projectChat: chat, providerSettings: ctx.providerSettings });
  writeFileSync(ctx.initial.file, 'explicitly tampered final artifact');
  const turn = { pkg: ctx.pkg, report, sceneIds: ['s1'], attempt: 1, conversationId, signal: new AbortController().signal };
  await assert.rejects(adapters.chatTurn(turn), /changed|missing/i);
  assert.equal(ctx.requests.length, 0, 'internal repairContext must revalidate the saved report before model inference');
  let chatCalls = 0, renderCalls = 0;
  const controller = createSelfRepairController({ runtimeDir: ctx.runtimeDir, readPackage: id => ctx.store.read(id),
    inspectRender: (pkg, input, options) => ctx.reviewer.inspect(pkg, input, options),
    chatTurn: input => { chatCalls++; return adapters.chatTurn(input); },
    renderCurrent: async () => { renderCalls++; throw new Error('must not render stale evidence'); } });
  const outcome = await controller.run(ctx.repairInput);
  assert.equal(outcome.status, 'stopped'); assert.equal(outcome.attempts, 0); assert.equal(outcome.renders, 0);
  assert.equal(outcome.checksSatisfied, false); assert.equal(outcome.acceptance, 'not_assessed');
  assert.equal(chatCalls, 0); assert.equal(renderCalls, 0); assert.equal(ctx.requests.length, 0);
  assert.deepEqual(ctx.store.read(ctx.pkg.id), ctx.pkg);
});
