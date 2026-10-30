import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { contributionStore, recordGenerationReceipts } from '../../../packages/jobs/src/model-contribution.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';
import { publishRenderArtifact } from '../src/render-artifacts.mjs';
import { createRenderReviewer, RENDER_INSPECT_TOOL } from '../src/render-review.mjs';
import { createLocalSpeechInspector } from '../src/local-speech-inspector.mjs';

// Synthetic provenance and ASR contracts only. Even the real CPU MP4 fixture
// contains color + a sine tone, not generated H3 pixels or genuine speech.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const line = 'The office spoon vanished.';
const observed = { provider: 'explicit-synthetic-final-ASR', uncertaintySeconds: 0.1,
  segments: [{ start: 0.5, end: 2.5, text: line }, { start: 4.5, end: 6.5, text: line }] };
const measured = { durationSec: 8, videoDurationSec: 8, fps: 24, frames: 192, width: 64, height: 64, audio: 'present', video: 'present' };

function fixture(t, { real = false, realAudio = true, nativeReceipt = true, transcribe = null, probe, changePackage } = {}) {
  const runtimeDir = mkdtempSync('/tmp/opencode/render-review-');
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const packageDir = join(runtimeDir, 'packages'), rendersDir = join(runtimeDir, 'renders');
  mkdirSync(join(packageDir, 'assets'), { recursive: true }); mkdirSync(rendersDir);
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url)));
  Object.assign(pkg, { id: 'pkg_render_review', revision: 3, title: 'Synthetic final-media review fixture',
    format: { width: 64, height: 64, fps: 24 }, duration: { mode: 'target', targetFrames: 192, exact: true },
    voice: { enabled: false, engine: 'none' }, datasets: {}, assets: {}, renders: [],
    scenes: [1, 2].map(i => ({ id: `s${i}`, layout: 'hero', media_only: true, preferredFrames: 96,
      background: { asset: 'a_native', muted: false, loop: false, speed: 1 },
      ...(i === 1 ? { lower_third: { text: 'CASE CLOSED', start_frame: 72 } } : {}) })) });
  collectMockContribution(pkg, packageDir);
  const workflow = 'workflows/fasth3_omni_ref2va.api.json';
  const graph = readFileSync(new URL(`../../../${workflow}`, import.meta.url));
  const source = Buffer.from('explicit synthetic H3 source bytes; not generated media');
  writeFileSync(join(packageDir, 'assets/native.mp4'), source);
  writeFileSync(join(packageDir, 'assets/native.workflow.api.json'), graph);
  pkg.assets.a_native = { kind: 'video', origin: 'generated', status: 'ready', file: 'assets/native.mp4', sha256: sha(source), bytes: source.length,
    media: { width: 64, height: 64, fps: 24, frames: 192, durationSeconds: 8, audio: 'present' },
    gen: { generator: 'fasth3-omni', workflow, workflow_sha256: sha(graph), inputs: { fps: 24, frames: 192 }, direction: { dialogue: { text: line } } } };
  if (nativeReceipt) {
    const output = { relative: 'assets/native.mp4', sha256: sha(source), bytes: source.length, workflow_submitted: true, measured: pkg.assets.a_native.media };
    const jobsDoc = { hash: sha('synthetic-native-job'), jobs: [{ id: 'native', generator: 'fasth3-omni', workflow, workflowSha256: sha(graph) }] };
    const manifest = { run_id: 'synthetic-native-run', jobsHash: jobsDoc.hash, jobs: [{ job: 'native', status: 'succeeded', job_id: 'synthetic-job', attempt_id: 'synthetic-attempt', outputs: [output] }] };
    assert.equal(recordGenerationReceipts({ manifest, jobsDoc, outputDir: packageDir, backend: 'byo-comfyui' }).length, 1);
  }
  changePackage?.(pkg);
  const timeline = compileTimeline(pkg), renderId = 'r_123456abcdef', file = join(rendersDir, `${renderId}.mp4`);
  if (real) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24',
    ...(realAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'] : []),
    '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(realAudio ? ['-c:a', 'aac'] : ['-an']), file]);
  else writeFileSync(file, 'explicit synthetic final MP4 contract bytes');
  const metadata = publishRenderArtifact({ renderId, rendersDir, receiptDir: packageDir, staged: { packageDir },
    snapshot: { intent: 'final', package: pkg, timeline }, result: { output: file }, revision: pkg.revision, preflight: { final: true } });
  const reviewer = createRenderReviewer({ runtimeDir, packageDir, transcribe, ...(probe ? { probe } : !real ? { probe: async () => measured } : {}) });
  const input = { packageId: pkg.id, expectedRevision: pkg.revision, renderId };
  return { runtimeDir, packageDir, rendersDir, pkg, timeline, file, metadata, reviewer, input,
    artifactFile: join(rendersDir, `${renderId}.artifact.json`),
    receiptFile: join(contributionStore(packageDir), 'renders', `${metadata.videoSha256}.json`),
    inspect: () => reviewer.inspect(pkg, input) };
}

const finding = (report, check, sceneId) => report.findings.find(item => item.check === check && (sceneId === undefined || item.sceneId === sceneId));
const reportPath = (ctx, report) => join(ctx.runtimeDir, 'render-reviews', `${report.reviewId}.json`);

test('real CPU ffprobe inspects final MP4; no ASR cannot certify quality; immutable lookup survives restart', async t => {
  const ctx = fixture(t, { real: true });
  const report = await ctx.inspect();
  for (const check of ['duration', 'video_duration', 'frame_count', 'frame_rate', 'resolution', 'audio_stream', 'native_source_contribution']) {
    assert.equal(finding(report, check).status, 'pass', check);
  }
  assert.equal(report.measured.frames, 192);
  assert.equal(report.capabilities.speechTiming, 'unavailable');
  assert.equal(finding(report, 'asr_text_comparison').status, 'unknown');
  assert.equal(report.checksStatus, 'unknown'); assert.equal(report.acceptance, 'not_assessed');
  assert.equal(finding(report, 'visual_quality').status, 'unknown');
  assert.equal(report.packageHash, sha(canonicalJson(ctx.pkg)));
  assert.equal(report.artifact.timelineHash, ctx.timeline.hash);
  assert(Object.isFrozen(report)); assert(Object.isFrozen(report.findings[0]));
  assert.deepEqual(JSON.parse(readFileSync(reportPath(ctx, report))), report);
  const restarted = createRenderReviewer({ runtimeDir: ctx.runtimeDir, packageDir: ctx.packageDir });
  assert.deepEqual(await restarted.read(ctx.pkg, { ...ctx.input, reviewId: report.reviewId }), report);
  assert.deepEqual(await restarted.validate(ctx.pkg, { ...ctx.input, reviewId: report.reviewId }), report);
  assert.deepEqual(readdirSync(join(ctx.runtimeDir, 'render-reviews')), [`${report.reviewId}.json`]);
});

test('tool accepts only server IDs; stale package revisions, hashes and fabricated reports rejected before probing', async t => {
  let probes = 0;
  const ctx = fixture(t, { probe: async () => { probes++; return measured; } });
  assert.equal(RENDER_INSPECT_TOOL.name, 'project_inspect_render');
  assert.deepEqual(RENDER_INSPECT_TOOL.parameters.required, ['packageId', 'expectedRevision', 'renderId']);
  for (const input of [{ ...ctx.input, file: ctx.file }, { ...ctx.input, findings: [] }, { ...ctx.input, expectedRevision: '3' },
    { ...ctx.input, renderId: '../outside' }, { packageId: ctx.pkg.id }]) {
    await assert.rejects(ctx.reviewer.inspect(ctx.pkg, input), { code: 'RENDER_REVIEW_INVALID' });
  }
  for (const pkg of [{ ...ctx.pkg, revision: 4 }, { ...ctx.pkg, title: 'Changed without revision' }, { ...ctx.pkg, id: 'pkg_other' }]) {
    await assert.rejects(ctx.reviewer.inspect(pkg, { ...ctx.input, packageId: pkg.id, expectedRevision: pkg.revision }), { code: 'RENDER_REVIEW_STALE' });
  }
  assert.equal(probes, 0);
  const report = await ctx.inspect(), lookup = { ...ctx.input, reviewId: report.reviewId };
  await assert.rejects(ctx.reviewer.read(ctx.pkg, { ...lookup, speech: observed }), { code: 'RENDER_REVIEW_INVALID' });
  await assert.rejects(ctx.reviewer.read(ctx.pkg, { ...lookup, reviewId: `rr_${'0'.repeat(64)}` }), { code: 'RENDER_REVIEW_INVALID' });
  await assert.rejects(ctx.reviewer.read({ ...ctx.pkg, title: 'Later edit' }, lookup), { code: 'RENDER_REVIEW_STALE' });
  const modified = JSON.parse(readFileSync(reportPath(ctx, report))); modified.checksStatus = 'pass';
  writeFileSync(reportPath(ctx, report), JSON.stringify(modified));
  await assert.rejects(ctx.reviewer.read(ctx.pkg, lookup), /modified/);
});

test('canonical package key order is accepted, without consulting mutable current sources', async t => {
  const ctx = fixture(t);
  const reordered = Object.fromEntries(Object.entries(ctx.pkg).reverse());
  writeFileSync(join(ctx.packageDir, 'assets/native.mp4'), 'later source overwrite');
  const report = await ctx.reviewer.inspect(reordered, ctx.input);
  assert.equal(finding(report, 'native_source_contribution').status, 'pass');
});

test('valid Klein export cannot mask absent native H3 contribution evidence in either scene', async t => {
  const ctx = fixture(t, { nativeReceipt: false });
  const receipt = JSON.parse(readFileSync(ctx.receiptFile));
  assert.equal(receipt.contribution.ok, true);
  assert(receipt.contribution.evidence.some(item => item.receipt.generator === 'flux3-klein'));
  const report = await ctx.inspect();
  for (const sceneId of ['s1', 's2']) assert.equal(finding(report, 'native_source_contribution', sceneId).status, 'fail');
  assert.equal(report.checksStatus, 'fail');
});

test('synthetic probe measurements disagreeing with historical frames, duration, resolution or audio fail checks', async t => {
  const ctx = fixture(t, { probe: async () => ({ ...measured, frames: 100, durationSec: 4, videoDurationSec: 4, width: 128, fps: 30, audio: 'none' }) });
  const report = await ctx.inspect();
  for (const check of ['duration', 'video_duration', 'frame_count', 'frame_rate', 'resolution', 'audio_stream']) assert.equal(finding(report, check).status, 'fail');
  assert.equal(report.checksStatus, 'fail');
});

test('empty, malformed, failed or absent ASR and failed probe stay unknown', async t => {
  for (const transcribe of [null, async () => ({ ...observed, segments: [] }), async () => ({ ...observed, segments: [{ start: 1, end: 9, text: line }] }),
    async () => ({ ...observed, segments: [...observed.segments].reverse() }), async () => { throw new Error('offline'); }]) {
    const ctx = fixture(t, { transcribe });
    const report = await ctx.inspect();
    assert.equal(finding(report, 'detected_speech_coverage').status, 'unknown');
    assert.equal(finding(report, 'asr_text_comparison').status, 'unknown');
    assert.equal(report.checksStatus, 'unknown');
  }
  const ctx = fixture(t, { probe: async () => { throw new Error('ffprobe unavailable'); } });
  const report = await ctx.inspect();
  assert.equal(report.capabilities.renderProbe, 'unknown'); assert.equal(finding(report, 'frame_count').status, 'unknown');
});

test('explicit synthetic ASR observes final bytes without expected prompts; match remains observational', async t => {
  let call;
  const ctx = fixture(t, { transcribe: async input => { call = input; return observed; } });
  const report = await ctx.inspect();
  assert.deepEqual(Object.keys(call).sort(), ['durationSeconds', 'file', 'sha256', 'signal']);
  assert.equal(call.file, ctx.file); assert.equal(call.sha256, sha(readFileSync(call.file))); assert.equal(call.durationSeconds, 8);
  for (const sceneId of ['s1', 's2']) {
    assert.equal(finding(report, 'asr_text_comparison', sceneId).status, 'needs_review');
    assert.equal(finding(report, 'asr_text_comparison', sceneId).matchObserved, true);
    assert.equal(finding(report, 'detected_speech_coverage', sceneId).status, 'pass');
  }
  assert.equal(report.windows[0].segments.length, 1); assert.equal(report.windows[1].segments[0].start, 4.5);
  assert.equal(report.checksStatus, 'needs_review'); assert.equal(report.acceptance, 'not_assessed');
  assert.equal(report.speech.coverageStatus, 'provider_contract');
  assert.match(report.speech.coverageLimitation, /trusted server-provider contract/);
  assert.equal(Object.hasOwn(report.speech, 'analyzer'), false, 'legacy analyzer mode is not inferred');
});

test('synthetic actual-final speech mismatch, boundary crossing and late lower-third timing need review', async t => {
  const ctx = fixture(t, { transcribe: async () => ({ ...observed,
    segments: [{ start: 2.7, end: 4.2, text: 'The office spoon' }, { start: 4.5, end: 6.5, text: line }] }) });
  const report = await ctx.inspect();
  assert.equal(finding(report, 'asr_text_comparison', 's1').matchObserved, false);
  assert.equal(finding(report, 'asr_text_comparison', 's1').status, 'needs_review');
  for (const check of ['detected_speech_coverage', 'speech_transition_overlap', 'speech_lower_third_overlap']) {
    assert.equal(finding(report, check, 's1').status, 'needs_review', check);
  }
  assert.equal(report.windows[0].segments[0].end, 4.2, 'never truncate observations to manufacture a passing bound');
  assert.equal(report.windows[1].segments.length, 2, 'cross-boundary speech is ambiguous in both scene windows');
  assert.equal(finding(report, 'asr_text_comparison', 's2').matchObserved, false);
});

test('timeline content tamper with retained hash, forged hash and historical package tamper rejected', async t => {
  for (const mutate of [record => { record.inputs.timeline.scenes[0].durationInFrames--; },
    record => { record.inputs.timeline.hash = record.timelineHash = '0'.repeat(64); },
    record => { record.inputs.package.title = 'forged history'; }]) {
    const ctx = fixture(t), report = await ctx.inspect(), record = JSON.parse(readFileSync(ctx.artifactFile));
    mutate(record); writeFileSync(ctx.artifactFile, JSON.stringify(record));
    await assert.rejects(ctx.inspect());
    await assert.rejects(ctx.reviewer.read(ctx.pkg, { ...ctx.input, reviewId: report.reviewId }));
    assert.deepEqual(readdirSync(join(ctx.runtimeDir, 'render-reviews')), [`${report.reviewId}.json`]);
  }
});

test('changed final bytes or missing trusted receipt invalidate inspection and stored review lookup', async t => {
  for (const tamper of [ctx => writeFileSync(ctx.file, 'changed final bytes'), ctx => rmSync(ctx.receiptFile)]) {
    const ctx = fixture(t), report = await ctx.inspect(), saved = readFileSync(reportPath(ctx, report));
    tamper(ctx);
    await assert.rejects(ctx.inspect());
    await assert.rejects(ctx.reviewer.read(ctx.pkg, { ...ctx.input, reviewId: report.reviewId }));
    assert.deepEqual(readFileSync(reportPath(ctx, report)), saved);
  }
});

test('byte replacement during probe or ASR is rejected, even if identical bytes are restored', async t => {
  for (const phase of ['probe', 'ASR', 'restore']) {
    let ctx;
    const mutate = file => {
      const original = readFileSync(file); writeFileSync(file, 'changed during observation');
      if (phase === 'restore') { writeFileSync(file + '.replacement', original); renameSync(file + '.replacement', file); }
    };
    ctx = fixture(t, { probe: async file => { if (phase !== 'ASR') mutate(file); return measured; },
      transcribe: async ({ file }) => { if (phase === 'ASR') mutate(file); return observed; } });
    await assert.rejects(ctx.inspect());
    assert.equal(existsSync(join(ctx.runtimeDir, 'render-reviews')), false);
  }
});

test('same-byte file symlink escapes and review-directory symlinks cannot read/write outside owned paths', async t => {
  const ctx = fixture(t), outside = join(ctx.runtimeDir, 'outside.mp4');
  writeFileSync(outside, readFileSync(ctx.file)); rmSync(ctx.file); symlinkSync(outside, ctx.file);
  await assert.rejects(ctx.inspect(), { code: 'RENDER_REVIEW_INVALID' });
  const other = fixture(t), target = join(other.runtimeDir, 'other'); mkdirSync(target);
  symlinkSync(target, join(other.runtimeDir, 'render-reviews'));
  await assert.rejects(other.inspect(), { code: 'RENDER_REVIEW_INVALID' });
  assert.deepEqual(readdirSync(target), []);
});

test('aborted inspection persists no report', async t => {
  const ctx = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(ctx.reviewer.inspect(ctx.pkg, ctx.input, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(existsSync(join(ctx.runtimeDir, 'render-reviews')), false);
});

test('real silent final MP4 needs neither an audio stream nor ASR; visual quality remains unknown', async t => {
  let calls = 0;
  const ctx = fixture(t, { real: true, realAudio: false, transcribe: async () => { calls++; return observed; },
    changePackage: pkg => {
      delete pkg.assets.a_native.gen.direction.dialogue;
      pkg.assets.a_native.media.audio = 'none';
      pkg.scenes.forEach(scene => { scene.background.muted = true; });
    } });
  const report = await ctx.inspect();
  assert.equal(report.measured.audio, 'none');
  assert.equal(finding(report, 'audio_stream').required, false);
  assert.equal(finding(report, 'audio_stream').status, 'pass');
  assert.equal(finding(report, 'speech_evidence').required, false);
  assert.equal(finding(report, 'speech_evidence').status, 'pass');
  assert.equal(report.capabilities.speechTiming, 'not_required');
  assert.deepEqual(report.windows, []); assert.equal(calls, 0);
  assert.equal(report.checksStatus, 'unknown'); assert.equal(report.acceptance, 'not_assessed');
});

test('wordless H3 native sound needs audio but no ASR, including empty dialogue objects/text', async t => {
  for (const dialogue of [undefined, {}, { text: '' }, { text: ' \n ' }]) {
    let calls = 0;
    const ctx = fixture(t, { transcribe: async () => { calls++; throw new Error('should not transcribe wordless scene'); },
      changePackage: pkg => {
        delete pkg.assets.a_native.gen.direction.dialogue;
        if (dialogue !== undefined) pkg.assets.a_native.gen.direction.dialogue = dialogue;
      } });
    const report = await ctx.inspect();
    assert.equal(finding(report, 'audio_stream').required, true);
    assert.equal(finding(report, 'audio_stream').status, 'pass');
    assert.equal(finding(report, 'speech_evidence').required, false);
    assert.equal(finding(report, 'speech_evidence').status, 'pass');
    assert.equal(report.capabilities.speechTiming, 'not_required');
    assert.equal(finding(report, 'detected_speech_coverage'), undefined);
    assert.equal(finding(report, 'asr_text_comparison'), undefined);
    assert.deepEqual(report.windows, []); assert.equal(calls, 0);
  }
});

test('only spoken H3 uses create timing/text windows; wordless shots retain contribution checks', async t => {
  const ctx = fixture(t, { transcribe: async () => ({ ...observed, coverageSeconds: 8, segments: [observed.segments[0]] }),
    changePackage: pkg => {
      pkg.assets.a_wordless = structuredClone(pkg.assets.a_native);
      delete pkg.assets.a_wordless.gen.direction.dialogue;
      pkg.scenes[1].background.asset = 'a_wordless';
    } });
  const report = await ctx.inspect();
  assert.deepEqual(report.windows.map(window => window.sceneId), ['s1']);
  assert.equal(finding(report, 'detected_speech_coverage', 's1').status, 'pass');
  assert.equal(finding(report, 'asr_text_comparison', 's1').matchObserved, true);
  assert.equal(finding(report, 'detected_speech_coverage', 's2'), undefined);
  assert.equal(finding(report, 'asr_text_comparison', 's2'), undefined);
  assert.equal(finding(report, 'native_source_contribution', 's2').status, 'pass');
});

test('authored dialogue, native ambience, score, SFX and narration require an audio stream', async t => {
  const cases = {
    dialogue: () => {},
    nativeAmbience: pkg => { delete pkg.assets.a_native.gen.direction.dialogue; },
    score: pkg => { pkg.audio = { music: { asset: 'a_score' } }; },
    sfx: pkg => { pkg.audio = { sfx: [{ asset: 'a_score', scene: 's1', at: 'scene-start' }] }; },
    narration: pkg => { pkg.voice = { enabled: true, engine: 'kokoro' }; pkg.scenes[0].narration = line; },
  };
  for (const [name, configure] of Object.entries(cases)) {
    const ctx = fixture(t, { probe: async () => ({ ...measured, audio: 'none' }), changePackage: pkg => {
      if (!['dialogue', 'nativeAmbience'].includes(name)) {
        delete pkg.assets.a_native.gen.direction.dialogue;
        pkg.scenes.forEach(scene => { scene.background.muted = true; });
      }
      configure(pkg);
    } });
    const report = await ctx.inspect();
    assert.equal(finding(report, 'audio_stream').required, true, name);
    assert.equal(finding(report, 'audio_stream').status, 'fail', name);
  }
});

test('muted speech with disabled dialogue bus is not an audible speech requirement', async t => {
  const ctx = fixture(t, { probe: async () => ({ ...measured, audio: 'none' }), changePackage: pkg => {
    pkg.scenes.forEach(scene => { scene.background.muted = true; });
    pkg.audio = { dialogue: { enabled: false } };
  } });
  const report = await ctx.inspect();
  assert.equal(finding(report, 'audio_stream').required, false);
  assert.equal(finding(report, 'audio_stream').status, 'pass');
  assert.equal(finding(report, 'speech_evidence').required, false);
  assert.deepEqual(report.windows, []);
});

test('ASR coverageSeconds/processedSeconds must each cover the entire measured final file', async t => {
  for (const coverage of [{ coverageSeconds: 8 }, { processedSeconds: 8 }, { coverageSeconds: 8, processedSeconds: 8 }, { processedSeconds: 7.98 }]) {
    const ctx = fixture(t, { transcribe: async () => ({ ...observed, ...coverage }) });
    const report = await ctx.inspect();
    assert.equal(report.speech.status, 'measured');
    for (const key of Object.keys(coverage)) assert.equal(report.speech[key], coverage[key]);
  }
  for (const coverage of [{ coverageSeconds: 4 }, { processedSeconds: 4 }, { coverageSeconds: 8, processedSeconds: 4 },
    { coverageSeconds: 4, processedSeconds: 8 }, { processedSeconds: 0 }, { coverageSeconds: '8' }, { coverageSeconds: null }, { coverageSeconds: 999 }]) {
    const ctx = fixture(t, { transcribe: async () => ({ ...observed, ...coverage }) });
    const report = await ctx.inspect();
    assert.equal(report.speech.status, 'unknown');
    assert.equal(finding(report, 'asr_text_comparison', 's1').status, 'unknown');
    assert.equal(finding(report, 'detected_speech_coverage', 's2').status, 'unknown');
  }
});

test('a synthetic 90-second final export cannot be reviewed from a declared 60-second ASR prefix; over-120s ASR is skipped', async t => {
  for (const seconds of [90, 121]) {
    let calls = 0;
    const ctx = fixture(t, { probe: async () => ({ ...measured, durationSec: seconds, videoDurationSec: seconds, frames: seconds * 24 }),
      changePackage: pkg => {
        pkg.duration.targetFrames = seconds * 24;
        const scene = pkg.scenes[0];
        pkg.scenes = Array.from({ length: 6 }, (_, i) => ({ ...structuredClone(scene), id: `s${i + 1}`, preferredFrames: seconds * 4 }));
      },
      transcribe: async () => { calls++; return { ...observed, processedSeconds: 60 }; } });
    const report = await ctx.inspect();
    assert.equal(report.speech.status, 'unknown');
    assert.equal(finding(report, 'duration').status, 'pass');
    assert.equal(finding(report, 'speech_evidence').status, 'unknown');
    assert.equal(calls, seconds === 90 ? 1 : 0);
  }
});

test('stored review byte changes, duplicate keys and same-directory symlink aliases are rejected', async t => {
  for (const mode of ['whitespace', 'duplicate-key', 'symlink']) {
    const ctx = fixture(t), report = await ctx.inspect(), file = reportPath(ctx, report);
    const raw = readFileSync(file);
    if (mode === 'whitespace') writeFileSync(file, Buffer.concat([raw, Buffer.from('\n')]));
    else if (mode === 'duplicate-key') writeFileSync(file, raw.toString().replace('"version": 1,', '"version": 2, "version": 1,'));
    else {
      const alias = join(ctx.runtimeDir, 'render-reviews', 'alias.json');
      writeFileSync(alias, raw); rmSync(file); symlinkSync(alias, file);
    }
    await assert.rejects(ctx.reviewer.read(ctx.pkg, { ...ctx.input, reviewId: report.reviewId }), { code: 'RENDER_REVIEW_INVALID' }, mode);
  }
});

test('local adapter coverage-object contract is retained; partial, malformed and contradictory coverage is unknown', async t => {
  const complete = { startSeconds: 0, endSeconds: 8, complete: true, requestedDurationSeconds: 8,
    decodedDurationSeconds: 8.03, sampleRate: 16000, inspectedSamples: 128000, paddingSeconds: 0.03 };
  const ctx = fixture(t);
  let args;
  // Explicit synthetic adapter execution; existing fixture files stand in for
  // configured local interpreter/weights. No Python or model is executed.
  const transcribe = createLocalSpeechInspector({ env: { COMFYRIZZ_QA_WHISPER_PYTHON: ctx.file, COMFYRIZZ_QA_WHISPER_WEIGHTS: ctx.file },
    execute: async (_command, argv) => { args = argv; return { stdout: JSON.stringify({ ...observed, coverage: complete,
      analyzer: { vadFilter: false, conditionOnPreviousText: false, wordTimestamps: true, downmix: 'mono', timestampCoordinates: 'original_media' } }) }; } });
  const reviewer = createRenderReviewer({ runtimeDir: ctx.runtimeDir, packageDir: ctx.packageDir, probe: async () => measured, transcribe });
  const report = await reviewer.inspect(ctx.pkg, ctx.input);
  assert.deepEqual(report.speech.coverage, complete);
  assert.equal(report.speech.status, 'measured');
  assert.equal(report.speech.coverageStatus, 'declared_complete');
  assert.equal(args[args.indexOf('--duration-seconds') + 1], '8');
  for (const coverage of [null, {}, { ...complete, complete: false }, { ...complete, startSeconds: 1 },
    { ...complete, endSeconds: 4 }, { ...complete, endSeconds: 99 }, { ...complete, decodedDurationSeconds: 4 },
    { ...complete, requestedDurationSeconds: 4 }, { ...complete, inspectedSamples: 64000 },
    { ...complete, sampleRate: 0 }, { ...complete, paddingSeconds: 0.2 }]) {
    const partial = fixture(t, { transcribe: async () => ({ ...observed, coverage, coverageSeconds: 8 }) });
    const result = await partial.inspect();
    assert.equal(result.speech.status, 'unknown');
    assert.equal(finding(result, 'detected_speech_coverage', 's1').status, 'unknown');
    if (coverage?.endSeconds !== undefined) assert.equal(result.speech.coverage.endSeconds, coverage.endSeconds);
    if (coverage?.complete !== undefined) assert.equal(result.speech.coverage.complete, coverage.complete);
  }
});

test('explicit VAD analyzer modes are preserved in immutable reports, including unknown speech observations', async t => {
  for (const vadFilter of [false, true]) {
    const analyzer = { vadFilter, conditionOnPreviousText: false, wordTimestamps: true, downmix: 'mono', timestampCoordinates: 'original_media' };
    for (const extra of [{}, { segments: [] }, { coverageSeconds: 4 }]) {
      const ctx = fixture(t, { transcribe: async () => ({ ...observed, analyzer, ...extra }) });
      const report = await ctx.inspect();
      assert.deepEqual(report.speech.analyzer, analyzer);
      assert.equal(report.speech.status, Object.keys(extra).length ? 'unknown' : 'measured');
      assert(Object.isFrozen(report.speech.analyzer));
      const saved = await ctx.reviewer.read(ctx.pkg, { ...ctx.input, reviewId: report.reviewId });
      assert.deepEqual(saved.speech.analyzer, analyzer);
    }
  }
});

test('malformed, oversized or unsupported analyzer contracts cannot yield measured evidence', async t => {
  const mode = { vadFilter: true, conditionOnPreviousText: false, wordTimestamps: true, downmix: 'mono', timestampCoordinates: 'original_media' };
  for (const analyzer of [null, [], {}, { ...mode, vadFilter: 'true' }, { ...mode, conditionOnPreviousText: true },
    { ...mode, wordTimestamps: false }, { ...mode, downmix: 'stereo' }, { ...mode, timestampCoordinates: 'vad_concatenated' },
    { ...mode, extra: 'x'.repeat(10000) }]) {
    const ctx = fixture(t, { transcribe: async () => ({ ...observed, analyzer }) });
    const report = await ctx.inspect();
    assert.equal(report.speech.status, 'unknown');
    assert.equal(Object.hasOwn(report.speech, 'analyzer'), false);
    assert.equal(finding(report, 'asr_text_comparison', 's1').status, 'unknown');
  }
});

const secondLine = 'It was in my pocket.';
function syntheticWordSpeech(first = line, second = secondLine) {
  const words = [first, second].flatMap((text, scene) => text.split(' ').map((word, i) => ({
    start: 0.5 + scene * 4 + i * 0.3, end: 0.75 + scene * 4 + i * 0.3, word: ` ${word}`, probability: 0,
  })));
  return { ...observed, segments: [{ start: words[0].start, end: words.at(-1).end,
    text: `${first} ${second}`, words }],
  analyzer: { vadFilter: true, conditionOnPreviousText: false, wordTimestamps: true, downmix: 'mono', timestampCoordinates: 'original_media' } };
}

function distinctSpokenScenes(pkg) {
  pkg.assets.a_second = structuredClone(pkg.assets.a_native);
  pkg.assets.a_second.gen.direction.dialogue.text = secondLine;
  pkg.scenes[1].background.asset = 'a_second';
}

test('one synthetic ASR segment spanning two scenes uses separate word atoms without filling the silent gap', async t => {
  const evidence = syntheticWordSpeech();
  const ctx = fixture(t, { transcribe: async () => evidence, changePackage: distinctSpokenScenes });
  const report = await ctx.inspect();
  assert.equal(report.speech.status, 'measured');
  assert.equal(report.speech.timingGranularity, 'word');
  assert.equal(report.speech.segments.length, 9);
  assert.equal(report.speech.rawSegments.length, 1);
  assert.deepEqual(report.speech.rawSegments[0], evidence.segments[0]);
  assert.equal(report.speech.rawSegments[0].words[0].probability, 0, 'probabilities remain diagnostic, not confidence gates');
  assert.equal(report.windows[0].segments.length, 4);
  assert.equal(report.windows[1].segments.length, 5);
  assert(report.speech.segments.every(segment => segment.end < 2 || segment.start >= 4.5), 'no atom bridges the silent gap');
  for (const window of report.windows) {
    assert.deepEqual(window.segments, report.speech.segments.filter(segment => segment.start < window.endSeconds && segment.end > window.startSeconds));
    for (const atom of window.segments) assert.deepEqual(atom, report.speech.segments.find(segment => segment.start === atom.start));
    assert.equal(finding(report, 'detected_speech_coverage', window.sceneId).status, 'pass');
    assert.equal(finding(report, 'speech_transition_overlap', window.sceneId).status, 'pass');
    assert.equal(finding(report, 'asr_text_comparison', window.sceneId).matchObserved, true);
    assert.equal(finding(report, 'asr_text_comparison', window.sceneId).status, 'needs_review');
  }
  assert.equal(finding(report, 'speech_lower_third_overlap', 's1').status, 'pass');
  const saved = await ctx.reviewer.read(ctx.pkg, { ...ctx.input, reviewId: report.reviewId });
  assert.deepEqual(saved.speech.rawSegments, report.speech.rawSegments);
  assert.deepEqual(saved.windows, report.windows);
});

test('word text matches must occur in the correct scene, not merely somewhere in the final transcript', async t => {
  const ctx = fixture(t, { transcribe: async () => syntheticWordSpeech(secondLine, line), changePackage: distinctSpokenScenes });
  const report = await ctx.inspect();
  for (const sceneId of ['s1', 's2']) {
    assert.equal(finding(report, 'detected_speech_coverage', sceneId).status, 'pass');
    assert.equal(finding(report, 'asr_text_comparison', sceneId).matchObserved, false);
    assert.equal(finding(report, 'asr_text_comparison', sceneId).status, 'needs_review');
  }
});

test('mixed word and legacy segment observations preserve the whole-segment fallback', async t => {
  const evidence = syntheticWordSpeech(line, line), words = evidence.segments[0].words;
  evidence.segments = [{ start: words[0].start, end: words[3].end, text: line },
    { start: words[4].start, end: words.at(-1).end, text: line, words: words.slice(4) }];
  const ctx = fixture(t, { transcribe: async () => evidence });
  const report = await ctx.inspect();
  assert.equal(report.speech.timingGranularity, 'mixed');
  assert.deepEqual(report.speech.segments[0], evidence.segments[0]);
  assert.deepEqual(report.windows[0].segments, [evidence.segments[0]]);
  assert.equal(report.windows[1].segments.length, 4);
  assert.equal(finding(report, 'asr_text_comparison', 's1').matchObserved, true);
  assert.equal(finding(report, 'asr_text_comparison', 's2').matchObserved, true);
});

test('invalid, incomplete, zero-length or out-of-bounds word evidence is unknown without segment fallback', async t => {
  const cases = {
    missingWord: segment => { segment.words.pop(); },
    wrongWord: segment => { segment.words[0].word = 'Unexpected'; },
    emptyWords: segment => { segment.words = []; },
    malformedWords: segment => { segment.words = null; },
    emptyText: segment => { segment.words[0].word = ' '; },
    excessiveText: segment => { segment.words[0].word = 'x'.repeat(257); },
    zeroDuration: segment => { segment.words[0].end = segment.words[0].start; },
    overlap: segment => { segment.words[1].start = segment.words[0].start; },
    unordered: segment => { segment.words.reverse(); },
    beforeSegment: segment => { segment.words[0].start = segment.start - 0.1; },
    afterSegment: segment => { segment.words.at(-1).end = segment.end + 0.1; },
    notFinite: segment => { segment.words[0].start = NaN; },
    malformedWord: segment => { segment.words[0] = null; },
    badProbability: segment => { segment.words[0].probability = 1.1; },
    excessiveWords: segment => { segment.words = Array(1025).fill(segment.words[0]); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const evidence = syntheticWordSpeech(); mutate(evidence.segments[0]);
    const ctx = fixture(t, { transcribe: async () => evidence });
    const report = await ctx.inspect();
    assert.equal(report.speech.status, 'unknown', name);
    assert.deepEqual(report.speech.segments, [], name);
    assert.equal(finding(report, 'detected_speech_coverage', 's1').status, 'unknown', name);
    assert.equal(finding(report, 'asr_text_comparison', 's1').status, 'unknown', name);
    assert.deepEqual(report.speech.analyzer, evidence.analyzer, 'analyzer diagnostics survive invalid word observations');
  }
});

test('word atom count is bounded across segments, and provider extras never enter retained raw evidence', async t => {
  const many = { ...observed, segments: Array.from({ length: 5 }, (_, segment) => ({ start: segment, end: segment + 1,
    text: Array(900).fill('x').join(' '), words: Array.from({ length: 900 }, (_, i) => ({
      start: segment + i / 900, end: segment + (i + 0.5) / 900, word: 'x',
    })) })) };
  const ctx = fixture(t, { transcribe: async () => many });
  assert.equal((await ctx.inspect()).speech.status, 'unknown');
  const evidence = syntheticWordSpeech();
  evidence.segments[0].untrustedExtra = { large: 'not retained' };
  evidence.segments[0].words[0].untrustedExtra = 'not retained';
  const clean = fixture(t, { transcribe: async () => evidence });
  const report = await clean.inspect();
  assert.deepEqual(Object.keys(report.speech.rawSegments[0]).sort(), ['end', 'start', 'text', 'words']);
  assert.deepEqual(Object.keys(report.speech.rawSegments[0].words[0]).sort(), ['end', 'probability', 'start', 'word']);
  assert.deepEqual(Object.keys(report.speech.segments[0]).sort(), ['end', 'start', 'text']);
});
