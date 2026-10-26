import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planJobs } from '../../../packages/jobs/src/index.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { createColabBackend, sessionsCheck } from '../../../packages/backends/src/colab-backend.mjs';
import { createByoBackend } from '../../../packages/backends/src/byo-backend.mjs';
import { runQwenColab } from '../../../scripts/tts/qwen_colab.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions, repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { renderPipeline } from '../../renderer/scripts/render-pipeline.mjs';
import { pipelineCommand } from './pipeline-process.mjs';
import { copyNamedAssets } from './run-assets.mjs';
import { json, writeJson, preparePresenterInputs, correctPresenters, presenterScenes } from './pipeline-media.mjs';
import { summarizeJobs, syncnetConfigured, SYNCNET_RUNTIME_SKIP_CODE, SYNCNET_SKIP_MESSAGE } from './pipeline-contract.mjs';
import { assessBudget, nextJobUpperEstimate, rateForGpu, reserveUnitsFor, spendingMinutes, COLLECT_AND_STOP_RESERVE_MINUTES } from '../../../packages/backends/src/budget.mjs';
import { decideRenderFallback } from '../../../packages/backends/src/colab-render-plan.mjs';
import { redactForLog } from '../../../packages/backends/src/colab-plan.mjs';
import { runColabRender } from './pipeline-colab-render.mjs';

export async function executePipeline(spec, { send = () => {}, signal = new AbortController().signal, runCommand = pipelineCommand, render = renderPipeline, colabFactory = createColabBackend, byoFactory = createByoBackend, qwenRunner = runQwenColab, presenterPreparation = preparePresenterInputs, presenterCorrection = correctPresenters, colabRender = runColabRender } = {}) {
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

let heldBackend = null;
/** Upper bound on a Google Colab render of one package (measured renders take a few minutes). */
const RENDER_ALLOWANCE_MINUTES = 15;
async function releaseHeld(reason) {
  if (!heldBackend) return { state: 'stopped' };
  const backend = heldBackend;
  heldBackend = null;
  let teardown;
  try { teardown = await backend.teardown(reason); }
  catch (error) { teardown = { state: 'stop_unconfirmed', evidence: error.message }; }
  const state = teardown?.state === 'not_owned' ? 'stopped' : (teardown?.state ?? 'stop_unconfirmed');
  let spentUnits = null;
  try {
    const after = await backend.usage?.();
    if (Number.isFinite(backend.inspect?.().usageBefore?.balance) && Number.isFinite(after?.balance)) spentUnits = Number((backend.inspect().usageBefore.balance - after.balance).toFixed(3));
  } catch { /* unknown is not zero */ }
  send({ kind: 'runtime', runtime: 'media', value: { state, ownership: 'managed', spentUnits, costSource: 'account_balance_delta', note: reason } });
  if (state !== 'stopped') {
    const error = new Error('Google Colab shutdown is unconfirmed');
    error.teardown = teardown;
    throw error;
  }
  return teardown;
}

async function main() {
  let pkg = json(packagePath), renderResult;
  const syncnetReady = syncnetConfigured(process.env);
  const remoteRender = plan.remoteRender === true && plan.options?.backendId === 'colab' && plan.options?.renderLocation === 'colab';
  await stage('preflight', async () => {
    const validation = validatePackage(pkg);
    if (!validation.valid) throw new Error('Invalid pipeline input');
    await command('ffmpeg', ['-version']); await command('ffprobe', ['-version']);
    if (plan.voiced) await command(process.env.COMFYRIZZ_PYTHON || 'python3', ['-c', 'import numpy']);
    if (!remoteRender && !existsSync(process.env.REMOTION_BROWSER || '/usr/bin/google-chrome') && render === renderPipeline) throw new Error('Configure REMOTION_BROWSER with an installed headless browser before starting generation.');
    cpSync(join(repoRoot, 'workflows'), join(workDir, 'workflows'), { recursive: true });
    if (plan.presenters && syncnetReady) await command(process.env.COMFYRIZZ_SYNCNET_PYTHON, ['-c', 'import cv2, torch, numpy; assert hasattr(cv2, "CascadeClassifier")']);
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
    for (const diagnostic of timeline.motionCueDiagnostics ?? []) {
      send({ kind: 'warning', stageId, code: diagnostic.code, sceneId: diagnostic.scene, message: diagnostic.message });
    }
    const durations = json(join(workDir, 'audio/durations.json'));
    for (const scene of timeline.scenes) {
      if (durations.scenes[scene.id] && scene.durationInFrames / timeline.fps + 0.001 < durations.scenes[scene.id].seconds) throw new Error(`${scene.id}: narration exceeds scene duration`);
    }
    progress('Measured timeline ready', { mode: 'measured', completed: timeline.scenes.length, total: timeline.scenes.length, unit: 'scenes' });
  }, !plan.voiced);

  await stage('presenter_inputs', () => presenterPreparation(workDir, { signal, onEvent: sourceEvent }), !plan.presenters);
  if (plan.presenters && !syncnetReady) {
    send({ kind: 'warning', stageId: 'presenter_inputs', code: SYNCNET_RUNTIME_SKIP_CODE, message: SYNCNET_SKIP_MESSAGE });
  }
  pkg = json(packagePath);
  const jobs = planJobs(pkg).jobs;
  await stage('media', async () => {
    const outDir = join(runDir, 'media-out'), scratch = join(runDir, 'media-runtime');
    const colab = plan.options.backendId === 'colab';
    const ceiling = plan.budget.mediaCeilingUnits;
    // PO-3 review: the rate is the requested accelerator's, from the per-gpu table (or its
    // COMFYRIZZ_COLAB_RATE_PER_HOUR_<GPU> override). `colab usage` is read *before* anything is allocated,
    // so its rate is the account's existing burn (0.00/h idle, ~0.08/h with a CPU session): it can raise
    // the price (another session is already spending) but never lower it. spend rate =
    // max(table rate for the gpu, measured). The teardown reserve is one number derived from that rate.
    const gpu = colab ? String(plan.options.gpu || 'G4').toUpperCase() : null;
    const planned = colab ? rateForGpu(gpu) : null;
    let measured = null, before = null;
    const limitsFor = rate => {
      const reserveUnits = reserveUnitsFor(rate);
      return { ratePerHour: rate, reserveUnits, deadlineMinutes: spendingMinutes(ceiling, rate, { reserveUnits }) };
    };
    let limits = colab ? limitsFor(planned.ratePerHour) : null;
    const makeBackend = () => colab ? colabFactory({ packageId: runId, packageDir: workDir, scratchDir: scratch, budgetUnits: ceiling, gpu, ratePerHour: limits.ratePerHour, watchdogMinutes: limits.deadlineMinutes, wallClockCapMinutes: limits.deadlineMinutes }) : byoFactory({ comfyuiUrl: plan.options.comfyuiUrl || 'http://127.0.0.1:8188', outDir });
    let backend = makeBackend();
    if (colab) {
      before = await backend.usage();
      measured = Number.isFinite(before?.ratePerHour) && before.ratePerHour > 0 ? before.ratePerHour : null;
      if (measured !== null && measured > limits.ratePerHour) {
        // Price, watchdog and wall-clock cap all follow the higher rate; nothing is allocated yet, so the
        // backend is simply rebuilt with the corrected limits.
        limits = limitsFor(measured);
        backend = makeBackend();
      }
    }
    const ratePerHour = limits?.ratePerHour ?? null;
    const rateSource = !colab ? null : limits.ratePerHour > planned.ratePerHour ? 'measured' : planned.origin;
    if (typeof backend.preflight === 'function') {
      const check = await backend.preflight();
      if (check.ok === false || check.ready === false) throw new Error(check.problems?.join('; ') || check.message || check.detail || 'Media backend preflight failed');
    }
    const estimate = await backend.estimate(jobs);
    const upperFor = rate => nextJobUpperEstimate({ gpuMinutes: estimate.gpuMinutes ?? 0, overheadMinutes: estimate.overheadMinutes ?? 0, ratePerHour: rate });
    let admission = null;
    if (colab) {
      admission = assessBudget({ budgetUnits: ceiling, ratePerHour, nextJobUpperEstimate: upperFor(ratePerHour) });
      if (!admission.allowed) throw new Error(`${admission.message} Re-plan with a larger media allocation.`);
    }
    send({ kind: 'task', stageId, detail: { event: 'media_plan', jobs: summarizeJobs(pkg, jobs), estimate, admission, spend: colab ? { gpu, ratePerHour, rateSource, tableRatePerHour: planned.tableRate, measuredRatePerHour: measured, deadlineMinutes: limits.deadlineMinutes, reserveUnits: limits.reserveUnits, reserveMinutes: COLLECT_AND_STOP_RESERVE_MINUTES } : null } });
    let result, teardown;
    const holdForRender = remoteRender && colab;
    if (holdForRender && typeof backend.setCollectPolicy === 'function') backend.setCollectPolicy('manifest');
    send({ kind: 'runtime', runtime: 'media', value: { state: 'allocating', ownership: colab ? 'managed' : 'external', spentUnits: null } });
    try {
      if (colab) {
        // PO-3: the ceiling is checked before anything is allocated. `required` is the upper estimate plus
        // the collect-and-stop reserve (assessBudget's reserve, the same reserveUnitsFor(rate) the deadline
        // subtracts). An unreadable balance is a refusal, not a pass: we cannot prove the run is covered.
        // Balance check: the account's existing burn keeps draining while we run, so the balance must cover
        // our run priced at (planned + measured), not max(). The per-run rate for watchdog/caps stays max().
        const balanceRate = Number((planned.ratePerHour + (measured ?? 0)).toFixed(3));
        const required = balanceRate === ratePerHour ? admission?.required ?? null : assessBudget({ budgetUnits: Number.MAX_SAFE_INTEGER, ratePerHour: balanceRate, nextJobUpperEstimate: upperFor(balanceRate) }).required;
        const balance = typeof before?.balance === 'number' ? before.balance : Number.NaN;
        send({ kind: 'task', stageId, detail: { event: 'media_spend_ceiling', gpu, ratePerHour, rateSource, balanceRatePerHour: balanceRate, required, reserveUnits: limits.reserveUnits, balance: Number.isFinite(balance) ? balance : null } });
        if (!Number.isFinite(balance)) throw new Error('The Google Colab account balance could not be read, so this run cannot be shown to fit it. Nothing was allocated; check `colab usage` and try again.');
        if (!Number.isFinite(required) || balance < required) {
          throw new Error(`The account balance (${balance} units) does not cover the estimated ${required} units for this run at ${balanceRate} units/h on ${gpu} (planned ${planned.ratePerHour} + the account's current ${measured ?? 0}), which includes the ${reserveUnitsFor(balanceRate)}-unit collect-and-stop reserve (${COLLECT_AND_STOP_RESERVE_MINUTES} min at ${balanceRate} units/h). Nothing was allocated; reduce the media allocation or top the account up.`);
        }
      }
      result = await backend.runPackage(pkg, { workDir, outDir, budget: admission, approved: true, teardownMode: holdForRender ? 'never' : 'done', gateCommand: null, signal, onEvent: sourceEvent });
      teardown = result.teardown;
      if (!result.ok) throw new Error('Media generation did not complete; collected assets are retained for diagnosis');
      if (holdForRender) {
        heldBackend = backend;
        // PO-3 review (8): the media watchdog was sized for media; the held VM now has to survive the
        // render. Re-arm it with a bounded render allowance plus the collect-and-stop reserve.
        if (typeof backend.rearmWatchdog === 'function') {
          const allowance = Number(process.env.COMFYRIZZ_COLAB_RENDER_ALLOWANCE_MINUTES) || RENDER_ALLOWANCE_MINUTES;
          const minutes = allowance + COLLECT_AND_STOP_RESERVE_MINUTES;
          const watchdog = await backend.rearmWatchdog({ minutes });
          send({ kind: 'task', stageId, detail: { event: 'render_watchdog', minutes, allowanceMinutes: allowance, estimatedUnits: Number(((minutes / 60) * ratePerHour).toFixed(3)), armed: Boolean(watchdog) } });
        }
      }
    } catch (error) {
      heldBackend = null;
      teardown = error.runPackage?.teardown ?? teardown;
      throw error;
    } finally {
      if (heldBackend) {
        send({ kind: 'runtime', runtime: 'media', value: { state: 'running', ownership: 'managed', spentUnits: null, costSource: 'account_balance_delta', note: 'Held for the Google Colab render' } });
      } else {
        if (!teardown) { try { teardown = await backend.teardown('pipeline cleanup'); } catch (error) { teardown = { state: 'stop_unconfirmed', evidence: error.message }; } }
        let spentUnits = null;
        if (colab) {
          try { const after = await backend.usage(); if (Number.isFinite(before?.balance) && Number.isFinite(after.balance)) spentUnits = Number((before.balance - after.balance).toFixed(3)); } catch { /* unknown is not zero */ }
        }
        // A rejected allocation never creates an owned runtime. Preserve its real
        // failure (for example, no GPU capacity), just as releaseHeld does above.
        const state = teardown?.state === 'not_owned' ? 'stopped' : (teardown?.state ?? 'stop_unconfirmed');
        send({ kind: 'runtime', runtime: 'media', value: { state, ownership: colab ? 'managed' : 'external', spentUnits, costSource: colab ? 'account_balance_delta' : 'external_unknown' } });
        if (colab && state !== 'stopped') throw new Error('Media runtime shutdown is unconfirmed');
        if (colab && spentUnits !== null && spentUnits > ceiling) throw new Error('Media spend exceeded its allocation; no further work will start');
      }
    }
    const collected = colab ? join(scratch, 'out') : outDir;
    copyNamedAssets({ pkg: result.package, outputDir: collected, packageDir: workDir });
    pkg = result.package; writeJson(packagePath, pkg);
  }, jobs.length === 0);

  await stage('presenter_sync', async () => {
    if (heldBackend && typeof heldBackend.downloadListed === 'function') {
      const current = json(packagePath);
      const files = presenterScenes(current).map((scene) => current.assets?.[scene.presenter_asset]?.file).filter((file) => typeof file === 'string');
      progress('Collecting presenter clips for timing correction', { mode: 'measured', completed: 0, total: files.length, unit: 'files' });
      await heldBackend.downloadListed(files, workDir, { onEvent: sourceEvent });
    }
    if (!syncnetReady) {
      send({ kind: 'warning', stageId, code: SYNCNET_RUNTIME_SKIP_CODE, message: SYNCNET_SKIP_MESSAGE });
      return [];
    }
    return presenterCorrection(workDir, runDir, { signal, onEvent: event => {
      progress(event.phase, event.total ? { mode: 'measured', completed: event.completed, total: event.total, unit: 'presenters' } : null, { sceneId: event.sceneId });
      send({ kind: 'task', stageId, detail: event });
    } });
  }, !plan.presenters);

  await stage('render', async () => {
    const localRender = async () => {
      renderResult = await render(packagePath, join(runDir, 'video.mp4'), { signal, onEvent: event => progress(event.phase, event.progress) });
      // Only the isolated run snapshot receives derived assets; the saved project
      // and its editable composition manifest remain authoritative source.
      if (renderResult.package) {
        pkg = renderResult.package;
        writeJson(packagePath, pkg);
      }
      progress('Normalizing the final audio mix', null);
      await command(process.execPath, [fileURLToPath(new URL('./pipeline-cpu-task.mjs', import.meta.url)), 'normalize', workDir, runDir]);
      renderResult.bytes = statSync(join(runDir, 'video.mp4')).size;
      renderResult.location = 'local';
      writeJson(join(runDir, 'render.json'), renderResult);
    };
    if (heldBackend) {
      let delivered = false;
      try {
        progress('Rendering on the Google Colab VM', null);
        const remote = await colabRender({ backend: heldBackend, workDir, runDir, voiced: plan.voiced, presenters: plan.presenters, signal, onEvent: event => progress(event.message || event.phase || 'rendering', event.progress ?? null) });
        renderResult = remote.renderResult;
        if (renderResult.package) {
          pkg = renderResult.package;
          writeJson(packagePath, pkg);
        }
        if (!existsSync(join(runDir, 'loudness.json'))) {
          progress('Normalizing the final audio mix', null);
          await command(process.execPath, [fileURLToPath(new URL('./pipeline-cpu-task.mjs', import.meta.url)), 'normalize', workDir, runDir]);
        }
        renderResult.bytes = statSync(join(runDir, 'video.mp4')).size;
        writeJson(join(runDir, 'render.json'), renderResult);
        delivered = true;
        await releaseHeld('render done');
      } catch (error) {
        if (signal.aborted || delivered) throw error;
        const message = redactForLog(error.message || 'remote render failed');
        let shutdownState = 'stopped';
        try {
          if (heldBackend && typeof heldBackend.setCollectPolicy === 'function') heldBackend.setCollectPolicy('full');
          if (heldBackend && typeof heldBackend.collectOut === 'function') {
            progress('Collecting generated media for the local render', null);
            const collected = await heldBackend.collectOut({ onEvent: sourceEvent });
            copyNamedAssets({ pkg: json(packagePath), outputDir: collected.local || join(runDir, 'media-runtime', 'out'), packageDir: workDir });
          }
        } catch (collectError) {
          send({ kind: 'warning', stageId: 'render', code: 'REMOTE_RENDER_COLLECT', message: redactForLog(collectError.message || 'Could not collect generated media') });
        }
        try { await releaseHeld('remote render failed'); }
        catch (stopError) {
          shutdownState = 'stop_unconfirmed';
          const decision = decideRenderFallback({ remoteError: message, shutdownState });
          send({ kind: 'warning', stageId: 'render', code: 'REMOTE_RENDER_FALLBACK', message: decision.warning });
          throw stopError;
        }
        const decision = decideRenderFallback({ remoteError: message, cancelled: signal.aborted, shutdownState });
        send({ kind: 'warning', stageId: 'render', code: 'REMOTE_RENDER_FALLBACK', message: decision.warning });
        if (!decision.fallback) throw error;
        renderResult = null;
      }
    }
    if (!renderResult) await localRender();
  });

  await stage('verify', async () => {
    // Exit 2 from the mix check is a failed narration verdict only when it comes with
    // a fresh report. Remove any old report, require the checker to write a new one,
    // and require its exit code and verdict to agree before recording it.
    const report = { checks: {}, probe: null, note: 'Technical checks do not replace perceptual review.' };
    try {
      report.probe = JSON.parse((await command('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,nb_read_frames,sample_rate:format=duration', '-of', 'json', join(runDir, 'video.mp4')])).stdout);
      const video = report.probe.streams.find(s => s.codec_type === 'video'), audio = report.probe.streams.find(s => s.codec_type === 'audio');
      report.checks = { frames: Number(video?.nb_read_frames) === renderResult.frames, dimensions: video?.width === renderResult.width && video?.height === renderResult.height, duration: Math.abs(Number(report.probe.format.duration) - renderResult.frames / renderResult.fps) < 0.1, narrationStream: !plan.voiced || Boolean(audio) };
      if (plan.voiced) {
        const measure = await command('ffmpeg', ['-hide_banner', '-nostats', '-i', join(runDir, 'video.mp4'), '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
        const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(measure.stderr);
        report.checks.nonSilentAudio = Boolean(mean) && Number(mean[1]) > -60;
        const narrationPath = join(runDir, 'audio-verification.json');
        rmSync(narrationPath, { force: true });
        const verdict = await command(process.env.COMFYRIZZ_PYTHON || 'python3', [join(repoRoot, 'scripts/tts/verify_mix.py'), '--video', join(runDir, 'video.mp4'), '--narration', join(workDir, 'audio/narration.norm.wav'), '--out', narrationPath], { allowedCodes: [0, 2] });
        let narration;
        try { narration = json(narrationPath); }
        catch { throw new Error(`Mix checker exited ${verdict.code} without writing a report`); }
        if (!narration || typeof narration.passed !== 'boolean') throw new Error(`Mix checker exited ${verdict.code} with an invalid report`);
        if ((verdict.code === 0) !== (narration.passed === true)) throw new Error(`Mix checker exit ${verdict.code} contradicts its ${narration.passed ? 'passing' : 'failing'} report`);
        report.narration = narration;
        report.checks.narrationEnvelope = narration.passed === true;
      }
      if (Object.values(report.checks).some(value => !value)) throw new Error('Final video verification failed');
    } catch (error) {
      report.error = error.message;
      if (plan.voiced && report.checks.narrationEnvelope === undefined) report.checks.narrationEnvelope = false;
      throw error;
    } finally {
      writeJson(join(runDir, 'verification.json'), report);
    }
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
    send({ kind: 'result', result: { packageId: pkg.id, baseRevision: plan.baseRevision, inputHash: plan.inputHash, frames: renderResult.frames, fps: renderResult.fps, renderLocation: renderResult.location ?? 'local', files, packageUrl: `/api/pipeline/${runId}/package`, verificationUrl: `/api/pipeline/${runId}/verification` } });
  });
}

try { await main(); return 0; }
catch (error) {
  if (heldBackend) {
    try { await releaseHeld(signal.aborted ? 'cancelled' : 'pipeline cleanup'); }
    catch { /* releaseHeld already reported an unconfirmed stop */ }
  }
  send({ kind: signal.aborted ? 'cancelled' : 'failed', stageId, code: signal.aborted ? 'CANCELLED' : 'STAGE_FAILED', message: signal.aborted ? 'Pipeline cancelled. Check the runtime states for shutdown confirmation.' : error.message });
  return 1;
} finally {
  clearInterval(heartbeat);
  if (heldBackend) {
    try { await releaseHeld('pipeline cleanup'); }
    catch { /* the failure event already names the stage; shutdown state was sent */ }
  }
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
      // PO-4: a reconcile must be interruptible. Stopping before a teardown starts is safe: the untried
      // runtimes keep the state they were recorded with, so the run stays unsettled and still blocks a new
      // one. A teardown that has already started is never abandoned half-way.
      if (abort.signal.aborted) {
        send({ kind: 'diagnostic', message: 'Reconciliation was cancelled; runtimes not yet confirmed stopped are unchanged.' });
        process.exitCode = 1;
        break;
      }
      const narration = runtime === 'narration';
      const backend = createColabBackend({ packageId: narration ? `${spec.plan.packageId}_qwen` : spec.runId, scratchDir: narration ? join(spec.runDir, 'qwen/scratch') : join(spec.runDir, 'media-runtime') });
      try {
        const sessions = await backend.sessions();
        // PO-4 review: only a positively clean listing is "stopped"; an unnamed (orphan) row may be the VM an
        // interrupted allocation created, so it is surfaced as unconfirmed rather than ignored.
        const check = sessionsCheck(sessions, backend.state.session);
        const teardown = check.clean ? { state: 'stopped', evidence: 'Runtime no longer listed by Google Colab' }
          : check.ours ? await backend.teardown('pipeline reconciliation')
          : { state: 'stop_unconfirmed', evidence: check.note, orphans: check.orphans, manual: 'colab sessions; colab stop -s <name> for any session this run created' };
        send({ kind: 'runtime', runtime, value: { ...value, state: teardown.state === 'stopped' ? 'stopped' : 'stop_unconfirmed', evidence: teardown.evidence } });
        if (teardown.state !== 'stopped') process.exitCode = 1;
      } catch (error) {
        send({ kind: 'runtime', runtime, value: { ...value, state: 'stop_unconfirmed', evidence: error.message } }); process.exitCode = 1;
      }
    }
  } else process.exitCode = await executePipeline(spec, { signal: abort.signal, send });
  if (process.connected) process.disconnect();
}
