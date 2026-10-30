// Ship the editor's package and a renderer bundle to the Google Colab VM, run the
// render plus mix verification there, and bring back the MP4 and reports.
// Generated plates stay on the VM through rendering; editable media and newly
// compiled composition resources return together after the movie is verified.
//
// RL10a: a render that stops reporting is stalled, not slow. The render cell on the VM
// heartbeats every 20 s (colab/render_remote.py), so a step that says nothing for minutes is
// gone, not busy. The render is therefore watched here instead of being awaited forever: no
// progress for the stall window ends the step with the state `stalled` and a retry hint, and
// every backend call has a deadline, so progress and status never wait on a promise that never
// settles.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { assertModelContribution, generationReceiptFiles } from '../../../packages/jobs/src/model-contribution.mjs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions, repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { namedAssetFiles } from './run-assets.mjs';
import { collectCompositionExtras, loadCompositionManifest } from '../../../packages/compositions/src/index.mjs';
import { collectCompositionCacheExtras, verifyPreparedCompositions } from '../../renderer/scripts/composition-worker.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import {
  listRenderBundleFiles,
  planColabRenderJob,
  renderBundleStamp,
  writeZipArchive,
} from '../../../packages/backends/src/colab-render-plan.mjs';

const renderDirsScript = join(repoRoot, 'colab', 'render_dirs.py');
const renderScript = join(repoRoot, 'colab', 'render_remote.py');
const python = () => process.env.COMFYRIZZ_PYTHON || 'python3';

/** The state a render that stopped reporting progress ends in. */
export const RENDER_STALL_STATE = 'stalled';
/** How long a render may stay silent before it counts as stalled. */
export const DEFAULT_RENDER_STALL_MINUTES = 5;
/** The knob for the stall window, so a very long render can be given more room. */
export const RENDER_STALL_MINUTES_ENV = 'COMFYRIZZ_COLAB_RENDER_STALL_MINUTES';
/** Upper bounds for the backend calls of one render. No step waits forever. */
export const RENDER_STEP_DEADLINES = Object.freeze({
  dirs: 5 * 60_000,
  upload: 11 * 60_000,
  render: 65 * 60_000,
  download: 16 * 60_000,
});

/** The clock the render watches itself with. A test injects its own. */
export const realClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle),
});

/**
 * The stall window in milliseconds: an explicit number of minutes, the environment, or the
 * default. A window that is not a positive number would stall every render, so it falls back
 * to the default rather than to "stall immediately".
 */
export function renderStallMs({ minutes = null, env = process.env } = {}) {
  const raw = minutes ?? env?.[RENDER_STALL_MINUTES_ENV] ?? DEFAULT_RENDER_STALL_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RENDER_STALL_MINUTES * 60_000;
  return Math.round(value * 60_000);
}

/**
 * A silence timer for one long step. `progress()` says the step is alive; when nothing has said
 * so for `stallMs` of the injected clock, `onStall` fires once and the guard stops.
 */
export function createStallGuard({ stallMs, clock = realClock, onStall = () => {} } = {}) {
  let handle = null;
  let lastProgressAt = clock.now();
  let stalled = false;
  const arm = () => {
    if (handle != null) { clock.clearTimeout(handle); handle = null; }
    if (stalled) return;
    const remaining = stallMs - (clock.now() - lastProgressAt);
    if (remaining <= 0) { stalled = true; onStall(); return; }
    handle = clock.setTimeout(() => { handle = null; arm(); }, remaining);
  };
  arm();
  return {
    get stalled() { return stalled; },
    get silentSince() { return lastProgressAt; },
    progress() { if (stalled) return; lastProgressAt = clock.now(); arm(); },
    stop() { if (handle != null) { clock.clearTimeout(handle); handle = null; } },
  };
}

/** The error a stalled render ends with: the state it reached, and what to do about it. */
export function stalledRenderError({ stallMs, detail = null }) {
  const minutes = Math.max(1, Math.round(stallMs / 60_000));
  const error = new Error(detail ?? `The Google Colab render stopped reporting progress for ${minutes} minutes and was stopped.`);
  error.name = 'ColabRenderStalled';
  error.code = 'RENDER_STALLED';
  error.state = RENDER_STALL_STATE;
  error.retry = {
    retryable: true,
    resume: 'render',
    hint: 'Retry the render: the generated media is still on the Google Colab VM, so the retry resumes at the render step instead of generating the plates again.',
  };
  return error;
}

/** The error a render that outlived its deadline ends with. */
export function renderTimeoutError({ label = 'render', deadlineMs }) {
  const minutes = Math.max(1, Math.round(deadlineMs / 60_000));
  const error = new Error(`The Google Colab ${label} step did not finish within ${minutes} minutes and was stopped.`);
  error.name = 'ColabRenderTimeout';
  error.code = 'RENDER_TIMEOUT';
  error.state = 'timeout';
  error.retry = {
    retryable: true,
    resume: 'render',
    hint: 'Retry the render: the generated media is still on the Google Colab VM, so the retry resumes at the render step instead of generating the plates again.',
  };
  return error;
}

/** Where the last render attempt stopped, so a retry can pick it up. */
export function readRenderStatus(runDir) {
  const path = join(runDir, 'colab-render', 'status.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeRenderStatus(scratch, clock, status) {
  try {
    writeFileSync(join(scratch, 'status.json'), JSON.stringify({ ...status, at: new Date(clock.now()).toISOString() }, null, 2));
  } catch { /* a status file never fails a render */ }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safeRelative(file) {
  if (typeof file !== 'string' || !file || file.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return file;
}

function filesUnder(workDir, rel) {
  const root = join(workDir, rel);
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [rel];
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const next = join(dir, entry);
      const name = `${prefix}/${entry}`;
      if (statSync(next).isDirectory()) walk(next, name);
      else found.push(name);
    }
  };
  walk(root, rel);
  return found;
}

/** Files the renderer needs from the host, and generated names that stay on the VM. */
export function projectTransferLists(pkg, workDir, cacheExtras = []) {
  const present = (file) => {
    const safe = safeRelative(file);
    if (!safe) return false;
    const path = join(workDir, safe);
    return existsSync(path) && statSync(path).isFile();
  };
  const named = namedAssetFiles(pkg).map(safeRelative).filter(Boolean);
  const upload = [];
  const link = [];
  for (const file of named) {
    if (present(file)) upload.push(file);
    else link.push(file);
  }
  const extras = [...filesUnder(workDir, 'audio'), ...collectCompositionExtras(pkg, workDir).map(extra => extra.path), ...cacheExtras.map(extra => extra.path)];
  for (const file of ['package.json', 'timeline.json', 'media.json']) if (present(file)) extras.push(file);
  for (const font of pkg.theme?.fonts ?? []) if (present(font?.file)) extras.push(font.file);
  return {
    uploadFiles: [...new Set([...extras, ...upload])],
    linkFiles: link,
    archiveFiles: named,
  };
}

export async function prepareRenderJob(workDir, { voiced = false, presenters = false } = {}) {
  const packagePath = join(workDir, 'package.json');
  const pkg = readJson(packagePath);
  const timeline = compileTimeline(pkg, narrationOptions(workDir));
  assertModelContribution({ pkg, packageDir: workDir, timeline });
  writeFileSync(join(workDir, 'timeline.json'), JSON.stringify(timeline));
  const lists = projectTransferLists(pkg, workDir, await collectCompositionCacheExtras(pkg, workDir));
  const compositions = (loadCompositionManifest(workDir, pkg)?.scenes.length ?? 0) > 0;
  const bundleFiles = [...listRenderBundleFiles(repoRoot), ...generationReceiptFiles(pkg, workDir)];
  if (!bundleFiles.some((file) => file.name === 'apps/renderer/package.json')) {
    throw new Error('The render bundle is missing the renderer package');
  }
  for (const file of ['packages/planner/src/index.ts', 'packages/vector/src/index.ts', 'packages/compositions/src/index.mjs']) {
    if (!bundleFiles.some(entry => entry.name === file)) throw new Error(`The render bundle is missing source: ${file}`);
  }
  const stamp = renderBundleStamp(bundleFiles);
  const job = planColabRenderJob({ ...lists, voiced, presenters, stamp, compositions });
  return { pkg, timeline, bundleFiles, job };
}

function unzipSafe(archive, dest) {
  const script = `
import sys, zipfile
from pathlib import Path
archive, dest = sys.argv[1:]
root = Path(dest)
root.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as bundle:
    for name in bundle.namelist():
        path = Path(name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit("unsafe zip member")
    bundle.extractall(root)
`;
  const result = spawnSync(python(), ['-c', script, archive, dest], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not unpack ${archive}: ${(result.stderr || '').slice(-400)}`);
}

/**
 * @param {object} backend a Google Colab backend that is already up (uploadFile, execStep, downloadFile)
 * @param {number} [stallMinutes] how long the render may stay silent before it counts as stalled
 * @param {object} [clock] {now, setTimeout, clearTimeout}: the clock the render watches itself with
 */
export async function runColabRender({ backend, workDir, runDir, voiced = false, presenters = false, signal, onEvent = () => {}, stallMinutes = null, clock = realClock, deadlines = {}, refWatch = null } = {}) {
  if (!backend || typeof backend.uploadFile !== 'function' || typeof backend.execStep !== 'function' || typeof backend.downloadFile !== 'function') {
    throw new Error('This Google Colab backend cannot run a remote render');
  }
  if (typeof refWatch?.beforeRender === 'function') {
    const gate = await refWatch.beforeRender({ workDir, runDir });
    if (gate?.ok === false) {
      const error = new Error(gate.message || 'Reference watch is holding the Google Colab video render until keyframes finish review.');
      error.code = 'REF_GATE_HELD';
      error.held = gate.held ?? [];
      throw error;
    }
  }
  const limits = { ...RENDER_STEP_DEADLINES, ...deadlines };
  const stallMs = renderStallMs({ minutes: stallMinutes });
  const scratch = join(runDir, 'colab-render');
  mkdirSync(scratch, { recursive: true });

  /**
   * One backend call, watched. The call is raced against its deadline and, for the render, against
   * its own silence: whichever comes first settles the step, so no caller waits on a promise that
   * never settles. The step gets an abort of its own, linked to the caller's cancellation, so a
   * deadline or a stall stops the work instead of leaving it running.
   */
  async function callStep(label, call, { stallMs: stallWindow = 0 } = {}) {
    const deadlineMs = limits[label] ?? 0;
    const controller = new AbortController();
    let settleCancel;
    const cancelled = new Promise((resolve) => { settleCancel = resolve; });
    const cancel = () => {
      const reason = signal?.reason ?? new Error('The pipeline was cancelled');
      controller.abort(reason);
      settleCancel({ state: 'cancelled', reason });
    };
    if (signal) { if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); }
    let stallError = null;
    let settleStall;
    const stalled = new Promise((resolve) => { settleStall = resolve; });
    const guard = stallWindow > 0 ? createStallGuard({
      stallMs: stallWindow,
      clock,
      onStall: () => {
        stallError = stalledRenderError({ stallMs: stallWindow });
        onEvent({ phase: RENDER_STALL_STATE, state: RENDER_STALL_STATE, progress: null, message: stallError.message, retry: stallError.retry });
        settleStall({ state: 'stalled' });
        controller.abort(stallError);
      },
    }) : null;
    let deadlineHandle = null;
    const deadline = new Promise((resolve) => {
      if (Number.isFinite(deadlineMs) && deadlineMs > 0) deadlineHandle = clock.setTimeout(() => resolve({ state: 'deadline' }), deadlineMs);
    });
    try {
      const settled = Promise.resolve()
        .then(() => call(controller.signal, guard))
        .then(value => ({ state: 'done', value }), error => ({ state: 'failed', error }));
      const outcome = await Promise.race([settled, deadline, stalled, cancelled]);
      if (outcome.state === 'stalled') throw stallError;
      if (outcome.state === 'cancelled') throw outcome.reason;
      if (outcome.state === 'deadline') {
        controller.abort(new Error(`The Google Colab ${label} step did not finish in time`));
        throw renderTimeoutError({ label, deadlineMs });
      }
      if (outcome.state === 'failed') throw outcome.error;
      return outcome.value;
    } finally {
      guard?.stop();
      if (deadlineHandle != null) clock.clearTimeout(deadlineHandle);
      if (signal) signal.removeEventListener('abort', cancel);
    }
  }

  const { pkg, timeline, bundleFiles, job } = await prepareRenderJob(workDir, { voiced, presenters });
  writeFileSync(join(scratch, 'job.json'), JSON.stringify(job));
  onEvent({ phase: 'bundling', progress: null });
  writeZipArchive(join(scratch, 'bundle.zip'), bundleFiles);
  writeZipArchive(join(scratch, 'project.zip'), job.uploadFiles.map((name) => ({ name, path: join(workDir, name) })));
  const forward = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.phase) onEvent({ phase: event.phase, progress: event.progress ?? null, message: event.message });
    else if (event.event === 'progress' && event.phase) onEvent({ phase: event.phase, progress: event.progress ?? null });
  };
  signal?.throwIfAborted();
  onEvent({ phase: 'preparing', progress: null });
  const dirs = await callStep('dirs', (stepSignal) => backend.execStep(renderDirsScript, 'render-dirs', { timeout: 180, signal: stepSignal, onEvent: forward }));
  if (!dirs?.ok) throw new Error(dirs?.note || 'Google Colab render directories were not created');
  signal?.throwIfAborted();
  onEvent({ phase: 'uploading', progress: null });
  await callStep('upload', (stepSignal) => backend.uploadFile(join(scratch, 'bundle.zip'), job.bundleZip, { signal: stepSignal }));
  await callStep('upload', (stepSignal) => backend.uploadFile(join(scratch, 'project.zip'), job.projectZip, { signal: stepSignal }));
  await callStep('upload', (stepSignal) => backend.uploadFile(join(scratch, 'job.json'), job.jobFile, { signal: stepSignal }));
  signal?.throwIfAborted();
  onEvent({ phase: 'bootstrapping', progress: null });
  let rendered;
  try {
    rendered = await callStep('render', (stepSignal, guard) => backend.execStep(renderScript, 'render', {
      timeout: 3600,
      silenceMs: 180000,
      signal: stepSignal,
      onEvent: (event) => { guard?.progress(); forward(event); },
    }), { stallMs });
    if (!rendered?.ok) {
      // The cell that stopped reporting is the same stall the guard watches for: the backend gave
      // up on it and never saw it finish. Say so, with the retry that works.
      if (rendered?.lost) {
        const error = stalledRenderError({ stallMs, detail: 'The Google Colab render stopped reporting and the cell on the VM was lost before it finished.' });
        onEvent({ phase: RENDER_STALL_STATE, state: RENDER_STALL_STATE, progress: null, message: error.message, retry: error.retry });
        throw error;
      }
      const failure = new Error(rendered?.note || 'Google Colab render did not finish');
      failure.code = 'RENDER_FAILED';
      throw failure;
    }
  } catch (error) {
    writeRenderStatus(scratch, clock, { state: error.state ?? (signal?.aborted ? 'cancelled' : 'failed'), phase: 'render', code: error.code ?? null, retry: error.retry ?? null });
    throw error;
  }
  writeRenderStatus(scratch, clock, { state: 'completed', phase: 'render' });
  signal?.throwIfAborted();
  onEvent({ phase: 'collecting', progress: { mode: 'measured', completed: 0, total: 2, unit: 'files' } });
  const resultsZip = join(scratch, 'results.zip');
  const mediaZip = join(scratch, 'media.zip');
  await callStep('download', (stepSignal) => backend.downloadFile(job.resultsZip, resultsZip, { signal: stepSignal }));
  await callStep('download', (stepSignal) => backend.downloadFile(job.mediaZip, mediaZip, { signal: stepSignal }));
  onEvent({ phase: 'collecting', progress: { mode: 'measured', completed: 2, total: 2, unit: 'files' } });
  unzipSafe(resultsZip, runDir);
  unzipSafe(mediaZip, workDir);
  const renderPath = join(runDir, 'render.json');
  if (!existsSync(join(runDir, 'video.mp4')) || !existsSync(renderPath) || !existsSync(join(runDir, 'verification.json'))) {
    throw new Error('Google Colab render did not return the MP4 and verification report');
  }
  const renderResult = readJson(renderPath);
  if (!renderResult.package || !validatePackage(renderResult.package).valid || renderResult.package.id !== pkg.id) throw new Error('Google Colab returned an invalid render package');
  const effectiveTimeline = compileTimeline(renderResult.package, narrationOptions(workDir));
  const timing = value => value.scenes.map(scene => [scene.id, scene.from, scene.durationInFrames]);
  if (JSON.stringify(timing(effectiveTimeline)) !== JSON.stringify(timing(timeline)) || JSON.stringify(effectiveTimeline.captions) !== JSON.stringify(timeline.captions) ||
      renderResult.frames !== timeline.durationInFrames || ['width', 'height', 'fps'].some(key => effectiveTimeline[key] !== timeline[key] || renderResult[key] !== timeline[key]) ||
      renderResult.hash !== effectiveTimeline.hash) throw new Error('Google Colab changed authoritative project timing');
  await verifyPreparedCompositions({ pkg: renderResult.package, packageDir: workDir, timeline: effectiveTimeline, signal });
  renderResult.bytes = statSync(join(runDir, 'video.mp4')).size;
  renderResult.location = 'colab';
  return { renderResult, job };
}
