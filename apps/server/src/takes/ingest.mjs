// TR04: turn a finished run's outputs into takes.
//
// The run manifest alone decides what landed. `applyManifestToPackage` already knows the
// SPEC 6.4 rules (a ready asset keeps its file, the new output becomes a candidate), so this
// module consumes both `applied` and `candidates` rather than re-implementing them. Every
// file is snapshotted into the takes store *before* the caller copies `outputDir/assets`
// over `packageDir/assets`, which is what keeps an overwritten asset from destroying the
// take it just produced. This module never reads or writes `packageDir/assets`.
//
// RL10b: a run can fail on one clip and succeed on the rest. `ingestRunWithRetries` re-runs
// only the clips that failed, through an injected provider, and lands a recovered clip as a
// take. The retry is bounded (MAX_RETRY_ATTEMPTS), a clip that keeps failing stays failed,
// and the rest of the batch is never affected: one broken clip cannot fail the whole run.
// The retry is recorded twice so the takes panel API can show it: on the clip's `lastJob`
// and in the recovered take's `gen.retry`.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { applyManifestToPackage, mediaFor } from '../../../../packages/jobs/src/apply.mjs';
import { MAX_RETRY_ATTEMPTS, retryRecord } from './model.mjs';

const SHA256_RE = /^[0-9a-f]{64}$/i;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assetIdOf(job) {
  return typeof job === 'string' ? job.split('.')[0] : null;
}

function effectiveRunIdOf(runId) {
  return typeof runId === 'string' && runId.trim() ? runId : 'run_unattributed';
}

/**
 * How many times a failed clip may be retried. The bound is what keeps a broken clip from
 * turning into an endless regeneration loop.
 *
 * @param {unknown} value the requested attempt count
 * @returns {number} 0 (no retry) up to MAX_RETRY_ATTEMPTS
 */
function boundedAttempts(value) {
  if (value === undefined || value === null) return 1;
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, MAX_RETRY_ATTEMPTS);
}

function recordTake(takes, added, succeededAssets, assetId, take) {
  takes.push(take);
  if (!added.has(assetId)) added.set(assetId, new Set());
  added.get(assetId).add(take.takeId);
  succeededAssets.add(assetId);
  return take;
}

/**
 * The takes the store now points at, but only the ones this ingest produced: an approved
 * take stays selected and is not reported as a new selection.
 */
function selectedFor(store, pkgId, added) {
  const selected = {};
  if (typeof store.read === 'function') {
    const doc = store.read(pkgId);
    for (const [assetId, takeIds] of added) {
      const current = doc?.clips?.[assetId]?.selected;
      if (typeof current === 'string' && takeIds.has(current)) selected[assetId] = current;
    }
    return selected;
  }
  for (const [assetId, takeIds] of added) {
    const last = [...takeIds].at(-1);
    if (last) selected[assetId] = last;
  }
  return selected;
}

function cleanError(value) {
  const raw = typeof value === 'string'
    ? value
    : (typeof value?.message === 'string' ? value.message : 'job failed');
  const text = raw.replace(CONTROL_RE, ' ').trim().slice(0, 2000);
  return text || 'job failed';
}

function seedOf(job, baseGen) {
  const candidates = [
    isObject(job?.inputs) ? job.inputs.seed : undefined,
    isObject(job?.params) ? job.params.seed : undefined,
    job?.seed,
    isObject(baseGen?.inputs) ? baseGen.inputs.seed : undefined,
    baseGen?.seed,
  ];
  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function inputsOf(job, baseGen) {
  if (isObject(job?.inputs)) return clone(job.inputs);
  if (isObject(job?.params)) return clone(job.params);
  if (isObject(baseGen?.inputs)) return clone(baseGen.inputs);
  return undefined;
}

function genFor({ asset, job, entry, backend, updatedAt }) {
  const base = isObject(asset?.gen) ? clone(asset.gen) : {};
  const gen = { ...base };
  const inputs = inputsOf(job, base);
  const seed = seedOf(job, base);
  const workflowSha = job?.workflowSha256 ?? job?.workflow_sha256 ?? entry?.workflow_sha256 ?? base.workflow_sha256;
  const jobId = entry?.job_id ?? base.job_id;
  const attemptId = entry?.attempt_id ?? base.attempt_id;
  const generator = job?.generator ?? entry?.generator ?? base.generator;
  const model = job?.model ?? base.model;

  if (typeof generator === 'string' && generator) gen.generator = generator;
  if (typeof job?.workflow === 'string' && job.workflow) gen.workflow = job.workflow;
  if (typeof workflowSha === 'string' && SHA256_RE.test(workflowSha)) gen.workflow_sha256 = workflowSha;
  if (typeof model === 'string' && model) gen.model = model;
  if (seed !== undefined) gen.seed = seed;
  if (inputs !== undefined) gen.inputs = inputs;
  if (jobId !== undefined && jobId !== null && jobId !== '') gen.job_id = jobId;
  if (attemptId !== undefined && attemptId !== null && attemptId !== '') gen.attempt_id = attemptId;
  if (typeof job?.backend === 'string' && job.backend) gen.backend = job.backend;
  else if (typeof backend === 'string' && backend) gen.backend = backend;
  if (isObject(job?.inputs)) {
    if (typeof job.inputs.prompt === 'string') gen.prompt = job.inputs.prompt;
    if (typeof job.inputs.negative === 'string') gen.negative = job.inputs.negative;
  } else if (isObject(job?.params)) {
    if (typeof job.params.prompt === 'string') gen.prompt = job.params.prompt;
    if (typeof job.params.negative === 'string') gen.negative = job.params.negative;
  }
  if (typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))) gen.created_at = updatedAt;
  return gen;
}

function sourceCandidates(output, job) {
  const values = [output?.relative, output?.file, job?.output];
  const candidates = [];
  const add = (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) return;
    if (!candidates.includes(value)) candidates.push(value);
  };
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    add(value);
    if (isAbsolute(value)) {
      add(basename(value));
      const assetsAt = value.lastIndexOf('/assets/');
      if (assetsAt >= 0) add(`assets/${value.slice(assetsAt + '/assets/'.length)}`);
      const outAt = value.lastIndexOf('/out/');
      if (outAt >= 0) add(value.slice(outAt + '/out/'.length));
    }
  }
  return candidates;
}

function resolveSource(outputDir, output, job) {
  const root = resolve(outputDir);
  const rootReal = existsSync(root) ? resolve(realpathSync(root)) : root;
  let fallback = null;
  for (const value of sourceCandidates(output, job)) {
    const target = isAbsolute(value) ? resolve(value) : resolve(root, value);
    if (!inside(root, target)) continue;
    if (!fallback) fallback = target;
    if (!existsSync(target)) continue;
    try {
      if (!statSync(target).isFile()) continue;
      const real = resolve(realpathSync(target));
      if (!inside(rootReal, real)) continue;
    } catch {
      continue;
    }
    return target;
  }
  return fallback;
}

function manifestJobs(manifest) {
  return Array.isArray(manifest?.jobs) ? manifest.jobs.filter(isObject) : [];
}

function successful(entry) {
  const state = typeof entry?.status === 'string' ? entry.status.toLowerCase() : '';
  return state === 'succeeded' || state === 'cached';
}

function isFailedJob(entry) {
  return !successful(entry) && typeof entry?.status === 'string' && entry.status !== '';
}

function outputFor(entry) {
  return Array.isArray(entry?.outputs) ? entry.outputs.find(isObject) ?? null : null;
}

function writeLastJob(store, pkgId, assetId, lastJob) {
  if (typeof store.setLastJob !== 'function') return;
  store.setLastJob(pkgId, assetId, lastJob);
}

/**
 * Where a retried clip's output lives. A relative path stays inside the run's output
 * directory; an absolute path is accepted as it is (the provider may produce the file in
 * a scratch directory) but it always has to be a regular file.
 *
 * @returns {string|null} the absolute path, or null when the provider named no usable file
 */
function resolveRetrySource(outputDir, produced) {
  const value = produced?.file ?? produced?.srcPath ?? produced?.path;
  if (typeof value !== 'string' || value === '' || value.includes('\u0000')) return null;
  const root = resolve(outputDir);
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value);
  if (!isAbsolute(value) && !inside(root, target)) return null;
  try {
    if (!statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  return target;
}

/**
 * Ingest one run's outputs as takes.
 *
 * @param {object} input
 * @param {object} input.pkg package the run was planned from (never mutated)
 * @param {object} input.manifest runner manifest
 * @param {object} input.jobsDoc jobs document for the run
 * @param {string} input.outputDir directory the manifest's relative paths are under
 * @param {object} input.store TR02 take store
 * @param {Record<string, object>} [input.corrections] correction keyed by asset id
 * @param {string} [input.runId]
 * @param {string} [input.backend]
 * @param {object} [input.retry] rejected: retrying a failed clip is `ingestRunWithRetries`
 * @returns {{takes: object[], selected: Record<string, string>, failed: object[]}}
 */
export function ingestRun({ pkg, manifest, jobsDoc, outputDir, store, corrections = {}, runId = null, backend = null, retry = null } = {}) {
  if (!isObject(pkg) || typeof pkg.id !== 'string' || pkg.id === '') {
    throw new TypeError('ingestRun needs a package with an id');
  }
  if (isObject(retry) && typeof retry.provider === 'function') {
    throw new TypeError('ingestRun does not retry a failed clip; use ingestRunWithRetries');
  }
  if (!isObject(manifest)) throw new TypeError('ingestRun needs a run manifest');
  if (typeof outputDir !== 'string' || outputDir === '') {
    throw new TypeError('ingestRun needs an outputDir');
  }
  if (!store || typeof store.addTake !== 'function') throw new TypeError('ingestRun needs a take store');

  const pkgId = pkg.id;
  const effectiveRunId = effectiveRunIdOf(runId);
  const updatedAt = typeof manifest.updatedAt === 'string' ? manifest.updatedAt : undefined;
  const jobs = new Map(((Array.isArray(jobsDoc?.jobs) ? jobsDoc.jobs : [])).filter(isObject).map((job) => [job.id, job]));
  const entries = new Map();
  const failed = [];
  const failedAssets = new Map();
  const succeededAssets = new Set();

  for (const entry of manifestJobs(manifest)) {
    const jobId = entry.job;
    if (typeof jobId !== 'string') continue;
    if (!entries.has(jobId)) entries.set(jobId, entry);
    const assetId = assetIdOf(jobId);
    if (!assetId || !isObject(pkg.assets?.[assetId])) continue;
    if (successful(entry)) {
      succeededAssets.add(assetId);
      continue;
    }
    if (!isFailedJob(entry)) continue;
    const error = cleanError(entry.reason ?? entry.error);
    if (!failedAssets.has(assetId)) failedAssets.set(assetId, error);
    failed.push({ assetId, job: jobId, state: 'failed', status: entry.status, error });
  }

  const appliedResult = applyManifestToPackage(pkg, { manifest, jobsDoc, outDir: outputDir, backend });
  const outputs = [...(appliedResult.applied || []), ...(appliedResult.candidates || [])];
  const takes = [];
  const added = new Map();

  for (const item of outputs) {
    if (!isObject(item)) continue;
    const jobId = item.job;
    const assetId = item.asset ?? assetIdOf(jobId);
    const asset = isObject(pkg.assets?.[assetId]) ? pkg.assets[assetId] : null;
    if (!asset) continue;

    const entry = entries.get(jobId) ?? { job: jobId };
    const job = jobs.get(jobId) ?? null;
    const output = outputFor(entry);
    const file = item.file ?? output?.relative ?? output?.file;
    const srcPath = file ? resolveSource(outputDir, { ...output, relative: item.file ?? output?.relative, file }, job) : null;
    if (!srcPath) {
      const error = 'the run recorded an output file that is missing from the output directory';
      if (!failedAssets.has(assetId)) failedAssets.set(assetId, error);
      failed.push({ assetId, job: jobId, state: 'failed', error });
      continue;
    }

    const gen = genFor({ asset, job, entry, backend, updatedAt });
    const media = mediaFor(job, job?.cutout ?? asset.cutout, output) ?? {};
    const correction = isObject(corrections?.[assetId]) ? clone(corrections[assetId]) : undefined;

    try {
      const take = store.addTake(pkgId, assetId, {
        srcPath,
        sha256: item.sha256 ?? output?.sha256,
        bytes: item.bytes ?? output?.bytes,
        media,
        gen,
        correction,
        runId: effectiveRunId,
        createdAt: updatedAt,
      });
      recordTake(takes, added, succeededAssets, assetId, take);
    } catch (error) {
      const message = cleanError(error);
      if (!failedAssets.has(assetId)) failedAssets.set(assetId, message);
      failed.push({ assetId, job: jobId, state: 'failed', error: message });
    }
  }

  for (const assetId of succeededAssets) {
    writeLastJob(store, pkgId, assetId, { runId: effectiveRunId, state: failedAssets.has(assetId) ? 'failed' : 'succeeded' });
  }
  for (const [assetId, error] of failedAssets) {
    if (succeededAssets.has(assetId)) continue;
    writeLastJob(store, pkgId, assetId, { runId: effectiveRunId, state: 'failed', error });
  }

  return { takes, selected: selectedFor(store, pkgId, added), failed };
}

/**
 * Ingest one run's outputs as takes and retry the clips that failed.
 *
 * RL10b: one broken clip must not fail the whole batch. Every clip that failed is re-run on
 * its own through the injected provider, at most `retry.attempts` times (bounded by
 * MAX_RETRY_ATTEMPTS). A clip the retry recovers lands as a take and both the clip's
 * `lastJob` and the take's `gen.retry` say so, so the takes panel API can show it; a clip
 * that keeps failing stays failed with the number of attempts it got. The provider is only
 * asked for clips that have no take from this run, so a clip that landed is never redone.
 *
 * @param {object} input the same input as ingestRun, plus:
 * @param {object} [input.retry]
 * @param {number} [input.retry.attempts] how many times a failed clip may be retried
 * @param {(ctx: object) => object|Promise<object>} input.retry.provider re-runs one clip and
 *   returns `{file, sha256?, bytes?, media?, gen?}` (or throws, which counts as a failed try)
 * @returns {Promise<{takes: object[], selected: Record<string, string>, failed: object[], retried: object[]}>}
 */
export async function ingestRunWithRetries(input = {}) {
  const { retry = null, ...rest } = input;
  const result = ingestRun(rest);
  const provider = isObject(retry) && typeof retry.provider === 'function' ? retry.provider : null;
  const attempts = boundedAttempts(isObject(retry) ? retry.attempts : undefined);
  if (!provider || attempts <= 0) return { ...result, retried: [] };

  const pkg = rest.pkg;
  const pkgId = pkg.id;
  const store = rest.store;
  const corrections = isObject(rest.corrections) ? rest.corrections : {};
  const runId = effectiveRunIdOf(rest.runId);
  const updatedAt = typeof rest.manifest?.updatedAt === 'string' ? rest.manifest.updatedAt : undefined;
  const jobs = new Map(((Array.isArray(rest.jobsDoc?.jobs) ? rest.jobsDoc.jobs : [])).filter(isObject).map((job) => [job.id, job]));

  // a clip that already landed a take in this run is never retried
  const landed = new Set(result.takes.filter(take => isObject(take) && take.runId === runId).map(take => take.assetId));

  // one retry per clip, even when the manifest failed it more than once
  const pending = [];
  const seen = new Set();
  for (const item of result.failed) {
    if (!isObject(item) || typeof item.assetId !== 'string') continue;
    if (seen.has(item.assetId)) continue;
    seen.add(item.assetId);
    if (landed.has(item.assetId)) continue;
    const asset = isObject(pkg.assets?.[item.assetId]) ? pkg.assets[item.assetId] : null;
    if (!asset) continue;
    pending.push({ item, asset });
  }

  const retried = [];
  const outcomes = new Map();
  const added = new Map();

  for (const { item, asset } of pending) {
    const assetId = item.assetId;
    const job = jobs.get(item.job) ?? null;
    const originalError = typeof item.error === 'string' && item.error !== '' ? item.error : 'job failed';

    let attempt = 0;
    let lastError = originalError;
    let produced = null;
    while (attempt < attempts) {
      attempt += 1;
      try {
        const value = await provider({
          assetId,
          jobId: item.job,
          attempt,
          attempts,
          error: originalError,
          asset,
          job,
          package: pkg,
          runId,
          backend: rest.backend ?? null,
          correction: isObject(corrections[assetId]) ? clone(corrections[assetId]) : undefined,
        });
        if (!isObject(value)) throw new Error('the clip retry provider returned no output');
        produced = value;
        break;
      } catch (error) {
        lastError = cleanError(error);
      }
    }

    if (!produced) {
      // the clip stays failed and the rest of the batch is untouched
      outcomes.set(assetId, { state: 'failed', attempts: attempt, error: lastError });
      retried.push({ assetId, job: item.job, attempts: attempt, state: 'failed', error: lastError });
      writeLastJob(store, pkgId, assetId, {
        runId,
        state: 'failed',
        error: lastError,
        retry: retryRecord({ attempts: attempt, recovered: false, error: originalError }),
      });
      continue;
    }

    try {
      const srcPath = resolveRetrySource(rest.outputDir, produced);
      if (!srcPath) throw new Error('the clip retry provider named no output file');
      const gen = {
        ...genFor({ asset, job, entry: null, backend: rest.backend ?? null, updatedAt }),
        ...(isObject(produced.gen) ? clone(produced.gen) : {}),
        retry: retryRecord({ attempts: attempt, recovered: true, error: originalError }),
      };
      const media = isObject(produced.media)
        ? clone(produced.media)
        : (mediaFor(job, job?.cutout ?? asset.cutout, null) ?? {});
      const correction = isObject(corrections[assetId]) ? clone(corrections[assetId]) : undefined;
      const take = store.addTake(pkgId, assetId, {
        srcPath,
        sha256: produced.sha256,
        bytes: produced.bytes,
        media,
        gen,
        correction,
        runId,
        createdAt: updatedAt,
      });
      result.takes.push(take);
      if (!added.has(assetId)) added.set(assetId, new Set());
      added.get(assetId).add(take.takeId);
      outcomes.set(assetId, { state: 'succeeded', attempts: attempt, error: null });
      retried.push({ assetId, job: item.job, attempts: attempt, state: 'succeeded' });
      writeLastJob(store, pkgId, assetId, {
        runId,
        state: 'succeeded',
        retry: retryRecord({ attempts: attempt, recovered: true, error: originalError }),
      });
    } catch (error) {
      const message = cleanError(error);
      outcomes.set(assetId, { state: 'failed', attempts: attempt, error: message });
      retried.push({ assetId, job: item.job, attempts: attempt, state: 'failed', error: message });
      writeLastJob(store, pkgId, assetId, {
        runId,
        state: 'failed',
        error: message,
        retry: retryRecord({ attempts: attempt, recovered: false, error: originalError }),
      });
    }
  }

  // a recovered clip is no longer failed, a retried clip that kept failing is
  const failed = [];
  const reported = new Set();
  for (const item of result.failed) {
    const assetId = isObject(item) && typeof item.assetId === 'string' ? item.assetId : null;
    const outcome = assetId ? outcomes.get(assetId) : null;
    if (!outcome) {
      failed.push(item);
      continue;
    }
    if (outcome.state === 'succeeded') continue;
    if (reported.has(assetId)) continue;
    reported.add(assetId);
    failed.push({ ...item, retries: outcome.attempts, error: outcome.error });
  }

  const selected = { ...result.selected, ...selectedFor(store, pkgId, added) };
  return { takes: result.takes, selected, failed, retried };
}
