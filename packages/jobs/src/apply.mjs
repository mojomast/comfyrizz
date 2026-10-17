// B5: write a finished run back into the package, with provenance.
//
// The runner's manifest says which job produced which file; this module turns that into
// `comfyrizz.package/v1` assets that still validate: `status: ready`, the collected file and its
// hash, media geometry from the job, `gen` provenance (generator, model, job id, attempt id,
// backend) and the generated-first default output licence (CC0-1.0, redistributable true).
//
// Two rules from SPEC.md 6.4 are enforced here:
//   * a later failure never discards earlier outputs — only jobs that succeeded are applied;
//   * a late result never replaces approved content — an asset that was already ready with a
//     file of its own keeps it, and the new output is recorded as a candidate instead.
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { MODEL_LICENSES, MODEL_GENERATORS } from "../../schema/src/semantic.mjs";

const GENERATED_LICENSE = { id: "CC0-1.0" };

/** Map a job kind onto the package's asset kinds and the media it implies.
 *
 * The geometry comes from the file the run actually produced where the runner measured it, and from
 * the plan only as a fallback: a reference-edit graph sizes its output from the reference image's
 * megapixels (1360x768 at 1.0 MP in GPU test 3), so the package format the plan guessed was wrong
 * in `media` and the renderer would lay out against the wrong shape (N4).
 */
export function mediaFor(job, cutout, output = null) {
  if (!job) return undefined;
  const measured = output?.measured || {};
  const width = measured.width ?? job.dims?.width;
  const height = measured.height ?? job.dims?.height;
  if (job.kind === "still") {
    return { width, height, alpha: cutout === true };
  }
  if (job.kind === "plate" || job.kind === "upscale") {
    return {
      width,
      height,
      fps: measured.fps ?? job.fps,
      frames: measured.frames ?? job.frames,
      ...(measured.durationSeconds === undefined ? {} : { durationSeconds: measured.durationSeconds }),
      audio: "muted",
    };
  }
  if (job.kind === "audio") return { audio: "present" };
  return undefined;
}

/**
 * @param {object} pkg          the package the run belongs to (not mutated)
 * @param {object} run          {manifest, jobsDoc, outDir, backend}
 * @returns {{package: object, applied: object[], candidates: object[], untouched: object[]}}
 */
export function applyManifestToPackage(pkg, { manifest, jobsDoc, outDir, backend = null } = {}) {
  if (!pkg || typeof pkg !== "object") throw new TypeError("applyManifestToPackage needs a package");
  if (!manifest) throw new TypeError("applyManifestToPackage needs a manifest (it alone decides what landed)");
  const jobs = new Map(((jobsDoc?.jobs) || []).map((job) => [job.id, job]));
  const copy = JSON.parse(JSON.stringify(pkg));
  copy.assets = copy.assets || {};
  const applied = [];
  const candidates = [];
  const untouched = [];

  for (const entry of manifest.jobs || []) {
    const assetId = String(entry.job).split(".")[0];
    const asset = copy.assets[assetId];
    if (!asset) {
      untouched.push({ job: entry.job, reason: "not an asset in this package" });
      continue;
    }
    if (entry.status !== "succeeded" && entry.status !== "cached") {
      asset.status = asset.status === "ready" ? "ready" : "failed";
      untouched.push({ job: entry.job, status: entry.status, reason: entry.reason || entry.error?.message || "not applied" });
      continue;
    }
    const output = (entry.outputs || [])[0];
    if (!output) {
      untouched.push({ job: entry.job, reason: "the manifest records no output file" });
      continue;
    }
    const relative = output.relative || output.file;
    const job = jobs.get(entry.job);
    const generator = job?.generator ?? asset.gen?.generator;
    // never a null: a cache hit carries the ids of the attempt that produced the file, and when even
    // that is unknown the key is left out rather than written as null (GPU test 3, N6 - a null fails
    // the package schema, so the run's result could not be applied at all)
    const jobId = entry.job_id ?? asset.gen?.job_id;
    const attemptId = entry.attempt_id ?? asset.gen?.attempt_id;
    const modelLicense = asset.model_license ?? MODEL_LICENSES[generator];
    const provenance = {
      ...(asset.gen || {}),
      generator,
      backend: backend || job?.backend || asset.gen?.backend || "byo-comfyui",
      ...(jobId ? { job_id: jobId } : {}),
      ...(attemptId ? { attempt_id: attemptId } : {}),
      created_at: manifest.updatedAt || new Date().toISOString(),
    };
    if (job?.workflow) provenance.workflow = job.workflow;
    if (job?.workflowSha256) provenance.workflow_sha256 = job.workflowSha256;
    if (job?.model) provenance.model = job.model; else if (asset.gen?.model) provenance.model = asset.gen.model;

    const next = {
      ...asset,
      status: "ready",
      file: relative,
      sha256: output.sha256,
      bytes: output.bytes ?? sizeOf(outDir, relative),
      license: asset.license || { ...GENERATED_LICENSE },
      redistributable: asset.redistributable ?? true,
      ...(modelLicense ? { model_license: modelLicense } : {}),
      gen: provenance,
      ...(mediaFor(job, job?.cutout ?? asset.cutout, output) ? { media: mediaFor(job, job?.cutout ?? asset.cutout, output) } : {}),
    };
    if (asset.cutout === true || job?.cutout === true) next.cutout = true;

    const alreadyApproved = asset.status === "ready" && asset.file && asset.sha256 && asset.sha256 !== output.sha256;
    if (alreadyApproved) {
      candidates.push({
        job: entry.job,
        asset: assetId,
        file: relative,
        sha256: output.sha256,
        note: "the asset was already ready with different content: kept, this run recorded as a candidate",
      });
      continue;
    }
    copy.assets[assetId] = next;
    applied.push({ job: entry.job, asset: assetId, file: relative, sha256: output.sha256, status: entry.status });
  }

  copy.revision = Number(copy.revision || 1) + 1;
  const backends = new Set([...(copy.compliance?.backends_used || []), backend].filter(Boolean));
  copy.compliance = { ...(copy.compliance || {}), backends_used: [...backends] };
  return { package: copy, applied, candidates, untouched };
}

function sizeOf(outDir, relative) {
  if (!outDir || !relative || isAbsolute(relative)) return undefined;
  try {
    return statSync(join(outDir, relative)).size;
  } catch {
    return undefined;
  }
}
