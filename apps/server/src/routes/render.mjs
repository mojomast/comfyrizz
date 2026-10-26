/**
 * RL11: the export and render routes.
 *
 * /api/export, /api/render, /api/scene/render and /api/render/edited live here so the
 * server entry point (app.mjs) only delegates to them. The handlers are the ones app.mjs
 * carried before, moved as they were: the shared operation slot (RL05) is taken before the
 * request body is read (RL06) and a running Google Colab pipeline owns the same slot
 * (RL10c), so a second export or render is refused with the holder instead of starting a
 * second job on the same budget.
 *
 * The module owns one piece of state: the last successfully rendered timeline per package
 * (C13), so an edit can be diffed against what the frame grid actually was. No secrets:
 * the API token and the provider keys never reach it.
 */
import { createReadStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildVariants } from '../variant.mjs';
import { runFrameQa } from '../qa.mjs';
import { sceneAssetIds } from '../scene.mjs';
import { packageTimeline, timingChangeReason } from '../edit.mjs';
import { measuredOptionsFromDir } from '../compile-package.mjs';
import { loadCompositionManifest } from '../../../../packages/compositions/src/index.mjs';
import { createDeliverySnapshot, preflightDelivery } from '../productions/delivery-snapshot.mjs';
import { readEditor, validateEditor } from '../editor-sidecar.mjs';

/**
 * IP54: the one table of final-delivery callers owned by this module. A route
 * outside this list is not a delivery route; a route added here must go through
 * `admitRender`, which is the only path from these handlers to a renderer or
 * exporter. The full production pipeline is the fifth caller and is gated in
 * app.mjs with the same readiness function.
 */
export const DELIVERY_ROUTE_PATHS = Object.freeze([
  '/api/export',
  '/api/render',
  '/api/scene/render',
  '/api/render/edited',
]);

const DELIVERY_ROUTE_SET = new Set(DELIVERY_ROUTE_PATHS);

/**
 * Hand the renderer an AbortSignal. Production renderers run that work on a
 * worker and kill the Remotion child when the signal aborts. A test double
 * that ignores the signal stays on this thread. Which function it is does not
 * matter: there is no name check.
 */
function startRender(renderFn, packagePath, outputPath, options) {
  const abort = new AbortController();
  let settled = false;
  const promise = Promise.resolve()
    .then(() => renderFn(packagePath, outputPath, { ...options, signal: abort.signal }))
    .then(result => {
      if (abort.signal.aborted) {
        const error = new Error('render cancelled');
        error.code = 'RENDER_CANCELLED';
        throw error;
      }
      return result;
    })
    .finally(() => { settled = true; });
  return {
    promise,
    signal: abort.signal,
    cancel() {
      if (settled) return;
      abort.abort();
    },
  };
}

function isCancelled(error, signal) {
  return Boolean(signal?.aborted) || error?.code === 'RENDER_CANCELLED' || error?.message === 'render cancelled';
}

export function createRenderRoutes(options = {}) {
  const {
    store,
    events,
    exporter,
    render,
    renderScene,
    qa,
    rendersDir,
    sceneCacheDir,
    operations,
    renderGate,
    readiness,
    draftRenderTarget,
    resolveRenderTarget,
    sendJson,
    readJson,
    production,
    reviewStarted,
    requireReadiness = false,
    runtimeDir,
  } = options;

  const productionFor = typeof production === 'function' ? production : null;
  const reviewProbe = typeof reviewStarted === 'function' ? reviewStarted : null;
  // IP25: a caller may inject the shared readiness under its own name; otherwise
  // the render gate app.mjs already owns is the one shared readiness.
  const sharedReadiness = typeof readiness === 'function' ? readiness : renderGate;

  if (!store || typeof store.read !== 'function') throw new TypeError('createRenderRoutes requires a package store');
  if (!events || typeof events.publish !== 'function') throw new TypeError('createRenderRoutes requires an event log');
  if (!exporter || typeof exporter !== 'function') throw new TypeError('createRenderRoutes requires an exporter');
  if (typeof render !== 'function' || typeof renderScene !== 'function') {
    throw new TypeError('createRenderRoutes requires the render and the scene renderer');
  }
  if (!operations || typeof operations.tryAcquire !== 'function') throw new TypeError('createRenderRoutes requires an operation coordinator');
  if (typeof sendJson !== 'function' || typeof readJson !== 'function') {
    throw new TypeError('createRenderRoutes requires the JSON helpers');
  }

  // C13: the last successfully rendered timeline per package, so an edit can be diffed
  // against what the frame grid actually was. In-memory: a server restart just makes the
  // next edit a first render (the A6 cache still reuses unchanged segments).
  const lastRendered = new Map();

  /**
   * Take the shared slot for one request. Before a render starts, a client that
   * goes away releases the slot. Once a render is running, close cancels that
   * render and the slot stays taken until `release` (after the child exits).
   */
  function holdOperation(kind, id, response) {
    const lease = operations.tryAcquire(kind, id);
    if (lease.busy) return { busy: true, holder: lease.holder };
    let released = false;
    let rendering = false;
    let cancelRender = () => {};
    const release = () => {
      if (released) return;
      released = true;
      rendering = false;
      lease.release();
    };
    response.once('finish', release);
    response.once('close', () => {
      if (released) return;
      if (rendering) cancelRender();
      else release();
    });
    return {
      busy: false,
      holder: null,
      release,
      endRender() { rendering = false; },
      beginRender(cancel) {
        // The request stream is destroyed once its body has been read. That is
        // not the client going away; only the response closing is.
        if (released || response.destroyed || response.writableEnded) {
          release();
          const error = new Error('render cancelled');
          error.code = 'RENDER_CANCELLED';
          throw error;
        }
        rendering = true;
        cancelRender = typeof cancel === 'function' ? cancel : () => {};
      },
    };
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function intentFor(body) {
    const value = body?.intent;
    if (value === undefined || value === null) return 'final';
    if (value !== 'draft' && value !== 'final') {
      const error = new Error("intent must be 'draft' or 'final'");
      error.status = 400;
      error.code = 'INVALID_INTENT';
      throw error;
    }
    return value;
  }

  function editorFor(pkg, body) {
    let candidate;
    if (body?.editor !== undefined) candidate = body.editor;
    else if (body?.captionOverrides !== undefined) candidate = { version: 1, captionOverrides: body.captionOverrides };
    else if (typeof runtimeDir === 'string' && runtimeDir !== '' && typeof pkg?.id === 'string' && pkg.id !== '') {
      try {
        candidate = readEditor(runtimeDir, pkg.id);
      } catch {
        candidate = null;
      }
    }
    if (candidate === undefined || candidate === null) return { editor: null, captionOverrides: [] };
    const checked = validateEditor(candidate);
    if (checked.error) {
      const error = new Error(checked.error);
      error.status = 400;
      error.code = 'INVALID_EDITOR';
      throw error;
    }
    return { editor: checked.editor, captionOverrides: checked.editor?.captionOverrides ?? [] };
  }

  function deliverySnapshotFor(target, body, intent, editor) {
    return createDeliverySnapshot({
      pkg: target.pkg,
      packageDir: dirname(target.packagePath),
      editor,
      editorRevision: body?.editorRevision,
      selections: body?.selections,
      intent,
      format: isPlainObject(body?.format) ? body.format : null,
      archiveMode: body?.archiveMode,
      reviews: body?.reviews,
      references: body?.references,
    });
  }

  function sendRouteError(response, error) {
    const status = Number.isSafeInteger(error?.status) ? error.status : 500;
    return sendJson(response, status, {
      error: error?.message ?? 'render failed',
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(error?.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
    });
  }

  async function productionBinding(pkg) {
    if (!productionFor) return null;
    const binding = await productionFor(pkg);
    if (!binding) return null;
    if (!isPlainObject(binding)
      || typeof binding.productionId !== 'string'
      || binding.productionId === ''
      || !isPlainObject(binding.context)
      || !binding.handler
      || typeof binding.handler.execute !== 'function') {
      const error = new Error('production binding is invalid');
      error.status = 500;
      error.code = 'PRODUCTION_BINDING_INVALID';
      throw error;
    }
    return binding;
  }

  function boundIdentity(body) {
    const commandId = typeof body?.commandId === 'string' && body.commandId.trim() !== ''
      ? body.commandId
      : null;
    const idempotencyKey = typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim() !== ''
      ? body.idempotencyKey
      : null;
    if (!commandId && !idempotencyKey) {
      const error = new Error('commandId or idempotencyKey is required on a production-bound request');
      error.status = 400;
      error.code = 'MISSING_COMMAND_ID';
      throw error;
    }
    return {
      commandId: commandId ?? idempotencyKey,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }

  function boundExpected(body) {
    const expected = isPlainObject(body?.expected) ? body.expected : {};
    if (!Number.isSafeInteger(expected.productionRevision) || expected.productionRevision < 0) {
      const error = new Error('expected.productionRevision is required on a production-bound request');
      error.status = 400;
      error.code = 'PRODUCTION_REVISION_REQUIRED';
      throw error;
    }
    return expected;
  }

  function executeBound(binding, identity, expected, kind, payload) {
    return binding.handler.execute({
      commandId: identity.commandId,
      ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
      kind,
      productionId: binding.productionId,
      expected,
      payload,
    }, binding.context);
  }

  function overrideInfo(body) {
    if (body?.override === undefined) return { provided: false, valid: false, reason: null };
    if (!isPlainObject(body.override)) return { provided: true, valid: false, reason: null };
    const reason = body.override.reason;
    const valid = typeof reason === 'string'
      && reason.length >= 4
      && reason.length <= 500
      && reason.trim().length >= 4;
    return { provided: true, valid, reason: valid ? reason : null };
  }

  /** IP25: whether this package already has a take record to be ready against. */
  function reviewStartedFor(pkg) {
    if (reviewProbe) {
      try {
        return reviewProbe(pkg) === true;
      } catch {
        return true;
      }
    }
    if (typeof pkg?.id !== 'string' || pkg.id === '') return false;
    const base = typeof runtimeDir === 'string' && runtimeDir !== '' ? runtimeDir : dirname(rendersDir);
    return existsSync(join(base, 'takes', `${pkg.id}.json`));
  }

  /**
   * IP25: one readiness admission for every legacy render route. A request is
   * gated when it is production-bound, when the caller asks for it, or when the
   * package already has a take record. A bound request journals gate.override
   * (when used) and render.request through the same command handler; a blocked
   * request journals nothing and never reaches a renderer, exporter or ledger.
   */
  async function admitRender({ pkg, body, pathname, revision, binding, alwaysGate = false, details = {} }) {
    // UX15: an explicit final intent is gated even when no take sidecar exists.
    // Legacy callers without an intent keep their existing admission path.
    const explicitFinal = intentFor(body) === 'final' && body?.intent === 'final';
    const required = alwaysGate
      || explicitFinal
      || Boolean(binding)
      || requireReadiness === true
      || typeof readiness === 'function'
      || reviewStartedFor(pkg);
    if (!required || typeof sharedReadiness !== 'function') {
      return { blocked: null, binding, revision, commandId: null, duplicate: false, overrode: false };
    }

    const identity = binding ? boundIdentity(body) : null;
    const expected = binding ? boundExpected(body) : null;
    const override = overrideInfo(body);

    if (binding && override.provided) {
      if (!override.valid) {
        const gate = sharedReadiness(pkg, body, pathname);
        return {
          blocked: gate ?? {
            status: 400,
            body: { error: 'override.reason must be a string of 4 to 500 characters', code: 'INVALID_OVERRIDE' },
          },
          binding,
          revision,
          commandId: identity.commandId,
          duplicate: false,
          overrode: false,
        };
      }

      const overrideIdentity = {
        commandId: `${identity.commandId}:override`,
        ...(identity.idempotencyKey ? { idempotencyKey: `${identity.idempotencyKey}:override` } : {}),
      };
      const overrideResult = executeBound(binding, overrideIdentity, expected, 'gate.override', {
        path: pathname,
        packageId: pkg.id,
        packageRevision: revision,
        reason: override.reason,
      });

      const gate = sharedReadiness(pkg, body, pathname);
      if (gate) {
        return { blocked: gate, binding, revision: overrideResult.revision, commandId: identity.commandId, duplicate: false, overrode: true };
      }

      const requestResult = executeBound(
        binding,
        identity,
        { productionRevision: overrideResult.revision },
        'render.request',
        {
          path: pathname,
          packageId: pkg.id,
          packageRevision: revision,
          overrode: true,
          ...details,
        },
      );
      return {
        blocked: null,
        binding,
        revision: requestResult.revision,
        commandId: identity.commandId,
        duplicate: requestResult.duplicate === true,
        overrode: true,
      };
    }

    const gate = sharedReadiness(pkg, body, pathname);
    if (gate) {
      return { blocked: gate, binding, revision, commandId: identity?.commandId ?? null, duplicate: false, overrode: false };
    }
    if (!binding) {
      return { blocked: null, binding, revision, commandId: null, duplicate: false, overrode: false };
    }

    const result = executeBound(binding, identity, expected, 'render.request', {
      path: pathname,
      packageId: pkg.id,
      packageRevision: revision,
      ...details,
    });
    return {
      blocked: null,
      binding,
      revision: result.revision,
      commandId: identity.commandId,
      duplicate: result.duplicate === true,
      overrode: false,
    };
  }

  function productionFields(admission) {
    if (!admission?.binding) return {};
    return {
      productionId: admission.binding.productionId,
      productionRevision: admission.revision,
      commandId: admission.commandId,
      ...(admission.duplicate ? { duplicate: true } : {}),
      ...(admission.overrode ? { overrode: true } : {}),
    };
  }

  function productionHeaders(admission) {
    if (!admission?.binding) return {};
    return {
      'x-comfyrizz-production-id': admission.binding.productionId,
      'x-comfyrizz-production-revision': String(admission.revision),
      'x-comfyrizz-command-id': admission.commandId,
      ...(admission.duplicate ? { 'x-comfyrizz-duplicate': '1' } : {}),
      ...(admission.overrode ? { 'x-comfyrizz-gate-override': '1' } : {}),
    };
  }

  async function handleExport(request, response, pathname = '/api/export') {
    // RL10c: a running Google Colab pipeline owns the shared slot, so the coordinator refuses
    // this export with the holder instead of a second job on the same budget.
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
      let abort = null;
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
        let binding;
        let admission;
        let intent;
        let editorInfo;
        try {
          intent = intentFor(body);
          editorInfo = editorFor(pkg, body);
          binding = await productionBinding(pkg);
          admission = await admitRender({
            pkg,
            body,
            pathname,
            revision,
            binding,
            details: body.variants && typeof body.variants === 'object' ? { variants: true } : {},
          });
        } catch (error) {
          return sendRouteError(response, error);
        }
        if (admission.blocked) return sendJson(response, admission.blocked.status, admission.blocked.body);

        events.publish({ type: 'export.started', exportId, packageId: pkg.id, revision });
        abort = new AbortController();
        hold.beginRender(() => abort.abort());
        if (body.variants && typeof body.variants === 'object') {
          // L1: one bundle per language/aspect variant plus a variants.json manifest.
          const plan = buildVariants(pkg, body.variants);
          const result = await exporter.variants({
            pkg,
            packagePath,
            variants: plan,
            force: body.force === true,
            signal: abort.signal,
            onLog: line => events.publish({ type: 'export.log', exportId, line }),
            intent,
            editor: editorInfo.editor,
            editorRevision: body.editorRevision,
            selections: body.selections,
            format: body.format,
            archiveMode: body.archiveMode,
            reviews: body.reviews,
            references: body.references,
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
          return sendJson(response, 200, {
            exportId,
            packageId: pkg.id,
            dir: result.dir,
            manifestPath: result.manifestPath,
            manifest: result.manifest,
            ...productionFields(admission),
          });
        }
        const result = await exporter({
          pkg,
          packagePath,
          revision,
          force: body.force === true,
          signal: abort.signal,
          onLog: line => events.publish({ type: 'export.log', exportId, line }),
          intent,
          editor: editorInfo.editor,
          editorRevision: body.editorRevision,
          selections: body.selections,
          format: body.format,
          archiveMode: body.archiveMode,
          reviews: body.reviews,
          references: body.references,
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
          intent: result.intent,
          deliveryFingerprint: result.snapshot?.fingerprint ?? null,
        });
        return sendJson(response, 200, { exportId, ...result, ...productionFields(admission) });
      } catch (error) {
        hold.endRender?.();
        const cancelled = isCancelled(error, abort?.signal);
        events.publish({
          type: cancelled ? 'export.cancelled' : 'export.failed',
          exportId,
          packageId: pkg?.id,
          message: error.message,
        });
        if (response.writableEnded || response.destroyed) return;
        const preflightCodes = new Set([
          'UNKNOWN_CREATIVE_REVIEW',
          'REJECTED_CREATIVE_REVIEW',
          'DELIVERY_GATE_BLOCKED',
          'DELIVERY_PREFLIGHT_BLOCKED',
          'PROVISIONAL_TIMING',
        ]);
        const status = error.status ?? (preflightCodes.has(error.code) ? 409 : 500);
        return sendJson(response, status, {
          error: error.message,
          exportId,
          ...(typeof error.code === 'string' ? { code: error.code } : {}),
          ...(error.preflight ? { preflight: error.preflight } : {}),
        });
      }
    } finally {
      hold.release();
    }
  }

  async function handleRender(request, response, pathname) {
    // RL10c: a running Google Colab pipeline owns the shared slot, so the coordinator refuses
    // this render with the holder instead of a second job on the same budget.
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

      let binding;
      let admission;
      try {
        binding = await productionBinding(pkg);
        admission = await admitRender({
          pkg,
          body,
          pathname,
          revision,
          binding,
          alwaysGate: true,
        });
      } catch (error) {
        return sendRouteError(response, error);
      }
      if (admission.blocked) return sendJson(response, admission.blocked.status, admission.blocked.body);

      let intent;
      let editorInfo;
      let snapshot;
      let preflight;
      try {
        intent = intentFor(body);
        editorInfo = editorFor(pkg, body);
        snapshot = deliverySnapshotFor({ pkg, packagePath }, body, intent, editorInfo.editor);
        preflight = preflightDelivery(snapshot, { reviews: body.reviews });
      } catch (error) {
        return sendRouteError(response, error);
      }
      if (!preflight.ok) {
        return sendJson(response, 409, {
          error: preflight.blockers[0].message,
          code: preflight.blockers[0].code,
          preflight,
        });
      }

      events.publish({
        type: 'render.started',
        renderId,
        packageId: pkg.id,
        revision,
        intent,
        deliveryFingerprint: snapshot.fingerprint,
      });
      let job;
      try {
        hold.beginRender(() => job?.cancel());
        job = startRender(render, packagePath, output, {
          onLog: line => events.publish({ type: 'render.log', renderId, line }),
          intent,
          deliveryFingerprint: snapshot.fingerprint,
          ...(editorInfo.captionOverrides.length === 0 ? {} : {
            captionOverrides: editorInfo.captionOverrides,
            editor: editorInfo.editor,
          }),
          ...(body.mixAudio === false ? { mixAudio: false } : {}),
        });
        const result = await job.promise;
        hold.endRender();
        events.publish({
          type: 'render.finished',
          renderId,
          packageId: pkg.id,
          revision,
          bytes: result.bytes,
          frames: result.frames,
          timeline_sha256: result.hash,
          intent,
          deliveryFingerprint: snapshot.fingerprint,
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
          'x-comfyrizz-delivery-fingerprint': snapshot.fingerprint,
          'x-comfyrizz-export-intent': intent,
          'x-comfyrizz-speech-sha256': snapshot.speechSha256,
          ...(revision == null ? {} : { 'x-comfyrizz-revision': String(revision) }),
          ...productionHeaders(admission),
        });
        createReadStream(result.output).pipe(response);
      } catch (error) {
        hold.endRender();
        const cancelled = isCancelled(error, job?.signal);
        events.publish({
          type: cancelled ? 'render.cancelled' : 'render.failed',
          renderId,
          packageId: pkg.id,
          message: error.message,
        });
        if (cancelled || response.writableEnded || response.destroyed) return;
        sendJson(response, 500, { error: error.message, renderId });
      }
    } finally {
      hold.release();
    }
    return;
  }

  // C11: re-render just one scene. The renderer's incremental renderer reuses every cached
  // segment whose key did not change (A6), then re-stitches and muxes; the response is the
  // full-length MP4.
  async function handleSceneRender(request, response, pathname = '/api/scene/render') {
    // RL10c: a running Google Colab pipeline owns the shared slot, so the coordinator refuses
    // this scene render with the holder instead of a second job on the same budget.
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
      let binding;
      let admission;
      try {
        binding = await productionBinding(target.pkg);
        admission = await admitRender({
          pkg: target.pkg,
          body,
          pathname,
          revision: target.revision,
          binding,
          details: { sceneId: body.sceneId },
        });
      } catch (error) {
        return sendRouteError(response, error);
      }
      if (admission.blocked) return sendJson(response, admission.blocked.status, admission.blocked.body);

      let intent;
      let editorInfo;
      let snapshot;
      let preflight;
      try {
        intent = intentFor(body);
        editorInfo = editorFor(target.pkg, body);
        snapshot = deliverySnapshotFor(target, body, intent, editorInfo.editor);
        preflight = preflightDelivery(snapshot, { reviews: body.reviews });
      } catch (error) {
        return sendRouteError(response, error);
      }
      if (!preflight.ok) {
        return sendJson(response, 409, {
          error: preflight.blockers[0].message,
          code: preflight.blockers[0].code,
          preflight,
        });
      }

      events.publish({
        type: 'scene.render.started',
        renderId,
        packageId: target.pkg.id,
        revision: target.revision,
        sceneId: body.sceneId,
        assets,
        intent,
        deliveryFingerprint: snapshot.fingerprint,
      });
      let job;
      try {
        hold.beginRender(() => job?.cancel());
        job = startRender(renderScene, target.packagePath, output, {
          cacheDir,
          force: body.force === true,
          intent,
          deliveryFingerprint: snapshot.fingerprint,
          ...(editorInfo.captionOverrides.length === 0 ? {} : {
            captionOverrides: editorInfo.captionOverrides,
            editor: editorInfo.editor,
          }),
          onLog: line => events.publish({ type: 'scene.render.log', renderId, sceneId: body.sceneId, line }),
        });
        const result = await job.promise;
        hold.endRender();
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
          intent,
          deliveryFingerprint: snapshot.fingerprint,
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
          'x-comfyrizz-delivery-fingerprint': snapshot.fingerprint,
          'x-comfyrizz-export-intent': intent,
          'x-comfyrizz-speech-sha256': snapshot.speechSha256,
          ...(target.revision == null ? {} : { 'x-comfyrizz-revision': String(target.revision) }),
          ...productionHeaders(admission),
        });
        createReadStream(result.output).pipe(response);
      } catch (error) {
        hold.endRender();
        const cancelled = isCancelled(error, job?.signal);
        events.publish({
          type: cancelled ? 'scene.render.cancelled' : 'scene.render.failed',
          renderId,
          packageId: target.pkg.id,
          sceneId: body.sceneId,
          message: error.message,
        });
        if (cancelled || response.writableEnded || response.destroyed) return;
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
  async function handleEditedRender(request, response, pathname = '/api/render/edited') {
    // RL10c: a running Google Colab pipeline owns the shared slot, so the coordinator refuses
    // this edited render with the holder instead of a second job on the same budget.
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
      let binding;
      let admission;
      try {
        binding = await productionBinding(target.pkg);
        admission = await admitRender({
          pkg: target.pkg,
          body,
          pathname,
          revision: target.revision,
          binding,
          details: { edited: true },
        });
      } catch (error) {
        return sendRouteError(response, error);
      }
      if (admission.blocked) return sendJson(response, admission.blocked.status, admission.blocked.body);

      let intent;
      let editorInfo;
      let snapshot;
      let preflight;
      try {
        intent = intentFor(body);
        editorInfo = editorFor(target.pkg, body);
        snapshot = deliverySnapshotFor(target, body, intent, editorInfo.editor);
        preflight = preflightDelivery(snapshot, { reviews: body.reviews });
      } catch (error) {
        return sendRouteError(response, error);
      }
      if (!preflight.ok) {
        return sendJson(response, 409, {
          error: preflight.blockers[0].message,
          code: preflight.blockers[0].code,
          preflight,
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
        intent,
        deliveryFingerprint: snapshot.fingerprint,
      });
      let job;
      try {
        hold.beginRender(() => job?.cancel());
        job = startRender(
          full ? render : renderScene,
          target.packagePath,
          output,
          {
            ...(full ? {} : { cacheDir, force: false }),
            intent,
            deliveryFingerprint: snapshot.fingerprint,
            ...(editorInfo.captionOverrides.length === 0 ? {} : {
              captionOverrides: editorInfo.captionOverrides,
              editor: editorInfo.editor,
            }),
            onLog: line => events.publish({ type: 'edit.render.log', renderId, line }),
          },
        );
        let result;
        let renderedSceneIds;
        let reusedSceneIds;
        result = await job.promise;
        hold.endRender();
        if (full) {
          renderedSceneIds = (nextTimeline.scenes ?? []).map(scene => scene.id);
          reusedSceneIds = [];
        } else {
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
          intent,
          deliveryFingerprint: snapshot.fingerprint,
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
          'x-comfyrizz-delivery-fingerprint': snapshot.fingerprint,
          'x-comfyrizz-export-intent': intent,
          'x-comfyrizz-speech-sha256': snapshot.speechSha256,
          ...(target.revision == null ? {} : { 'x-comfyrizz-revision': String(target.revision) }),
          ...productionHeaders(admission),
        });
        createReadStream(result.output ?? output).pipe(response);
      } catch (error) {
        hold.endRender();
        const cancelled = isCancelled(error, job?.signal);
        events.publish({
          type: cancelled ? 'edit.render.cancelled' : 'edit.render.failed',
          renderId,
          packageId: target.pkg.id,
          message: error.message,
        });
        if (cancelled || response.writableEnded || response.destroyed) return;
        sendJson(response, 500, { error: error.message, renderId });
      }
    } finally {
      hold.release();
    }
    return;
  }

  /**
   * Handle the export and render routes. Returns true when a route answered, so the
   * caller stops; false leaves the request to the next route.
   */
  async function handle(request, response, url) {
    let pathname;
    try {
      pathname = typeof url === 'string' ? new URL(url, 'http://127.0.0.1').pathname : url?.pathname;
    } catch {
      return false;
    }
    if (typeof pathname !== 'string') return false;
    if (!DELIVERY_ROUTE_SET.has(pathname) || request.method !== 'POST') return false;

    // Every delivery caller is dispatched from the one table above and every
    // handler below admits through `admitRender` before any side effect.
    if (pathname === '/api/export') {
      await handleExport(request, response, pathname);
      return true;
    }
    if (pathname === '/api/render') {
      await handleRender(request, response, pathname);
      return true;
    }
    if (pathname === '/api/scene/render') {
      await handleSceneRender(request, response, pathname);
      return true;
    }
    if (pathname === '/api/render/edited') {
      await handleEditedRender(request, response, pathname);
      return true;
    }
    return false;
  }

  return Object.freeze({ handle });
}

export default createRenderRoutes;
