import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { listClips } from './clips.mjs';
import { buildCorrection } from './correction.mjs';
import { MAX_NOTE_CHARS, TAKES_SCHEMA, VERDICTS, deriveClipState } from './model.mjs';
import { revertTake, selectTake } from './select.mjs';
import { redactForLog } from '../../../../packages/backends/src/colab-plan.mjs';

const ROUTE_RE = /^\/api\/package\/([^/]+)\/clips(?:\/(.*))?$/;
const PACKAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const PLAN_HASH_RE = /^[0-9a-f]{64}$/i;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_BATCH_ITEMS = 50;

class RouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendError(response, status, code, message) {
  return sendJson(response, status, { error: message, code });
}

function statusFor(error) {
  if (Number.isInteger(error?.status)) return error.status;
  switch (error?.code) {
    case 'NOT_FOUND':
    case 'UNKNOWN_ASSET':
    case 'UNKNOWN_CLIP':
    case 'UNKNOWN_TAKE':
    case 'SOURCE_NOT_FOUND':
      return 404;
    case 'NO_PREVIOUS_TAKE':
    case 'CONFLICT':
      return 409;
    case 'PATH_ESCAPE':
      return 403;
    case 'BACKEND_UNAVAILABLE':
      return 422;
    case 'INVALID_BODY':
    case 'INVALID_CHANGE':
    case 'INVALID_TEXT':
    case 'INVALID_SEED':
    case 'INVALID_TAKES_COUNT':
    case 'INVALID_INPUTS':
    case 'INPUT_NOT_ALLOWED':
    case 'INPUT_UNSUPPORTED':
    case 'INVALID_INPUT_VALUE':
    case 'INVALID_VERDICT':
    case 'INVALID_TAKE_ID':
    case 'INVALID_ASSET_ID':
    case 'INVALID_PACKAGE':
    case 'INVALID_TAKES':
      return 400;
    default:
      return 500;
  }
}

// Unexpected failures are still somebody's bug: leave the stack in the server log so
// the next repro has a cause instead of a bare "clip request failed". The body stays
// masked, and token-shaped values never reach stderr.
function logUnexpected(error) {
  const stack = typeof error?.stack === 'string' && error.stack ? error.stack : String(error);
  try {
    process.stderr.write(`[comfyrizz] unexpected clip route error\n${redactForLog(stack)}\n`);
  } catch {
    // Logging must never replace the response.
  }
}

function respondError(response, error) {
  const status = statusFor(error);
  if (status >= 500) logUnexpected(error);
  const code = typeof error?.code === 'string' ? error.code : (status === 500 ? 'INTERNAL' : 'INVALID_REQUEST');
  const message = status === 500 ? 'clip request failed' : (error?.message ?? 'clip request failed');
  return sendError(response, status, code, message);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.off?.('data', onData);
      request.off?.('end', onEnd);
      request.off?.('error', onError);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onData = (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY) {
        settle(reject, new RouteError(413, 'BODY_TOO_LARGE', 'request body too large'));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return settle(resolveBody, {});
      try {
        settle(resolveBody, JSON.parse(text));
      } catch {
        settle(reject, new RouteError(400, 'INVALID_BODY', 'invalid JSON body'));
      }
    };
    const onError = (error) => settle(reject, error);
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

function publish(events, payload) {
  const target = typeof events === 'function' ? events : events?.publish;
  if (typeof target !== 'function') return;
  try {
    target.call(events, payload);
  } catch {
    void payload;
  }
}

function emptyDoc(pkgId) {
  return { schema: TAKES_SCHEMA, packageId: pkgId, clips: {}, overrides: [] };
}

function ensureEntry(doc, assetId) {
  if (!isPlainObject(doc.clips)) doc.clips = {};
  if (!isPlainObject(doc.clips[assetId])) doc.clips[assetId] = { selected: null, takes: [] };
  const entry = doc.clips[assetId];
  if (!Array.isArray(entry.takes)) entry.takes = [];
  if (entry.selected === undefined) entry.selected = null;
  return entry;
}

function activeTakes(entry) {
  if (!isPlainObject(entry) || !Array.isArray(entry.takes)) return [];
  return entry.takes.filter(take => isPlainObject(take) && take.purged !== true);
}

function effectiveSelected(entry) {
  const takes = activeTakes(entry);
  if (typeof entry?.selected === 'string' && takes.some(take => take.takeId === entry.selected)) {
    return entry.selected;
  }
  let best = null;
  for (const take of takes) {
    if (!best || (Number.isSafeInteger(take.n) ? take.n : 0) >= (Number.isSafeInteger(best.n) ? best.n : 0)) best = take;
  }
  return best?.takeId ?? null;
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function clipView(pkg, clip, doc) {
  const entry = isPlainObject(doc?.clips?.[clip.assetId]) ? doc.clips[clip.assetId] : null;
  const takes = activeTakes(entry);
  const selectedId = effectiveSelected(entry);
  const selected = takes.find(take => take.takeId === selectedId) ?? null;
  const asset = pkg.assets?.[clip.assetId];
  const state = deriveClipState({
    clip: isPlainObject(asset) ? asset : clip,
    takes: entry ?? { selected: null, takes: [] },
    assetGen: isPlainObject(asset?.gen) ? asset.gen : undefined,
  });
  return {
    ...clip,
    state,
    selected: selectedId,
    selectedN: selected?.n ?? null,
    takeCount: takes.length,
    newTakes: takes.filter(take => take.takeId !== selectedId && take.verdict === 'unreviewed').length,
    lastJob: entry?.lastJob ?? null,
    queued: Boolean(entry?.queued),
  };
}

function recordQueued(takeStore, pkgId, entries) {
  const doc = takeStore.read(pkgId) ?? emptyDoc(pkgId);
  for (const item of entries) {
    const entry = ensureEntry(doc, item.assetId);
    const queued = { correction: item.correction };
    if (typeof item.planHash === 'string' && PLAN_HASH_RE.test(item.planHash)) queued.planHash = item.planHash;
    if (typeof item.backendId === 'string' && item.backendId) queued.backendId = item.backendId;
    if (item.budgetUnits !== undefined && item.budgetUnits !== null) queued.budgetUnits = item.budgetUnits;
    entry.queued = queued;
  }
  takeStore.write(pkgId, doc);
  return doc;
}

function recordStarted(takeStore, pkgId, entries, result) {
  const doc = takeStore.read(pkgId) ?? emptyDoc(pkgId);
  const runId = typeof result?.runId === 'string' && result.runId.trim() ? result.runId : null;
  for (const item of entries) {
    const entry = ensureEntry(doc, item.assetId);
    if (runId) entry.lastJob = { runId, state: result.status ?? 'starting' };
    delete entry.queued;
  }
  takeStore.write(pkgId, doc);
  return doc;
}

function isBusyResult(result) {
  return result?.status === 409 || result?.error === 'run busy';
}

function isBusyError(error) {
  return error?.status === 409 || error?.code === 'RUN_BUSY' || /run busy/i.test(error?.message ?? '');
}

function savePackage(store, pkg, next) {
  if (typeof store.save === 'function') return store.save(pkg.id, next, pkg.revision);
  if (typeof store.write === 'function') return store.write(next);
  throw new RouteError(500, 'STORE_UNAVAILABLE', 'package store cannot save');
}

export function createTakeRoutes(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('createTakeRoutes options must be an object');
  const { store, takeStore, runs, events = null, mediaTickets = null } = options;
  if (!store || typeof store.read !== 'function') throw new TypeError('createTakeRoutes requires a package store');
  if (!takeStore || typeof takeStore.read !== 'function' || typeof takeStore.write !== 'function') {
    throw new TypeError('createTakeRoutes requires a take store');
  }
  if (!runs || typeof runs.start !== 'function') throw new TypeError('createTakeRoutes requires a run controller');
  const measuredFor = typeof options.measuredFor === 'function' ? options.measuredFor : () => ({});

  async function measured(pkg) {
    const value = await measuredFor(pkg);
    return isPlainObject(value) ? value : {};
  }

  function readPackage(pkgId) {
    let pkg;
    try {
      pkg = store.read(pkgId);
    } catch (error) {
      throw new RouteError(400, 'INVALID_PACKAGE_ID', error.message);
    }
    if (!pkg) throw new RouteError(404, 'NOT_FOUND', 'package not found');
    return pkg;
  }

  function adopt(pkg) {
    if (typeof takeStore.adoptInitial !== 'function') return;
    try {
      takeStore.adoptInitial(pkg);
    } catch {
      void pkg;
    }
  }

  async function clipsFor(pkg) {
    return listClips(pkg, await measured(pkg));
  }

  async function clipFor(pkg, clipId) {
    const clips = await clipsFor(pkg);
    const clip = clips.find(candidate => candidate.clipId === clipId);
    if (!clip) throw new RouteError(404, 'UNKNOWN_CLIP', 'clip not found');
    return { clip, clips };
  }

  async function startTakeRun({ pkg, assetIds, corrections, backendId, approved, budgetUnits }) {
    let result;
    try {
      result = await runs.start({
        backendId,
        pkg,
        assets: assetIds,
        includeReady: true,
        mode: 'take',
        corrections,
        approved: approved === true,
        budgetUnits,
      });
    } catch (error) {
      if (isBusyError(error)) return { kind: 'queued', result: null };
      // IP02: a CPU runner exists, but a deployment must register it. Say that
      // plainly instead of implying the CPU slice has no media path at all.
      if (backendId === 'cpu' && error?.code === 'BACKEND_UNAVAILABLE') {
        throw new RouteError(
          422,
          'BACKEND_UNAVAILABLE',
          'the CPU backend is not configured on this server; use Google Colab or your own ComfyUI',
        );
      }
      throw error;
    }
    if (isBusyResult(result)) return { kind: 'queued', result };
    if (result?.approvalRequired || (result?.requiresApproval && result?.approved === false)) {
      return { kind: 'approval_required', result };
    }
    if (result?.refused) return { kind: 'refused', result };
    return { kind: 'started', result: result ?? {} };
  }

  async function handleList(response, pkgId) {
    const pkg = readPackage(pkgId);
    adopt(pkg);
    const clips = await clipsFor(pkg);
    const doc = takeStore.read(pkgId) ?? emptyDoc(pkgId);
    return sendJson(response, 200, {
      packageId: pkgId,
      revision: pkg.revision ?? null,
      clips: clips.map(clip => clipView(pkg, clip, doc)),
    });
  }

  async function handleTakes(response, pkgId, clipId) {
    const pkg = readPackage(pkgId);
    adopt(pkg);
    const { clip } = await clipFor(pkg, clipId);
    const doc = takeStore.read(pkgId) ?? emptyDoc(pkgId);
    const entry = isPlainObject(doc.clips?.[clip.assetId]) ? doc.clips[clip.assetId] : null;
    return sendJson(response, 200, {
      packageId: pkgId,
      revision: pkg.revision ?? null,
      clip: clipView(pkg, clip, doc),
      assetId: clip.assetId,
      selected: effectiveSelected(entry),
      takes: Array.isArray(entry?.takes) ? entry.takes : [],
      history: Array.isArray(entry?.history) ? entry.history : [],
      lastJob: entry?.lastJob ?? null,
      queued: entry?.queued ?? null,
    });
  }

  async function handleRegenerate(request, response, pkgId, clipId) {
    const body = await readJson(request);
    if (!isPlainObject(body)) throw new RouteError(400, 'INVALID_BODY', 'body must be an object');
    const pkg = readPackage(pkgId);
    const { clip } = await clipFor(pkg, clipId);
    const doc = takeStore.read(pkgId) ?? emptyDoc(pkgId);
    const entry = isPlainObject(doc.clips?.[clip.assetId]) ? doc.clips[clip.assetId] : null;
    const built = buildCorrection(pkg, clip.assetId, body.change, { takesCount: activeTakes(entry).length });
    const backendId = typeof body.backendId === 'string' && body.backendId ? body.backendId : 'colab';
    const outcome = await startTakeRun({
      pkg: built.package,
      assetIds: [clip.assetId],
      corrections: { [clip.assetId]: built.correction },
      backendId,
      approved: body.approved === true,
      budgetUnits: body.budgetUnits,
    });
    const common = { clipId, assetId: clip.assetId, diff: built.diff, correction: built.correction };

    if (outcome.kind === 'queued') {
      recordQueued(takeStore, pkgId, [{
        assetId: clip.assetId,
        correction: built.correction,
        planHash: outcome.result?.planHash,
        backendId,
        budgetUnits: body.budgetUnits,
      }]);
      publish(events, {
        type: 'clip.queued', packageId: pkgId, clipId, assetId: clip.assetId, backendId,
        ...(typeof outcome.result?.planHash === 'string' ? { planHash: outcome.result.planHash } : {}),
      });
      return sendJson(response, 202, {
        kind: 'queued',
        ...common,
        ...(typeof outcome.result?.planHash === 'string' ? { planHash: outcome.result.planHash } : {}),
      });
    }

    if (outcome.kind === 'approval_required') {
      const result = outcome.result;
      return sendJson(response, 200, {
        kind: 'approval_required',
        approvalRequired: true,
        requiresApproval: true,
        ...common,
        planHash: result.planHash,
        estimate: result.estimate ?? null,
        budget: result.budget ?? null,
        backend: result.backend ?? null,
        jobs: result.jobs ?? null,
      });
    }

    if (outcome.kind === 'refused') {
      return sendJson(response, 409, {
        kind: 'refused',
        ...common,
        planHash: outcome.result?.planHash ?? null,
        budget: outcome.result?.budget ?? null,
      });
    }

    const result = outcome.result;
    recordStarted(takeStore, pkgId, [{ assetId: clip.assetId }], result);
    publish(events, {
      type: 'clip.job', packageId: pkgId, clipId, assetId: clip.assetId, runId: result.runId,
      state: result.status ?? 'starting', progress: 0,
    });
    // IP02: a local CPU take is dispatched the same way as a paid run, but there is
    // nothing to approve and no remote session: 202 Accepted says so. The new take
    // lands asynchronously through the normal ingest path.
    return sendJson(response, backendId === 'cpu' ? 202 : 200, {
      kind: 'started',
      ...common,
      runId: result.runId,
      status: result.status ?? null,
      planHash: result.planHash ?? null,
      estimate: result.estimate ?? null,
      budget: result.budget ?? null,
    });
  }

  async function handleRegenerateBatch(request, response, pkgId) {
    const body = await readJson(request);
    if (!isPlainObject(body) || !Array.isArray(body.items) || body.items.length === 0) {
      throw new RouteError(400, 'INVALID_BODY', 'items must be a non-empty array');
    }
    if (body.items.length > MAX_BATCH_ITEMS) {
      throw new RouteError(400, 'INVALID_BODY', `items must contain at most ${MAX_BATCH_ITEMS} entries`);
    }
    const pkg = readPackage(pkgId);
    const clips = await clipsFor(pkg);
    const doc = takeStore.read(pkgId) ?? emptyDoc(pkgId);
    const seenAssets = new Set();
    const items = [];
    const corrections = {};
    let corrected = pkg;

    for (const item of body.items) {
      if (!isPlainObject(item)) throw new RouteError(400, 'INVALID_BODY', 'each item must be an object');
      const clipId = item.clipId ?? item.clip_id ?? item.id;
      let clip = typeof clipId === 'string' && clipId ? clips.find(candidate => candidate.clipId === clipId) : null;
      if (!clip && typeof item.assetId === 'string' && item.assetId) {
        const matches = clips.filter(candidate => candidate.assetId === item.assetId);
        if (matches.length === 1) clip = matches[0];
      }
      if (!clip) {
        if (typeof clipId !== 'string' || clipId === '') throw new RouteError(400, 'INVALID_BODY', 'each item needs a clipId');
        throw new RouteError(404, 'UNKNOWN_CLIP', `clip not found: ${clipId}`);
      }
      if (seenAssets.has(clip.assetId)) {
        throw new RouteError(400, 'INVALID_BODY', `clip ${clip.clipId} repeats an asset already in this batch`);
      }
      seenAssets.add(clip.assetId);
      const entry = isPlainObject(doc.clips?.[clip.assetId]) ? doc.clips[clip.assetId] : null;
      const built = buildCorrection(corrected, clip.assetId, item.change, { takesCount: activeTakes(entry).length });
      corrected = built.package;
      corrections[clip.assetId] = built.correction;
      items.push({ clipId: clip.clipId, assetId: clip.assetId, diff: built.diff, correction: built.correction, backendId: item.backendId });
    }

    const backendId = typeof body.backendId === 'string' && body.backendId
      ? body.backendId
      : (typeof items[0].backendId === 'string' && items[0].backendId ? items[0].backendId : 'colab');
    const assetIds = items.map(item => item.assetId);
    const outcome = await startTakeRun({
      pkg: corrected,
      assetIds,
      corrections,
      backendId,
      approved: body.approved === true,
      budgetUnits: body.budgetUnits,
    });
    const publicItems = items.map(({ clipId, assetId, diff, correction }) => ({ clipId, assetId, diff, correction }));

    if (outcome.kind === 'queued') {
      const planHash = outcome.result?.planHash;
      recordQueued(takeStore, pkgId, items.map(item => ({
        assetId: item.assetId,
        correction: item.correction,
        planHash,
        backendId,
        budgetUnits: body.budgetUnits,
      })));
      for (const item of items) {
        publish(events, {
          type: 'clip.queued', packageId: pkgId, clipId: item.clipId, assetId: item.assetId, backendId,
          ...(typeof planHash === 'string' ? { planHash } : {}),
        });
      }
      return sendJson(response, 202, {
        kind: 'queued',
        items: publicItems,
        ...(typeof planHash === 'string' ? { planHash } : {}),
      });
    }

    if (outcome.kind === 'approval_required') {
      const result = outcome.result;
      return sendJson(response, 200, {
        kind: 'approval_required',
        approvalRequired: true,
        requiresApproval: true,
        items: publicItems,
        planHash: result.planHash,
        estimate: result.estimate ?? null,
        budget: result.budget ?? null,
        backend: result.backend ?? null,
        jobs: result.jobs ?? null,
      });
    }

    if (outcome.kind === 'refused') {
      return sendJson(response, 409, {
        kind: 'refused',
        items: publicItems,
        planHash: outcome.result?.planHash ?? null,
        budget: outcome.result?.budget ?? null,
      });
    }

    const result = outcome.result;
    recordStarted(takeStore, pkgId, items.map(item => ({ assetId: item.assetId })), result);
    for (const item of items) {
      publish(events, {
        type: 'clip.job', packageId: pkgId, clipId: item.clipId, assetId: item.assetId, runId: result.runId,
        state: result.status ?? 'starting', progress: 0,
      });
    }
    return sendJson(response, backendId === 'cpu' ? 202 : 200, {
      kind: 'started',
      items: publicItems,
      runId: result.runId,
      status: result.status ?? null,
      planHash: result.planHash ?? null,
      estimate: result.estimate ?? null,
      budget: result.budget ?? null,
    });
  }

  async function handleSelect(request, response, pkgId, clipId) {
    const body = await readJson(request);
    if (!isPlainObject(body) || typeof body.takeId !== 'string' || body.takeId === '') {
      throw new RouteError(400, 'INVALID_BODY', 'takeId is required');
    }
    const pkg = readPackage(pkgId);
    const { clip } = await clipFor(pkg, clipId);
    const doc = takeStore.read(pkgId);
    if (!doc) throw new RouteError(404, 'NOT_FOUND', 'takes document does not exist');
    const entry = isPlainObject(doc.clips?.[clip.assetId]) ? doc.clips[clip.assetId] : null;
    const take = activeTakes(entry).find(candidate => candidate.takeId === body.takeId);
    if (!take) throw new RouteError(404, 'UNKNOWN_TAKE', 'take is not in this clip');

    const next = selectTake(pkg, doc, clip.assetId, body.takeId);
    const saved = savePackage(store, pkg, next);
    takeStore.write(pkgId, doc);
    publish(events, {
      type: 'clip.take.selected', packageId: pkgId, clipId, assetId: clip.assetId, takeId: body.takeId,
    });
    return sendJson(response, 200, {
      kind: 'selected',
      packageId: pkgId,
      revision: saved.revision ?? null,
      clip: clipView(saved, clip, doc),
      takeId: body.takeId,
    });
  }

  async function handleRevert(request, response, pkgId, clipId) {
    const pkg = readPackage(pkgId);
    const { clip } = await clipFor(pkg, clipId);
    const doc = takeStore.read(pkgId);
    if (!doc) throw new RouteError(404, 'NOT_FOUND', 'takes document does not exist');
    const next = revertTake(pkg, doc, clip.assetId);
    const saved = savePackage(store, pkg, next);
    takeStore.write(pkgId, doc);
    const takeId = effectiveSelected(doc.clips?.[clip.assetId]);
    publish(events, {
      type: 'clip.take.selected', packageId: pkgId, clipId, assetId: clip.assetId, takeId,
    });
    return sendJson(response, 200, {
      kind: 'reverted',
      packageId: pkgId,
      revision: saved.revision ?? null,
      clip: clipView(saved, clip, doc),
      takeId,
    });
  }

  async function handleVerdict(request, response, pkgId, clipId) {
    const body = await readJson(request);
    if (!isPlainObject(body)) throw new RouteError(400, 'INVALID_BODY', 'body must be an object');
    if (!VERDICTS.includes(body.verdict)) {
      throw new RouteError(400, 'INVALID_VERDICT', `verdict must be one of: ${VERDICTS.join(', ')}`);
    }
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== 'string' || body.note.length > MAX_NOTE_CHARS) {
        throw new RouteError(400, 'INVALID_TEXT', `note must be a string of at most ${MAX_NOTE_CHARS} characters`);
      }
    }
    const pkg = readPackage(pkgId);
    const { clip } = await clipFor(pkg, clipId);
    const current = takeStore.read(pkgId);
    const entry = isPlainObject(current?.clips?.[clip.assetId]) ? current.clips[clip.assetId] : null;
    const takeId = typeof body.takeId === 'string' && body.takeId ? body.takeId : effectiveSelected(entry);
    if (!takeId) throw new RouteError(409, 'NO_TAKE', 'clip has no take to review');
    const doc = takeStore.setVerdict(pkgId, clip.assetId, takeId, body.verdict, body.note);
    publish(events, {
      type: 'clip.verdict', packageId: pkgId, clipId, assetId: clip.assetId, takeId, verdict: body.verdict,
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
    });
    return sendJson(response, 200, {
      kind: 'verdict',
      packageId: pkgId,
      clip: clipView(pkg, clip, doc),
      takeId,
      verdict: body.verdict,
    });
  }

  async function handleTicket(response, pkgId, clipId, takeId) {
    const pkg = readPackage(pkgId);
    const { clip } = await clipFor(pkg, clipId);
    const doc = takeStore.read(pkgId);
    const take = activeTakes(doc?.clips?.[clip.assetId]).find(candidate => candidate.takeId === takeId);
    if (!take) throw new RouteError(404, 'UNKNOWN_TAKE', 'take is not in this clip');
    if (!mediaTickets || typeof mediaTickets.mint !== 'function') {
      throw new RouteError(503, 'MEDIA_UNAVAILABLE', 'media tickets are not available');
    }
    const root = typeof takeStore.packageRoot === 'function'
      ? takeStore.packageRoot(pkgId)
      : dirname(store.path(pkgId));
    const file = resolve(root, take.file);
    if (!inside(root, file)) throw new RouteError(403, 'PATH_ESCAPE', 'take file escapes the package directory');
    if (!existsSync(file) || !statSync(file).isFile()) throw new RouteError(404, 'NOT_FOUND', 'take file does not exist');
    const rootReal = resolve(realpathSync(root));
    const fileReal = resolve(realpathSync(file));
    if (!inside(rootReal, fileReal)) throw new RouteError(403, 'PATH_ESCAPE', 'take file escapes the package directory');
    const minted = mediaTickets.mint(fileReal);
    return sendJson(response, 200, {
      kind: 'ticket',
      takeId,
      ticket: minted.ticket,
      expiresAt: minted.expiresAt,
      url: minted.url,
    });
  }

  async function handle(request, response, url) {
    let pathname;
    try {
      pathname = typeof url === 'string' ? new URL(url, 'http://127.0.0.1').pathname : url?.pathname;
    } catch {
      return false;
    }
    if (typeof pathname !== 'string') return false;
    const match = ROUTE_RE.exec(pathname);
    if (!match) return false;

    const pkgId = safeDecode(match[1]);
    if (pkgId === null || !PACKAGE_ID_RE.test(pkgId)) {
      sendError(response, 400, 'INVALID_PACKAGE_ID', 'invalid package id');
      return true;
    }

    const rest = match[2] ?? '';
    const rawParts = rest === '' ? [] : rest.split('/');
    const parts = [];
    for (const part of rawParts) {
      const decoded = safeDecode(part);
      if (decoded === null) {
        sendError(response, 400, 'INVALID_PATH', 'path is not valid URL encoding');
        return true;
      }
      parts.push(decoded);
    }
    const method = String(request.method ?? 'GET').toUpperCase();

    try {
      if (parts.length === 0) {
        if (method !== 'GET') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        await handleList(response, pkgId);
        return true;
      }

      if (parts.length === 1 && parts[0] === 'regenerate-batch') {
        if (method !== 'POST') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        await handleRegenerateBatch(request, response, pkgId);
        return true;
      }

      const clipId = parts[0];
      const tail = parts.slice(1);

      if (tail.length === 1 && tail[0] === 'takes') {
        if (method !== 'GET') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        await handleTakes(response, pkgId, clipId);
        return true;
      }
      if (tail.length === 1 && tail[0] === 'regenerate') {
        if (method !== 'POST') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        await handleRegenerate(request, response, pkgId, clipId);
        return true;
      }
      if (tail.length === 1 && tail[0] === 'select') {
        if (method !== 'POST') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        await handleSelect(request, response, pkgId, clipId);
        return true;
      }
      if (tail.length === 1 && tail[0] === 'revert') {
        if (method !== 'POST') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        await handleRevert(request, response, pkgId, clipId);
        return true;
      }
      if (tail.length === 1 && tail[0] === 'verdict') {
        if (method !== 'POST') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        await handleVerdict(request, response, pkgId, clipId);
        return true;
      }
      if (tail.length === 3 && tail[0] === 'takes' && tail[2] === 'ticket') {
        if (method !== 'POST') {
          sendError(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
          return true;
        }
        await handleTicket(response, pkgId, clipId, tail[1]);
        return true;
      }

      sendError(response, 404, 'NOT_FOUND', 'not found');
      return true;
    } catch (error) {
      respondError(response, error);
      return true;
    }
  }

  return Object.freeze({ handle });
}

export default createTakeRoutes;
