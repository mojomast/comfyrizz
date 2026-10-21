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
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildVariants } from '../variant.mjs';
import { runFrameQa } from '../qa.mjs';
import { sceneAssetIds } from '../scene.mjs';
import { packageTimeline, timingChangeReason } from '../edit.mjs';
import { measuredOptionsFromDir } from '../compile-package.mjs';
import { loadCompositionManifest } from '../../../../packages/compositions/src/index.mjs';

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
    draftRenderTarget,
    resolveRenderTarget,
    sendJson,
    readJson,
  } = options;

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

  async function handleExport(request, response) {
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

      const gate = renderGate(pkg, body, pathname);
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

  // C11: re-render just one scene. The renderer's incremental renderer reuses every cached
  // segment whose key did not change (A6), then re-stitches and muxes; the response is the
  // full-length MP4.
  async function handleSceneRender(request, response) {
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
  async function handleEditedRender(request, response) {
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

    if (pathname === '/api/export' && request.method === 'POST') {
      await handleExport(request, response);
      return true;
    }
    if (pathname === '/api/render' && request.method === 'POST') {
      await handleRender(request, response, pathname);
      return true;
    }
    if (pathname === '/api/scene/render' && request.method === 'POST') {
      await handleSceneRender(request, response);
      return true;
    }
    if (pathname === '/api/render/edited' && request.method === 'POST') {
      await handleEditedRender(request, response);
      return true;
    }
    return false;
  }

  return Object.freeze({ handle });
}

export default createRenderRoutes;
