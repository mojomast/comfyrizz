import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planJobs } from '../../../packages/jobs/src/index.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { createColabBackend } from '../../../packages/backends/src/colab-backend.mjs';
import { createByoBackend } from '../../../packages/backends/src/byo-backend.mjs';
import { runQwenColab } from '../../../scripts/tts/qwen_colab.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions, repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { renderPipeline } from '../../renderer/scripts/render-pipeline.mjs';
import { pipelineCommand } from './pipeline-process.mjs';
import { copyNamedAssets } from './run-assets.mjs';
import { json, writeJson, preparePresenterInputs, correctPresenters } from './pipeline-media.mjs';
import { summarizeJobs } from './pipeline-contract.mjs';
import { assessBudget, nextJobUpperEstimate } from '../../../packages/backends/src/budget.mjs';

export async function executePipeline(spec, { send = () => {}, signal = new AbortController().signal, runCommand = pipelineCommand, render = renderPipeline, colabFactory = createColabBackend, byoFactory = createByoBackend, qwenRunner = runQwenColab, presenterPreparation = preparePresenterInputs, presenterCorrection = correctPresenters } = {}) {
const { runDir, workDir, plan, runId } = spec;
const packagePath = join(workDir, 'package.json');
let stageId = null;
const heartbeat = setInterval(() => send({ kind: 'heartbeat', stageId }), 10000);
heartbeat.unref();
const progress = (message, value = null, extra = {}) => send({ kind: 'progress', stageId, message, progress: value, ...extra });
const lastDiagnostic = new Map(), lastJobProgress = new Map();
const sourceEvent = event => {
  const id = event.event ?? event.type;
  if (id === 'diagnostic' || id === 'bootstrap_log') {
    if (Date.now() - (lastDiagnostic.get(stageId) ?? 0) < 1000) return;
    lastDiagnostic.set(stageId, Date.now());
    return send({ kind: 'diagnostic', stageId, message: event.message });
  }
  if (id === 'progress' && event.job) {
    if (Date.now() - (lastJobProgress.get(event.job) ?? 0) < 500 && event.value !== 1) return;
    lastJobProgress.set(event.job, Date.now());
  }
  if (event.completed !== undefined && event.total !== undefined) progress(id, { mode: 'measured', completed: event.completed, total: event.total, unit: id === 'collection_progress' ? 'files' : id?.startsWith('alignment') ? 'aligned_scenes' : 'scenes' }, { sceneId: event.sceneId });
  else progress(event.phase ?? id, null, { jobId: event.job ?? null, attemptId: event.attempt ?? null });
  send({ kind: 'task', stageId, detail: event });
  if (event.flagged) send({ kind: 'warning', stageId, code: 'ASR_REVIEW', sceneId: event.sceneId, message: 'Speech recognition flagged this take. Review the transcript; spelling differences can also trigger this flag.' });
  if (id === 'qwen_finished') send({ kind: 'runtime', runtime: 'narration', value: { state: event.teardown?.state ?? 'stop_unconfirmed', spentUnits: event.spentUnits, costSource: 'account_balance_delta' } });
};
const command = (bin, args, options = {}) => runCommand(bin, args, { signal, onEvent: sourceEvent, ...options });
async function stage(id, fn, skip = false) {
  signal.throwIfAborted(); stageId = id;
  send({ kind: 'stage', stageId: id, status: skip ? 'skipped' : 'running' });
  if (skip) return;
  const result = await fn();
  signal.throwIfAborted();
  send({ kind: 'stage', stageId: id, status: 'completed' });
  if (['timing', 'media', 'presenter_sync'].includes(id)) {
    const current = json(packagePath);
    send({ kind: 'artifacts', artifacts: Object.entries(current.assets ?? {}).filter(([, asset]) => asset.file && existsSync(join(workDir, asset.file))).map(([assetId, asset]) => ({ assetId, kind: asset.kind, status: asset.status, bytes: asset.bytes ?? null, url: `/api/pipeline/${runId}/assets/${assetId}` })) });
  }
  return result;
}

async function main() {
  let pkg = json(packagePath), renderResult;
  await stage('preflight', async () => {
    const validation = validatePackage(pkg);
    if (!validation.valid) throw new Error('Invalid pipeline input');
    await command('ffmpeg', ['-version']); await command('ffprobe', ['-version']);
    if (plan.voiced) await command(process.env.COMFYRIZZ_PYTHON || 'python3', ['-c', 'import numpy']);
    if (!existsSync(process.env.REMOTION_BROWSER || '/usr/bin/google-chrome') && render === renderPipeline) throw new Error('Configure REMOTION_BROWSER with an installed headless browser before starting generation.');
    cpSync(join(repoRoot, 'workflows'), join(workDir, 'workflows'), { recursive: true });
    if (plan.presenters) await command(process.env.COMFYRIZZ_SYNCNET_PYTHON, ['-c', 'import cv2, torch, numpy; assert hasattr(cv2, "CascadeClassifier")']);
    if (plan.voiced && !plan.remoteVoice) {
      const qwen = pkg.voice.engine === 'qwen3-tts';
      await command(qwen ? process.env.COMFYRIZZ_QWEN_TTS_PYTHON || process.env.COMFYRIZZ_PYTHON || 'python3' : process.env.COMFYRIZZ_PYTHON || 'python3', ['-c', qwen ? 'import qwen_tts, soundfile' : 'import kokoro_onnx, numpy']);
      if (qwen) await command(process.env.COMFYRIZZ_QWEN_ASR_PYTHON || process.env.COMFYRIZZ_PYTHON || 'python3', ['-c', 'import qwen_asr']);
    }
  });

  await stage('narration', async () => {
    if (plan.remoteVoice) {
      const out = join(runDir, 'qwen');
      send({ kind: 'runtime', runtime: 'narration', value: { state: 'allocating', spentUnits: null } });
      await qwenRunner({ packagePath, out, units: plan.budget.narrationCeilingUnits, signal, onEvent: sourceEvent });
      // Validate all archive paths before extraction. The worker only accepts audio output.
      await command(process.env.COMFYRIZZ_PYTHON || 'python3', ['-c', `import zipfile,pathlib,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 for n in z.namelist():
  p=pathlib.PurePosixPath(n)
  assert not p.is_absolute() and '..' not in p.parts and p.parts[0]=='audio', n
 assert z.testzip() is None
 z.extractall(sys.argv[2])`, join(out, 'audio.zip'), workDir]);
    } else {
      const qwen = pkg.voice.engine === 'qwen3-tts';
      const python = qwen ? process.env.COMFYRIZZ_QWEN_TTS_PYTHON || process.env.COMFYRIZZ_PYTHON || 'python3' : process.env.COMFYRIZZ_PYTHON || 'python3';
      await command(python, [join(repoRoot, 'packages/tts/py/synth.py'), '--package', packagePath, '--out', join(workDir, 'audio'), '--padding', '0.5']);
      if (qwen) await command(process.env.COMFYRIZZ_QWEN_ASR_PYTHON || python, [join(repoRoot, 'packages/tts/py/qa_qwen.py'), '--package', packagePath, '--out', join(workDir, 'audio')]);
    }
    const report = json(join(workDir, 'audio/durations.json'));
    if (pkg.voice.engine === 'qwen3-tts' && (report.engine !== 'qwen3-tts' || report.engineFallback)) throw new Error('Selected Qwen voice was not produced');
    for (const [sceneId, scene] of Object.entries(report.scenes)) {
      if (scene.qa?.flagged) send({ kind: 'warning', stageId, code: 'ASR_REVIEW', sceneId, message: 'Review this scene’s speech-recognition diagnostic.' });
    }
  }, !plan.voiced);

  await stage('timing', async () => {
    await command(process.execPath, [join(repoRoot, 'packages/tts/scripts/narrate.mjs'), '--example', workDir]);
    pkg = json(packagePath);
    const timeline = compileTimeline(pkg, narrationOptions(workDir));
    const durations = json(join(workDir, 'audio/durations.json'));
    for (const scene of timeline.scenes) {
      if (durations.scenes[scene.id] && scene.durationInFrames / timeline.fps + 0.001 < durations.scenes[scene.id].seconds) throw new Error(`${scene.id}: narration exceeds scene duration`);
    }
    progress('Measured timeline ready', { mode: 'measured', completed: timeline.scenes.length, total: timeline.scenes.length, unit: 'scenes' });
  }, !plan.voiced);

  await stage('presenter_inputs', () => presenterPreparation(workDir, { signal, onEvent: sourceEvent }), !plan.presenters);
  pkg = json(packagePath);
  const jobs = planJobs(pkg).jobs;
  await stage('media', async () => {
    const outDir = join(runDir, 'media-out'), scratch = join(runDir, 'media-runtime');
    const colab = plan.options.backendId === 'colab';
    const ceiling = plan.budget.mediaCeilingUnits;
    const backend = colab ? colabFactory({ packageId: runId, packageDir: workDir, scratchDir: scratch, budgetUnits: ceiling, watchdogMinutes: Math.max(1, Math.floor(ceiling / 8.9 * 60)), wallClockCapMinutes: Math.max(1, Math.floor(ceiling / 8.9 * 60)) }) : byoFactory({ comfyuiUrl: plan.options.comfyuiUrl || 'http://127.0.0.1:8188', outDir });
    if (typeof backend.preflight === 'function') {
      const check = await backend.preflight();
      if (check.ok === false || check.ready === false) throw new Error(check.problems?.join('; ') || check.message || check.detail || 'Media backend preflight failed');
    }
    const estimate = await backend.estimate(jobs);
    let admission = null;
    if (colab) {
      admission = assessBudget({ budgetUnits: ceiling, ratePerHour: 8.9, nextJobUpperEstimate: nextJobUpperEstimate({ gpuMinutes: estimate.gpuMinutes ?? 0, overheadMinutes: estimate.overheadMinutes ?? 0, ratePerHour: 8.9 }) });
      if (!admission.allowed) throw new Error(`${admission.message} Re-plan with a larger media allocation.`);
    }
    send({ kind: 'task', stageId, detail: { event: 'media_plan', jobs: summarizeJobs(pkg, jobs), estimate, admission } });
    let before, result, teardown;
    send({ kind: 'runtime', runtime: 'media', value: { state: 'allocating', ownership: colab ? 'managed' : 'external', spentUnits: null } });
    try {
      if (colab) before = await backend.usage();
      result = await backend.runPackage(pkg, { workDir, outDir, budget: admission, approved: true, teardownMode: 'done', gateCommand: null, signal, onEvent: sourceEvent });
      teardown = result.teardown;
      if (!result.ok) throw new Error('Media generation did not complete; collected assets are retained for diagnosis');
    } catch (error) {
      teardown = error.runPackage?.teardown ?? teardown;
      throw error;
    } finally {
      if (!teardown) { try { teardown = await backend.teardown('pipeline cleanup'); } catch (error) { teardown = { state: 'stop_unconfirmed', evidence: error.message }; } }
      let spentUnits = null;
      if (colab) {
        try { const after = await backend.usage(); if (Number.isFinite(before?.balance) && Number.isFinite(after.balance)) spentUnits = Number((before.balance - after.balance).toFixed(3)); } catch { /* unknown is not zero */ }
      }
      send({ kind: 'runtime', runtime: 'media', value: { state: teardown?.state ?? 'stop_unconfirmed', ownership: colab ? 'managed' : 'external', spentUnits, costSource: colab ? 'account_balance_delta' : 'external_unknown' } });
      if (colab && teardown?.state !== 'stopped') throw new Error('Media runtime shutdown is unconfirmed');
      if (colab && spentUnits !== null && spentUnits > ceiling) throw new Error('Media spend exceeded its allocation; no further work will start');
    }
    const collected = colab ? join(scratch, 'out') : outDir;
    copyNamedAssets({ pkg: result.package, outputDir: collected, packageDir: workDir });
    pkg = result.package; writeJson(packagePath, pkg);
  }, jobs.length === 0);

  await stage('presenter_sync', () => presenterCorrection(workDir, runDir, { signal, onEvent: event => {
    progress(event.phase, event.total ? { mode: 'measured', completed: event.completed, total: event.total, unit: 'presenters' } : null, { sceneId: event.sceneId });
    send({ kind: 'task', stageId, detail: event });
  } }), !plan.presenters);

  await stage('render', async () => {
    renderResult = await render(packagePath, join(runDir, 'video.mp4'), { signal, onEvent: event => progress(event.phase, event.progress) });
    progress('Normalizing the final audio mix', null);
    await command(process.execPath, [fileURLToPath(new URL('./pipeline-cpu-task.mjs', import.meta.url)), 'normalize', workDir, runDir]);
    renderResult.bytes = statSync(join(runDir, 'video.mp4')).size;
    writeJson(join(runDir, 'render.json'), renderResult);
  });

  await stage('verify', async () => {
    const probe = JSON.parse((await command('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,nb_read_frames,sample_rate:format=duration', '-of', 'json', join(runDir, 'video.mp4')])).stdout);
    const video = probe.streams.find(s => s.codec_type === 'video'), audio = probe.streams.find(s => s.codec_type === 'audio');
    const checks = { frames: Number(video?.nb_read_frames) === renderResult.frames, dimensions: video?.width === renderResult.width && video?.height === renderResult.height, duration: Math.abs(Number(probe.format.duration) - renderResult.frames / renderResult.fps) < 0.1, narrationStream: !plan.voiced || Boolean(audio) };
    if (plan.voiced) {
      const measure = await command('ffmpeg', ['-hide_banner', '-nostats', '-i', join(runDir, 'video.mp4'), '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
      const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(measure.stderr);
      checks.nonSilentAudio = Boolean(mean) && Number(mean[1]) > -60;
      await command(process.env.COMFYRIZZ_PYTHON || 'python3', [join(repoRoot, 'scripts/tts/verify_mix.py'), '--video', join(runDir, 'video.mp4'), '--narration', join(workDir, 'audio/narration.norm.wav'), '--out', join(runDir, 'audio-verification.json')]);
      checks.narrationEnvelope = json(join(runDir, 'audio-verification.json')).passed;
    }
    writeJson(join(runDir, 'verification.json'), { checks, probe, note: 'Technical checks do not replace perceptual review.' });
    if (Object.values(checks).some(value => !value)) throw new Error('Final video verification failed');
  });

  await stage('export', async () => {
    pkg = json(packagePath);
    const target = join(runDir, 'exports', pkg.id); mkdirSync(target, { recursive: true });
    copyFileSync(join(runDir, 'video.mp4'), join(target, 'video.mp4'));
    await command(process.execPath, [fileURLToPath(new URL('./pipeline-cpu-task.mjs', import.meta.url)), 'export', workDir, runDir]);
    await command(process.env.COMFYRIZZ_PYTHON || 'python3', ['-c', `import zipfile,pathlib,sys,json,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 for n in z.namelist():
  p=pathlib.PurePosixPath(n)
  assert not p.is_absolute() and '..' not in p.parts
 p=json.loads(z.read('package.json'))
 for a in p['assets'].values():
  if a.get('file') and a.get('sha256'): assert hashlib.sha256(z.read(a['file'])).hexdigest()==a['sha256']`, join(target, 'package.zip')]);
    const files = json(join(runDir, 'export.json')).files.map(file => ({ name: file.name, bytes: file.bytes, url: `/api/pipeline/${runId}/files/${file.name}` }));
    send({ kind: 'result', result: { packageId: pkg.id, baseRevision: plan.baseRevision, inputHash: plan.inputHash, frames: renderResult.frames, fps: renderResult.fps, files, packageUrl: `/api/pipeline/${runId}/package`, verificationUrl: `/api/pipeline/${runId}/verification` } });
  });
}

try { await main(); return 0; }
catch (error) {
  send({ kind: signal.aborted ? 'cancelled' : 'failed', stageId, code: signal.aborted ? 'CANCELLED' : 'STAGE_FAILED', message: signal.aborted ? 'Pipeline cancelled. Check the runtime states for shutdown confirmation.' : error.message });
  return 1;
} finally {
  clearInterval(heartbeat);
}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  process.on('message', message => { if (message?.kind === 'cancel') abort.abort(); });
  process.on('SIGTERM', () => abort.abort());
  process.on('SIGINT', () => abort.abort());
  process.on('disconnect', () => abort.abort());
  const spec = json(process.argv[2]);
  const send = message => { if (process.connected) process.send(message); };
  if (spec.action === 'reconcile') {
    process.exitCode = 0;
    for (const [runtime, value] of Object.entries(spec.runtimes)) {
      if (value.ownership === 'external' || value.state === 'stopped') continue;
      const narration = runtime === 'narration';
      const backend = createColabBackend({ packageId: narration ? `${spec.plan.packageId}_qwen` : spec.runId, scratchDir: narration ? join(spec.runDir, 'qwen/scratch') : join(spec.runDir, 'media-runtime') });
      try {
        const sessions = await backend.sessions();
        const teardown = sessions.empty || !sessions.sessions.some(s => s.name === backend.state.session) ? { state: 'stopped', evidence: 'Runtime no longer listed by Colab' } : await backend.teardown('pipeline reconciliation');
        send({ kind: 'runtime', runtime, value: { ...value, state: teardown.state === 'stopped' ? 'stopped' : 'stop_unconfirmed', evidence: teardown.evidence } });
        if (teardown.state !== 'stopped') process.exitCode = 1;
      } catch (error) {
        send({ kind: 'runtime', runtime, value: { ...value, state: 'stop_unconfirmed', evidence: error.message } }); process.exitCode = 1;
      }
    }
  } else process.exitCode = await executePipeline(spec, { signal: abort.signal, send });
  if (process.connected) process.disconnect();
}
