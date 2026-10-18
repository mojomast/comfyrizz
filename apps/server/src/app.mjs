import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PackageStore, ConflictError, InvalidPackageError } from './store.mjs';
import { EventLog } from './events.mjs';
import { createRunController } from './run.mjs';
import { createExporter } from './export.mjs';
import { sceneAssetIds, sceneJobsPlan } from './scene.mjs';
import { renderPackage as defaultRenderPackage, repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { renderPackageIncremental as defaultRenderScene } from '../../renderer/scripts/render-incremental.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
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
      ratePerHour: opts.ratePerHour ?? 8.9,
    });
  }
  if (backendId === 'byo-comfyui') {
    return mod.createByoBackend({ comfyuiUrl: opts.comfyuiUrl ?? 'http://127.0.0.1:8188', outDir: opts.outDir ?? null });
  }
  return null;
}

export function createApp({
  root = repoRoot,
  token,
  runtimeDir = join(root, 'apps', 'server', '.runtime'),
  exportsDir = join(runtimeDir, 'out', 'export'),
  webDist = join(root, 'apps', 'web', 'dist'),
  render = defaultRenderPackage,
  renderScene = defaultRenderScene,
  agentRunner = null,
  providers = providerAvailability(),
  backendFactory = defaultBackendFactory,
} = {}) {
  if (!token || token.length < 16) throw new Error('createApp requires a token of at least 16 characters');
  mkdirSync(runtimeDir, { recursive: true });
  const rendersDir = join(runtimeDir, 'renders');
  mkdirSync(rendersDir, { recursive: true });
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const events = new EventLog();

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

  // C9: H8's runPackage tags applied assets with the backend's short id (`colab`); the package
  // schema accepts only `colab:<hardware>` (e.g. `colab:G4`) or `byo-comfyui`. Normalise here so a
  // successful run always stores a valid package. Reported as an H8 follow-up on the board.
  function normalizeBackendTag(pkg, record) {
    if (record.backendId !== 'colab') return pkg;
    const tag = `colab:${record.result?.up?.hardware ?? 'G4'}`;
    for (const asset of Object.values(pkg.assets ?? {})) {
      if (asset?.gen?.backend === 'colab') asset.gen.backend = tag;
    }
    if (Array.isArray(pkg.compliance?.backends_used)) {
      pkg.compliance.backends_used = pkg.compliance.backends_used.map((entry) => (entry === 'colab' ? tag : entry));
    }
    return pkg;
  }

  // C9: after collect, write the applied package back next to its collected plates, then render
  // the accepted revision to an MP4 the run panel can offer.
  async function completeRun({ pkg, result, record }) {
    if (!result?.package) return { revision: null, render: null };
    normalizeBackendTag(result.package, record);
    const id = pkg.id;
    const packageDir = dirname(store.path(id));
    const collectedAssets = join(record.outputDir, 'assets');
    if (existsSync(collectedAssets)) cpSync(collectedAssets, join(packageDir, 'assets'), { recursive: true });
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

  const runs = createRunController({ backendFactory, events, runtimeDir, prepareWorkDir: prepareRunWorkDir, onComplete: completeRun });
  // A9: the export bundle is the final render — 1920×1080 and, when the package carries x2
  // upscaled variants (H12), the variant files. The Player preview and /api/render keep the
  // package's working resolution.
  const exportRender = (packagePath, outputPath, opts = {}) => render(packagePath, outputPath, { ...opts, final: true });
  const exporter = createExporter({ exportsDir, render: exportRender });
  let activeRender = null;
  let activeExport = null;
  let activeSceneRender = null;

  const sceneCacheDir = (packageId) => join(runtimeDir, 'scene-cache', packageId);

  /**
   * Resolve a render target the same way for every render route: an in-memory draft is written to
   * a throwaway file (C1 compatibility, never mutating the stored package); otherwise the stored
   * package is read and the base revision is checked.
   */
  function resolveRenderTarget(body, suffix) {
    if (body.package && typeof body.package === 'object') {
      const pkg = body.package;
      const packagePath = join(rendersDir, `${suffix}.package.json`);
      writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
      return { pkg, packagePath, revision: Number.isFinite(pkg.revision) ? pkg.revision : null };
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
    response.writeHead(200, headers);
    if (request.method === 'HEAD') return response.end();
    createReadStream(file).pipe(response);
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

    const denied = auth(request, url);
    if (denied) return sendJson(response, denied.status, { error: denied.error });

    if (url.pathname === '/api/events' && request.method === 'GET') {
      const lastEventId = request.headers['last-event-id'] ?? url.searchParams.get('lastEventId');
      events.subscribe(request, response, lastEventId);
      return;
    }

    // Which live providers have a server-side key. Booleans only: the browser
    // never receives a key and never needs one (U1).
    if (url.pathname === '/api/providers' && request.method === 'GET') {
      return sendJson(response, 200, { providers });
    }

    const packageMatch = /^\/api\/package\/([^/]+)$/.exec(url.pathname);
    if (packageMatch) {
      const id = packageMatch[1];
      if (request.method === 'GET') {
        const pkg = store.read(id);
        if (!pkg) return sendJson(response, 404, { error: 'package not found' });
        return sendJson(response, 200, { package: pkg, revision: pkg.revision });
      }
      if (request.method === 'PATCH') {
        const body = await readJson(request);
        if (!body.package || typeof body.package !== 'object') return sendJson(response, 400, { error: 'package required' });
        try {
          const saved = store.save(id, body.package, body.baseRevision);
          events.publish({ type: 'package.updated', packageId: id, revision: saved.revision });
          return sendJson(response, 200, { package: saved, revision: saved.revision });
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

    if (url.pathname === '/api/agent' && request.method === 'POST') {
      if (!agentRunner) return sendJson(response, 503, { error: 'agent runner not configured' });
      const body = await readJson(request);
      events.publish({ type: 'agent.started', brief: typeof body.brief === 'string' ? body.brief.slice(0, 160) : null });
      try {
        const result = await agentRunner({
          brief: body.brief,
          provider: body.provider,
          model: body.model,
          sessionId: body.sessionId,
          runtimeDir,
          onEvent: event => events.publish({ type: 'agent.event', event }),
        });
        const saved = store.write(result.package);
        const timeline = compileTimeline(saved);
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

    if (url.pathname === '/api/export' && request.method === 'POST') {
      if (activeExport) return sendJson(response, 409, { error: 'export busy', exportId: activeExport });
      const body = await readJson(request);
      const exportId = `x_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      activeExport = exportId;
      let pkg;
      let packagePath;
      let revision = null;
      try {
        if (body.package && typeof body.package === 'object') {
          // C1 compatibility: an edited draft draft-exported without mutating the store.
          pkg = body.package;
          packagePath = join(rendersDir, `${exportId}.package.json`);
          writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
          revision = Number.isFinite(pkg.revision) ? pkg.revision : null;
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
        const result = await exporter({
          pkg,
          packagePath,
          revision,
          force: body.force === true,
          onLog: line => events.publish({ type: 'export.log', exportId, line }),
        });
        events.publish({
          type: 'export.finished',
          exportId,
          packageId: pkg.id,
          revision,
          dir: result.dir,
          files: result.files.map(file => file.name),
          frames: result.frames,
          captions: result.captions,
          complete: result.complete,
          excluded: result.excluded,
        });
        return sendJson(response, 200, { exportId, ...result });
      } catch (error) {
        events.publish({ type: 'export.failed', exportId, packageId: pkg?.id, message: error.message });
        return sendJson(response, error.status ?? 500, { error: error.message, exportId });
      } finally {
        activeExport = null;
      }
    }

    if (url.pathname === '/api/render' && request.method === 'POST') {
      if (activeRender) return sendJson(response, 409, { error: 'render busy', renderId: activeRender });
      const body = await readJson(request);
      const renderId = `r_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      activeRender = renderId;
      const output = join(rendersDir, `${renderId}.mp4`);
      let pkg;
      let packagePath;
      let revision = null;
      if (body.package && typeof body.package === 'object') {
        // C1 compatibility: an edited draft, rendered without mutating the stored package.
        pkg = body.package;
        packagePath = join(rendersDir, `${renderId}.package.json`);
        writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
        revision = Number.isFinite(pkg.revision) ? pkg.revision : null;
      } else {
        const id = body.packageId;
        if (!id) {
          activeRender = null;
          return sendJson(response, 400, { error: 'packageId or package required' });
        }
        pkg = store.read(id);
        if (!pkg) {
          activeRender = null;
          return sendJson(response, 404, { error: 'package not found' });
        }
        if (body.baseRevision != null && Number(body.baseRevision) !== pkg.revision) {
          activeRender = null;
          return sendJson(response, 409, { error: 'conflict', currentRevision: pkg.revision });
        }
        packagePath = store.path(id);
        revision = pkg.revision;
      }

      events.publish({ type: 'render.started', renderId, packageId: pkg.id, revision });
      try {
        const result = await render(packagePath, output, {
          onLog: line => events.publish({ type: 'render.log', renderId, line }),
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
      } finally {
        activeRender = null;
      }
      return;
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
        target = resolveRenderTarget(body, `plan_${randomUUID().replaceAll('-', '').slice(0, 8)}`);
      } catch (error) {
        return sendJson(response, error.status ?? 400, {
          error: error.message,
          ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
        });
      }
      try {
        const plan = sceneJobsPlan(target.pkg, body.sceneId, { includeReady: body.includeReady !== false });
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
      if (activeSceneRender) return sendJson(response, 409, { error: 'scene render busy', renderId: activeSceneRender });
      const body = await readJson(request);
      const renderId = `sr_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      let target;
      try {
        target = resolveRenderTarget(body, renderId);
      } catch (error) {
        return sendJson(response, error.status ?? 400, {
          error: error.message,
          ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}),
        });
      }
      if (!body.sceneId) return sendJson(response, 400, { error: 'sceneId required' });
      const assets = sceneAssetIds(target.pkg, body.sceneId);
      if (assets === null) return sendJson(response, 404, { error: `unknown scene ${body.sceneId}` });
      activeSceneRender = renderId;
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
          ...(target.revision == null ? {} : { 'x-comfyrizz-revision': String(target.revision) }),
        });
        createReadStream(result.output).pipe(response);
      } catch (error) {
        events.publish({ type: 'scene.render.failed', renderId, packageId: target.pkg.id, sceneId: body.sceneId, message: error.message });
        sendJson(response, 500, { error: error.message, renderId });
      } finally {
        activeSceneRender = null;
      }
      return;
    }

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
    events,
    runs,
    rendersDir,
    exportsDir,
    sceneCacheDir,
    webDist,
    close: () => events.closeAll(),
  };
}
