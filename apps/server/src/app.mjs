import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PackageStore, ConflictError, InvalidPackageError } from './store.mjs';
import { EventLog } from './events.mjs';
import { colabStatus } from './colab-status.mjs';
import { startColabAuth } from './colab-auth.mjs';
import { readColabProgress } from '../../../packages/backends/src/colab-progress.mjs';
import { createRunController } from './run.mjs';
import { createExporter } from './export.mjs';
import { buildVariants } from './variant.mjs';
import { buildDataset } from './dataset.mjs';
import { copyNamedAssets } from './run-assets.mjs';
import { loadAssetWorkflow } from './workflow.mjs';
import { runFrameQa, createQaRegistry } from './qa.mjs';
import { sceneAssetIds, sceneJobsPlan } from './scene.mjs';
import { packageTimeline, timingChangeReason } from './edit.mjs';
import { planBrief, refreshBrief, briefPresets } from './brief.mjs';
import { prepareBrand } from './brand.mjs';
import { handleProviderSettings } from './provider-settings.mjs';
import { createProjectChat } from './agent-chat.mjs';
import { createReferenceRoutes } from './references/routes.mjs';
import { createCharacterRoutes } from './characters/routes.mjs';
import { ingestRun } from './takes/ingest.mjs';
import { selectTake } from './takes/select.mjs';
import { createTakeStore } from './takes/store.mjs';
import { TAKES_SCHEMA } from './takes/model.mjs';
import { createTakeRoutes } from './takes/routes.mjs';
import { buildCorrection } from './takes/correction.mjs';
import { listClips } from './takes/clips.mjs';
import { finalGate } from './takes/gate.mjs';
import { applySceneChip, sceneChipList } from '../../../packages/agent/dist/src/index.js';
import { applyPresenterSet, presenterChips, presenterPresets } from '../../../packages/agent/dist/src/index.js';
import { renderPackage as defaultRenderPackage, repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { renderPackageIncremental as defaultRenderScene } from '../../renderer/scripts/render-incremental.mjs';
import { compilePackage, measuredOptionsFromDir } from './compile-package.mjs';
import { handleCompile } from './compile-route.mjs';
import { handleMedia } from './media-route.mjs';
import { readEditor, validateEditor, writeEditor } from './editor-sidecar.mjs';
import { serveStaticFile } from './static-file.mjs';
import { createPipelineController } from './pipeline.mjs';
import { stagePipelineInputs } from './pipeline-media.mjs';
import { createOperationCoordinator } from './operations.mjs';
import { KOKORO_VOICES, QWEN_SPEAKERS, VOICE_PRESETS } from '../../../packages/tts/voices.mjs';
import { animationOptions } from './animation-options.mjs';
import { createMediaTickets, safeMediaPath, serveTicket } from './media-range.mjs';
import { loadCompositionManifest } from '../../../packages/compositions/src/index.mjs';

const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.vtt': 'text/vtt; charset=utf-8',
  '.zip': 'application/zip',
};

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

function sendBytes(response, status, body, headers = {}) {
  const buffer = Buffer.from(body);
  response.writeHead(status, {
    'content-length': buffer.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(buffer);
}

function safeTokenEqual(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hostAllowed(host) {
  return typeof host === 'string' && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

function sameOrigin(origin, host) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

function bearer(request) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

// Only key presence is ever reported; key values never leave the server.
export function providerAvailability(env = process.env) {
  return {
    openrouter: Boolean(env.OPENROUTER_API_KEY),
    'opencode-go': Boolean(env.OPENCODE_API_KEY || env.OPENCODE_GO_API_KEY),
    custom: Boolean(env.COMFYRIZZ_CUSTOM_BASE_URL || env.COMFYRIZZ_CUSTOM_API_KEY),
  };
}

// Loaded lazily so tests can inject a fake and so the backends module is not parsed
// for every server test that never touches a GPU path.
async function defaultBackendFactory(backendId, opts = {}) {
  const mod = await import('../../../packages/backends/src/index.mjs');
  if (backendId === 'colab') {
    return mod.createColabBackend({
      packageId: opts.packageId ?? 'comfyrizz-run',
      packageDir: opts.workDir ?? undefined,
      scratchDir: opts.scratchDir ?? undefined,
      budgetUnits: opts.budgetUnits ?? 0,
      // PO-3: the rate lives in the backend budget module, not in a literal here.
      ratePerHour: mod.resolveRatePerHour({ gpu: opts.gpu, explicit: opts.ratePerHour }),
    });
  }
  if (backendId === 'byo-comfyui') {
    return mod.createByoBackend({ comfyuiUrl: opts.comfyuiUrl ?? 'http://127.0.0.1:8188', outDir: opts.outDir ?? null });
  }
  return null;
}

export function createApp({
  root = repoRoot,
  colabProgressDir = null,
  token,
  runtimeDir = join(root, 'apps', 'server', '.runtime'),
  exportsDir = join(runtimeDir, 'out', 'export'),
  webDist = join(root, 'apps', 'web', 'dist'),
  render = defaultRenderPackage,
  renderScene = defaultRenderScene,
  agentRunner = null,
  providers = providerAvailability(),
  providerSettings = null,
  backendFactory = defaultBackendFactory,
  datasetFetch = globalThis.fetch,
  pipelineLaunch,
  mediaRoot = join(runtimeDir, 'media'),
} = {}) {
  if (!token || token.length < 16) throw new Error('createApp requires a token of at least 16 characters');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  const mediaTickets = createMediaTickets();
  const rendersDir = join(runtimeDir, 'renders');
  const qa = createQaRegistry();
  mkdirSync(rendersDir, { recursive: true });
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const takeStore = createTakeStore({ runtimeDir, packageDir: store.dir });
  const projectChat = createProjectChat({ runtimeDir, store, providerSettings, prepareBrand });
  const events = new EventLog();
  const publishEntry = events.publish.bind(events);
  const pipelineIngested = new Set();
  const runPackages = new Map();
  // TR09: pipelines finish in the worker, so the server consumes the run directory
  // afterwards (never editing the worker). A terminal media run schedules one queued
  // regenerate; both hooks run after the completed/finished event has been published.
  events.publish = (event) => {
    const entry = publishEntry(event);
    try {
      if (event?.type === 'pipeline.event' && event.kind === 'stage'
        && event.stageId === 'media' && event.status === 'completed') {
        ingestPipelineRun(event.runId);
      } else if (event?.type === 'pipeline.event' && event.kind === 'completed') {
        ingestPipelineRun(event.runId);
        scheduleQueuedDrain(event.runId);
      } else if (event?.type === 'run.finished' || event?.type === 'run.failed') {
        scheduleQueuedDrain(event.runId);
      }
    } catch (error) {
      try { publishEntry({ type: 'takes.ingest.failed', message: error.message }); } catch { /* best effort */ }
    }
    return entry;
  };

  // C9: stage where H8's runPackage resolves relative paths: the package JSON, the repo's
  // workflow graphs, and any assets the package already has on disk.
  async function prepareRunWorkDir(pkg, workDir) {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg, null, 2));
    const workflowsLink = join(workDir, 'workflows');
    if (!existsSync(workflowsLink)) {
      const source = join(repoRoot, 'workflows');
      try {
        symlinkSync(source, workflowsLink, 'dir');
      } catch {
        cpSync(source, workflowsLink, { recursive: true });
      }
    }
    const assets = join(dirname(store.path(pkg.id)), 'assets');
    if (existsSync(assets)) cpSync(assets, join(workDir, 'assets'), { recursive: true });
  }

  // C9: after collect, write the applied package back next to its collected plates, then render
  // the accepted revision to an MP4 the run panel can offer. The applied compliance tag comes from
  // H8's `runPackage`/`backend.appliedBackendId` (H-fix7), so no server-side normaliser is needed.
  async function completeRun({ pkg, result, record }) {
    if (pkg?.id && record?.runId) runPackages.set(record.runId, pkg.id);
    if (!result?.package) return { revision: null, render: null };
    const id = pkg.id;
    const packageDir = dirname(store.path(id));
    const collectedAssets = join(record.outputDir, 'assets');
    if (record.mode === 'take') {
      // TR07: snapshot the run's outputs as takes *before* the collected assets are copied over
      // the package's own files. The take store keeps the bytes, so a later overwrite cannot
      // destroy the take that produced it.
      const ingested = ingestRun({
        pkg,
        manifest: result.manifest,
        jobsDoc: result.jobsDoc,
        outputDir: record.outputDir,
        store: takeStore,
        corrections: record.corrections ?? {},
        runId: record.runId,
        backend: record.backendId,
      });
      if (existsSync(collectedAssets)) cpSync(collectedAssets, join(packageDir, 'assets'), { recursive: true });
      const copied = copyNamedAssets({ pkg: result.package, outputDir: record.outputDir, packageDir });
      if (copied.length) {
        events.publish({ type: 'run.log', runId: record.runId, line: `collected ${copied.length} package file(s): ${copied.join(', ')}` });
      }
      // ingestRun has already written the new takes (including lastJob), so read the fresh doc
      // before applying the auto-selected takes to the package.
      const takeDoc = takeStore.read(id) ?? { schema: TAKES_SCHEMA, packageId: id, clips: {}, overrides: [] };
      let next = result.package;
      for (const [assetId, takeId] of Object.entries(ingested.selected)) {
        next = selectTake(next, takeDoc, assetId, takeId);
      }
      takeStore.write(id, takeDoc);
      const current = store.read(id);
      const saved = current ? store.save(id, next, pkg.revision) : store.write(next);
      events.publish({ type: 'package.updated', packageId: id, revision: saved.revision });
      const landed = new Map();
      for (const take of ingested.takes) landed.set(take.assetId, take);
      for (const [assetId, take] of landed) {
        events.publish({
          type: 'clip.take.landed',
          packageId: id,
          assetId,
          takeId: take.takeId,
          selected: ingested.selected[assetId] ?? null,
          runId: record.runId,
        });
      }
      return { revision: saved.revision, render: null };
    }
    if (existsSync(collectedAssets)) cpSync(collectedAssets, join(packageDir, 'assets'), { recursive: true });
    // G5-10: the applied package can also name files outside `assets/` (the runner's
    // non-upscaled plates live at `out/intermediates/<id>.plate.mp4`), so copy every path it
    // names — otherwise the renderer falls back to placeholders.
    const copied = copyNamedAssets({ pkg: result.package, outputDir: record.outputDir, packageDir });
    if (copied.length) {
      events.publish({ type: 'run.log', runId: record.runId, line: `collected ${copied.length} package file(s): ${copied.join(', ')}` });
    }
    const current = store.read(id);
    const saved = current ? store.save(id, result.package, pkg.revision) : store.write(result.package);
    events.publish({ type: 'package.updated', packageId: id, revision: saved.revision });
    // A partial run keeps its finished plates (H8 already applied them), but there is nothing
    // honest to render when the manifest says the run did not complete.
    if (result.ok === false || result.manifest?.complete === false) return { revision: saved.revision, render: null };
    const output = join(rendersDir, `${record.runId}.mp4`);
    const rendered = await render(store.path(id), output, { onLog: line => events.publish({ type: 'run.log', runId: record.runId, line }) });
    events.publish({
      type: 'run.rendered',
      runId: record.runId,
      packageId: id,
      revision: saved.revision,
      bytes: rendered.bytes,
      frames: rendered.frames,
      timeline_sha256: rendered.hash,
    });
    return {
      revision: saved.revision,
      render: { bytes: rendered.bytes, frames: rendered.frames, timeline_sha256: rendered.hash, url: `/api/run/${record.runId}/video` },
    };
  }

  const runs = createRunController({ backendFactory, events, runtimeDir, prepareWorkDir: prepareRunWorkDir, onComplete: completeRun, isBusy: () => Boolean(pipelines?.active()) });
  // A9: the export bundle is the final render — 1920×1080 and, when the package carries x2
  // upscaled variants (H12), the variant files. The Player preview and /api/render keep the
  // package's working resolution.
  const exportRender = (packagePath, outputPath, opts = {}) => render(packagePath, outputPath, { ...opts, final: true });
  const exporter = createExporter({ exportsDir, render: exportRender });
  // RL06: one shared slot (RL05's coordinator) for export, full render and the two scene
  // render routes. The lease is taken before the request body is read, so a second request
  // is refused as busy instead of starting a second job on the same CPU/GPU budget.
  const operations = createOperationCoordinator();

  /**
   * Take the shared slot for one request. The lease is released on every exit: an explicit
   * release on the error paths, the response's finish/close events (a finished download or a
   * client that went away) and the route's finally block.
   */
  function holdOperation(kind, id, response) {
    const lease = operations.tryAcquire(kind, id);
    if (lease.busy) return { busy: true, holder: lease.holder };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lease.release();
    };
    response.once('finish', release);
    response.once('close', release);
    return { busy: false, holder: null, release };
  }

  const pipelines = createPipelineController({ runtimeDir, events, stageInputs: stagePipelineInputs, ...(pipelineLaunch ? { launch: pipelineLaunch } : {}), isBusy: () => Boolean(runs.status().activeRunId || operations.status().busy) });

  function takeDocFor(pkgId) {
    try {
      return takeStore.read(pkgId);
    } catch {
      return null;
    }
  }

  function gateClips(pkg) {
    const measured = measuredOptionsFromDir(dirname(store.path(pkg.id)));
    return listClips(pkg, measured).filter((clip) => {
      const asset = pkg.assets?.[clip.assetId];
      if (asset?.kind === 'svg' || asset?.kind === 'vector-anim') return false;
      return !(typeof asset?.file === 'string' && extname(asset.file).toLowerCase() === '.svg');
    });
  }

  function appendOverride(pkg, reason) {
    const doc = takeDocFor(pkg.id) ?? { schema: TAKES_SCHEMA, packageId: pkg.id, clips: {}, overrides: [] };
    if (!Array.isArray(doc.overrides)) doc.overrides = [];
    doc.overrides.push({
      at: new Date().toISOString(),
      reason,
      revision: Number.isSafeInteger(pkg.revision) && pkg.revision >= 0 ? pkg.revision : 0,
    });
    takeStore.write(pkg.id, doc);
    return doc;
  }

  // Returns null when the render may proceed, or {status, body} when it must not.
  function renderGate(pkg, body, pathname) {
    const gate = finalGate(pkg, takeDocFor(pkg.id), gateClips(pkg));
    if (gate.ok) return null;

    const override = body?.override;
    const reason = override && typeof override === 'object' && !Array.isArray(override) ? override.reason : undefined;
    const validReason = typeof reason === 'string' && reason.length >= 4 && reason.length <= 500 && reason.trim().length >= 4;

    if (!validReason) {
      events.publish({
        type: 'render.gate.blocked',
        packageId: pkg.id,
        path: pathname,
        approved: gate.approved,
        total: gate.total,
        blocking: gate.blocking,
      });
      if (override !== undefined) {
        return {
          status: 400,
          body: { error: 'override.reason must be a string of 4 to 500 characters', code: 'INVALID_OVERRIDE', gate },
        };
      }
      return {
        status: 409,
        body: {
          error: `${gate.blocking.length} of ${gate.total} clip(s) still need approval`,
          code: 'RENDER_GATE_BLOCKED',
          approved: gate.approved,
          total: gate.total,
          blocking: gate.blocking,
          gate,
        },
      };
    }

    appendOverride(pkg, reason);
    events.publish({
      type: 'render.gate.override',
      packageId: pkg.id,
      path: pathname,
      approved: gate.approved,
      total: gate.total,
      blocking: gate.blocking,
      reason,
    });
    return null;
  }

  function pathInside(root, target) {
    const base = resolve(root);
    const full = resolve(target);
    if (full === base) return true;
    return full.startsWith(`${base}${sep}`);
  }

  function readJsonFile(file) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  // A runner always leaves media-out/manifest.json. When an older/fake worker did not,
  // derive the same answer by reading the collected files and matching package assets.
  function manifestFromFiles(pkg, outDir, jobsDoc) {
    const jobs = new Map((Array.isArray(jobsDoc?.jobs) ? jobsDoc.jobs : [])
      .filter(job => job && typeof job.id === 'string')
      .map(job => [job.id, job]));
    const entries = [];
    for (const [assetId, asset] of Object.entries(pkg.assets ?? {})) {
      if (!asset || typeof asset.gen?.generator !== 'string' || !asset.gen.generator.trim()) continue;
      const candidates = [];
      if (typeof asset.file === 'string' && asset.file) candidates.push(asset.file);
      for (const ext of ['mp4', 'webm', 'png', 'jpg', 'webp']) candidates.push(`assets/${assetId}.${ext}`);
      const relative = candidates.find(candidate => {
        const file = resolve(outDir, candidate);
        if (!pathInside(outDir, file)) return false;
        try { return statSync(file).isFile(); } catch { return false; }
      });
      if (!relative) continue;
      const job = [...jobs.values()].find(candidate => candidate.asset === assetId);
      const jobId = job?.id ?? `${assetId}.${asset.kind === 'image' ? 'still' : 'plate'}`;
      const bytes = statSync(resolve(outDir, relative)).size;
      entries.push({ job: jobId, status: 'succeeded', outputs: [{ relative, bytes }] });
    }
    return entries.length ? { v: 1, complete: true, updatedAt: new Date().toISOString(), jobs: entries } : null;
  }

  function ingestPipelineRun(runId) {
    if (typeof runId !== 'string' || pipelineIngested.has(runId)) return;
    const record = pipelines.get(runId);
    if (!record) return;
    const directory = pipelines.directory(runId);
    if (!directory) return;
    const outDir = join(directory, 'media-out');
    if (!existsSync(outDir) || !statSync(outDir).isDirectory()) return;

    const workDir = join(directory, 'work');
    let pkg = readJsonFile(join(workDir, 'package.json'));
    if (!pkg?.id) {
      try { pkg = store.read(record.packageId); } catch { pkg = null; }
    }
    if (!pkg?.id) return;
    const jobsDoc = readJsonFile(join(workDir, 'jobs.json'));
    let manifest = readJsonFile(join(outDir, 'manifest.json'));
    if (!manifest || !Array.isArray(manifest.jobs) || manifest.jobs.length === 0) {
      manifest = manifestFromFiles(pkg, outDir, jobsDoc);
    }
    if (!manifest) return;

    const ingested = ingestRun({ pkg, manifest, jobsDoc, outputDir: outDir, store: takeStore, runId });
    pipelineIngested.add(runId);
    for (const take of ingested.takes) {
      events.publish({
        type: 'clip.take.landed',
        packageId: pkg.id,
        assetId: take.assetId,
        takeId: take.takeId,
        selected: ingested.selected[take.assetId] ?? null,
        runId,
      });
    }
  }

  function takeDocIds(preferred = null) {
    const ids = [];
    if (typeof preferred === 'string' && preferred) ids.push(preferred);
    try {
      for (const name of readdirSync(join(runtimeDir, 'takes'))) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!ids.includes(id)) ids.push(id);
      }
    } catch {
      // no takes sidecar directory yet
    }
    return ids;
  }

  function findQueued(preferred = null) {
    for (const packageId of takeDocIds(preferred)) {
      const doc = takeDocFor(packageId);
      if (!doc || !doc.clips || typeof doc.clips !== 'object') continue;
      for (const [assetId, entry] of Object.entries(doc.clips)) {
        if (!entry || typeof entry !== 'object' || !entry.queued || typeof entry.queued !== 'object') continue;
        return { packageId, assetId, entry, doc };
      }
    }
    return null;
  }

  function correctionChange(correction) {
    const change = {};
    for (const key of ['note', 'by', 'promptAppend', 'promptReplace', 'negativeAppend', 'seed', 'inputs']) {
      if (correction?.[key] !== undefined) change[key] = correction[key];
    }
    return change;
  }

  async function drainOneQueued(runId) {
    const found = findQueued(runPackages.get(runId) ?? null);
    if (!found) return false;
    let pkg;
    try { pkg = store.read(found.packageId); } catch { pkg = null; }
    if (!pkg) return false;

    const active = Array.isArray(found.entry.takes) ? found.entry.takes.filter(take => take && take.purged !== true).length : 0;
    let built;
    try {
      built = buildCorrection(pkg, found.assetId, correctionChange(found.entry.queued.correction), { takesCount: active });
    } catch {
      return false;
    }

    const queue = found.entry.queued;
    const planHash = typeof queue.planHash === 'string' ? queue.planHash : null;
    const approvals = runs.status().approvals ?? [];
    let result;
    try {
      result = await runs.start({
        backendId: typeof queue.backendId === 'string' && queue.backendId ? queue.backendId : 'colab',
        pkg: built.package,
        assets: [found.assetId],
        includeReady: true,
        mode: 'take',
        corrections: { [found.assetId]: built.correction },
        approved: Boolean(planHash && approvals.includes(planHash)),
        budgetUnits: queue.budgetUnits,
      });
    } catch (error) {
      if (/run busy|busy/i.test(error?.message ?? '')) return false;
      throw error;
    }
    if (result?.error === 'run busy' || result?.status === 409) return false;
    // Approval is still the user's decision: leave the request queued for a later approval.
    if (result?.approvalRequired || result?.refused) return true;
    if (!result?.runId) return false;

    const latest = takeDocFor(found.packageId);
    const entry = latest?.clips?.[found.assetId];
    if (entry) {
      delete entry.queued;
      entry.lastJob = { runId: result.runId, state: result.status ?? 'starting' };
      takeStore.write(found.packageId, latest);
    }
    const clip = gateClips(pkg).find(candidate => candidate.assetId === found.assetId);
    events.publish({
      type: 'clip.job',
      packageId: found.packageId,
      ...(clip ? { clipId: clip.clipId } : {}),
      assetId: found.assetId,
      runId: result.runId,
      state: result.status ?? 'starting',
      progress: 0,
    });
    return true;
  }

  function scheduleQueuedDrain(runId) {
    setImmediate(() => {
      (async () => {
        try {
          if (runs.status().activeRunId) return;
          if (!findQueued(runPackages.get(runId) ?? null)) return;
          await drainOneQueued(runId);
        } catch {
          // A queued regenerate is best effort; the run that just ended is unaffected.
        } finally {
          runPackages.delete(runId);
        }
      })();
    });
  }

  const takeRoutes = createTakeRoutes({
    store,
    takeStore,
    runs,
    events,
    mediaTickets,
    measuredFor: pkg => measuredOptionsFromDir(dirname(store.path(pkg.id))),
  });
  // C13: the last successfully rendered timeline per package, so an edit can be diffed
  // against what the frame grid actually was. In-memory: a server restart just makes the
  // next edit a first render (the A6 cache still reuses unchanged segments).
  const lastRendered = new Map();

  const sceneCacheDir = (packageId) => join(runtimeDir, 'scene-cache', packageId);

  /**
   * Resolve a render target the same way for every render route: an in-memory draft is written to
   * a throwaway file (C1 compatibility, never mutating the stored package); otherwise the stored
   * package is read and the base revision is checked.
   */
  function draftRenderTarget(pkg, suffix, response) {
    let existing;
    try {
      if (typeof pkg.id !== 'string') throw new Error('invalid package id');
      existing = store.read(pkg.id); // path() validates the ID before any filesystem lookup.
    } catch (error) {
      error.status = 400;
      throw error;
    }
    const sourceDir = existing ? dirname(store.path(pkg.id)) : rendersDir;
    const packagePath = join(sourceDir, `.draft-${suffix}-${randomUUID()}.package.json`);
    writeFileSync(packagePath, JSON.stringify(pkg, null, 2), { flag: 'wx', mode: 0o600 });
    const cleanup = () => rmSync(packagePath, { force: true });
    response.once('finish', cleanup);
    response.once('close', cleanup);
    return { pkg, packagePath, revision: Number.isFinite(pkg.revision) ? pkg.revision : null };
  }

  function resolveRenderTarget(body, suffix, response) {
    if (body.package && typeof body.package === 'object') {
      return draftRenderTarget(body.package, suffix, response);
    }
    const id = body.packageId;
    if (!id) {
      const error = new Error('packageId or package required');
      error.status = 400;
      throw error;
    }
    const pkg = store.read(id);
    if (!pkg) {
      const error = new Error('package not found');
      error.status = 404;
      throw error;
    }
    if (body.baseRevision != null && Number(body.baseRevision) !== pkg.revision) {
      const error = new Error('conflict');
      error.status = 409;
      error.currentRevision = pkg.revision;
      throw error;
    }
    return { pkg, packagePath: store.path(id), revision: pkg.revision };
  }

  async function readJson(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) {
        const error = new Error('request body too large');
        error.status = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      const error = new Error('invalid JSON body');
      error.status = 400;
      throw error;
    }
  }

  function auth(request, url) {
    const host = request.headers.host;
    if (!hostAllowed(host)) return { error: 'host not allowed', status: 403 };
    if (!sameOrigin(request.headers.origin, host) && request.method !== 'GET' && request.method !== 'HEAD') {
      return { error: 'origin not allowed', status: 403 };
    }
    const supplied = request.headers['x-comfyrizz-token'] ?? bearer(request) ?? url.searchParams.get('token');
    if (!safeTokenEqual(supplied, token)) return { error: 'unauthorized', status: 401 };
    return null;
  }

  function serveStatic(request, response, url) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(response, 400, { error: 'bad path' });
    }
    if (pathname === '/') pathname = '/index.html';
    const file = resolve(webDist, `.${pathname}`);
    if (file !== webDist && !file.startsWith(webDist + sep)) return sendJson(response, 403, { error: 'forbidden' });
    const exists = existsSync(file) && statSync(file).isFile();
    if (!exists) {
      if (extname(pathname)) return sendJson(response, 404, { error: 'not found' });
      // SPA fallback.
      const index = join(webDist, 'index.html');
      if (!existsSync(index)) return sendJson(response, 503, { error: 'web build missing; run npm run build in apps/web' });
      response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      createReadStream(index).pipe(response);
      return;
    }
    const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
    if (pathname.startsWith('/assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
    return serveStaticFile(request, response, file, headers);
  }

  async function handler(request, response) {
    const host = request.headers.host ?? '127.0.0.1';
    if (!hostAllowed(host)) return sendJson(response, 403, { error: 'host not allowed' });
    const url = new URL(request.url ?? '/', `http://${host}`);

    if (url.pathname === '/api/health') {
      return sendJson(response, 200, { ok: true, service: 'comfyrizz-local' });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method not allowed' });
      return serveStatic(request, response, url);
    }

    // Ticket URLs are the credential for native media elements, which cannot send
    // the API header. The ticket is not the API token and is not written to exports.
    const mediaGet = /^\/api\/media\/([a-f0-9]{32})$/.exec(url.pathname);
    if (mediaGet && (request.method === 'GET' || request.method === 'HEAD')) {
      const file = mediaTickets.resolve(mediaGet[1]);
      if (!file) return sendJson(response, 401, { error: 'media ticket expired' });
      return serveTicket(request, response, file);
    }

    const denied = auth(request, url);
    if (denied) return sendJson(response, denied.status, { error: denied.error });

    if (url.pathname === '/api/media-ticket' && request.method === 'POST') {
      const body = await readJson(request);
      const file = safeMediaPath(mediaRoot, body?.path);
      if (!file) return sendJson(response, 400, { error: 'bad path' });
      if (!existsSync(file)) return sendJson(response, 404, { error: 'media not found' });
      const minted = mediaTickets.mint(file);
      return sendJson(response, 200, { ticket: minted.ticket, expiresAt: minted.expiresAt, url: minted.url });
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      const lastEventId = request.headers['last-event-id'] ?? url.searchParams.get('lastEventId');
      events.subscribe(request, response, lastEventId);
      return;
    }

    if (url.pathname === '/api/voice-options' && request.method === 'GET') {
      return sendJson(response, 200, {
        version: 1, presets: VOICE_PRESETS, kokoroVoices: KOKORO_VOICES, qwenSpeakers: QWEN_SPEAKERS,
        capabilities: {
          kokoro: { runtime: 'local', controls: ['voice', 'speed', 'blend', 'chunking', 'language'] },
          qwenDesign: { runtime: 'local-or-colab', controls: ['persona', 'delivery', 'reference_text', 'non_streaming', 'language'], perSceneDelivery: false },
          qwenCustom: { runtime: 'local-or-colab', controls: ['voice', 'delivery', 'non_streaming', 'language'], perSceneDelivery: true },
        },
      });
    }

    if (url.pathname === '/api/animation-options' && request.method === 'GET') {
      return sendJson(response, 200, animationOptions());
    }

    // Full-production API. Existing /api/run remains the media-only API.
    if (['/api/pipeline/plan', '/api/pipeline'].includes(url.pathname) && request.method === 'POST') {
      const body = await readJson(request);
      const pkg = body.packageId ? store.read(body.packageId) : null;
      if (!pkg) return sendJson(response, 404, { error: 'package not found' });
      if (body.baseRevision !== pkg.revision) return sendJson(response, 409, { error: 'revision conflict', currentRevision: pkg.revision });
      if (!url.pathname.endsWith('/plan')) {
        const gate = renderGate(pkg, body, url.pathname);
        if (gate) return sendJson(response, gate.status, gate.body);
      }
      try {
        if (url.pathname.endsWith('/plan')) return sendJson(response, 200, pipelines.plan(pkg, body));
        const result = await pipelines.start(pkg, body, dirname(store.path(pkg.id)));
        return sendJson(response, result.status, result);
      } catch (error) { return sendJson(response, 400, { error: error.message }); }
    }
    if (url.pathname === '/api/pipeline' && request.method === 'GET') return sendJson(response, 200, { runs: pipelines.list() });
    const pipelineMatch = /^\/api\/pipeline\/(pipe_[a-f0-9]{32})(?:\/(cancel|reconcile|events|package|verification|files\/[^/]+|assets\/[A-Za-z0-9_-]+))?$/.exec(url.pathname);
    if (pipelineMatch) {
      const [, runId, resource] = pipelineMatch;
      const record = pipelines.get(runId), directory = pipelines.directory(runId);
      if (!record) return sendJson(response, 404, { error: 'pipeline not found' });
      if (resource === 'cancel' && request.method === 'POST') return sendJson(response, 202, { run: pipelines.cancel(runId) });
      if (resource === 'reconcile' && request.method === 'POST') {
        const result = pipelines.reconcile(runId); return sendJson(response, result.status, result);
      }
      if (!['GET', 'HEAD'].includes(request.method)) return sendJson(response, 405, { error: 'method not allowed' });
      if (!resource) return sendJson(response, 200, { run: record });
      if (resource === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) return sendJson(response, 400, { error: 'after must be a non-negative sequence number' });
        const entries = pipelines.replay(runId, after);
        const nextSequence = entries.at(-1)?.sequence ?? after;
        return sendJson(response, 200, { events: entries, nextSequence, hasMore: nextSequence < record.sequence });
      }
      if (resource === 'package' || resource === 'verification') {
        if (record.status !== 'completed') return sendJson(response, 409, { error: 'pipeline has not completed' });
        const file = resource === 'package' ? join(directory, 'work', 'package.json') : join(directory, 'verification.json');
        return sendJson(response, 200, JSON.parse(readFileSync(file)));
      }
      if (resource?.startsWith('assets/')) {
        const id = resource.slice(7);
        if (!record.artifacts?.some(asset => asset.assetId === id)) return sendJson(response, 404, { error: 'asset has not been collected' });
        const root = join(directory, 'work');
        const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
        const asset = pkg.assets[id];
        const file = asset?.file ? resolve(root, asset.file) : null;
        if (!file || !file.startsWith(root + sep) || !existsSync(file) || !realpathSync(file).startsWith(realpathSync(root) + sep)) return sendJson(response, 404, { error: 'asset not available' });
        return serveStaticFile(request, response, file, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      }
      if (resource?.startsWith('files/')) {
        const name = resource.slice(6);
        const file = record.result?.files?.find(item => item.name === name);
        if (record.status !== 'completed' || !file) return sendJson(response, 404, { error: 'artifact not available' });
        const exportRoot = resolve(directory, 'exports', record.packageId);
        const target = safeMediaPath(exportRoot, name);
        try {
          // Membership in the result manifest is not permission to follow a
          // replaced artifact (or export directory) outside its pipeline run.
          const realRoot = realpathSync(exportRoot);
          if (!target || !realRoot.startsWith(realpathSync(directory) + sep)
            || !realpathSync(target).startsWith(realRoot + sep) || !statSync(target).isFile()) {
            return sendJson(response, 404, { error: 'artifact not available' });
          }
        } catch {
          return sendJson(response, 404, { error: 'artifact not available' });
        }
        return serveStaticFile(request, response, target, { 'content-type': MIME[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      }
      return sendJson(response, 404, { error: 'not found' });
    }

    // Which live providers have a server-side key. Booleans only: the browser
    // never receives a key and never needs one (U1).
    if (url.pathname === '/api/providers' && request.method === 'GET') {
      const configured = providerSettings
        ? Object.fromEntries(providerSettings.snapshot().profiles.map(item => [item.id, item.configured]))
        : providers;
      return sendJson(response, 200, { providers: configured });
    }

    if (providerSettings && await handleProviderSettings({ request, response, url, settings: providerSettings, readJson, sendJson })) return;

    const chatMatch = /^\/api\/agent\/chat(?:\/([^/]+))?$/.exec(url.pathname);
    if (chatMatch) {
      try {
        if (request.method === 'GET' && chatMatch[1]) return sendJson(response, 200, projectChat.get(chatMatch[1]));
        if (request.method === 'POST' && !chatMatch[1]) return sendJson(response, 200, await projectChat.send(await readJson(request)));
        return sendJson(response, 405, { error: 'method not allowed' });
      } catch (error) {
        return sendJson(response, error.status ?? 502, { error: providerSettings ? providerSettings.redact(error.message) : error.message });
      }
    }

    // U2: the settings card's read-only view of the Google Colab CLI - installed or not, signed in or
    // not, and the units a run will be measured against. Read-only on purpose: the sign-in itself is a
    // separate route that streams the CLI's own prompt, and the token never passes through here.
    if (url.pathname === '/api/colab/status' && request.method === 'GET') {
      const status = await colabStatus({ backendFactory });
      return sendJson(response, 200, status);
    }

    // Live gauges of Google Colab runs (tqdm, ComfyUI sampler/node progress, render frames), read from
    // the per-run JSONL files the backend writes as the VM's colab_progress lines arrive.
    if (url.pathname === '/api/colab/progress' && request.method === 'GET') {
      return sendJson(response, 200, readColabProgress(colabProgressDir ? { dir: colabProgressDir } : {}));
    }

    // U2: the guided sign-in. `colab auth` prints a URL and waits; every line it prints is relayed to
    // the card as it arrives (redacted) and the response carries the outcome. The token stays with the
    // CLI: nothing here reads, parses or stores a credential.
    if (url.pathname === '/api/colab/auth' && request.method === 'POST') {
      const outcome = await startColabAuth({
        onLine: (line) => {
          // the run panel's own event stream, when it is there: the card renders live lines if it is
          // watching, and the response below carries them all either way
          try {
            events?.emit?.('colab_auth', { line });
          } catch {
            /* an emitter that is not there yet is not a reason to lose the sign-in */
          }
        },
      });
      return sendJson(response, outcome.ok ? 200 : 502, {
        ok: outcome.ok,
        lines: outcome.lines,
        reason: outcome.reason,
        install: outcome.install === true,
      });
    }

    // W1: download the API-format workflow saved next to a generated still or plate.
    // UI format is not offered: converting it is not reliable (see OPEN-IN-COMFYUI.md).
    const workflowMatch = /^\/api\/package\/([^/]+)\/assets\/([^/]+)\/workflow$/.exec(url.pathname);
    if (workflowMatch) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method not allowed' });
      let packageId;
      let assetId;
      try {
        packageId = decodeURIComponent(workflowMatch[1]);
        assetId = decodeURIComponent(workflowMatch[2]);
      } catch {
        return sendJson(response, 400, { error: 'bad path' });
      }
      let pkg;
      try {
        pkg = store.read(packageId);
      } catch (error) {
        if (error.message === 'invalid package id') return sendJson(response, 400, { error: error.message });
        throw error;
      }
      if (!pkg) return sendJson(response, 404, { error: 'package not found' });
      const loaded = loadAssetWorkflow({
        packageDir: dirname(store.path(packageId)),
        pkg,
        assetId,
        format: url.searchParams.get('format') || 'api',
        variant: url.searchParams.get('variant'),
      });
      if (loaded.status !== 200) return sendJson(response, loaded.status, { error: loaded.error, ...(loaded.reason ? { reason: loaded.reason } : {}) });
      const headers = {
        'content-type': loaded.contentType,
        'content-disposition': `attachment; filename="${loaded.filename}"`,
        'x-comfyrizz-workflow-format': loaded.format,
        // The canvas Load button needs UI format. We ship the API graph instead.
        'x-comfyrizz-ui-format': 'unavailable',
      };
      if (request.method === 'HEAD') {
        response.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(loaded.body), 'cache-control': 'no-store' });
        return response.end();
      }
      return sendBytes(response, 200, loaded.body, headers);
    }

    if (await handleCompile({ request, response, url, readJson, sendJson, store })) return;
    if (handleMedia({ request, response, url, sendJson, runtimeDir, store })) return;

    const packageMatch = /^\/api\/package\/([^/]+)$/.exec(url.pathname);
    if (packageMatch) {
      const id = packageMatch[1];
      if (request.method === 'GET') {
        const pkg = store.read(id);
        if (!pkg) return sendJson(response, 404, { error: 'package not found' });
        let editor = null;
        try { editor = readEditor(runtimeDir, id); } catch { editor = null; }
        return sendJson(response, 200, editor ? { package: pkg, revision: pkg.revision, editor } : { package: pkg, revision: pkg.revision });
      }
      if (request.method === 'PATCH') {
        const body = await readJson(request);
        if (!body.package || typeof body.package !== 'object') return sendJson(response, 400, { error: 'package required' });
        const parsed = validateEditor(body.editor);
        if (parsed.error) return sendJson(response, 400, { error: parsed.error });
        try {
          const saved = store.save(id, body.package, body.baseRevision);
          if (parsed.editor) writeEditor(runtimeDir, id, parsed.editor);
          events.publish({ type: 'package.updated', packageId: id, revision: saved.revision });
          const editor = parsed.editor ?? readEditor(runtimeDir, id);
          const ack = Number.isInteger(body.editSequence) ? { editSequence: body.editSequence } : {};
          return sendJson(response, 200, { package: saved, revision: saved.revision, ...ack, ...(editor ? { editor } : {}) });
        } catch (error) {
          if (error instanceof ConflictError) {
            return sendJson(response, 409, { error: 'conflict', currentRevision: error.currentRevision });
          }
          if (error instanceof InvalidPackageError) {
            return sendJson(response, 422, { error: 'invalid package', details: error.errors });
          }
          if (error.message === 'invalid package id') return sendJson(response, 400, { error: error.message });
          throw error;
        }
      }
      return sendJson(response, 405, { error: 'method not allowed' });
    }

    if (url.pathname === '/api/brief' && request.method === 'POST') {
      const body = await readJson(request);
      if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
        return sendJson(response, 400, { error: 'prompt is required' });
      }
      try {
        // B1: a brand kit on the request overrides the brief's palette/font; the
        // logo bytes are written here so the asset exists before any agent run.
        const brand = body.brand ? prepareBrand(body.brand, { assetsDir: join(runtimeDir, 'packages', 'assets') }) : null;
        const result = planBrief({ ...body, brand: brand?.kit ?? null });
        events.publish({ type: 'brief.planned', mode: result.mode, complete: result.complete, questions: result.questions.map(question => question.id) });
        return sendJson(response, 200, { ...result, brand: brand ? { theme: brand.theme, assets: Object.keys(brand.assets), warnings: brand.warnings } : null });
      } catch (error) {
        return sendJson(response, error.status ?? 400, {
          error: error.message,
          ...(Array.isArray(error.issues) ? { issues: error.issues } : {}),
        });
      }
    }

    if (url.pathname === '/api/brief/presets' && request.method === 'GET') {
      return sendJson(response, 200, briefPresets());
    }

    if (url.pathname === '/api/dataset' && request.method === 'POST') {
      const body = await readJson(request);
      try {
        const result = await buildDataset(body, { fetchImpl: datasetFetch });
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, error.status ?? 400, { error: error.message });
      }
    }

    if (url.pathname === '/api/brand' && request.method === 'POST') {
      const body = await readJson(request);
      const prepared = prepareBrand(body.brand ?? body, { assetsDir: join(runtimeDir, 'packages', 'assets') });
      events.publish({ type: 'brand.prepared', palette: prepared.kit.palette.length, fonts: prepared.kit.fonts.length, logo: Boolean(prepared.kit.logo_asset) });
      return sendJson(response, 200, { kit: prepared.kit, theme: prepared.theme, assets: prepared.assets, warnings: prepared.warnings });
    }

    if (url.pathname === '/api/brief/outline' && request.method === 'POST') {
      const body = await readJson(request);
      try {
        const brand = body.brand ? prepareBrand(body.brand, { assetsDir: join(runtimeDir, 'packages', 'assets') }) : null;
        const result = refreshBrief({ ...body, brand: brand?.kit ?? null });
        events.publish({ type: 'brief.outline', beats: result.outline.beats.length, seconds: result.outline.estimatedSeconds });
        return sendJson(response, 200, { ...result, brand: brand ? { theme: brand.theme, assets: Object.keys(brand.assets), warnings: brand.warnings } : null });
      } catch (error) {
        return sendJson(response, error.status ?? 400, {
          error: error.message,
          ...(Array.isArray(error.issues) ? { issues: error.issues } : {}),
        });
      }
    }

    if (url.pathname === '/api/agent' && request.method === 'POST') {
      if (!agentRunner) return sendJson(response, 503, { error: 'agent runner not configured' });
      const body = await readJson(request);
      events.publish({ type: 'agent.started', brief: typeof body.brief === 'string' ? body.brief.slice(0, 160) : null });
      try {
        const brand = body.brand ? prepareBrand(body.brand, { assetsDir: join(runtimeDir, 'packages', 'assets') }) : null;
        const result = await agentRunner({
          brief: body.brief,
          ...(brand ? { brand } : {}),
          provider: body.provider,
          model: body.model,
          sessionId: body.sessionId,
          runtimeDir,
          onEvent: event => events.publish({ type: 'agent.event', event }),
        });
        const saved = store.write(result.package);
        const timeline = compilePackage(saved, dirname(store.path(saved.id)));
        events.publish({ type: 'agent.finished', packageId: saved.id, revision: saved.revision, svgAssets: result.svgAssets?.length ?? 0, live: Boolean(result.live) });
        return sendJson(response, 200, {
          package: saved,
          revision: saved.revision,
          timeline,
          generatedAssets: result.generatedAssets ?? {},
          routes: result.routes ?? [],
          pendingGpu: result.pendingGpu ?? [],
          svgAssets: result.svgAssets ?? [],
          live: Boolean(result.live),
          fallback: Boolean(result.fallback),
          provider: result.provider ?? null,
          model: result.model ?? null,
        });
      } catch (error) {
        events.publish({ type: 'agent.failed', message: error.message });
        return sendJson(response, error.status ?? 500, {
          error: error.message,
          ...(Array.isArray(error.errors) ? { details: error.errors } : {}),
        });
      }
    }

    if (url.pathname === '/api/run' && request.method === 'POST') {
      if (pipelines.active()) return sendJson(response, 409, { error: 'pipeline busy' });
      const body = await readJson(request);
      try {
        let pkg = null;
        if (body.package && typeof body.package === 'object') pkg = body.package;
        else if (body.packageId) {
          pkg = store.read(body.packageId);
          if (!pkg) return sendJson(response, 404, { error: 'package not found' });
        } else {
          return sendJson(response, 400, { error: 'packageId or package required' });
        }
        const result = await runs.start({
          backendId: body.backendId ?? 'colab',
          pkg,
          budgetUnits: body.budgetUnits,
          approved: body.approved === true,
          comfyuiUrl: body.comfyuiUrl,
          ratePerHour: body.ratePerHour,
          teardownMode: body.teardownMode,
          includeReady: body.includeReady === true,
          assets: body.assets,
          mode: body.mode,
          corrections: body.corrections,
        });
        return sendJson(response, result.status === 409 ? 409 : 200, result);
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }

    if (url.pathname === '/api/run' && request.method === 'GET') {
      return sendJson(response, 200, runs.status());
    }

    if (url.pathname === '/api/run/approve' && request.method === 'POST') {
      const body = await readJson(request);
      try {
        return sendJson(response, 200, runs.approve(body.planHash));
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }

    const runMatch = /^\/api\/run\/([^/]+)$/.exec(url.pathname);
    if (runMatch && request.method === 'GET') {
      const record = runs.get(runMatch[1]);
      if (!record) return sendJson(response, 404, { error: 'run not found' });
      return sendJson(response, 200, { run: record });
    }

    const runVideoMatch = /^\/api\/run\/([^/]+)\/video$/.exec(url.pathname);
    if (runVideoMatch && request.method === 'GET') {
      const record = runs.get(runVideoMatch[1]);
      const file = record?.render ? join(rendersDir, `${record.runId}.mp4`) : null;
      if (!file || !existsSync(file)) return sendJson(response, 404, { error: 'no rendered MP4 for this run yet' });
      const size = statSync(file).size;
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': size,
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="comfyrizz-${record.runId}.mp4"`,
        'x-comfyrizz-frames': String(record.render.frames ?? ''),
        'x-comfyrizz-timeline-sha256': String(record.render.timeline_sha256 ?? ''),
      });
      createReadStream(file).pipe(response);
      return;
    }

    // MS4: the last frame-QA result for a render (or the latest for a package).
    if (url.pathname === '/api/qa' && request.method === 'GET') {
      const result = qa.lookup({ renderId: url.searchParams.get('renderId') ?? undefined, packageId: url.searchParams.get('packageId') ?? undefined });
      if (!result) return sendJson(response, 404, { error: 'no qa result' });
      return sendJson(response, 200, result);
    }
    if (url.pathname === '/api/qa/sheet' && request.method === 'GET') {
      const result = qa.lookup({ renderId: url.searchParams.get('renderId') ?? undefined, packageId: url.searchParams.get('packageId') ?? undefined });
      if (!result?.sheet || !existsSync(result.sheet)) return sendJson(response, 404, { error: 'no contact sheet' });
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      createReadStream(result.sheet).pipe(response);
      return;
    }

    if (url.pathname === '/api/export' && request.method === 'POST') {
      if (pipelines.active()) return sendJson(response, 409, { error: 'pipeline busy' });
      // RL06: take the shared slot before the body is read, so a slow request cannot let a
      // second export through the same door.
      const exportId = `x_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const hold = holdOperation('export', exportId, response);
      if (hold.busy) return sendJson(response, 409, { error: 'export busy', busy: true, holder: hold.holder });
      try {
        const body = await readJson(request);
        let pkg;
        let packagePath;
        let revision = null;
        try {
          if (body.package && typeof body.package === 'object') {
            // C1 compatibility: an edited draft draft-exported without mutating the store.
            ({ pkg, packagePath, revision } = draftRenderTarget(body.package, exportId, response));
          } else {
            const id = body.packageId;
            if (!id) return sendJson(response, 400, { error: 'packageId or package required' });
            pkg = store.read(id);
            if (!pkg) return sendJson(response, 404, { error: 'package not found' });
            if (body.baseRevision != null && Number(body.baseRevision) !== pkg.revision) {
              return sendJson(response, 409, { error: 'conflict', currentRevision: pkg.revision });
            }
            packagePath = store.path(id);
            revision = pkg.revision;
          }
          events.publish({ type: 'export.started', exportId, packageId: pkg.id, revision });
          if (body.variants && typeof body.variants === 'object') {
            // L1: one bundle per language/aspect variant plus a variants.json manifest.
            const plan = buildVariants(pkg, body.variants);
            const result = await exporter.variants({
              pkg,
              packagePath,
              variants: plan,
              force: body.force === true,
              onLog: line => events.publish({ type: 'export.log', exportId, line }),
              ...(body.mixAudio === false ? { mixAudio: false } : {}),
            });
            events.publish({
              type: 'export.finished',
              exportId,
              packageId: pkg.id,
              revision,
              kind: 'variants',
              dir: result.dir,
              variants: result.manifest.variants.length,
            });
            return sendJson(response, 200, { exportId, packageId: pkg.id, dir: result.dir, manifestPath: result.manifestPath, manifest: result.manifest });
          }
          const result = await exporter({
            pkg,
            packagePath,
            revision,
            force: body.force === true,
            onLog: line => events.publish({ type: 'export.log', exportId, line }),
            ...(body.mixAudio === false ? { mixAudio: false } : {}),
          });
          events.publish({
            type: 'export.finished',
            exportId,
            packageId: pkg.id,
            revision,
            dir: result.dir,
            files: result.files.map(file => file.name),
            social: (result.social ?? []).map(file => file.name),
            frames: result.frames,
            captions: result.captions,
            complete: result.complete,
            excluded: result.excluded,
          });
          return sendJson(response, 200, { exportId, ...result });
        } catch (error) {
          events.publish({ type: 'export.failed', exportId, packageId: pkg?.id, message: error.message });
          return sendJson(response, error.status ?? 500, { error: error.message, exportId });
        }
      } finally {
        hold.release();
      }
    }

    if (url.pathname === '/api/render' && request.method === 'POST') {
      if (pipelines.active()) return sendJson(response, 409, { error: 'pipeline busy' });
      // RL06: the shared slot is taken before the body is read, so two parallel renders
      // cannot both start; the loser is told who holds the slot.
      const renderId = `r_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const hold = holdOperation('render', renderId, response);
      if (hold.busy) return sendJson(response, 409, { error: 'render busy', busy: true, holder: hold.holder });
      try {
        const body = await readJson(request);
        const output = join(rendersDir, `${renderId}.mp4`);
        let pkg;
        let packagePath;
        let revision = null;
        if (body.package && typeof body.package === 'object') {
          // C1 compatibility: an edited draft, rendered without mutating the stored package.
          try {
            ({ pkg, packagePath, revision } = draftRenderTarget(body.package, renderId, response));
          } catch (error) {
            return sendJson(response, error.status ?? 400, { error: error.message });
          }
        } else {
          const id = body.packageId;
          if (!id) {
            return sendJson(response, 400, { error: 'packageId or package required' });
          }
          pkg = store.read(id);
          if (!pkg) {
            return sendJson(response, 404, { error: 'package not found' });
          }
          if (body.baseRevision != null && Number(body.baseRevision) !== pkg.revision) {
            return sendJson(response, 409, { error: 'conflict', currentRevision: pkg.revision });
          }
          packagePath = store.path(id);
          revision = pkg.revision;
        }

        const gate = renderGate(pkg, body, url.pathname);
        if (gate) {
          return sendJson(response, gate.status, gate.body);
        }

        events.publish({ type: 'render.started', renderId, packageId: pkg.id, revision });
        try {
          const result = await render(packagePath, output, {
            onLog: line => events.publish({ type: 'render.log', renderId, line }),
            ...(body.mixAudio === false ? { mixAudio: false } : {}),
          });
          events.publish({
            type: 'render.finished',
            renderId,
            packageId: pkg.id,
            revision,
            bytes: result.bytes,
            frames: result.frames,
            timeline_sha256: result.hash,
          });
          // MS4: the "look at your own frames" gate. Non-fatal: a QA failure is
          // reported, never a reason to lose a render the owner asked for.
          if (result.timeline) {
            try {
              const qaResult = runFrameQa({ mp4: result.output, timeline: result.timeline, pkg, outDir: rendersDir });
              qa.record(renderId, pkg.id, qaResult);
              events.publish({ type: 'qa.result', renderId, packageId: pkg.id, ok: qaResult.ok, findings: qaResult.findings.length, sheet: qaResult.sheet ?? null });
            } catch (error) {
              events.publish({ type: 'qa.failed', renderId, packageId: pkg.id, message: error.message });
            }
          }
          response.writeHead(200, {
            'content-type': 'video/mp4',
            'content-length': result.bytes,
            'cache-control': 'no-store',
            'content-disposition': `attachment; filename="comfyrizz-${renderId}.mp4"`,
            'x-comfyrizz-render-id': renderId,
            'x-comfyrizz-timeline-sha256': result.hash,
            'x-comfyrizz-frames': String(result.frames),
            ...(revision == null ? {} : { 'x-comfyrizz-revision': String(revision) }),
          });
          createReadStream(result.output).pipe(response);
        } catch (error) {
          events.publish({ type: 'render.failed', renderId, packageId: pkg.id, message: error.message });
          sendJson(response, 500, { error: error.message, renderId });
        }
      } finally {
        hold.release();
      }
      return;
    }

    // R2 step 5: the per-scene edit chips. "Warmer / Calmer motion / More depth / Less busy" are
    // fixed, deterministic scene-local edits (packages/agent scene-chips) — no model, no network,
    // no GPU. Saving validates the package; the web then re-runs only that scene via C11/A6.
    if (url.pathname === '/api/scene/chips' && request.method === 'GET') {
      return sendJson(response, 200, { chips: sceneChipList() });
    }

    if (url.pathname === '/api/scene/chip' && request.method === 'POST') {
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return sendJson(response, error.status ?? 400, { error: error.message });
      }
      if (!body.sceneId) return sendJson(response, 400, { error: 'sceneId required' });
      let target;
      try {
        target = resolveRenderTarget(body, `chip_${randomUUID().replaceAll('-', '').slice(0, 8)}`, response);
      } catch (error) {
        return sendJson(response, error.status ?? 400, {
          error: error.message,
          ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
        });
      }
      let result;
      try {
        result = applySceneChip(target.pkg, body.sceneId, body.chip);
      } catch (error) {
        return sendJson(response, error.status ?? 400, { error: error.message });
      }
      const inline = Boolean(body.package);
      let revision = target.revision;
      if (!inline && result.changed) {
        try {
          const saved = store.save(body.packageId, result.package, body.baseRevision ?? target.pkg.revision);
          revision = saved.revision;
        } catch (error) {
          return sendJson(response, error.status ?? 400, {
            error: error.message,
            ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
          });
        }
      }
      events.publish({
        type: 'scene.chip.applied',
        packageId: result.package.id ?? body.packageId ?? null,
        sceneId: result.sceneId,
        chip: result.chip,
        changed: result.changed,
        revision,
      });
      return sendJson(response, 200, {
        packageId: result.package.id ?? body.packageId ?? null,
        revision,
        sceneId: result.sceneId,
        chip: result.chip,
        summary: result.summary,
        changed: result.changed,
        package: result.package,
      });
    }

    // C-pres: the presenter controls. The brief chip, the storyboard per-scene toggle and the
    // agent all end up here. Pure package mutation (H17 schema) + save; no model, network or GPU.
    if (url.pathname === '/api/presenter/chips' && request.method === 'GET') {
      return sendJson(response, 200, { chips: presenterChips(), presets: presenterPresets() });
    }

    if (url.pathname === '/api/presenter/set' && request.method === 'POST') {
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return sendJson(response, error.status ?? 400, { error: error.message });
      }
      let target;
      try {
        target = resolveRenderTarget(body, `presenter_${randomUUID().replaceAll('-', '').slice(0, 8)}`, response);
      } catch (error) {
        return sendJson(response, error.status ?? 400, {
          error: error.message,
          ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
        });
      }
      let result;
      try {
        result = applyPresenterSet(target.pkg, {
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.coverage !== undefined ? { coverage: body.coverage } : {}),
          ...(body.preset !== undefined ? { preset: body.preset } : {}),
          ...(body.scenes ? { scenes: body.scenes } : {}),
          ...(body.placement !== undefined ? { placement: body.placement } : {}),
          ...(body.shape !== undefined ? { shape: body.shape } : {}),
          ...(body.size !== undefined ? { size: body.size } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.portrait !== undefined ? { portrait: body.portrait } : {}),
          ...(body.presetStyle !== undefined ? { presetStyle: body.presetStyle } : {}),
          ...(body.backdrop !== undefined ? { backdrop: body.backdrop } : {}),
        });
      } catch (error) {
        return sendJson(response, error.status ?? 400, { error: error.message });
      }
      const inline = Boolean(body.package);
      let revision = target.revision;
      if (!inline && result.changed) {
        try {
          const saved = store.save(body.packageId, result.package, body.baseRevision ?? target.pkg.revision);
          revision = saved.revision;
        } catch (error) {
          return sendJson(response, error.status ?? 400, {
            error: error.message,
            ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
          });
        }
      }
      events.publish({
        type: 'presenter.set',
        packageId: result.package.id ?? body.packageId ?? null,
        revision,
        summary: result.summary,
      });
      return sendJson(response, 200, {
        packageId: result.package.id ?? body.packageId ?? null,
        revision,
        summary: result.summary,
        changed: result.changed,
        presenter: result.package.presenter ?? null,
        findings: result.findings ?? [],
        portrait_prompt: result.portrait_prompt ?? null,
        presenters: compilePackage(result.package, dirname(target.packagePath)).presenters ?? [],
        package: result.package,
      });
    }

    // C11: a dry-run jobs plan for one scene's generated assets. Nothing is sent to Google Colab
    // and no VM is started; the storyboard shows it on the spend card.
    if (url.pathname === '/api/scene/plan' && request.method === 'POST') {
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return sendJson(response, error.status ?? 400, { error: error.message });
      }
      let target;
      try {
        target = resolveRenderTarget(body, `plan_${randomUUID().replaceAll('-', '').slice(0, 8)}`, response);
      } catch (error) {
        return sendJson(response, error.status ?? 400, {
          error: error.message,
          ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
        });
      }
      try {
        const plan = sceneJobsPlan(target.pkg, body.sceneId, {
          includeReady: body.includeReady !== false,
          measured: measuredOptionsFromDir(dirname(target.packagePath)),
        });
        return sendJson(response, 200, {
          packageId: target.pkg.id,
          revision: target.revision,
          dryRun: true,
          metered: false,
          ...plan,
        });
      } catch (error) {
        return sendJson(response, error.status ?? 500, { error: error.message });
      }
    }

    // C11: re-render just one scene. The renderer's incremental renderer reuses every cached
    // segment whose key did not change (A6), then re-stitches and muxes; the response is the
    // full-length MP4.
    if (url.pathname === '/api/scene/render' && request.method === 'POST') {
      if (pipelines.active()) return sendJson(response, 409, { error: 'pipeline busy' });
      // RL06: the shared slot is taken before the body is read, so a scene render cannot
      // start while an export or a full render holds the machine.
      const renderId = `sr_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const hold = holdOperation('scene-render', renderId, response);
      if (hold.busy) return sendJson(response, 409, { error: 'scene render busy', busy: true, holder: hold.holder });
      try {
        const body = await readJson(request);
        let target;
        try {
          target = resolveRenderTarget(body, renderId, response);
        } catch (error) {
          return sendJson(response, error.status ?? 400, {
            error: error.message,
            ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
          });
        }
        if (!body.sceneId) return sendJson(response, 400, { error: 'sceneId required' });
        const assets = sceneAssetIds(target.pkg, body.sceneId, measuredOptionsFromDir(dirname(target.packagePath)));
        if (assets === null) return sendJson(response, 404, { error: `unknown scene ${body.sceneId}` });
        const output = join(rendersDir, `${renderId}.mp4`);
        const cacheDir = sceneCacheDir(target.pkg.id);
        events.publish({ type: 'scene.render.started', renderId, packageId: target.pkg.id, revision: target.revision, sceneId: body.sceneId, assets });
        try {
          const result = await renderScene(target.packagePath, output, {
            cacheDir,
            force: body.force === true,
            onLog: line => events.publish({ type: 'scene.render.log', renderId, sceneId: body.sceneId, line }),
          });
          events.publish({
            type: 'scene.render.finished',
            renderId,
            packageId: target.pkg.id,
            revision: target.revision,
            sceneId: body.sceneId,
            bytes: result.bytes,
            frames: result.frames,
            timeline_sha256: result.timelineHash,
            rendered: result.rendered,
            reused: result.reused,
            full: result.full ?? false,
            reason: result.reason ?? null,
          });
          response.writeHead(200, {
            'content-type': 'video/mp4',
            'content-length': result.bytes,
            'cache-control': 'no-store',
            'content-disposition': `attachment; filename="comfyrizz-${renderId}.mp4"`,
            'x-comfyrizz-render-id': renderId,
            'x-comfyrizz-scene-id': String(body.sceneId),
            'x-comfyrizz-timeline-sha256': result.timelineHash,
            'x-comfyrizz-frames': String(result.frames),
            'x-comfyrizz-rendered': String(result.rendered.length),
            'x-comfyrizz-reused': String(result.reused.length),
            'x-comfyrizz-full-render': result.full ? '1' : '0',
            'x-comfyrizz-full-reason': result.reason ?? '',
            ...(target.revision == null ? {} : { 'x-comfyrizz-revision': String(target.revision) }),
          });
          createReadStream(result.output).pipe(response);
        } catch (error) {
          events.publish({ type: 'scene.render.failed', renderId, packageId: target.pkg.id, sceneId: body.sceneId, message: error.message });
          sendJson(response, 500, { error: error.message, renderId });
        }
      } finally {
        hold.release();
      }
      return;
    }

    // C13: an agent edit only re-renders the scenes whose compiled segment changed. The new
    // package is diffed against the last rendered timeline; a scene-local change goes through
    // the A6 incremental cache, a timing change falls back to a full render with a reason.
    if (url.pathname === '/api/render/edited' && request.method === 'POST') {
      if (pipelines.active()) return sendJson(response, 409, { error: 'pipeline busy' });
      // RL06: an edited render shares the scene render slot, taken before the body is read.
      const renderId = `er_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const hold = holdOperation('scene-render', renderId, response);
      if (hold.busy) return sendJson(response, 409, { error: 'scene render busy', busy: true, holder: hold.holder });
      try {
        let body;
        try {
          body = await readJson(request);
        } catch (error) {
          return sendJson(response, error.status ?? 400, { error: error.message });
        }
        let target;
        try {
          target = resolveRenderTarget(body, renderId, response);
        } catch (error) {
          return sendJson(response, error.status ?? 400, {
            error: error.message,
            ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
          });
        }
        const previous = lastRendered.get(target.pkg.id) ?? null;
        const nextTimeline = packageTimeline(target.packagePath, target.pkg);
        const fullReason = loadCompositionManifest(dirname(target.packagePath), target.pkg)
          ? 'compositions require a full render'
          : timingChangeReason(previous?.timeline ?? null, nextTimeline);
        const full = Boolean(fullReason);
        const output = join(rendersDir, `${renderId}.mp4`);
        const cacheDir = sceneCacheDir(target.pkg.id);
        events.publish({
          type: 'edit.render.started',
          renderId,
          packageId: target.pkg.id,
          revision: target.revision,
          previousRevision: previous?.revision ?? null,
          full,
          reason: fullReason,
        });
        try {
          let result;
          let renderedSceneIds;
          let reusedSceneIds;
          if (full) {
            result = await render(target.packagePath, output, { onLog: line => events.publish({ type: 'edit.render.log', renderId, line }) });
            renderedSceneIds = (nextTimeline.scenes ?? []).map(scene => scene.id);
            reusedSceneIds = [];
          } else {
            result = await renderScene(target.packagePath, output, {
              cacheDir,
              force: false,
              onLog: line => events.publish({ type: 'edit.render.log', renderId, line }),
            });
            const renderedKeys = new Set(result.rendered);
            const reusedKeys = new Set(result.reused);
            renderedSceneIds = result.segments.filter(segment => renderedKeys.has(segment.key)).map(segment => segment.sceneId);
            reusedSceneIds = result.segments.filter(segment => reusedKeys.has(segment.key)).map(segment => segment.sceneId);
          }
          lastRendered.set(target.pkg.id, { timeline: nextTimeline, revision: target.revision, at: Date.now() });
          const timelineHash = result.timelineHash ?? result.hash ?? null;
          const reason = fullReason ?? (previous ? 'content changes only' : 'first render');
          events.publish({
            type: 'edit.render.finished',
            renderId,
            packageId: target.pkg.id,
            revision: target.revision,
            full,
            reason,
            bytes: result.bytes,
            frames: result.frames,
            timeline_sha256: timelineHash,
            rendered: renderedSceneIds,
            reused: reusedSceneIds,
          });
          response.writeHead(200, {
            'content-type': 'video/mp4',
            'content-length': result.bytes,
            'cache-control': 'no-store',
            'content-disposition': `attachment; filename="comfyrizz-${renderId}.mp4"`,
            'x-comfyrizz-render-id': renderId,
            'x-comfyrizz-full-render': full ? '1' : '0',
            'x-comfyrizz-full-reason': fullReason ?? '',
            'x-comfyrizz-rendered': renderedSceneIds.join(','),
            'x-comfyrizz-rendered-count': String(renderedSceneIds.length),
            'x-comfyrizz-reused': reusedSceneIds.join(','),
            'x-comfyrizz-reused-count': String(reusedSceneIds.length),
            'x-comfyrizz-timeline-sha256': String(timelineHash ?? ''),
            'x-comfyrizz-frames': String(result.frames),
            ...(target.revision == null ? {} : { 'x-comfyrizz-revision': String(target.revision) }),
          });
          createReadStream(result.output ?? output).pipe(response);
        } catch (error) {
          events.publish({ type: 'edit.render.failed', renderId, packageId: target.pkg.id, message: error.message });
          sendJson(response, 500, { error: error.message, renderId });
        }
      } finally {
        hold.release();
      }
      return;
    }

    if (await takeRoutes.handle(request, response, url)) return;
    if (await createCharacterRoutes({ rootDir: runtimeDir, events }).handle(request, response, url)) return;
    if (await createReferenceRoutes({ rootDir: runtimeDir, events }).handle(request, response, url)) return;
    return sendJson(response, 404, { error: 'not found' });
  }

  return {
    handler: (request, response) => {
      Promise.resolve(handler(request, response)).catch(error => {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        sendJson(response, error.status ?? 500, { error: error.message });
      });
    },
    store,
    takeStore,
    events,
    runs,
    pipelines,
    rendersDir,
    exportsDir,
    sceneCacheDir,
    webDist,
    close: () => { pipelines.close(); events.closeAll(); },
  };
}
