// TR04: turn a finished run's outputs into takes.
//
// The run manifest alone decides what landed. `applyManifestToPackage` already knows the
// SPEC 6.4 rules (a ready asset keeps its file, the new output becomes a candidate), so this
// module consumes both `applied` and `candidates` rather than re-implementing them. Every
// file is snapshotted into the takes store *before* the caller copies `outputDir/assets`
// over `packageDir/assets`, which is what keeps an overwritten asset from destroying the
// take it just produced. This module never reads or writes `packageDir/assets`.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { applyManifestToPackage, mediaFor } from '../../../../packages/jobs/src/apply.mjs';

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
 * @returns {{takes: object[], selected: Record<string, string>, failed: object[]}}
 */
export function ingestRun({ pkg, manifest, jobsDoc, outputDir, store, corrections = {}, runId = null, backend = null } = {}) {
  if (!isObject(pkg) || typeof pkg.id !== 'string' || pkg.id === '') {
    throw new TypeError('ingestRun needs a package with an id');
  }
  if (!isObject(manifest)) throw new TypeError('ingestRun needs a run manifest');
  if (typeof outputDir !== 'string' || outputDir === '') {
    throw new TypeError('ingestRun needs an outputDir');
  }
  if (!store || typeof store.addTake !== 'function') throw new TypeError('ingestRun needs a take store');

  const pkgId = pkg.id;
  const effectiveRunId = typeof runId === 'string' && runId.trim() ? runId : 'run_unattributed';
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
      takes.push(take);
      if (!added.has(assetId)) added.set(assetId, new Set());
      added.get(assetId).add(take.takeId);
      succeededAssets.add(assetId);
    } catch (error) {
      const message = cleanError(error);
      if (!failedAssets.has(assetId)) failedAssets.set(assetId, message);
      failed.push({ assetId, job: jobId, state: 'failed', error: message });
    }
  }

  for (const assetId of succeededAssets) {
    if (typeof store.setLastJob !== 'function') break;
    store.setLastJob(pkgId, assetId, { runId: effectiveRunId, state: failedAssets.has(assetId) ? 'failed' : 'succeeded' });
  }
  for (const [assetId, error] of failedAssets) {
    if (succeededAssets.has(assetId)) continue;
    if (typeof store.setLastJob === 'function') store.setLastJob(pkgId, assetId, { runId: effectiveRunId, state: 'failed', error });
  }

  const selected = {};
  if (typeof store.read === 'function') {
    const doc = store.read(pkgId);
    for (const [assetId, takeIds] of added) {
      const current = doc?.clips?.[assetId]?.selected;
      if (typeof current === 'string' && takeIds.has(current)) selected[assetId] = current;
    }
  } else {
    for (const [assetId, takeIds] of added) {
      const last = [...takeIds].at(-1);
      if (last) selected[assetId] = last;
    }
  }

  return { takes, selected, failed };
}
