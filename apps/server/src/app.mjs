import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PackageStore, ConflictError, InvalidPackageError } from './store.mjs';
import { EventLog } from './events.mjs';
import { colabStatus } from './colab-status.mjs';
import { startColabAuth } from './colab-auth.mjs';
import { createHfTokenSettings } from './hf-token-settings.mjs';
import { handleHfTokenRoutes } from './hf-token-routes.mjs';
import { readColabProgress } from '../../../packages/backends/src/colab-progress.mjs';
import { createRunController } from './run.mjs';
import { planFromPackage } from './productions/plan-from-package.mjs';
import { prepareRunNarration } from './run-narration.mjs';
import { createExporter } from './export.mjs';
import { buildDataset } from './dataset.mjs';
import { copyNamedAssets } from './run-assets.mjs';
import { mergeRunMedia, changedRunMedia } from './run-media-merge.mjs';
import { loadAssetWorkflow } from './workflow.mjs';
import { createQaRegistry } from './qa.mjs';
import { sceneJobsPlan } from './scene.mjs';
import { planBrief, refreshBrief, briefPresets } from './brief.mjs';
import { preflightBrief } from './brief-preflight.mjs';
import { prepareBrand } from './brand.mjs';
import { handleProviderSettings } from './provider-settings.mjs';
import { createProjectChat } from './agent-chat.mjs';
import { createAgentProgress } from './agent-progress.mjs';
import { createReferenceRoutes } from './references/routes.mjs';
import { createCharacterRoutes } from './characters/routes.mjs';
import { createCharacterStore } from './characters/store.mjs';
import { castIdFor } from './characters/cast.mjs';
import { createAuditionCache, createAuditionWorker } from './characters/audition.mjs';
import { createKokoroSynth, probeKokoroRuntime } from './characters/kokoro-synth.mjs';
import { ingestRun } from './takes/ingest.mjs';
import { selectTake } from './takes/select.mjs';
import { createTakeStore } from './takes/store.mjs';
import { TAKES_SCHEMA, shouldAutoSelect } from './takes/model.mjs';
import { createTakeRoutes } from './takes/routes.mjs';
import { createThumbRoutes } from './thumbs/routes.mjs';
import { buildCorrection } from './takes/correction.mjs';
import { listClips } from './takes/clips.mjs';
import { finalGate } from './takes/gate.mjs';
import { applySceneChip, sceneChipList } from '../../../packages/agent/dist/src/index.js';
import { applyPresenterSet, presenterChips, presenterPresets } from '../../../packages/agent/dist/src/index.js';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { compilePackage, measuredOptionsFromDir } from './compile-package.mjs';
import { handleCompile } from './compile-route.mjs';
import { handleMedia } from './media-route.mjs';
import { readEditor, validateEditor, writeEditor } from './editor-sidecar.mjs';
import { serveStaticFile } from './static-file.mjs';
import { createPipelineController } from './pipeline.mjs';
import { planPipeline, syncnetDiagnostics } from './pipeline-contract.mjs';
import { stagePipelineInputs } from './pipeline-media.mjs';
import { createOperationCoordinator } from './operations.mjs';
import { KOKORO_VOICES, QWEN_SPEAKERS, VOICE_PRESETS } from '../../../packages/tts/voices.mjs';
import { animationOptions } from './animation-options.mjs';
import { createMediaTickets, safeMediaPath, serveTicket } from './media-range.mjs';
import { createRenderRoutes } from './routes/render.mjs';
import { createWorkerRenderer } from './routes/render-worker.mjs';
import { createConversationRoutes } from './routes/conversations.mjs';
import { createPackageRoutes } from './routes/packages.mjs';
import { createProductionStore } from './productions/store.mjs';
import { createProductionAdmission } from './productions/admission.mjs';
import { createPipelineAdapter } from './productions/pipeline-adapter.mjs';
import { createOutboxExecutor } from './productions/outbox-execution.mjs';
import { createCommandHandler } from './productions/commands.mjs';
import { createBudgetLedger } from './productions/ledger.mjs';
import { createActionCoordinator } from './productions/actions.mjs';
import { createProductionCoordinator } from './productions/coordinator.mjs';
import { createProductionRoutes } from './routes/productions.mjs';
import { createPreferencesStore } from './productions/preferences.mjs';
import { createIterationRoutes } from './productions/iteration-routes.mjs';

const MAX_BODY = 5 * 1024 * 1024;
// IP11: a completion save races with edits. Re-read the latest package and reapply the
// run's result a bounded number of times instead of overwriting or failing the run.
const MAX_CAS_ATTEMPTS = 5;
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

const CONFIGURED_HOSTS = new Set((process.env.COMFYRIZZ_ALLOWED_HOSTS ?? '').split(',').map(host => host.trim()).filter(Boolean));

function hostAllowed(host) {
  return CONFIGURED_HOSTS.has(host) || (typeof host === 'string' && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host));
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

// IP11: did the owner change this asset after the run started? The comparison is against
// the package the run started from (captured before staging), never the staged package:
// a correction deliberately differs from what is stored, and must still auto-select.
function assetEditedSinceBaseline({ baseline, current, pkg, assetId }) {
  if (!current) return false;
  const startRevision = baseline?.revision ?? pkg?.revision ?? null;
  if (startRevision !== null && current.revision === startRevision) return false;
  if (!baseline?.assets) return true;
  const before = baseline.assets[assetId];
  const after = current.assets?.[assetId];
  if (before === undefined && after === undefined) return false;
  return !isDeepStrictEqual(before, after);
}

// G5-10: a run can name an asset the package did not have yet (the runner's non-upscaled
// plate). mergeRunMedia deliberately refuses to replace an asset that was in the staged
// package, but a ready asset absent from both the staged and the live package is a new
// output and belongs in the rebased package.
export function mergeFinalRunMedia({ staged, current, generated, baseline = null }) {
  const merged = mergeRunMedia({ staged, current, generated });
  if (!current) return merged;
  for (const [assetId, asset] of Object.entries(generated.assets ?? {})) {
    if (merged.assets?.[assetId] !== undefined) continue;
    if (staged.assets?.[assetId] !== undefined) continue;
    if (!asset || typeof asset !== 'object' || asset.status !== 'ready' || !asset.file) continue;
    merged.assets = { ...merged.assets, [assetId]: structuredClone(asset) };
  }
  // Narration is introduced by the final-run hook after the baseline snapshot.
  // Keep it when the owner left narration untouched, but never undo an edit or
  // deletion made while media was running.
  const narration = generated.assets?.a_narration;
  if (baseline && narration?.status === 'ready' && narration.file
    && isDeepStrictEqual(baseline.assets?.a_narration, current.assets?.a_narration)) {
    merged.assets = { ...merged.assets, a_narration: structuredClone(narration) };
    merged.scenes = (current.scenes ?? []).map(scene => {
      const before = baseline.scenes?.find(candidate => candidate.id === scene.id);
      const after = generated.scenes?.find(candidate => candidate.id === scene.id);
      if (!before || !after?.narration_asset || !isDeepStrictEqual(before.narration, scene.narration)
        || !isDeepStrictEqual(before.narration_asset, scene.narration_asset)
        || !isDeepStrictEqual(before.narration_duration_frames, scene.narration_duration_frames)) return scene;
      return { ...scene, narration_asset: after.narration_asset, narration_duration_frames: after.narration_duration_frames ?? null };
    });
  }
  return merged;
}

export function createApp({
  root = repoRoot,
  colabProgressDir = null,
  token,
  runtimeDir = join(root, 'apps', 'server', '.runtime'),
  exportsDir = join(runtimeDir, 'out', 'export'),
  webDist = join(root, 'apps', 'web', 'dist'),
  render,
  renderScene,
  renderModuleUrl,
  sceneModuleUrl,
  agentRunner = null,
  providers = providerAvailability(),
  providerSettings = null,
  hfTokenSettings: providedHfTokenSettings = null,
  backendFactory = defaultBackendFactory,
  // IP02F: only the exact string '1' opts into the deterministic CPU placeholder
  // backend; every other value (including 'true' and '0') leaves the default app as-is.
  fakeBackend = process.env.COMFYRIZZ_FAKE_BACKEND === '1',
  datasetFetch = globalThis.fetch,
  pipelineLaunch,
  mediaRoot = join(runtimeDir, 'media'),
  // IP45K: a Kokoro synthesizer may be injected by a caller (tests, a custom
  // runtime). Without one the app mounts the local Kokoro synthesizer lazily,
  // and only after the same python + kokoro_onnx probe the pipeline worker
  // uses succeeds; a failed probe keeps the route at 503.
  auditionSynth = null,
} = {}) {
  if (!token || token.length < 16) throw new Error('createApp requires a token of at least 16 characters');
  // Local Remotion renders run on a worker. Callers that pass their own render
  // function (tests, a stub) stay on this thread. The choice is the argument,
  // not the function's name.
  if (typeof render !== 'function') {
    render = createWorkerRenderer(
      renderModuleUrl ?? new URL('../../renderer/scripts/render-package-lib.mjs', import.meta.url),
      'renderPackageAsync',
    );
  }
  if (typeof renderScene !== 'function') {
    renderScene = createWorkerRenderer(
      sceneModuleUrl ?? new URL('../../renderer/scripts/render-incremental.mjs', import.meta.url),
      'renderPackageIncrementalAsync',
    );
  }
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  const hfTokenSettings = providedHfTokenSettings ?? createHfTokenSettings({ runtimeDir });
  const mediaTickets = createMediaTickets();
  const rendersDir = join(runtimeDir, 'renders');
  const qa = createQaRegistry();
  mkdirSync(rendersDir, { recursive: true });
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const takeStore = createTakeStore({ runtimeDir, packageDir: store.dir });
  const events = new EventLog();
  const agentProgress = new Map();
  const publishEntry = events.publish.bind(events);
  const pipelineIngested = new Set();
  const runPackages = new Map();
  // IP11: runId -> { revision, assets } captured from the stored package before staging.
  const runBaselines = new Map();
  // TR09: pipelines finish in the worker, so the server consumes the run directory
  // afterwards (never editing the worker). A terminal media run schedules one queued
  // regenerate; both hooks run after the completed/finished event has been published.
  events.publish = (event) => {
    const entry = publishEntry(event);
    try {
      if (event?.type === 'run.event' && event.event?.type === 'preview_ready') {
        const record = runs.get(event.runId);
        if (record) {
          const staged = readJsonFile(join(record.workDir, 'package.json'));
          const pkg = staged?.id ? store.read(staged.id) : null;
          if (pkg) {
            const ingested = ingestRun({ pkg: staged, manifest: event.event.manifest,
              jobsDoc: readJsonFile(join(record.workDir, 'jobs.json')), outputDir: event.event.outputDir,
              store: takeStore, runId: event.runId, backend: record.backendId });
            for (const take of ingested.takes) publishEntry({ type: 'clip.take.landed', packageId: pkg.id,
              assetId: take.assetId, takeId: take.takeId, runId: event.runId });
          }
        }
      } else if (event?.type === 'pipeline.event' && event.kind === 'stage'
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

  function trackConversationProgress(sessionId, brief) {
    const progress = createAgentProgress(sessionId);
    const progressDir = join(runtimeDir, 'agent-progress');
    mkdirSync(progressDir, { recursive: true });
    const progressFile = join(progressDir, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
    const persist = () => writeFileSync(progressFile, JSON.stringify(progress.snapshot(), null, 2));
    progress.update({ type: 'request', brief });
    persist();
    if (agentProgress.size >= 100) agentProgress.delete(agentProgress.keys().next().value);
    agentProgress.set(sessionId, progress);
    return {
      onEvent(event) {
        progress.update(event);
        if (event.type !== 'text') persist();
        events.publish({ type: 'agent.event', sessionId, event });
      },
      finish(status, message = null) {
        progress.finish(status, message);
        persist();
        events.publish({ type: status === 'done' ? 'agent.finished' : 'agent.failed', sessionId, ...(message ? { message } : {}) });
      },
    };
  }

  // C9: stage where H8's runPackage resolves relative paths: the package JSON, the repo's
  // workflow graphs, and any assets the package already has on disk.
  async function prepareRunWorkDir(pkg, workDir, options = {}) {
    // IP11: remember the stored package the run starts from. `pkg` can be a corrected
    // staging copy, so its assets must never be the baseline for "was this edited?".
    if (options?.runId && options.dryRun !== true) {
      let stored = null;
      try { stored = store.read(pkg.id); } catch { stored = null; }
      runBaselines.set(options.runId, {
        revision: stored?.revision ?? pkg.revision ?? null,
        assets: stored ? JSON.parse(JSON.stringify(stored.assets ?? {})) : null,
        scenes: stored ? JSON.parse(JSON.stringify(stored.scenes ?? [])) : null,
      });
    }
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
    copyNamedAssets({ pkg, outputDir: dirname(store.path(pkg.id)), packageDir: workDir });
  }

  // C9: after collect, write the applied package back next to its collected plates, then render
  // the accepted revision to an MP4 the run panel can offer. The applied compliance tag comes from
  // H8's `runPackage`/`backend.appliedBackendId` (H-fix7), so no server-side normaliser is needed.
  async function completeRun({ pkg, result, record }) {
    if (pkg?.id && record?.runId) runPackages.set(record.runId, pkg.id);
    const baseline = record?.runId ? runBaselines.get(record.runId) ?? null : null;
    if (record?.runId) runBaselines.delete(record.runId);
    if (!result?.package) return { revision: null, render: null };
    const id = pkg.id;
    const packageDir = dirname(store.path(id));
    if (record.mode === 'take') {
      // IP11/TR07: snapshot the run's outputs as takes *before* the package is touched.
      // The take store keeps the bytes, so a later overwrite cannot destroy the take that
      // produced it, and the package asset points at the take file instead of a copy of
      // the run's output.
      const ingested = ingestRun({
        pkg,
        manifest: result.manifest,
        jobsDoc: result.jobsDoc,
        outputDir: record.outputDir,
        store: takeStore,
        corrections: record.corrections ?? {},
        runId: record.runId,
        backend: record.backendId,
        autoSelect: false,
      });

      const byAsset = new Map();
      for (const take of ingested.takes) {
        if (!byAsset.has(take.assetId)) byAsset.set(take.assetId, []);
        byAsset.get(take.assetId).push(take);
      }

      // Rebase onto the latest stored package. The stored asset is the baseline: a
      // correction staging copy deliberately differs from it and must still auto-select,
      // while any owner edit made during the run wins and leaves the output as a candidate.
      let saved = null;
      let attempt = 0;
      const applied = {};
      while (!saved) {
        const current = store.read(id);
        const takeDoc = takeStore.read(id) ?? { schema: TAKES_SCHEMA, packageId: id, clips: {}, overrides: [] };
        let next = current ?? result.package;
        const candidate = {};
        for (const [assetId, assetTakes] of byAsset) {
          if (assetEditedSinceBaseline({ baseline, current, pkg, assetId })) continue;
          for (const take of assetTakes) {
            if (!shouldAutoSelect(takeDoc.clips?.[assetId], take)) continue;
            next = selectTake(next, takeDoc, assetId, take.takeId);
            candidate[assetId] = take.takeId;
          }
        }
        try {
          saved = current ? store.save(id, next, current.revision) : store.write(next);
        } catch (error) {
          if (!(error instanceof ConflictError) || attempt >= MAX_CAS_ATTEMPTS) throw error;
          attempt += 1;
          continue;
        }
        // Persist the take document only after the package accepted the selection, so a
        // conflicted attempt cannot leave a take selected over an owner-edited package.
        takeStore.write(id, takeDoc);
        Object.assign(applied, candidate);
      }

      events.publish({ type: 'package.updated', packageId: id, revision: saved.revision });
      for (const take of ingested.takes) {
        events.publish({
          type: 'clip.take.landed',
          packageId: id,
          assetId: take.assetId,
          takeId: take.takeId,
          selected: applied[take.assetId] === take.takeId ? take.takeId : null,
          runId: record.runId,
        });
      }
      return { revision: saved.revision, render: null };
    }
    // TR07: only an explicit take-mode run lands takes. A final run's outputs stay in the
    // package, and any verified in-flight preview already landed its own take before now.
    // G5-10: the applied package can also name files outside `assets/` (the runner's
    // non-upscaled plates live at `out/intermediates/<id>.plate.mp4`), so copy every path it
    // names — otherwise the renderer falls back to placeholders.
    let saved = null;
    let attempt = 0;
    let copied = [];
    while (!saved) {
      const current = store.read(id);
      const merged = mergeFinalRunMedia({ staged: pkg, current, generated: result.package, baseline });
      copied = copyNamedAssets({ pkg: changedRunMedia(current, merged), outputDir: record.outputDir, packageDir });
      try {
        saved = current ? store.save(id, merged, current.revision) : store.write(merged);
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt >= MAX_CAS_ATTEMPTS) throw error;
        attempt += 1;
      }
    }
    if (copied.length) {
      events.publish({ type: 'run.log', runId: record.runId, line: `collected ${copied.length} package file(s): ${copied.join(', ')}` });
    }
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

  // IP02F: the flag wraps the configured factory rather than replacing it, so an
  // injected factory keeps handling 'cpu' itself and every other id is untouched.
  let effectiveBackendFactory = backendFactory;
  if (fakeBackend) {
    console.warn('COMFYRIZZ_FAKE_BACKEND=1: CPU placeholder backend enabled (dev/test only)');
    effectiveBackendFactory = async (backendId, opts = {}) => {
      const delegated = await backendFactory(backendId, opts);
      if (backendId !== 'cpu' || delegated) return delegated;
      const mod = await import('../../../packages/backends/src/cpu-backend.mjs');
      return mod.createCpuBackend();
    };
  }

  // IP24: the production journal is shared by the legacy /api/run adapter and
  // the /api/productions facade, so a bound package can only start from the
  // action slot that was dispatched for it.
  const productionStore = createProductionStore({ runtimeDir });
  // UX01/UX10: one server-resolved binding and one guard for every entry point
  // that can allocate generation work. The production journal is the authority.
  const admission = createProductionAdmission({ store: productionStore });
  const characterStore = createCharacterStore({ rootDir: runtimeDir });
  const preferencesStore = createPreferencesStore({ runtimeDir });
  const iterationRoutes = createIterationRoutes({ store: productionStore, preferences: preferencesStore });
  // IP66: the chat adapter uses the same command handler as the production
  // facade. The handler is created here, before the chat, so a bound package's
  // turn can dispatch agent-attributed commands through the one command path.
  const productionCommands = createCommandHandler({ store: productionStore });
  // UX21F: every surface hands commands to this one handler object. Its
  // post-commit hook (defined below, once the outbox executor exists) wakes the
  // executor from the commit that produced the event, not from EventLog.
  const commandHandler = {
    execute(envelope, attribution) {
      return executeProductionCommand(envelope, attribution);
    },
  };
  const runs = createRunController({
    backendFactory: effectiveBackendFactory,
    events,
    runtimeDir,
    prepareWorkDir: prepareRunWorkDir,
    prepareNarration: async (pkg, { workDir, outputDir, runId }) => {
      const prepared = await prepareRunNarration({ pkg, workDir, outputDir, packageDir: dirname(store.path(pkg.id)) });
      if (prepared.extendedScenes?.length) {
        events.publish({ type: 'run.log', runId, line: `Measured narration adjusted ${prepared.extendedScenes.length} shot(s) within the accepted duration range; final timeline is ${(prepared.durationInFrames / (pkg.format?.fps ?? 30)).toFixed(2)}s.` });
      }
      return prepared;
    },
    onComplete: completeRun,
    isBusy: () => Boolean(pipelines?.active()),
    productionStore,
    ledgerFor: ({ productionId }) => {
      if (typeof productionId !== 'string' || productionId === '') return null;
      const production = productionStore.read(productionId);
      if (!production) return null;
      return createBudgetLedger({ runtimeDir, ledgerId: production.budgetLedgerId });
    },
  });
  // IP26: chat is a thin adapter over the same run path. A package bound to a
  // production never starts a paid run from chat, not even with a legacy plan
  // hash approval: the production plan card dispatches the IP20 action slot.
  // The binding is resolved here from the production journal, never from the
  // request.
  // UX01: resolve the owner through the frozen contract, including an inline
  // pkg.productionId. The production object stays the shape the chat adapter
  // already consumes; the decision is never a second store scan. UX21F: a
  // journal failure refuses with productionBindingFor's typed 503 instead of
  // silently looking unbound, so chat cannot fall through to a paid run.
  const findBoundProduction = (pkgOrId) => {
    const pkg = typeof pkgOrId === 'string' ? { id: pkgOrId } : pkgOrId;
    if (!pkg || typeof pkg.id !== 'string' || pkg.id === '') return null;
    const binding = productionBindingFor(pkg);
    if (!binding) return null;
    return productionStore.read(binding.productionId) ?? null;
  };
  const chatRunController = admission.guardRuns(runs, 'chat.correction');
  const chatRuns = {
    estimate: (...args) => runs.estimate(...args),
    status: (...args) => runs.status(...args),
    start: async (options = {}) => {
      const bound = findBoundProduction(options?.pkg);
      if (bound) return { approvalRequired: true, planHash: null, productionId: bound.id };
      return chatRunController.start(options);
    },
  };
  // IP26 (A01): chat gets the run controller, takes, events and measured options
  // so a confirmed clip correction reaches the same coordinator as the routes.
  const projectChat = createProjectChat({
    runtimeDir,
    store,
    providerSettings,
    prepareBrand,
    takeStore,
    runs: chatRuns,
    events,
    measuredFor: pkg => measuredOptionsFromDir(dirname(store.path(pkg.id))),
    production: {
      findBound: findBoundProduction,
      read: productionId => productionStore.read(productionId),
      command: (envelope, attribution) => commandHandler.execute(envelope, attribution),
      proposeCorrection: async ({ productionId, pkg, sceneIds, commandId, userEventId }) => {
        const production = productionStore.read(productionId);
        if (!production) throw Object.assign(new Error('production not found'), { status: 404 });
        const described = planFromPackage({
          pkg,
          level: production.iteration?.policy?.level ?? production.iteration?.level ?? 'draft',
          compute: 'colab', productionId, revision: production.revision,
          onlyShotIds: sceneIds,
        });
        return productionActions.propose({
          productionId,
          body: {
            commandId, idempotencyKey: commandId,
            expected: { productionRevision: production.revision },
            payload: {
              planId: `plan_${randomUUID().replaceAll('-', '')}`, revision: 0,
              reservationCeiling: described.reservationCeiling, collectAndStopReserve: 0,
              requiredDecisions: described.requiredDecisions, actions: described.actions,
            },
          },
          context: { actor: 'user', userEventId },
        });
      },
    },
  });
  // UX10/UX15: a package owned by a production reaches take, select, revert and
  // export through the production command path. A conflict or a claimed but
  // missing production refuses instead of falling back to legacy execution.
  function productionBindingFor(pkg) {
    let binding;
    try {
      binding = admission.binding(pkg);
    } catch (error) {
      const refusal = new Error('the production journal is not available');
      refusal.status = 503;
      refusal.code = 'BOUND_AUTHORITY_UNAVAILABLE';
      refusal.cause = error;
      throw refusal;
    }
    if (!binding || binding.state === 'unbound') return null;
    if (binding.state === 'conflict') {
      const refusal = new Error('the package names a different production than the one that owns it');
      refusal.status = 409;
      refusal.code = 'PRODUCTION_MISMATCH';
      throw refusal;
    }
    if (typeof binding.productionId !== 'string' || productionStore.read(binding.productionId) === null) {
      const refusal = new Error('production not found');
      refusal.status = 409;
      refusal.code = 'PRODUCTION_NOT_FOUND';
      throw refusal;
    }
    return {
      productionId: binding.productionId,
      context: { actor: 'user', userEventId: `ue_${randomUUID()}` },
      handler: commandHandler,
    };
  }
  // A9: the export bundle is the final render — 1920×1080 and, when the package carries x2
  // upscaled variants (H12), the variant files. The Player preview and /api/render keep the
  // package's working resolution.
  const exportRender = (packagePath, outputPath, opts = {}) => render(packagePath, outputPath, { ...opts, final: true });
  const exporter = createExporter({ exportsDir, render: exportRender });
  // RL06: one shared slot (RL05's coordinator) for export, full render and the two scene
  // render routes. The lease is taken before the request body is read, so a second request
  // is refused as busy instead of starting a second job on the same CPU/GPU budget.
  const operations = createOperationCoordinator();

  // RL10c: the pipeline controller takes the same shared slot for the whole life of a Google
  // Colab generation run, so an export or a render during the run is refused with the holder
  // instead of starting a second job on the same budget.
  const pipelines = createPipelineController({
    runtimeDir, events, stageInputs: stagePipelineInputs,
    ...(pipelineLaunch ? { launch: pipelineLaunch } : {}),
    operations,
    isBusy: () => Boolean(runs.status().activeRunId),
  });

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

  // IP54: the single final-delivery gate. Every render/export caller — the four
  // route handlers and the full pipeline below — admits through this one
  // function, so the clip rule and the override journal cannot drift per route.
  // Returns null when the render may proceed, or {status, body} when it must not.
  function finalDeliveryGate(pkg, body, pathname) {
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

  // UX01: the queue drain is one named entry point. A bound package refuses
  // there instead of starting an unguarded paid run.
  const queuedRunController = admission.guardRuns(runs, 'take.queue_drain');

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
      result = await queuedRunController.start({
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
    // UX01: an unbound regeneration still runs through the controller; a bound
    // one is dispatched as a take.request command by the production binding.
    runs: admission.guardRuns(runs, 'take.regenerate'),
    production: productionBindingFor,
    events,
    mediaTickets,
    measuredFor: pkg => measuredOptionsFromDir(dirname(store.path(pkg.id))),
  });
  const thumbRoutes = createThumbRoutes({ store, takeStore, runtimeDir, mediaTickets });
  const sceneCacheDir = (packageId) => join(runtimeDir, 'scene-cache', packageId);

  // RL11: the export and render routes live in src/routes/render.mjs. This is a pure
  // delegation: the handlers, the shared operation slot and the C13 rendered-timeline
  // bookkeeping are the route module's, the wiring stays here.
  // IP19/IP20: production commands, action plans and dispatch. The authenticated
  // local user is the only actor. Headers are not an identity source, and there
  // is no default spend cap — the ledger stays uncapped until the user sets one.
  // A failed Google Colab run with unknown usage settles its full reservation
  // in the ledger; dispatch only reserves.
  const productionActions = createActionCoordinator({
    store: productionStore,
    handler: commandHandler,
    ledgerFor: (production) => createBudgetLedger({
      runtimeDir,
      ledgerId: production.budgetLedgerId,
    }),
  });

  // VX15: the production's package is read-only here. The gate maps a plate to
  // the scene that names it, then the scene's cast id to the character record
  // whose approved prompt audition must still pin the current seed+description.
  const packageForProduction = (production) => {
    const packageId = production?.packageId;
    if (typeof packageId !== 'string' || packageId === '') return null;
    try {
      return store.read(packageId);
    } catch {
      return null;
    }
  };

  // UX03: the outbox is the only path from a dispatched action to the pipeline.
  // Durable attempt identity lives in the adapter; the executor claims each
  // entry, adopts an attributed run before dispatching, and never contacts
  // Google Colab itself.
  const pipelineAdapter = createPipelineAdapter({ store: productionStore, controller: pipelines });
  const outboxExecutor = createOutboxExecutor({
    store: productionStore,
    adapter: pipelineAdapter,
    packageFor: packageForProduction,
    ledgerFor: (production) => createBudgetLedger({
      runtimeDir,
      ledgerId: production.budgetLedgerId,
    }),
  });
  /**
   * One stable surface for an outbox failure: the operator log carries a single
   * prefix, and the EventLog carries a typed event the activity panel can show.
   */
  function reportExecutionFailure(productionId, code, error) {
    const message = typeof error === 'string'
      ? error
      : typeof error?.message === 'string' && error.message !== ''
        ? error.message
        : 'outbox execution failed';
    const resolvedCode = typeof code === 'string' && code !== ''
      ? code
      : typeof error?.code === 'string' && error.code !== ''
        ? error.code
        : 'OUTBOX_EXECUTION_FAILED';
    console.error('[ux03-outbox]', productionId, message);
    try {
      events.publish({
        type: 'production.execution_error',
        productionId,
        code: resolvedCode,
        message,
      });
    } catch (publishError) {
      console.error('[ux03-outbox]', productionId, publishError?.message ?? 'event publish failed');
    }
  }

  /**
   * The executor needs the pipeline input the production approved. It is
   * derived from the latest trusted plan slot, never from a caller-supplied
   * body. A slot that does not name its backend and finite ceiling is refused
   * instead of being filled with Google Colab defaults.
   */
  function pipelineDrainContext(productionId, actionId = null) {
    const production = productionStore.read(productionId);
    if (!production) return { refused: 'PRODUCTION_UNAVAILABLE' };
    const pkg = packageForProduction(production);
    if (!pkg) return { refused: 'PACKAGE_UNAVAILABLE' };
    let journal;
    try {
      journal = productionStore.readEvents(productionId);
    } catch (error) {
      return { refused: 'JOURNAL_UNAVAILABLE', error };
    }
    let action = null;
    for (const event of journal) {
      if (event.type !== 'action.state_changed' || !event.data?.id) continue;
      if (actionId && event.data.id !== actionId) continue;
      action = action && action.id === event.data.id ? { ...action, ...event.data } : event.data;
    }
    if (!action) return { refused: 'ACTION_UNAVAILABLE' };
    let slot = null;
    for (const event of journal) {
      if (event.type !== 'plan.proposed' || !Array.isArray(event.data?.actions)) continue;
      if (event.data.id !== action.planId && event.data.planHash !== action.planHash) continue;
      slot = event.data.actions.find(candidate => candidate?.id === action.id) ?? slot;
    }
    if (!slot || typeof slot.backendId !== 'string' || slot.backendId === '' || !Number.isFinite(slot.upperBound)) {
      return { refused: 'SLOT_INCOMPLETE' };
    }
    // Input comes only from the approved slot. There is no request-body or
    // environment fallback here.
    const input = { backendId: slot.backendId, budgetUnits: slot.upperBound };
    // Spend authority was consumed by the IP20 coordinator before this drain
    // (see productions/pipeline-adapter.mjs). The hash is redeemed only for an
    // action that dispatch already moved out of planning.
    if (action.state === 'queued' || action.state === 'dispatching') {
      try {
        const plan = planPipeline(pkg, input, { env: process.env });
        if (plan.ready && plan.requiresApproval) input.approvedPlanHash = plan.planHash;
      } catch (error) {
        // The drain still runs; the adapter records the typed refusal. The
        // preflight reason is reported by the caller so it is not swallowed.
        return {
          pkg,
          input,
          sourceDir: dirname(store.path(pkg.id)),
          preflightError: error?.message ?? 'pipeline preflight failed',
        };
      }
    }
    return { pkg, input, sourceDir: dirname(store.path(pkg.id)) };
  }

  // UX21F2: a cancel drain carries no dispatch authority. dispatchEntry sees
  // no package and leaves any pending dispatch entry untouched, while
  // cancelEntry reads the action id from its own outbox payload and runs.
  const CANCEL_ONLY_DRAIN = Object.freeze({ pkg: false });

  /**
   * UX21F: the one post-commit hook at the command boundary. Production
   * commands commit to the production journal and never publish to EventLog,
   * so the commit result is the only reliable wake-up. Duplicates replay a
   * recorded commit and must not drain or fan out a second time.
   */
  function executeProductionCommand(envelope, attribution) {
    const result = productionCommands.execute(envelope, attribution);
    if (!result || result.committed !== true || result.duplicate === true) return result;
    const productionId = result.productionId;
    for (const event of result.events ?? []) {
      if (event?.type === 'production.cancelled'
        || (event?.type === 'production.intent_changed' && event.data?.intent === 'cancel_requested')) {
        Promise.resolve(outboxExecutor.onEvent({ ...event, productionId }))
          .catch(error => reportExecutionFailure(productionId, 'CANCEL_FANOUT_FAILED', error));
      }
    }
    const outboxIds = Array.isArray(result.outboxIds) ? result.outboxIds : [];
    if (outboxIds.length > 0) {
      // UX21F2: action.cancel/action.retry name their durable action in the
      // command payload; result.action is only a fallback for a commit shape
      // that does not carry the command envelope.
      const payloadActionId = result.command?.payload?.actionId;
      const actionId = typeof payloadActionId === 'string' && payloadActionId !== ''
        ? payloadActionId
        : (result.action?.id ?? null);
      const context = pipelineDrainContext(productionId, actionId);
      if (result.command?.kind === 'action.cancel') {
        // A cancel commit owns its cancel effect, not dispatch authority. When
        // the dispatch context is refused (for example SLOT_INCOMPLETE) or
        // another slot has a dispatch entry pending, withhold the package so
        // dispatchEntry refuses without starting anything while cancelEntry,
        // which reads only its own outbox payload, still acknowledges the
        // cancel. This is the same drain, never a second path.
        let otherDispatchPending = false;
        try {
          otherDispatchPending = productionStore.pending(productionId)
            .some(entry => entry?.type === 'action.dispatch' && (entry.payload?.actionId ?? null) !== actionId);
        } catch (error) {
          reportExecutionFailure(productionId, 'OUTBOX_PENDING_UNAVAILABLE', error);
          otherDispatchPending = true;
        }
        const cancelContext = context.refused || otherDispatchPending ? CANCEL_ONLY_DRAIN : context;
        Promise.resolve(outboxExecutor.drainProduction(productionId, cancelContext))
          .catch(error => reportExecutionFailure(productionId, 'OUTBOX_DRAIN_FAILED', error));
      } else if (context.refused) {
        reportExecutionFailure(productionId, context.refused, context.error ?? `outbox drain refused: ${context.refused}`);
      } else {
        if (context.preflightError) {
          reportExecutionFailure(productionId, 'PLAN_PREFLIGHT_FAILED', context.preflightError);
        }
        Promise.resolve(outboxExecutor.drainProduction(productionId, context))
          .catch(error => reportExecutionFailure(productionId, 'OUTBOX_DRAIN_FAILED', error));
      }
    }
    return result;
  }

  // Startup recovery: reconcile actions that already claimed execution. A
  // queued action is started by its dispatch or a later production event, not
  // by merely opening the app, so a restart cannot spend without a live claim.
  setImmediate(() => {
    for (const production of productionStore.list()) {
      Promise.resolve(outboxExecutor.reconcileProduction({ productionId: production.id }))
        .catch(error => reportExecutionFailure(production.id, 'RECONCILE_FAILED', error));
    }
  });

  const conversationCastFor = (conversationId) => {
    if (typeof conversationId !== 'string' || conversationId === '') return [];
    try {
      const session = JSON.parse(readFileSync(join(runtimeDir, 'conversations', `${conversationId}.json`), 'utf8'));
      return Array.isArray(session?.cast) ? session.cast : [];
    } catch {
      return [];
    }
  };

  const charactersForProduction = (production) => {
    const pkg = packageForProduction(production);
    const characters = new Map();
    const explicit = new Map();
    for (const entry of conversationCastFor(production?.conversationId)) {
      if (!entry || typeof entry.castId !== 'string' || typeof entry.characterId !== 'string') continue;
      explicit.set(entry.castId, entry.characterId);
    }
    for (const entry of Array.isArray(pkg?.cast) ? pkg.cast : []) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.characterId !== 'string') continue;
      if (!explicit.has(entry.id)) explicit.set(entry.id, entry.characterId);
    }
    for (const [castId, characterId] of explicit) {
      let character = null;
      try { character = characterStore.get(characterId); } catch { character = null; }
      if (character) characters.set(castId, character);
    }
    let library = [];
    try { library = characterStore.list(); } catch { library = []; }
    for (const character of library) {
      if (!character || typeof character.handle !== 'string') continue;
      let castId;
      try { castId = castIdFor(character.handle); } catch { continue; }
      if (!characters.has(castId)) characters.set(castId, character);
    }
    return characters;
  };

  const productionCoordinator = createProductionCoordinator({
    store: productionStore,
    actions: productionActions,
    handler: commandHandler,
    pkg: packageForProduction,
    characters: charactersForProduction,
  });

  // IP20 keeps propose/getAction; dispatch goes through the IP21 coordinator so
  // VX15's prompt-voice gate runs before any reservation or hold.
  const productionRouteActions = Object.freeze({
    propose: (args) => productionActions.propose(args),
    getAction: (args) => productionActions.getAction(args),
    dispatch: (args) => {
      const result = productionCoordinator.dispatch(args);
      // UX03/UX21F: actions.dispatch commits its outbox entry inside the action
      // coordinator, so this is the one drain trigger for a dispatch. Command
      // commits reached through commandHandler are drained by its post-commit
      // hook instead; there is no second path for either kind.
      if (result && typeof args?.productionId === 'string') {
        const context = pipelineDrainContext(args.productionId, result?.action?.id ?? null);
        if (context.refused) {
          reportExecutionFailure(args.productionId, context.refused,
            context.error ?? `outbox drain refused: ${context.refused}`);
        } else {
          if (context.preflightError) {
            reportExecutionFailure(args.productionId, 'PLAN_PREFLIGHT_FAILED', context.preflightError);
          }
          Promise.resolve(outboxExecutor.drainProduction(args.productionId, context))
            .catch(error => reportExecutionFailure(args.productionId, 'OUTBOX_DRAIN_FAILED', error));
        }
      }
      return result;
    },
  });

  // IP45K: one free Kokoro path for the app's lifetime. The probe is lazy and
  // cached, so createApp stays synchronous and a box without kokoro_onnx keeps
  // answering 503. Paid auditions still need a named, approved IP20 slot.
  const defaultAuditionSynth = (() => {
    let synth = null;
    let probe = null;
    return async (request) => {
      if (probe === null) probe = probeKokoroRuntime();
      if (!(await probe)) {
        return { ok: false, code: 'AUDITION_UNAVAILABLE', message: 'Kokoro is not available on this server' };
      }
      if (!synth) {
        synth = createKokoroSynth({
          cacheDir: join(runtimeDir, 'kokoro-auditions'),
          python: process.env.COMFYRIZZ_PYTHON || 'python3',
        });
      }
      return synth(request);
    };
  })();
  const auditionWorker = createAuditionWorker({
    cache: createAuditionCache({
      rootDir: runtimeDir,
      synth: { kokoro: typeof auditionSynth === 'function' ? auditionSynth : defaultAuditionSynth },
    }),
    productionStore,
    ledgerFor: (production) => createBudgetLedger({
      runtimeDir,
      ledgerId: production.budgetLedgerId,
    }),
  });
  const productionRoutes = createProductionRoutes({
    store: productionStore,
    handler: commandHandler,
    actions: productionRouteActions,
    contextFor: () => ({
      actor: 'user',
      userEventId: `ue_${randomUUID()}`,
    }),
    ledgerFor: (production) => createBudgetLedger({
      runtimeDir,
      ledgerId: production.budgetLedgerId,
    }),
    readPackage: (packageId) => {
      try { return store.read(packageId); } catch { return null; }
    },
    estimateFinalRun: async ({ productionId }) => {
      const production = productionStore.read(productionId);
      if (!production?.packageId) throw new Error('the final plan has no bound package');
      const pkg = store.read(production.packageId);
      // The browser's easy-plan ceiling is only a placeholder. Price against the
      // user-configured production cap, then replace that placeholder with the estimate.
      const pricingBudget = createBudgetLedger({ runtimeDir, ledgerId: production.budgetLedgerId }).status().ceiling ?? Number.MAX_SAFE_INTEGER;
      const estimated = await runs.estimate({ backendId: 'colab', pkg, budgetUnits: pricingBudget });
      const required = estimated.budget?.required;
      if (!Number.isFinite(required) || required <= 0) throw new Error('the final run could not be priced');
      if (estimated.budget?.allowed === false) {
        const error = new Error(`the final run needs ${required.toFixed(2)} Google Colab credits, above the configured ${pricingBudget}-credit cap`);
        error.code = 'BUDGET_EXCEEDED';
        throw error;
      }
      return required;
    },
    onError: (error, context) => {
      console.error(`[productions ${context.route} ${context.productionId}]`, error);
    },
  });

  const renderRoutes = createRenderRoutes({
    store,
    events,
    exporter,
    render,
    renderScene,
    qa,
    rendersDir,
    sceneCacheDir,
    operations,
    renderGate: finalDeliveryGate,
    runtimeDir,
    // UX15/UX10: bound delivery takes the production command path instead of
    // the legacy export route.
    production: productionBindingFor,
    reviewStarted: pkg => {
      try {
        return takeStore.read(pkg.id) != null;
      } catch {
        return true;
      }
    },
    draftRenderTarget,
    resolveRenderTarget,
    sendJson,
    readJson,
  });

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

    if (await thumbRoutes.handle(request, response, url)) return;

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
    if (url.pathname === '/api/pipeline/diagnostics' && request.method === 'GET') {
      return sendJson(response, 200, syncnetDiagnostics());
    }
    if (['/api/pipeline/plan', '/api/pipeline'].includes(url.pathname) && request.method === 'POST') {
      const body = await readJson(request);
      const pkg = body.packageId ? store.read(body.packageId) : null;
      if (!pkg) return sendJson(response, 404, { error: 'package not found' });
      if (body.baseRevision !== pkg.revision) return sendJson(response, 409, { error: 'revision conflict', currentRevision: pkg.revision });
      if (!url.pathname.endsWith('/plan')) {
        const gate = finalDeliveryGate(pkg, body, url.pathname);
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
    if (await handleHfTokenRoutes({ request, response, url, settings: hfTokenSettings, readJson, sendJson })) return;

    const chatRecoveryMatch = /^\/api\/agent\/chat\/([^/]+)\/recovery$/.exec(url.pathname);
    if (chatRecoveryMatch && request.method === 'POST') {
      try {
        let conversationId = chatRecoveryMatch[1];
        try { conversationId = decodeURIComponent(conversationId); } catch { throw Object.assign(new Error('Invalid conversation ID'), { status: 400 }); }
        return sendJson(response, 200, projectChat.resolveRecovery(conversationId, await readJson(request)));
      } catch (error) {
        return sendJson(response, error.status ?? 502, {
          error: providerSettings ? providerSettings.redact(error.message) : error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.recoveryConflict ? { recoveryConflict: error.recoveryConflict } : {}),
        });
      }
    }

    const chatMatch = /^\/api\/agent\/chat(?:\/([^/]+))?$/.exec(url.pathname);
    if (chatMatch) {
      let conversationProgress = null;
      try {
        if (request.method === 'GET' && chatMatch[1]) return sendJson(response, 200, projectChat.get(chatMatch[1]));
        if (request.method === 'POST' && !chatMatch[1]) {
          const body = await readJson(request);
          const progressId = typeof body.turnId === 'string' && body.turnId ? body.turnId : `chat_${randomUUID()}`;
          conversationProgress = trackConversationProgress(progressId, typeof body.message === 'string' ? body.message : '');
          const result = await projectChat.send(body, { onEvent: conversationProgress.onEvent });
          conversationProgress.finish('done');
          return sendJson(response, 200, result);
        }
        return sendJson(response, 405, { error: 'method not allowed' });
      } catch (error) {
        conversationProgress?.finish('failed', error.message);
        return sendJson(response, error.status ?? 502, {
          error: providerSettings ? providerSettings.redact(error.message) : error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.recoveryConflict ? { recoveryConflict: error.recoveryConflict } : {}),
        });
      }
    }

    // U2: the settings card's read-only view of the Google Colab CLI - installed or not, signed in or
    // not, and the units a run will be measured against. Read-only on purpose: the sign-in itself is a
    // separate route that streams the CLI's own prompt, and the token never passes through here.
    if (url.pathname === '/api/colab/status' && request.method === 'GET') {
      const status = await colabStatus({ backendFactory, hfSettings: hfTokenSettings });
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
            events?.publish?.({ type: 'colab_auth', line });
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
        const runDefaults = store.runDefaults(id);
        return sendJson(response, 200, { package: pkg, revision: pkg.revision,
          ...(editor ? { editor } : {}), ...(runDefaults ? { runDefaults } : {}) });
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

    if (url.pathname === '/api/agent/progress' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (!sessionId) {
        const latest = Array.from(agentProgress.values()).at(-1);
        if (latest) return sendJson(response, 200, latest.snapshot());
        const progressDir = join(runtimeDir, 'agent-progress');
        const files = existsSync(progressDir)
          ? readdirSync(progressDir).filter(file => file.endsWith('.json')).sort((left, right) => {
              try {
                return statSync(join(progressDir, right)).mtimeMs - statSync(join(progressDir, left)).mtimeMs;
              } catch {
                return 0;
              }
            })
          : [];
        if (files.length > 0) {
          try {
            return sendJson(response, 200, JSON.parse(readFileSync(join(progressDir, files[0]), 'utf8')));
          } catch {
            // Fall through to the same not-found response as an empty registry.
          }
        }
        return sendJson(response, 404, { error: 'no planning sessions found' });
      }
      const progress = agentProgress.get(sessionId);
      if (!progress) return sendJson(response, 404, { error: 'planning session not found' });
      return sendJson(response, 200, progress.snapshot());
    }

    if (url.pathname === '/api/agent' && request.method === 'POST') {
      if (!agentRunner) return sendJson(response, 503, { error: 'agent runner not configured' });
      const body = await readJson(request);
      // PS03: an unsatisfiable brief is refused here, before any planning tool
      // call or provider spend. The response carries a typed code and details.
      const refusal = preflightBrief(body);
      if (refusal) {
        return sendJson(response, refusal.status, {
          error: refusal.message,
          code: refusal.code,
          details: refusal.details,
          reason: refusal.reason,
          conflict: refusal.conflict,
          next_steps: refusal.next_steps,
        });
      }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : randomUUID();
      const progress = createAgentProgress(sessionId);
      const progressDir = join(runtimeDir, 'agent-progress');
      mkdirSync(progressDir, { recursive: true });
      const progressFile = join(progressDir, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
      const persistProgress = () => writeFileSync(progressFile, JSON.stringify(progress.snapshot(), null, 2));
      progress.update({ type: 'request', brief: typeof body.brief === 'string' ? body.brief : '' });
      persistProgress();
      if (agentProgress.size >= 100) agentProgress.delete(agentProgress.keys().next().value);
      agentProgress.set(sessionId, progress);
      events.publish({ type: 'agent.started', sessionId, brief: typeof body.brief === 'string' ? body.brief.slice(0, 160) : null });
      try {
        const brand = body.brand ? prepareBrand(body.brand, { assetsDir: join(runtimeDir, 'packages', 'assets') }) : null;
        const result = await agentRunner({
          brief: body.brief,
          ...(brand ? { brand } : {}),
          provider: body.provider,
          model: body.model,
          motionModel: body.motionModel,
          thinking: body.thinking,
          sessionId,
          runtimeDir,
          onEvent: event => {
            progress.update(event);
            if (event.type !== 'text') persistProgress();
            events.publish({ type: 'agent.event', sessionId, event });
          },
        });
        const saved = store.write(result.package);
        const timeline = compilePackage(saved, dirname(store.path(saved.id)));
        progress.finish('done');
        persistProgress();
        events.publish({ type: 'agent.finished', sessionId, packageId: saved.id, revision: saved.revision, svgAssets: result.svgAssets?.length ?? 0, live: Boolean(result.live) });
        return sendJson(response, 200, {
          sessionId,
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
          usage: result.usage ?? { input: 0, output: 0, total: 0 },
        });
      } catch (error) {
        progress.finish('failed', error.message);
        persistProgress();
        events.publish({ type: 'agent.failed', sessionId, message: error.message });
        return sendJson(response, error.status ?? 500, {
          sessionId,
          error: error.message,
          usage: progress.snapshot().usage,
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
          // IP24: one input shape. A bound package starts only with the IP20
          // authority and the revision it was dispatched against.
          authority: body.authority,
          expected: body.expected,
        });
        const status = Number.isSafeInteger(result.status) && result.status >= 400 ? result.status : 200;
        return sendJson(response, status, result);
      } catch (error) {
        return sendJson(response, Number.isInteger(error?.status) ? error.status : 400, {
          error: error.message,
          ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        });
      }
    }

    if (url.pathname === '/api/run' && request.method === 'GET') {
      return sendJson(response, 200, runs.status());
    }

    // UX01/UX03: cancellation is the run controller's retained abort handle.
    // A terminal or unknown run answers idempotently; a bound run's action is
    // settled by the controller, not by a second cancel path.
    const runCancelMatch = /^\/api\/run\/([^/]+)\/cancel$/.exec(url.pathname);
    if (runCancelMatch && request.method === 'POST') {
      let runId;
      try {
        runId = decodeURIComponent(runCancelMatch[1]);
      } catch {
        return sendJson(response, 400, { error: 'bad run id', code: 'INVALID_RUN_ID' });
      }
      const result = runs.cancel(runId);
      if (!result) return sendJson(response, 404, { error: 'run not found', code: 'RUN_NOT_FOUND' });
      return sendJson(response, 200, result);
    }

    if (url.pathname === '/api/run/approve' && request.method === 'POST') {
      const body = await readJson(request);
      // IP24: a plan that lives in a production journal is approved (or
      // rejected) through the production command path, never by this legacy
      // in-memory set. Refusing here keeps one authority per plan hash.
      if (typeof body?.planHash === 'string' && body.planHash !== '') {
        for (const production of productionStore.list()) {
          const journaled = productionStore.readEvents(production.id)
            .some(event => event.type === 'plan.proposed' && event.data?.planHash === body.planHash);
          if (journaled) {
            return sendJson(response, 409, {
              error: 'this plan is bound to a production; approve it through the production command path',
              code: 'PLAN_BOUND_TO_PRODUCTION',
            });
          }
        }
      }
      try {
        return sendJson(response, 200, runs.approve(body.planHash));
      } catch (error) {
        return sendJson(response, 400, {
          error: error.message,
          ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        });
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

    // RL11: the export and render routes live in src/routes/render.mjs: /api/export,
    // /api/render, /api/scene/render and /api/render/edited.
    if (await renderRoutes.handle(request, response, url)) return;

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

    if (await createConversationRoutes({ rootDir: runtimeDir }).handle(request, response, url)) return;
    if (await createPackageRoutes({ packagesDir: store.dir }).handle(request, response, url)) return;
    if (await iterationRoutes.handle(request, response, url)) return;
    if (await productionRoutes.handle(request, response, url)) return;
    if (await takeRoutes.handle(request, response, url)) return;
    if (await createCharacterRoutes({
      rootDir: runtimeDir,
      store: characterStore,
      events,
      mediaTickets,
      audition: { worker: auditionWorker },
    }).handle(request, response, url)) return;
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
        if ((error.status ?? 500) >= 500) console.error('[app request]', error);
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
