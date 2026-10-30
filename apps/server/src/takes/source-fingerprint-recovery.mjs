// Versioned recovery of one historical collection bug: preview ingestion used
// a pending (hash-less) same-run image instead of the verified image consumed
// by LTX. Never infer freshness from matching video bytes alone. All evidence
// comes from the server-owned run and receipt ledger, not package imports.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { canonical, planJobs, sha256Hex } from '../../../../packages/jobs/src/plan.mjs';
import { MODEL_CONTRIBUTION_POLICY } from '../../../../packages/jobs/src/model-contribution.mjs';
import { genFingerprint } from './model.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
const digestPattern = /^[a-f0-9]{64}$/;

function file(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('unsafe evidence path');
  const path = realpathSync(resolve(root, relative));
  if (!path.startsWith(realpathSync(root) + sep) || !statSync(path).isFile()) throw new Error('evidence path escapes root');
  return path;
}

function json(root, relative) { return JSON.parse(readFileSync(file(root, relative), 'utf8')); }

function verifyBytes(root, relative, hash, bytes) {
  if (!digestPattern.test(hash ?? '') || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('missing byte identity');
  const path = file(root, relative);
  if (statSync(path).size !== bytes || sha(readFileSync(path)) !== hash) throw new Error('evidence bytes changed');
  return path;
}

function semanticGen(gen) {
  const copy = { ...gen };
  for (const key of ['backend', 'job_id', 'attempt_id', 'created_at', 'idempotency_key', 'params_hash']) delete copy[key];
  return copy;
}

/** A recovered baseline must not mask a later on-disk overwrite that kept the
 * package's old sha metadata. Semantic edits are already caught by the normal
 * fingerprint check; only revoke this recovery when its baseline still matches
 * but its byte-bound evidence no longer does. */
export function recoveredSourceBytesChanged({ pkg, assetId, take, packageDir, takeRoot }) {
  const proof = take?.sourceGenFingerprintRecovery;
  const asset = pkg?.assets?.[assetId];
  if (proof?.version !== 1 || take.sourceGenFingerprint !== proof.to
    || genFingerprint(asset?.gen, pkg) !== proof.to) return false;
  try {
    const ref = pkg.assets?.[proof.conditioning?.assetId];
    if (ref?.sha256 !== proof.conditioning.sha256 || ref?.bytes !== proof.conditioning.bytes) return true;
    verifyBytes(packageDir, ref.file, ref.sha256, ref.bytes);
    verifyBytes(packageDir, asset.file, take.sha256, take.bytes);
    verifyBytes(takeRoot, take.file, take.sha256, take.bytes);
    return false;
  } catch {
    return true;
  }
}

/** Returns proof, never mutates package, take, run snapshots or receipts.
 * Unsupported/incomplete historical evidence remains stale. Version 1 is
 * deliberately limited to LTX with one same-run, unconditioned Klein image.
 */
export function recoverPendingReferenceFingerprint({ pkg, assetId, take, runtimeDir, packageDir, takeRoot }) {
  try {
    const previous = take?.sourceGenFingerprint;
    const asset = pkg?.assets?.[assetId];
    if (!digestPattern.test(previous ?? '') || !asset?.gen || asset.kind !== 'video'
      || asset.origin !== 'generated' || asset.status !== 'ready'
      || !/^run_[A-Za-z0-9_-]+$/.test(take.runId ?? '')) return null;
    const fingerprint = genFingerprint(asset.gen, pkg);
    if (previous === fingerprint) return null;
    const runRelative = `runs/${take.runId}`;
    const staged = json(runtimeDir, `${runRelative}/work/package.json`);
    const jobs = json(runtimeDir, `${runRelative}/work/jobs.json`);
    if (staged.id !== pkg.id || jobs.packageId !== pkg.id
      || jobs.hash !== sha256Hex(canonical({ ...jobs, hash: undefined }))
      || planJobs(staged).hash !== jobs.hash) return null;
    const source = staged.assets?.[assetId];
    if (!source?.gen || source.status !== 'pending' || genFingerprint(source.gen, staged) !== previous
      || !same(semanticGen(source.gen), semanticGen(asset.gen))) return null;

    const job = jobs.jobs.find(job => job.asset === assetId && job.kind === 'plate');
    if (job?.generator !== 'ltx25' || job.fileInputs?.length !== 1) return null;
    const input = job.fileInputs[0];
    if (input.from !== 'job' || input.param !== 'image') return null;
    const dependency = jobs.jobs.find(job => job.id === input.job);
    if (dependency?.generator !== 'flux3-klein' || dependency.kind !== 'still'
      || (dependency.fileInputs?.length ?? 0) !== 0 || (dependency.deps?.length ?? 0) !== 0) return null;
    const refId = dependency.asset;
    if (source.gen.inputs?.image !== refId || job.params?.image !== refId) return null;
    const oldRef = staged.assets?.[refId];
    const ref = pkg.assets?.[refId];
    if (oldRef?.origin !== 'generated' || oldRef.status !== 'pending' || oldRef.sha256 !== undefined || oldRef.bytes !== undefined
      || ref?.origin !== 'generated' || ref.status !== 'ready'
      || !same(semanticGen(oldRef.gen), semanticGen(ref.gen))) return null;
    // Prove the only fingerprint difference is this newly resolved content.
    const unresolved = { ...pkg, assets: { ...pkg.assets, [refId]: oldRef } };
    if (genFingerprint(asset.gen, unresolved) !== previous) return null;

    const manifest = json(runtimeDir, `${runRelative}/out/manifest.json`);
    if (manifest.complete !== true || manifest.jobsHash !== jobs.hash) return null;
    function receiptFor(job, current) {
      if (!digestPattern.test(current?.sha256 ?? '')) throw new Error('missing output hash');
      const receipt = json(runtimeDir, `.comfy-provenance/${current.sha256}.json`);
      const entry = manifest.jobs?.find(entry => entry.job === job.id);
      const output = entry?.outputs?.find(output => output.sha256 === current.sha256);
      if (receipt.schema !== MODEL_CONTRIBUTION_POLICY || receipt.status !== 'succeeded'
        || !['colab', 'byo-comfyui'].includes(receipt.backend) || entry?.status !== 'succeeded'
        || output?.workflow_submitted !== true || receipt.runId !== manifest.run_id
        || receipt.jobsHash !== jobs.hash || receipt.plannedJobId !== job.id
        || receipt.jobId !== entry.job_id || receipt.attemptId !== entry.attempt_id
        || receipt.outputSha256 !== current.sha256 || receipt.bytes !== current.bytes
        || receipt.bytes !== output.bytes || receipt.generator !== job.generator || receipt.model !== job.model
        || receipt.workflow !== job.workflow || receipt.workflowSha256 !== job.workflowSha256
        || !same(receipt.conditioning?.params, job.params ?? null)
        || !same(receipt.conditioning?.deps, job.deps ?? [])
        || !same(receipt.conditioning?.fileInputs, job.fileInputs ?? [])
        || !same(receipt.conditioning?.consumed, output.conditioning_inputs ?? [])) throw new Error('receipt does not bind this job/output');
      const relative = output.relative ?? output.file;
      if (relative !== job.output) throw new Error('job output changed');
      verifyBytes(runtimeDir, `${runRelative}/out/${relative}`, current.sha256, current.bytes);
      verifyBytes(packageDir, current.file, current.sha256, current.bytes);
      const capturedPath = `${runRelative}/out/${relative.replace(/\.[^/.]+$/, '.workflow.api.json')}`;
      const captured = readFileSync(file(runtimeDir, capturedPath));
      if (sha(captured) !== receipt.capturedWorkflowSha256) throw new Error('captured workflow changed');
      return { receipt, graph: JSON.parse(captured) };
    }

    const video = receiptFor(job, asset);
    const image = receiptFor(dependency, ref);
    if (take.sha256 !== asset.sha256 || take.bytes !== asset.bytes
      || take.gen?.workflow_sha256 !== job.workflowSha256 || take.gen?.workflow !== job.workflow
      || take.gen?.generator !== job.generator || take.gen?.model !== job.model
      || take.gen?.seed !== job.seed || take.gen?.prompt !== job.params?.prompt
      || !same(take.gen?.inputs, job.params)) return null;
    verifyBytes(takeRoot, take.file, take.sha256, take.bytes);
    const consumed = video.receipt.conditioning.consumed;
    if (consumed.length !== 1 || consumed[0].input !== 'image'
      || consumed[0].sha256 !== ref.sha256 || consumed[0].bytes !== ref.bytes
      || video.graph[consumed[0].nodeId]?.class_type !== 'LoadImage'
      || video.graph[consumed[0].nodeId]?.inputs?.image !== consumed[0].uploadedName) return null;

    return {
      version: 1, reason: 'pending-same-run-conditioning-reference',
      from: previous, to: fingerprint, runId: take.runId, jobsHash: jobs.hash,
      receipts: [video.receipt.outputSha256, image.receipt.outputSha256],
      capturedWorkflowSha256: video.receipt.capturedWorkflowSha256,
      conditioning: { assetId: refId, sha256: ref.sha256, bytes: ref.bytes },
    };
  } catch {
    return null;
  }
}
