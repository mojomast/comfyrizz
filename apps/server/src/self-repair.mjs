import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from '../../../packages/planner/dist/src/index.js';

const MAX_RUN_MS = 15 * 60 * 1000;
const active = new Set();
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const clone = value => structuredClone(value);
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const repairIdOK = value => typeof value === 'string' && /^repair_[A-Za-z0-9_-]{1,96}$/.test(value);
const renderIdOK = value => typeof value === 'string' && /^r_[a-f0-9]{12}$/.test(value);
const inspectionIdOK = value => typeof value === 'string' && /^(?:r|run)_[a-f0-9]{12}$/.test(value);
const hashOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timingChecks = new Set(['detected_speech_coverage', 'speech_transition_overlap']);
const textCheck = finding => finding.check === 'asr_text_comparison';
const repairRelevant = finding => timingChecks.has(finding.check) || textCheck(finding);
const informational = new Set(['speech_evidence', 'visual_quality', 'speech_lower_third_overlap']);
const statuses = new Set(['pass', 'fail', 'unknown', 'needs_review']);
const issue = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const key = finding => JSON.stringify([finding.check, finding.sceneId ?? null, finding.assetId ?? null, finding.slot ?? null]);

function validateInput(input) {
  const fields = ['repairId', 'packageId', 'expectedRevision', 'renderId', 'conversationId', 'maxRepairs'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))
    || !repairIdOK(input.repairId) || !safe(input.packageId) || !safe(input.conversationId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || !inspectionIdOK(input.renderId) || ![1, 2].includes(input.maxRepairs)) {
    throw issue('SELF_REPAIR_INVALID', 'Supply exactly repairId, packageId, expectedRevision, renderId, conversationId and maxRepairs (1 or 2).', 422);
  }
  return clone(input);
}

function read(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function write(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(temp, file);
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function validateReport(report, pkg, renderId) {
  if (!report || report.packageId !== pkg.id || report.packageRevision !== pkg.revision
    || report.packageHash !== digest(pkg) || report.artifact?.renderId !== renderId) {
    throw issue('SELF_REPAIR_STALE', 'Inspection does not bind the current package and requested render.');
  }
  if (!/^rr_[a-f0-9]{64}$/.test(report.reviewId ?? '') || !hashOK(report.artifact.videoSha256)
    || !hashOK(report.artifact.timelineHash) || report.acceptance !== 'not_assessed'
    || !statuses.has(report.checksStatus) || !Array.isArray(report.findings) || !report.findings.length
    || report.findings.some(finding => !finding || typeof finding.check !== 'string' || !statuses.has(finding.status))
    || new Set(report.findings.map(key)).size !== report.findings.length) {
    throw issue('SELF_REPAIR_EVIDENCE', 'Invalid render inspection evidence.', 422);
  }
  return freeze(clone(report));
}

// Contract matches render-review.mjs: speech is measured over actual final bytes;
// windows contain absolute, observed segments associated with each scene. This
// only authorizes asking Pi to inspect the source, never a particular trim.
// A measured text mismatch also permits source inspection: a missing word may
// be a source-in issue, but only the source tool can establish a feasible trim.
// matchObserved true remains an ASR observation, not exact-word certification;
// null/missing comparison or a wholly unobserved line cannot authorize repair
// or satisfy the scoped checks. Lower-third overlap is informational until an
// explicit authored requirement is supported; it never initiates a trim.
function assess(report, pkg) {
  if (report.capabilities?.finalRender !== 'inspected' || report.capabilities?.renderProbe !== 'measured'
    || report.capabilities?.contribution !== 'receipt_verified') return { reason: 'unavailable_evidence' };
  const required = report.findings.filter(finding => !informational.has(finding.check));
  if (!required.length) return { reason: 'unavailable_evidence' };
  if (required.some(finding => !repairRelevant(finding) && finding.status === 'fail')) return { reason: 'source_or_staging_fault' };
  if (required.some(finding => !repairRelevant(finding) && finding.status !== 'pass')) return { reason: 'unavailable_evidence' };
  if (required.some(finding => timingChecks.has(finding.check) && finding.status === 'unknown')) return { reason: 'unavailable_evidence' };
  if (required.some(finding => textCheck(finding) && (typeof finding.matchObserved !== 'boolean' || finding.status === 'unknown'))) return { reason: 'unavailable_evidence' };
  const problems = required.filter(finding => timingChecks.has(finding.check) && ['fail', 'needs_review'].includes(finding.status)
    || textCheck(finding) && finding.matchObserved === false);
  if (!problems.length) return { satisfied: true, sceneIds: [] };
  const speech = report.speech;
  if (speech?.status !== 'measured' || report.capabilities.speechTiming !== 'measured'
    || typeof speech.provider !== 'string' || !speech.provider.trim()
    || !Number.isFinite(speech.uncertaintySeconds) || speech.uncertaintySeconds < 0 || speech.uncertaintySeconds > 1
    || !Array.isArray(speech.segments) || !speech.segments.length
    || speech.segments.some(segment => !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || segment.start < 0 || segment.end <= segment.start || typeof segment.text !== 'string' || !segment.text.trim())
    || !Array.isArray(report.windows)) return { reason: 'unavailable_evidence' };
  const sceneIds = [...new Set(problems.map(finding => finding.sceneId))];
  for (const sceneId of sceneIds) {
    const scene = pkg.scenes?.find(item => item.id === sceneId);
    const windows = report.windows.filter(window => window.sceneId === sceneId);
    const window = windows[0];
    if (!scene || !scene.background || scene.locked || windows.length !== 1
      || !Number.isFinite(window.startSeconds) || !Number.isFinite(window.endSeconds)
      || window.startSeconds < 0 || window.endSeconds <= window.startSeconds
      || !Array.isArray(window.segments) || !window.segments.length
      || window.segments.some(segment => !speech.segments.some(observed => isDeepStrictEqual(segment, observed))
        || segment.start >= window.endSeconds || segment.end <= window.startSeconds)) return { reason: 'unavailable_evidence' };
  }
  return { sceneIds };
}

function verifyEdit(before, after, sceneIds) {
  if (isDeepStrictEqual(before, after)) return 'no_op';
  if (!after || !Number.isSafeInteger(after.revision) || after.revision !== before.revision + 1) return 'stale_package';
  const candidate = clone(after);
  candidate.revision = before.revision;
  let changed = false;
  for (const sceneId of sceneIds) {
    const oldScene = before.scenes.find(scene => scene.id === sceneId);
    const newScene = candidate.scenes?.find(scene => scene.id === sceneId);
    if (!oldScene?.background || !newScene?.background) return 'out_of_scope_edit';
    const oldTrim = oldScene.background.trim;
    const newTrim = newScene.background.trim;
    if (isDeepStrictEqual(oldTrim, newTrim)) continue;
    // A newly introduced trim may only contain startSeconds. An existing end
    // (including its absence) must remain byte-for-byte semantically unchanged.
    if (!newTrim || !Number.isFinite(newTrim.startSeconds) || newTrim.startSeconds < 0
      || newTrim.endSeconds !== oldTrim?.endSeconds
      || (newTrim.endSeconds !== undefined && newTrim.startSeconds >= newTrim.endSeconds)) return 'out_of_scope_edit';
    const restored = clone(newTrim);
    if (oldTrim && Object.hasOwn(oldTrim, 'startSeconds')) restored.startSeconds = oldTrim.startSeconds;
    else delete restored.startSeconds;
    if (!isDeepStrictEqual(restored, oldTrim ?? {})) return 'out_of_scope_edit';
    if ((oldTrim?.startSeconds ?? 0) !== newTrim.startSeconds) changed = true;
    if (oldTrim === undefined) delete newScene.background.trim;
    else newScene.background.trim = clone(oldTrim);
  }
  if (!isDeepStrictEqual(candidate, before)) return 'out_of_scope_edit';
  return changed ? null : 'no_op';
}

function sourceTrimChanges(before, after) {
  const oldScenes = new Map((before?.scenes ?? []).map(scene => [scene.id, scene]));
  const newScenes = new Map((after?.scenes ?? []).map(scene => [scene.id, scene]));
  return [...new Set([...oldScenes.keys(), ...newScenes.keys()])].flatMap(sceneId => {
    const oldTrim = oldScenes.get(sceneId)?.background?.trim ?? null;
    const newTrim = newScenes.get(sceneId)?.background?.trim ?? null;
    return isDeepStrictEqual(oldTrim, newTrim) ? [] : [{ sceneId, before: clone(oldTrim), after: clone(newTrim) }];
  });
}

function attemptReport(report) {
  if (!report) return null;
  const { reviewId, packageRevision, packageHash, renderId, videoSha256, timelineHash } = report;
  return { reviewId, packageRevision, packageHash, renderId, videoSha256, timelineHash,
    findings: report.findings.filter(finding => repairRelevant(finding) || finding.check === 'speech_lower_third_overlap'
      || !informational.has(finding.check) && finding.status !== 'pass') };
}

function comparison(before, after) {
  const analyzer = report => ({ version: report.version ?? 1, provider: report.speech?.provider ?? null,
    uncertaintySeconds: report.speech?.uncertaintySeconds ?? null, analyzer: report.speech?.analyzer ?? null,
    timingGranularity: report.speech?.timingGranularity ?? 'segment' });
  if (!isDeepStrictEqual(analyzer(before), analyzer(after))) return 'analyzer_changed';
  const next = new Map(after.findings.map(finding => [key(finding), finding]));
  const previous = new Map(before.findings.map(finding => [key(finding), finding]));
  const rank = { pass: 0, needs_review: 1, fail: 2, unknown: 3 };
  if (before.findings.some(finding => !next.has(key(finding)) || rank[next.get(key(finding)).status] > rank[finding.status])
    || before.findings.some(finding => textCheck(finding) && finding.matchObserved === true && next.get(key(finding))?.matchObserved !== true)
    || after.findings.some(finding => !previous.has(key(finding)) && finding.status !== 'pass')) return 'regression';
  const improved = before.findings.some(finding => timingChecks.has(finding.check)
    && rank[next.get(key(finding)).status] < rank[finding.status]
    || textCheck(finding) && finding.matchObserved === false && next.get(key(finding)).matchObserved === true);
  return improved ? null : 'no_improvement';
}

const evidenceHash = report => digest({ findings: report.findings, speech: report.speech, windows: report.windows });

function renderReadiness(result) {
  if (!result || typeof result.ok !== 'boolean' || (result.ok === false
    && (typeof result.code !== 'string' || !result.code.trim() || typeof result.message !== 'string'))) {
    throw issue('SELF_REPAIR_READINESS', 'Render readiness callback returned an invalid result.');
  }
  if (result.ok) return { ok: true };
  const bounded = { ok: false, code: result.code.slice(0, 128), message: result.message.slice(0, 500) };
  if (Array.isArray(result.blocking)) {
    bounded.blocking = result.blocking.slice(0, 100).map(item => Object.fromEntries(
      ['clipId', 'state', 'code', 'message'].filter(field => typeof item?.[field] === 'string')
        .map(field => [field, item[field].slice(0, field === 'message' ? 500 : 128)])));
  }
  return bounded;
}

/**
 * All callbacks are trusted host adapters and must honor signal. chatTurn runs
 * the existing Pi conversation/CAS build with evidence-bound source-trim tools;
 * it may commit once and must reject tool failures. This controller never edits
 * packages or authorizes generation, takes, payment, or render-gate overrides.
 * readPackage(packageId) returns the saved package (sync or async).
 * Optional checkRenderReadiness({pkg, packageId, expectedRevision, signal}) is
 * read-only: return {ok:true} or {ok:false,code,message,blocking?}. It runs only
 * for eligible repairs, before each reservation. Blocked codes/messages are
 * bounded to 128/500 characters; at most 100 clipId/state/code/message blockers
 * are retained. Passing is advisory: renderCurrent must recheck admission/CAS.
 * chatTurn also receives frozen priorAttempts, reconstructed from the package
 * reservation log and durable run histories/reports, including other repair IDs
 * and conversations. Entries contain repairId/attempt, exact sourceTrimChanges
 * ({sceneId,before,after}, null trim means absent), validation and before/after
 * report summaries with hashes and relevant findings. A null changes/report
 * value means unobserved, never proof of no effect. An empty changes array is an
 * observed no-op. Completion is scoped_checks_satisfied, not acceptance.
 * get(repairId) is synchronous; run(input, {signal}) returns its durable record.
 * The persistent two-reservation ceiling is per package, across all repair IDs
 * and conversations. It is deliberately stricter than a resettable lineage cap.
 */
export function createSelfRepairController({ runtimeDir, readPackage, inspectRender, chatTurn, renderCurrent, checkRenderReadiness }) {
  if (typeof runtimeDir !== 'string' || !runtimeDir || [readPackage, inspectRender, chatTurn, renderCurrent].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Self repair requires runtimeDir and all four host callbacks.');
  }
  if (checkRenderReadiness !== undefined && typeof checkRenderReadiness !== 'function') {
    throw new TypeError('checkRenderReadiness must be a trusted read-only callback.');
  }
  const root = resolve(runtimeDir, 'self-repairs');
  const packages = join(root, 'packages');
  mkdirSync(packages, { recursive: true, mode: 0o700 });
  const recordFile = id => join(root, `${id}.json`);
  const lockFile = id => join(packages, `${id}.lock`);
  const budgetFile = id => join(packages, `${id}.json`);

  function event(record, type, details = {}) {
    record.history.push({ sequence: record.history.length + 1, at: new Date().toISOString(), type,
      stage: record.stage, attempt: record.attempts, revision: record.currentRevision, ...details });
    record.updatedAt = record.history.at(-1).at;
    write(recordFile(record.repairId), record);
  }

  function release(packageId, nonce) {
    if (read(lockFile(packageId))?.nonce === nonce) unlinkSync(lockFile(packageId));
  }

  function get(repairId) {
    if (!repairIdOK(repairId)) throw issue('SELF_REPAIR_INVALID', 'Invalid repair ID.', 422);
    const record = read(recordFile(repairId));
    if (!record) return null;
    if (record.status === 'running' && !active.has(recordFile(repairId))
      && (record.ownerPid === process.pid || !alive(record.ownerPid))) {
      record.status = 'interrupted';
      record.reason = 'restart_interrupted';
      record.effectUncertain = ['chat_turn', 'render'].includes(record.stage);
      event(record, 'interrupted', { lastKnownRevision: record.currentRevision });
      release(record.input.packageId, record.lockNonce);
    }
    return clone(record);
  }

  function acquire(packageId, repairId) {
    const file = lockFile(packageId), nonce = randomUUID();
    const old = read(file);
    if (old && !active.has(recordFile(old.repairId)) && (old.pid === process.pid || !alive(old.pid))) {
      get(old.repairId);
      release(packageId, old.nonce);
    }
    try { writeFileSync(file, JSON.stringify({ pid: process.pid, repairId, nonce }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw issue('SELF_REPAIR_BUSY', 'This package already has an active repair.');
      throw error;
    }
    return nonce;
  }

  function priorAttempts(reservations) {
    return freeze(reservations.map(reservation => {
      const previous = get(reservation.repairId);
      const events = previous?.history.filter(item => item.attempt === reservation.attempt) ?? [];
      const edit = events.find(item => item.type === 'edit_observed');
      const inspection = events.find(item => item.type === 'inspection_saved');
      const before = previous?.reports.find(item => item.reviewId === reservation.reviewId);
      const after = previous?.reports.find(item => item.reviewId === inspection?.reviewId);
      return { repairId: reservation.repairId, conversationId: reservation.conversationId, attempt: reservation.attempt,
        beforeRevision: reservation.revision, afterRevision: edit?.afterRevision ?? null,
        sourceTrimChanges: clone(edit?.sourceTrimChanges ?? null), validation: edit?.validation ?? 'not_observed',
        runStatus: previous?.status ?? 'unavailable', runReason: previous?.reason ?? null,
        before: attemptReport(before), after: attemptReport(after) };
    }));
  }

  async function run(rawInput, { signal: callerSignal } = {}) {
    const input = validateInput(rawInput);
    const previous = get(input.repairId);
    if (previous) {
      if (!isDeepStrictEqual(previous.input, input)) throw issue('SELF_REPAIR_CONFLICT', 'Repair ID was already used for different input.');
      return previous;
    }
    const nonce = acquire(input.packageId, input.repairId);
    const identity = recordFile(input.repairId);
    // The package lock serializes records and the package-wide reservation log.
    const raced = get(input.repairId);
    if (raced) {
      release(input.packageId, nonce);
      if (!isDeepStrictEqual(raced.input, input)) throw issue('SELF_REPAIR_CONFLICT', 'Repair ID was already used for different input.');
      return raced;
    }
    active.add(identity);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(issue('SELF_REPAIR_TIMEOUT', 'Self repair exceeded its 15-minute budget.')), MAX_RUN_MS);
    timer.unref();
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    const pending = new Set();
    const record = { version: 1, repairId: input.repairId, input, status: 'running', reason: null,
      stage: 'read_package', ownerPid: process.pid, lockNonce: nonce, currentRevision: input.expectedRevision,
      attempts: 0, renders: 0, packageRoundsReserved: 0, reports: [], history: [],
      checksSatisfied: false, acceptance: 'not_assessed', effectUncertain: false,
      deadlineAt: new Date(Date.now() + MAX_RUN_MS).toISOString() };
    // A repair ID is global, even when two processes submit different package
    // IDs. Exclusive creation prevents their separate package locks from
    // allowing either request to overwrite the other's idempotency record.
    try { writeFileSync(identity, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      clearTimeout(timer); active.delete(identity); release(input.packageId, nonce);
      if (error.code !== 'EEXIST') throw error;
      const existing = get(input.repairId);
      if (!existing || !isDeepStrictEqual(existing.input, input)) throw issue('SELF_REPAIR_CONFLICT', 'Repair ID was already used for different input.');
      return existing;
    }
    function stage(name, details = {}) { record.stage = name; event(record, 'stage_started', details); }
    function stop(reason, status = 'stopped') {
      record.status = status; record.reason = reason; event(record, 'finished'); return clone(record);
    }
    // Cancellation returns promptly, but an adapter ignoring abort keeps the
    // package locked until it settles. Its reservation is never refunded.
    async function invoke(fn) {
      signal.throwIfAborted();
      const work = Promise.resolve().then(() => { signal.throwIfAborted(); return fn(); });
      pending.add(work);
      work.then(() => pending.delete(work), () => pending.delete(work));
      let abort;
      const interrupted = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try { return await Promise.race([work, interrupted]); }
      finally { signal.removeEventListener('abort', abort); }
    }
    async function saved(expected) {
      const pkg = clone(await invoke(() => readPackage(input.packageId)));
      if (!pkg || pkg.id !== input.packageId || pkg.revision !== expected) throw issue('SELF_REPAIR_STALE', 'Saved package revision changed.');
      record.currentRevision = pkg.revision;
      record.currentPackageHash = digest(pkg);
      return pkg;
    }
    async function unchanged(pkg) {
      const current = await saved(pkg.revision);
      if (!isDeepStrictEqual(current, pkg)) throw issue('SELF_REPAIR_STALE', 'Saved package changed without a revision.');
    }
    async function inspect(pkg, renderId) {
      stage('inspect_render', { renderId });
      const report = validateReport(await invoke(() => inspectRender(freeze(clone(pkg)), {
        packageId: input.packageId, expectedRevision: pkg.revision, renderId,
      }, { signal })), pkg, renderId);
      record.reports.push({ reviewId: report.reviewId, packageRevision: report.packageRevision, packageHash: report.packageHash,
        renderId, videoSha256: report.artifact.videoSha256, timelineHash: report.artifact.timelineHash,
        checksStatus: report.checksStatus, findings: clone(report.findings), capabilities: clone(report.capabilities), acceptance: 'not_assessed' });
      record.beforeVideoSha256 ??= report.artifact.videoSha256;
      record.afterVideoSha256 = report.artifact.videoSha256;
      event(record, 'inspection_saved', { reviewId: report.reviewId, renderId, videoSha256: report.artifact.videoSha256 });
      await unchanged(pkg);
      return report;
    }
    try {
      event(record, 'started');
      let pkg = await saved(input.expectedRevision);
      let report = await inspect(pkg, input.renderId);
      const seen = new Set([evidenceHash(report)]);
      const videos = new Set([report.artifact.videoSha256]);
      for (;;) {
        signal.throwIfAborted();
        const assessment = assess(report, pkg);
        if (assessment.reason) return stop(assessment.reason);
        if (assessment.satisfied) {
          record.checksSatisfied = true;
          return stop('scoped_checks_satisfied', 'completed');
        }
        if (record.attempts >= input.maxRepairs || record.renders >= 2) return stop('attempts_exhausted');
        await unchanged(pkg);
        const budget = read(budgetFile(input.packageId)) ?? { version: 1, packageId: input.packageId, reservations: [] };
        if (budget.version !== 1 || budget.packageId !== input.packageId || !Array.isArray(budget.reservations)) throw issue('SELF_REPAIR_BUDGET', 'Invalid persistent repair budget.');
        record.packageRoundsReserved = budget.reservations.length;
        if (budget.reservations.length >= 2) return stop('package_budget_exhausted');
        if (checkRenderReadiness) {
          stage('check_render_readiness');
          const readiness = await invoke(() => checkRenderReadiness({ pkg: freeze(clone(pkg)),
            packageId: input.packageId, expectedRevision: pkg.revision, signal }));
          await unchanged(pkg);
          record.readiness = renderReadiness(readiness);
          event(record, 'render_readiness_checked', { packageHash: digest(pkg), ...record.readiness });
          if (!record.readiness.ok) {
            record.error = { code: record.readiness.code, message: record.readiness.message };
            return stop('render_not_ready');
          }
        }
        const previousAttempts = priorAttempts(budget.reservations);
        record.attempts++;
        stage('reserve_round', { sceneIds: assessment.sceneIds });
        budget.reservations.push({ repairId: input.repairId, conversationId: input.conversationId, attempt: record.attempts,
          revision: pkg.revision, packageHash: digest(pkg), renderId: report.artifact.renderId,
          videoSha256: report.artifact.videoSha256, reviewId: report.reviewId, reservedAt: new Date().toISOString() });
        write(budgetFile(input.packageId), budget);
        record.packageRoundsReserved = budget.reservations.length;
        stage('chat_turn', { sceneIds: assessment.sceneIds, reviewId: report.reviewId });
        const result = await invoke(() => chatTurn({ pkg: freeze(clone(pkg)), report, sceneIds: [...assessment.sceneIds],
          attempt: record.attempts, conversationId: input.conversationId, priorAttempts: previousAttempts, signal }));
        if (result?.ok === false || result?.error || ['failed', 'error', 'cancelled'].includes(result?.status)) throw issue('SELF_REPAIR_TOOL', 'Repair turn reported a failed tool or turn.');
        stage('verify_edit');
        const after = clone(await invoke(() => readPackage(input.packageId)));
        if (after && Number.isSafeInteger(after.revision)) record.currentRevision = after.revision;
        if (after) record.currentPackageHash = digest(after);
        const rejected = verifyEdit(pkg, after, assessment.sceneIds);
        event(record, 'edit_observed', { beforeRevision: pkg.revision, afterRevision: after?.revision ?? null,
          sourceTrimChanges: after ? sourceTrimChanges(pkg, after) : null, validation: rejected ?? 'source_in_only' });
        if (rejected) return stop(rejected);
        pkg = after;
        await unchanged(pkg);
        record.renders++;
        stage('render', { expectedRevision: pkg.revision });
        const rendered = await invoke(() => renderCurrent({ packageId: input.packageId, expectedRevision: pkg.revision,
          signal, repairId: input.repairId, attempt: record.attempts }));
        if (!renderIdOK(rendered?.renderId)) throw issue('SELF_REPAIR_RENDER', 'Render did not return a valid artifact ID.');
        record.lastRenderId = rendered.renderId;
        event(record, 'render_returned', { renderId: rendered.renderId });
        await unchanged(pkg);
        const next = await inspect(pkg, rendered.renderId);
        const regression = comparison(report, next);
        if (regression === 'regression' || regression === 'analyzer_changed') return stop(regression);
        const fingerprint = evidenceHash(next);
        if (videos.has(next.artifact.videoSha256) || seen.has(fingerprint)) return stop('repeated_evidence');
        if (regression) return stop(regression);
        seen.add(fingerprint); videos.add(next.artifact.videoSha256);
        report = next;
      }
    } catch (error) {
      record.error = { code: error?.code ?? 'SELF_REPAIR_FAILED', message: String(error?.message ?? error).slice(0, 500) };
      record.effectUncertain = ['chat_turn', 'render'].includes(record.stage);
      // An adapter can throw after committing. Observe when possible, never undo
      // or infer that a rejected/cancelled turn had no durable effect.
      if (!pending.size && !signal.aborted) {
        try {
          const observed = await invoke(() => readPackage(input.packageId));
          record.observedRevision = observed?.revision ?? null;
          if (observed) record.observedPackageHash = digest(observed);
        } catch { record.observedRevision = null; }
      }
      const reason = signal.aborted ? deadline.signal.aborted ? 'run_budget_exhausted' : 'cancelled'
        : /STALE/.test(error?.code ?? '') ? 'stale_package'
          : record.stage === 'chat_turn' ? 'tool_failed' : record.stage === 'render' ? 'render_failed'
            : record.stage === 'check_render_readiness' ? 'readiness_check_failed' : 'inspection_or_read_failed';
      return stop(reason, signal.aborted ? 'cancelled' : 'stopped');
    } finally {
      clearTimeout(timer);
      const unlock = () => { release(input.packageId, nonce); active.delete(identity); };
      if (pending.size) void Promise.allSettled([...pending]).then(unlock);
      else unlock();
    }
  }
  return { run, get };
}
