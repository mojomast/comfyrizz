// B2: `comfyrizz.package/v1` -> `jobs.json`.
//
// The planner is deterministic (no timestamps, sorted batches, canonical hashing) so
// the same package always produces the same jobs.json hash. It batches every FLUX still
// in the package into one ordered batch *before* any plate (SPEC.md 6.4: one job at a
// time, stills before plates, one GPU session), resolves LTX dimensions to multiples of
// 32 and frame counts to 8n+1, and gives each job a cache key over
// (workflow sha, resolved inputs, model revision, seed, dims, frames).
import { createHash } from "node:crypto";
import { pathProblem } from "../../schema/src/semantic.mjs";
import { resolveDimensions, resolveFrames, resolveFramesFromSeconds } from "./dims.mjs";

export const JOBS_VERSION = 1;
export const BATCH_ORDER = ["stills", "plates", "upscales", "audio"];

/** Latent downsampling factor per job kind: plates/upscales follow the LTX 32 rule. */
export const DIM_MULTIPLE_BY_KIND = { still: 8, plate: 32, upscale: 32 };

const OUTPUT_EXT = { still: ".png", plate: ".mp4", upscale: ".mp4", audio: ".wav" };
const OUTPUT_KIND = { still: "image", plate: "video", upscale: "video", audio: "audio" };
const GENERATOR_KIND = {
  "flux3-klein": "still",
  ltx25: "plate",
  kokoro: "audio",
  "llm-svg": null, // procedural vector: CPU work, no Comfy job (PLAN.md A5)
};

/** Stable JSON: object keys sorted, so a hash never depends on key order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function cacheKeyFor({ workflowSha256, generator, model, modelRevision, params, seed, width, height, frames }) {
  return sha256Hex(
    canonical({
      workflowSha256: workflowSha256 ?? null,
      generator: generator ?? null,
      model: model ?? null,
      modelRevision: modelRevision ?? null,
      params,
      seed: seed ?? null,
      width: width ?? null,
      height: height ?? null,
      frames: frames ?? null,
    }),
  );
}

function requireRelativePath(value, what, errors) {
  const problem = pathProblem(value);
  if (problem) errors.push(`${what}: ${problem} (${JSON.stringify(value)})`);
}

function sceneIndexOf(pkg, assetId) {
  const scenes = Array.isArray(pkg.scenes) ? pkg.scenes : [];
  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i];
    if (!scene || typeof scene !== "object") continue;
    if (scene.background && scene.background.asset === assetId) return i;
    if (Array.isArray(scene.foreground) && scene.foreground.some((fg) => fg && fg.asset === assetId)) return i;
    if (scene.narration_asset === assetId) return i;
  }
  return -1;
}

/**
 * Plan the generation jobs for a package.
 *
 * @param {object} pkg            a comfyrizz.package/v1 document
 * @param {object} [opts]
 * @param {string[]} [opts.assets] only plan these asset ids
 * @param {boolean} [opts.includeReady] also plan assets whose status is ready/candidate
 * @returns {{v:number, packageId:string, revision:number, fps:number, jobs:object[], batches:object[], skipped:object[], hash:string}}
 */
export function planJobs(pkg, opts = {}) {
  const errors = [];
  if (!pkg || typeof pkg !== "object") throw new TypeError("planJobs needs a package document");
  const assets = pkg.assets && typeof pkg.assets === "object" ? pkg.assets : {};
  const fps = (pkg.format && pkg.format.fps) || 30;
  const format = pkg.format || {};
  const only = opts.assets ? new Set(opts.assets) : null;
  const skipped = [];

  const orderedAssets = Object.keys(assets)
    .filter((id) => (only ? only.has(id) : true))
    .sort();

  // Pass 1: decide which assets produce a job at all.
  const kinds = new Map();
  for (const assetId of orderedAssets) {
    const asset = assets[assetId];
    if (!asset || typeof asset !== "object") continue;
    const generator = asset.gen && asset.gen.generator;
    const kind = typeof generator === "string" ? GENERATOR_KIND[generator] : undefined;
    if (kind === undefined) {
      skipped.push({ asset: assetId, reason: `unknown generator ${JSON.stringify(generator)}` });
      continue;
    }
    if (kind === null) {
      skipped.push({ asset: assetId, reason: "llm-svg is CPU work (A5 sanitize + render-check), not a Comfy job" });
      continue;
    }
    if (asset.origin !== "generated") {
      skipped.push({ asset: assetId, reason: `origin ${JSON.stringify(asset.origin)} is not generated` });
      continue;
    }
    const readyish = asset.status === "ready" || asset.status === "candidate" || asset.status === "rejected";
    if (readyish && !opts.includeReady) {
      skipped.push({ asset: assetId, reason: `status ${JSON.stringify(asset.status)} needs no generation` });
      continue;
    }
    kinds.set(assetId, kind);
  }

  // Pass 2: build jobs.
  const jobs = [];
  const add = (job) => {
    if (jobs.some((j) => j.id === job.id)) {
      errors.push(`duplicate job id ${job.id}`);
      return;
    }
    jobs.push(job);
  };

  for (const assetId of [...kinds.keys()].sort()) {
    const asset = assets[assetId];
    const kind = kinds.get(assetId);
    const gen = asset.gen || {};
    const inputs = gen.inputs && typeof gen.inputs === "object" ? gen.inputs : {};
    const sceneIndex = sceneIndexOf(pkg, assetId);
    const scene = sceneIndex >= 0 ? pkg.scenes[sceneIndex].id : null;

    requireRelativePath(gen.workflow, `assets.${assetId}.gen.workflow`, errors);
    if (typeof gen.workflow_sha256 !== "string") {
      errors.push(`assets.${assetId}.gen.workflow_sha256 is required so the job can be cached and audited`);
    }

    const params = { ...inputs };
    const job = {
      id: `${assetId}.${kind}`,
      kind,
      batch: kind === "still" ? "stills" : kind === "plate" ? "plates" : kind === "upscale" ? "upscales" : "audio",
      asset: assetId,
      scene,
      sceneIndex: sceneIndex >= 0 ? sceneIndex : null,
      generator: gen.generator,
      workflow: gen.workflow,
      workflowSha256: gen.workflow_sha256 ?? null,
      model: gen.model ?? null,
      modelRevision: gen.model_revision ?? null,
      deps: [],
      output: `assets/${assetId}${OUTPUT_EXT[kind]}`,
      outputKind: OUTPUT_KIND[kind],
      cacheKey: null,
    };

    if (kind === "still") {
      const requested = {
        width: Number(params.width ?? format.width ?? 1024),
        height: Number(params.height ?? format.height ?? 1024),
      };
      const dims = resolveDimensions(requested.width, requested.height, DIM_MULTIPLE_BY_KIND.still);
      job.dims = { width: dims.width, height: dims.height };
      job.dimsAdjusted = dims.adjusted;
      // A still only sends width/height to the workflow when the package asked for them: some
      // graphs (reference/edit conditioning) take their geometry from the reference image, and
      // inventing a width there would be a parameter the workflow cannot accept.
      if (params.width !== undefined) params.width = dims.width;
      if (params.height !== undefined) params.height = dims.height;
      if (params.cutout === true || asset.cutout === true) job.cutout = true;
      params.cutout = job.cutout === true;
    } else if (kind === "plate") {
      const width = Number(params.width ?? 960);
      const height = Number(params.height ?? 544);
      const dims = resolveDimensions(width, height, DIM_MULTIPLE_BY_KIND.plate);
      const requestedFrames = Number(params.frames ?? Math.round(Number(params.fps ?? 24) * 4));
      const frames = resolveFrames(requestedFrames);
      job.dims = { width: dims.width, height: dims.height };
      job.dimsAdjusted = dims.adjusted;
      job.fps = Number(params.fps ?? 24);
      job.frames = frames;
      job.framesAdjusted = frames !== requestedFrames;
      params.width = dims.width;
      params.height = dims.height;
      params.frames = frames;
      params.fps = job.fps;
      job.inputAsset = typeof params.image === "string" ? params.image : null;
      job.output = `out/intermediates/${assetId}.plate.mp4`;
      if (job.inputAsset && kinds.has(job.inputAsset)) {
        job.deps.push(`${job.inputAsset}.${kinds.get(job.inputAsset)}`);
      }
      if (params.upscale) {
        // A plate that will be upscaled is an intermediate; the upscale job owns the asset file.
        job.output = `out/intermediates/${assetId}.plate.mp4`;
        const upscaleParams = { ...params, upscale: params.upscale };
        // A package may name a dedicated finals graph; otherwise the upscale stage of the plate
        // graph is reused, and `paramsSource` tells the runner to prefer that stage's map.
        const upscaleWorkflow = inputs.upscale_workflow ?? gen.workflow;
        requireRelativePath(upscaleWorkflow, `assets.${assetId}.gen.inputs.upscale_workflow`, errors);
        const up = {
          id: `${assetId}.upscale`,
          kind: "upscale",
          batch: "upscales",
          asset: assetId,
          scene,
          sceneIndex: sceneIndex >= 0 ? sceneIndex : null,
          generator: gen.generator,
          workflow: upscaleWorkflow,
          paramsSource: "upscale",
          workflowSha256: gen.workflow_sha256 ?? null,
          model: gen.model ?? null,
          modelRevision: gen.model_revision ?? null,
          deps: [`${assetId}.plate`],
          output: `assets/${assetId}${OUTPUT_EXT.upscale}`,
          outputKind: "video",
          params: upscaleParams,
          source: `out/intermediates/${assetId}.plate.mp4`,
        };
        const factor = /x\s*(\d)/i.exec(String(upscaleParams.upscale));
        const scale = factor ? Number(factor[1]) : 2;
        const target = {
          width: dims.width * scale,
          height: dims.height * scale,
        };
        const cropX = Number(format.width) && target.width > Number(format.width) ? target.width - Number(format.width) : 0;
        const cropY = Number(format.height) && target.height > Number(format.height) ? target.height - Number(format.height) : 0;
        up.dims = { width: target.width - cropX, height: target.height - cropY };
        up.upscaleTarget = target;
        if (cropX || cropY) {
          up.crop = { top: Math.floor(cropY / 2), bottom: Math.ceil(cropY / 2), left: Math.floor(cropX / 2), right: Math.ceil(cropX / 2) };
        }
        up.frames = frames;
        up.fps = job.fps;
        up.cacheKey = cacheKeyFor({
          workflowSha256: up.workflowSha256,
          generator: up.generator,
          model: up.model,
          modelRevision: up.modelRevision,
          params: up.params,
          seed: params.seed,
          width: up.dims.width,
          height: up.dims.height,
          frames: up.frames,
        });
        add(up);
      }
    } else if (kind === "audio") {
      job.text = typeof gen.caption === "string" ? gen.caption : "";
      if (!job.text) errors.push(`assets.${assetId} (kokoro) needs gen.caption for the text to speak`);
    }

    job.params = params;
    job.seed = Number.isFinite(Number(params.seed)) ? Number(params.seed) : null;
    if (!job.cacheKey) {
      job.cacheKey = cacheKeyFor({
        workflowSha256: job.workflowSha256,
        generator: job.generator,
        model: job.model,
        modelRevision: job.modelRevision,
        params,
        seed: job.seed,
        width: job.dims?.width,
        height: job.dims?.height,
        frames: job.frames,
      });
    }
    add(job);
  }

  if (errors.length) {
    const error = new Error(`cannot plan jobs:\n${errors.join("\n")}`);
    error.problems = errors;
    throw error;
  }

  // Deterministic execution order: batch first (every FLUX still before any plate),
  // then scene order, then asset id, then kind. jobs[] is in the order the runner
  // walks it, and batches[] names the same runs for a UI or a log.
  const batchIndex = (job) => BATCH_ORDER.indexOf(job.batch);
  jobs.sort(
    (a, b) =>
      batchIndex(a) - batchIndex(b) ||
      (a.sceneIndex ?? Number.MAX_SAFE_INTEGER) - (b.sceneIndex ?? Number.MAX_SAFE_INTEGER) ||
      a.asset.localeCompare(b.asset) ||
      a.kind.localeCompare(b.kind),
  );

  const batches = BATCH_ORDER.map((name) => ({
    name,
    jobs: jobs.filter((j) => j.batch === name).map((j) => j.id),
  })).filter((batch) => batch.jobs.length > 0);

  const doc = {
    v: JOBS_VERSION,
    packageId: pkg.id ?? null,
    revision: pkg.revision ?? null,
    revisionHash: pkg.timeline_sha256 ?? null,
    fps,
    batches,
    jobs,
    skipped,
  };
  doc.hash = sha256Hex(canonical({ ...doc, hash: undefined }));
  return doc;
}

/** Structural self-check of a jobs.json document (used by the CLI and by pipeline-py). */
export function checkJobsDoc(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object") return ["jobs document must be an object"];
  if (doc.v !== JOBS_VERSION) problems.push(`v must be ${JOBS_VERSION}`);
  if (!Array.isArray(doc.jobs)) problems.push("jobs must be an array");
  const ids = new Set();
  for (const job of doc.jobs || []) {
    if (!job || typeof job !== "object") {
      problems.push("every job must be an object");
      continue;
    }
    if (typeof job.id !== "string" || !job.id) problems.push("job.id must be a non-empty string");
    if (ids.has(job.id)) problems.push(`duplicate job id ${job.id}`);
    ids.add(job.id);
    if (!BATCH_ORDER.includes(job.batch)) problems.push(`${job.id}: batch ${JSON.stringify(job.batch)} is not one of ${BATCH_ORDER.join(", ")}`);
    const pathIssue = pathProblem(job.output);
    if (pathIssue) problems.push(`${job.id}: output path ${pathIssue}`);
    if (typeof job.cacheKey !== "string" || job.cacheKey.length !== 64) problems.push(`${job.id}: cacheKey must be a sha256`);
    for (const dep of job.deps || []) {
      if (!(doc.jobs || []).some((other) => other.id === dep)) problems.push(`${job.id}: dependency ${dep} is not in this document`);
    }
  }
  return problems;
}
