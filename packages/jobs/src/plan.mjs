// B2: `comfyrizz.package/v1` -> `jobs.json`.
//
// The planner is deterministic (no timestamps, sorted batches, canonical hashing) so
// the same package always produces the same jobs.json hash. It batches every FLUX still
// in the package into one ordered batch *before* any plate (SPEC.md 6.4: one job at a
// time, stills before plates, one GPU session), resolves LTX dimensions to multiples of
// 64 (32 at stage 1) and frame counts to 8n+1, and gives each job a cache key over
// (workflow sha, resolved inputs, model revision, seed, dims, frames). A still that
// names a cast member also folds the reference file's sha256 into that key.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathProblem } from "../../schema/src/semantic.mjs";
import { applyMotionRoleDefaults, applyPresenterDefaults, applyPromptDefaults } from "./defaults.mjs";
import { dimsForMegapixels, isDimensionValid, isFrameCountValid, resolveDimensions, resolveFrames, resolveFramesFromSeconds } from "./dims.mjs";
import { buildFastH3Prompt, fastH3SlotSeconds } from "./fasth3-direction.mjs";
import { planningAssetIds, sceneAssetIds } from "./reachable.mjs";
import { KLEIN_REF_CAP, REF_EDIT_WORKFLOW, REF2_EDIT_WORKFLOW, kleinReferenceProblem } from "./klein-references.mjs";
export { KLEIN_REF_CAP, REF_EDIT_WORKFLOW, REF2_EDIT_WORKFLOW } from "./klein-references.mjs";

export const JOBS_VERSION = 1;
export const BATCH_ORDER = ["stills", "plates", "upscales", "audio", "presenters"];

/**
 * Latent downsampling factor per job kind: plates/upscales follow the LTX rule, stills the Klein
 * 16 rule. Klein's VAE factor is 8 but its patch size is 2, so a still that is only a multiple of
 * 8 is padded or cropped by the model — GPU test 2 shipped 960x540 sample rasters and the fix was
 * "use 960x544 or 1024x576" (docs/GPU_TEST_2.md, issue 6).
 *
 * Plates are 64, not 32 (GPU test 3, N9): the two-stage graph renders stage 1 at *half* the final
 * size, and LTX floors its latents to 32, so a final size that is a multiple of 32 but not of 64
 * needs a stage-1 size that is not a multiple of 32 at all. A planned 960x544 went in and 960x512
 * came out — the plan said one thing and the file was another, which is how a media dims mismatch
 * reached `apply`. A multiple of 64 makes the half a multiple of 32 by construction.
 */
export const DIM_MULTIPLE_BY_KIND = { still: 16, plate: 64, upscale: 64 };

/**
 * FastH3 Omni's own geometry (RL12, experimental).
 *
 * The reference-to-video+audio graph is not LTX: its spatial lattice is 32 pixels, its frame counts
 * are 17n+5 (the model's temporal lattice) and it runs at 24 fps, because the generated audio is
 * muxed with the frames into one MP4. A count that is not 17n+5 is rounded *up*, so the shot is
 * never shorter than the line it has to speak.
 */
export const FASTH3_DIM_MULTIPLE = 32;
export const FASTH3_FRAME_MODULUS = 17;
export const FASTH3_FRAME_OFFSET = 5;
export const FASTH3_FPS = 24;

/**
 * VX05: the two-image graph with no LoadAudio input. Prompt-voice shots give the model a written
 * voice description instead of a clip, so the audio graph is not what they execute.
 */
export const FASTH3_NOCLIP_WORKFLOW = "workflows/fasth3_omni_ref2v_noclip.api.json";
export const FASTH3_PROMPT_WORDS_PER_SECOND = 2.5;

/** The next FastH3 frame count (17n+5) at or above the requested one. */
export function resolveFastH3Frames(requested) {
  const base = Math.max(FASTH3_FRAME_OFFSET, requested);
  const remainder = base % FASTH3_FRAME_MODULUS;
  const pad = (FASTH3_FRAME_OFFSET - remainder + FASTH3_FRAME_MODULUS) % FASTH3_FRAME_MODULUS;
  return base + pad;
}

/**
 * Parameters whose value is a *file* the graph has to be given a server-side name for
 * (a `LoadImage`-style node). The runner uploads these to ComfyUI's input directory and injects
 * the name it gets back; without this the graph receives the asset id and the server answers
 * "Prompt outputs failed validation" (GPU test 2, issue 2).
 */
export const FILE_PARAMS = ["image", "reference", "mask", "audio"];

/**
 * IP58/A25: the one motion-reference input name. A plate names the **documented excerpt derivative**
 * asset in `gen.inputs.motion_reference`; the raw reference upload is never a graph input. There is
 * deliberately no `asset.frames` / `asset.derivatives` fallback: a frame extracted from a clip is a
 * start image (an explicit `image`), not motion transfer.
 *
 * A workflow may receive this input only when its capability profile declares
 * `slots.motion_reference`. The shipped LTX i2v and FastH3 Omni graphs do not, so naming a motion
 * reference on them is a planning error, not a silent start-frame substitution.
 */
export const MOTION_REFERENCE_INPUT = "motion_reference";
const MOTION_REFERENCE_CONTROLS = [
  "motion_reference_original",
  "motion_reference_original_sha256",
  "motion_reference_in",
  "motion_reference_out",
  "motion_reference_fps",
  "motion_reference_audio",
];
const MOTION_AUDIO_POLICIES = ["muted", "none", "present"];
const SHA256_RE = /^[a-f0-9]{64}$/;

function capabilityProfile(generator, slots = {}) {
  return Object.freeze({
    generator,
    slots: Object.freeze({
      image: false,
      reference: false,
      mask: false,
      audio: false,
      motion_reference: false,
      ...slots,
    }),
  });
}

/**
 * What each shipped graph can really consume. `motion_reference: true` means the graph has a video
 * conditioning slot; none ships yet. `workflowCapabilities` on `planJobs` may add a profile for a
 * test fixture or a future graph without changing this table.
 */
export const WORKFLOW_CAPABILITY_PROFILES = Object.freeze({
  "workflows/flux3_klein_t2i.api.json": capabilityProfile("flux3-klein"),
  "workflows/flux3_klein_img2img.api.json": capabilityProfile("flux3-klein", { image: true }),
  "workflows/flux3_klein_ref_edit.api.json": capabilityProfile("flux3-klein", { image: true, reference: true }),
  "workflows/flux3_klein_ref2_edit.api.json": capabilityProfile("flux3-klein", { image: true, reference: true }),
  "workflows/character_lora_klein.api.json": capabilityProfile("flux3-klein", { image: true, reference: true }),
  "workflows/character_identity_pulid.api.json": capabilityProfile("flux3-klein", { image: true, reference: true }),
  "workflows/ltx25_i2v_2stage.api.json": capabilityProfile("ltx25", { image: true }),
  "workflows/ltx25_t2v_2stage.api.json": capabilityProfile("ltx25"),
  "workflows/ltx25_a2v_2stage.api.json": capabilityProfile("ltx25-a2v", { image: true, audio: true }),
  "workflows/fasth3_omni_ref2va.api.json": capabilityProfile("fasth3-omni", { image: true, reference: true, audio: true }),
});

function profileForWorkflow(workflow, overrides) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, workflow)) return overrides[workflow];
  return WORKFLOW_CAPABILITY_PROFILES[workflow] ?? capabilityProfile(null);
}

function hasMotionReferenceSlot(profile) {
  const slots = profile && typeof profile === "object" ? profile.slots : null;
  return Boolean(slots && (slots.motion_reference === true || slots.video === true));
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflowShaCaches = new Map();
let fastH3NoclipWorkflowShaCache = null;

function workflowSha(workflow) {
  if (!workflowShaCaches.has(workflow)) workflowShaCaches.set(workflow, sha256Hex(readFileSync(join(REPO_ROOT, workflow))));
  return workflowShaCaches.get(workflow);
}

function refEditWorkflowSha() {
  return workflowSha(REF_EDIT_WORKFLOW);
}

function fastH3NoclipWorkflowSha() {
  if (!fastH3NoclipWorkflowShaCache) {
    fastH3NoclipWorkflowShaCache = sha256Hex(readFileSync(join(REPO_ROOT, FASTH3_NOCLIP_WORKFLOW)));
  }
  return fastH3NoclipWorkflowShaCache;
}

function extraRefParam(index) {
  return `_reference_${index + 1}`;
}

export function isUploadParam(param) {
  return param === MOTION_REFERENCE_INPUT || FILE_PARAMS.includes(param) || /^_reference_(?:[2-9]|10)$/.test(param);
}

function fileParamNames() {
  const names = [...FILE_PARAMS];
  for (let n = 2; n <= KLEIN_REF_CAP; n += 1) names.push(`_reference_${n}`);
  return names;
}

/** Which job kind produces the file a file-parameter needs. */
const FILE_PARAM_KIND = { image: "still", reference: "still", mask: "still", audio: "audio", video: "plate" };

const OUTPUT_EXT = { still: ".png", plate: ".mp4", upscale: ".mp4", audio: ".wav", presenter: ".mp4" };
const OUTPUT_KIND = { still: "image", plate: "video", upscale: "video", audio: "audio", presenter: "video" };
const GENERATOR_KIND = {
  "flux3-klein": "still",
  ltx25: "plate",
  "fasth3-omni": "plate",
  // H17: the presenter is LTX-2.5 audio-to-video - the same weights, a different graph, and its own
  // batch because it can only run once the narration it is generated from exists
  "ltx25-a2v": "presenter",
  // RL12: FastH3 Omni is experimental - reference-conditioned video *with* native audio. It plans
  // like a plate (one MP4 per shot) but with its own geometry rules (see the plate branch below).
  "fasth3-omni": "plate",
  kokoro: "audio",
  "llm-svg": null, // procedural vector: CPU work, no Comfy job (PLAN.md A5)
  "procedural-audio": null, // deterministic PCM finishing stem: already synthesized on CPU
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

/** A prompt-voice line has no measured WAV, so its duration is estimated from the words. */
export function estimateFastH3SpeechSeconds(text) {
  if (typeof text !== "string") return 0;
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return words.length / FASTH3_PROMPT_WORDS_PER_SECOND;
}

/**
 * VX05: the shipped direction helper emits the clip-mode voice references (`<Audio 1>` and the
 * `<d>` dialogue tag). A prompt-voice shot has no audio slot, so its prompt carries a fixed voice
 * section with the description verbatim and the exact line in quotes. The rest of the helper's
 * prompt is kept as-is so the two modes share one formatting contract.
 */
function applyFastH3PromptVoice(prompt, { description, line, language }) {
  let next = prompt
    .replace(/^<Audio 1> is .*$/m, () => `voice:\n${description}`)
    .replace(
      /^<Audio 1>: reference - .*$/m,
      () => "<Voice 1>: prompt - generate a new synchronized performance from the written voice description.",
    )
    .replace("[reference generation + audio reference]", "[reference generation + prompt voice]");
  if (line !== undefined) {
    next = next.replace(/<d>\[[^\]]+\][\s\S]*?<\/d>/, () => `[${language}] "${line}"`);
  }
  return next;
}

export function cacheKeyFor({ workflowSha256, generator, model, modelRevision, params, seed, width, height, frames, refSha256, motionRef }) {
  // `refSha256` and `motionRef` are omitted unless they were attached, so a package with neither
  // hashes exactly as before.
  const body = {
    workflowSha256: workflowSha256 ?? null,
    generator: generator ?? null,
    model: model ?? null,
    modelRevision: modelRevision ?? null,
    params,
    seed: seed ?? null,
    width: width ?? null,
    height: height ?? null,
    frames: frames ?? null,
  };
  if (refSha256 != null) body.refSha256 = refSha256;
  // IP58: derivative hashes and excerpt parameters are part of the key, so a new excerpt of the same
  // source cannot reuse a previous clip's paid output.
  if (motionRef != null) body.motionRef = motionRef;
  return sha256Hex(canonical(body));
}

function requireRelativePath(value, what, errors) {
  const problem = pathProblem(value);
  if (problem) errors.push(`${what}: ${problem} (${JSON.stringify(value)})`);
}

function sceneIndexOf(pkg, assetId) {
  const scenes = Array.isArray(pkg.scenes) ? pkg.scenes : [];
  for (let i = 0; i < scenes.length; i += 1) {
    if (sceneAssetIds(scenes[i]).includes(assetId)) return i;
  }
  return -1;
}

/**
 * The upscale strength a package asked for: `upscale: "x2"` (or true) is 2. The file's suffix says
 * what the upscale was; the *dims* of the variant are whatever the file turned out to be (N4).
 */
function upscaleScale(inputs) {
  const raw = inputs?.upscale;
  if (raw === undefined || raw === null || raw === false) return 0;
  const factor = /x\s*(\d+(?:\.\d+)?)/i.exec(String(raw === true ? "x2" : raw));
  return factor ? Number(factor[1]) : 2;
}

/** The x2 variant's filename: it says the upscale, never the resulting size. */
function upscaleFileName(assetId, inputs) {
  return `assets/${assetId}@${String(upscaleScale(inputs)).replace(/\.0$/, "")}x${OUTPUT_EXT.upscale}`;
}

/** The job that ends up owning an asset's *file*, with the path that file lands at. */
function producerOf(pkg, assetId, kind) {
  const asset = (pkg.assets && pkg.assets[assetId]) || {};
  const inputs = (asset.gen && asset.gen.inputs) || {};
  if (kind === "still") return { job: `${assetId}.still`, path: `assets/${assetId}.png` };
  if (kind === "audio") return { job: `${assetId}.audio`, path: `assets/${assetId}.wav` };
  // H12: a plate that is upscaled has two files. The plate is the asset's own file (1x, in the
  // package's media dir) and the upscale is a *variant* the 1080p export prefers. The upscale job is
  // therefore not the producer of the asset's file any more - it produces `variants.upscaled`.
  if (kind === "upscale") return { job: `${assetId}.upscale`, path: upscaleFileName(assetId, inputs), variant: "upscaled" };
  // an upscaled plate's own file is its plate output; a plain plate is claimed here too (its
  // intermediate path is what the manifest reports, see the plate branch below)
  if (inputs.upscale) return { job: `${assetId}.plate`, path: `assets/${assetId}${OUTPUT_EXT.plate}` };
  return { job: `${assetId}.plate`, path: `assets/${assetId}${OUTPUT_EXT.plate}` };
}

function looksLikePath(value) {
  return value.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(value);
}

/**
 * Turn one file-valued parameter into the instruction the runner needs: where the file is now
 * and who produces it. Returns null and pushes a message when there is nothing to upload —
 * passing the raw value through is what produced the GPU test 2 failure.
 */
function resolveFileInput({ param, value, assetId, pkg, kinds, errors }) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`assets.${assetId}: ${param} must be a string naming an asset or a relative file path, got ${JSON.stringify(value)}`);
    return null;
  }
  const needed = FILE_PARAM_KIND[param] || "still";
  if (kinds.has(value) && kinds.get(value) === needed) {
    const producer = producerOf(pkg, value, needed);
    return { param, from: "job", job: producer.job, path: producer.path };
  }
  if (kinds.has(value)) {
    errors.push(
      `assets.${assetId}: ${param} needs a ${needed} but ${value} is planned as ${kinds.get(value)}; ` +
        "give the asset id of a generated still (or a relative path to a file staged next to jobs.json)",
    );
    return null;
  }
  const asset = pkg.assets && pkg.assets[value];
  if (asset) {
    const file = asset.file;
    if (typeof file !== "string" || !file) {
      errors.push(
        `assets.${assetId}: ${param} references asset ${value}, which is not generated by this plan and carries no ` +
          "`file`, so there is nothing to upload for the graph to load",
      );
      return null;
    }
    return { param, from: "package", path: file };
  }
  if (looksLikePath(value)) {
    // a file the caller staged next to jobs.json (the bundle layout on the Google Colab VM)
    const problem = pathProblem(value);
    if (problem) {
      errors.push(`assets.${assetId}: ${param} ${problem} (${JSON.stringify(value)})`);
      return null;
    }
    return { param, from: "package", path: value };
  }
  errors.push(
    `assets.${assetId}: ${param} is ${JSON.stringify(value)}: not an asset in this package and not a relative path, ` +
      "so there is nothing to upload and the graph would be handed a value LoadImage cannot load",
  );
  return null;
}

/**
 * Resolve a plate's motion reference against the workflow's capability profile.
 *
 * Canonical package shape (all values are `gen.inputs` scalars, so the package stays schema-valid):
 *   motion_reference:              asset id of the excerpt derivative (kind video, ready file+sha)
 *   motion_reference_original:     optional original asset id (default: excerpt.source.id)
 *   motion_reference_original_sha256: optional original sha256 (default: that asset's sha256)
 *   motion_reference_in:           source in-point seconds (default 0)
 *   motion_reference_out:          source out-point seconds (default excerpt media.durationSeconds)
 *   motion_reference_fps:          excerpt fps (default excerpt media.fps)
 *   motion_reference_audio:        muted | none | present (default excerpt media.audio ?? none)
 *
 * Returns `{ fileInput, ...provenance }` and removes the planner controls from `params`. The file
 * input is always the excerpt's file: an excerpt that names the original file/hash is refused.
 */
function resolveMotionReference({ pkg, assetId, kind, gen, inputs, params, profile, errors }) {
  const named = inputs[MOTION_REFERENCE_INPUT];
  const present = named !== undefined && named !== null;
  // these are planner controls, never node params (the runner refuses an unmapped param)
  for (const name of MOTION_REFERENCE_CONTROLS) delete params[name];
  if (!present) return null;
  delete params[MOTION_REFERENCE_INPUT];

  const workflow = gen.workflow ?? "(no workflow)";
  const unsupported = (detail) =>
    `PLAN_MOTION_REFERENCE_UNSUPPORTED assets.${assetId}: motion reference ${JSON.stringify(named)} cannot be executed by ` +
    `${workflow} (${detail}); its capability profile declares no motion reference video slot. ` +
    "Use an explicit `image` start frame if that is what is wanted - a clip's frame 0 is not motion transfer.";
  const invalid = (detail) => `PLAN_MOTION_REFERENCE_INVALID assets.${assetId}: ${detail}`;

  if (kind !== "plate") {
    errors.push(unsupported(`a ${kind} job`));
    return null;
  }
  if (!hasMotionReferenceSlot(profile)) {
    errors.push(unsupported("workflow capability profile"));
    return null;
  }
  if (typeof named !== "string" || !named.trim()) {
    errors.push(invalid(`${MOTION_REFERENCE_INPUT} must name the excerpt derivative asset, got ${JSON.stringify(named)}`));
    return null;
  }

  const excerptAsset = pkg.assets?.[named];
  if (!excerptAsset || typeof excerptAsset !== "object") {
    errors.push(invalid(`${JSON.stringify(named)} is not an asset in this package; motion references name an excerpt asset, not a path or a raw upload`));
    return null;
  }
  if (excerptAsset.kind !== "video") {
    errors.push(invalid(`excerpt asset ${named} is a ${JSON.stringify(excerptAsset.kind)} asset, not a video`));
    return null;
  }
  const excerptFile = excerptAsset.file;
  const excerptSha256 = excerptAsset.sha256;
  if (typeof excerptFile !== "string" || !excerptFile) {
    errors.push(invalid(`excerpt asset ${named} carries no file; the runner has nothing to upload`));
    return null;
  }
  const excerptPathProblem = pathProblem(excerptFile);
  if (excerptPathProblem) {
    errors.push(invalid(`excerpt asset ${named} file ${excerptPathProblem} (${JSON.stringify(excerptFile)})`));
    return null;
  }
  if (typeof excerptSha256 !== "string" || !SHA256_RE.test(excerptSha256)) {
    errors.push(invalid(`excerpt asset ${named} needs a lowercase sha256 of the derivative bytes`));
    return null;
  }

  const sourceId = excerptAsset.source && typeof excerptAsset.source.id === "string" ? excerptAsset.source.id : null;
  const originalId = typeof inputs.motion_reference_original === "string" && inputs.motion_reference_original
    ? inputs.motion_reference_original
    : sourceId;
  const originalAsset = originalId ? pkg.assets?.[originalId] : null;
  const originalSha256 = typeof inputs.motion_reference_original_sha256 === "string"
    ? inputs.motion_reference_original_sha256
    : originalAsset?.sha256;
  const originalFile = typeof originalAsset?.file === "string"
    ? originalAsset.file
    : excerptAsset.source && typeof excerptAsset.source.original_file === "string"
      ? excerptAsset.source.original_file
      : null;
  if (typeof originalId !== "string" || !originalId || typeof originalSha256 !== "string" || !SHA256_RE.test(originalSha256)) {
    errors.push(
      `PLAN_MOTION_REFERENCE_PROVENANCE assets.${assetId}: the excerpt needs its original asset id and sha256 ` +
        "(name it in motion_reference_original/motion_reference_original_sha256, or set source.id on the excerpt asset)",
    );
    return null;
  }
  if (originalId === named || excerptSha256 === originalSha256 || (originalFile && excerptFile === originalFile)) {
    errors.push(
      `PLAN_MOTION_REFERENCE_RAW_SOURCE assets.${assetId}: ${JSON.stringify(named)} is the raw original, not an excerpt; ` +
        "make the documented trim/scale derivative a separate asset and name that instead",
    );
    return null;
  }

  const originalFps = Number(originalAsset?.media?.fps);
  const excerptFps = Number(inputs.motion_reference_fps ?? excerptAsset.media?.fps);
  const inSeconds = Number(inputs.motion_reference_in ?? 0);
  const outSeconds = Number(inputs.motion_reference_out ?? excerptAsset.media?.durationSeconds);
  const audio = typeof inputs.motion_reference_audio === "string"
    ? inputs.motion_reference_audio
    : (excerptAsset.media?.audio ?? "none");
  if (!Number.isFinite(inSeconds) || inSeconds < 0) {
    errors.push(invalid(`motion_reference_in must be a non-negative number of seconds, got ${JSON.stringify(inputs.motion_reference_in)}`));
    return null;
  }
  if (!Number.isFinite(outSeconds) || outSeconds <= inSeconds) {
    errors.push(invalid(`motion_reference_out must be greater than the in-point, got ${JSON.stringify(inputs.motion_reference_out)}`));
    return null;
  }
  if (!Number.isFinite(excerptFps) || excerptFps <= 0 || excerptFps > 240) {
    errors.push(invalid(`motion_reference_fps must be a positive frame rate, got ${JSON.stringify(inputs.motion_reference_fps)}`));
    return null;
  }
  if (!MOTION_AUDIO_POLICIES.includes(audio)) {
    errors.push(invalid(`motion_reference_audio must be one of ${MOTION_AUDIO_POLICIES.join(", ")}, got ${JSON.stringify(audio)}`));
    return null;
  }

  const transformations = [{ op: "trim", inSeconds, outSeconds }];
  transformations.push({ op: "fps", ...(Number.isFinite(originalFps) && originalFps > 0 ? { from: originalFps } : {}), to: excerptFps });
  if (
    Number(originalAsset?.media?.width) > 0 &&
    Number(originalAsset?.media?.height) > 0 &&
    Number(excerptAsset.media?.width) > 0 &&
    Number(excerptAsset.media?.height) > 0 &&
    (originalAsset.media.width !== excerptAsset.media.width || originalAsset.media.height !== excerptAsset.media.height)
  ) {
    transformations.push({
      op: "scale",
      from: { width: originalAsset.media.width, height: originalAsset.media.height },
      to: { width: excerptAsset.media.width, height: excerptAsset.media.height },
    });
  }
  transformations.push({ op: "audio", policy: audio });

  return {
    fileInput: { param: MOTION_REFERENCE_INPUT, from: "package", path: excerptFile },
    slot: MOTION_REFERENCE_INPUT,
    workflow,
    original: { asset: originalId, sha256: originalSha256, ...(originalFile ? { file: originalFile } : {}) },
    excerpt: { asset: named, file: excerptFile, sha256: excerptSha256 },
    source: { inSeconds, outSeconds, fps: excerptFps },
    transformations,
    audio,
  };
}

/** The job-facing provenance record, without the internal fileInput instruction. */
function motionReferenceProvenance(motion) {
  return {
    slot: motion.slot,
    workflow: motion.workflow,
    original: motion.original,
    excerpt: motion.excerpt,
    source: motion.source,
    transformations: motion.transformations,
    audio: motion.audio,
  };
}

/** Cache-key view of a motion reference: both byte hashes plus the excerpt parameters. */
function motionReferenceKey(motion) {
  return {
    originalSha256: motion.original.sha256,
    excerptSha256: motion.excerpt.sha256,
    source: motion.source,
    audio: motion.audio,
    transformations: motion.transformations,
  };
}

/**
 * The dims a reference/edit job will really produce, or null when the asset is not reference-sized.
 *
 * `megapixels` is the graph's own budget parameter (ReferenceMultiLatent in the Klein ref-edit graph
 * carries `resolution.megapixels`), and it sizes the output from the reference image: the plan has to
 * say the same kind of number instead of the package format (GPU test 3, N4). The reference is
 * resolved from the asset it names — another asset's planned size, or that asset's own inputs.
 */
function referenceSizedDims({ params, kind, assets, kinds, format, multiple, referenceMultiple }) {
  if (kind !== "still") return null;
  const megapixels = Number(params.megapixels);
  if (!(megapixels > 0)) return null;
  const referenceId = typeof params.reference === "string" ? params.reference : typeof params.image === "string" ? params.image : null;
  // The reference's size is known only when this same plan generates it: then its own inputs resolved
  // on its own lattice are what it will be planned at (order-independent, since it is the same rule
  // its job uses). A file the package ships has a size this plan cannot read, and inventing the
  // format for it is exactly the N4 mistake - the caller is told instead.
  const generated = referenceId && kinds.has(referenceId) && kinds.get(referenceId) === "still";
  if (!generated) return null;
  const referenceInputs = assets[referenceId]?.gen?.inputs || {};
  const refWidth = Number(referenceInputs.width ?? format.width);
  const refHeight = Number(referenceInputs.height ?? format.height);
  if (!(refWidth > 0) || !(refHeight > 0)) return null;
  const planned = resolveDimensions(refWidth, refHeight, referenceMultiple ?? multiple);
  return dimsForMegapixels(planned.width, planned.height, megapixels, multiple);
}

/** Attach the resolved file inputs to a job, and record the job that produces each one. */
function withFileInputs(job, params, assetId, ctx) {
  const entries = [];
  for (const name of fileParamNames()) {
    if (params[name] === undefined || params[name] === null) continue;
    const entry = resolveFileInput({ param: name, value: params[name], assetId, pkg: ctx.pkg, kinds: ctx.kinds, errors: ctx.errors });
    if (!entry) continue;
    if (entry.from === "job" && !job.deps.includes(entry.job)) job.deps.push(entry.job);
    entries.push(entry);
  }
  if (entries.length) job.fileInputs = entries;
  return entries;
}

/** How much of an aspect mismatch is rounding noise rather than a different shape. */
const ASPECT_TOLERANCE = 0.01;

/**
 * An i2v source has to be at its plate's aspect (GPU test 2: "a 1:1 mascot fed to 16:9 i2v was
 * centre-cropped, cutting off the head"). The graph's ImageScale centre-crops whatever it gets, so
 * a source of the wrong shape loses content silently - the plan refuses instead, and a caller that
 * really wants the crop has to say so (`{ allowAspectMismatch: true }`), which the plan then records.
 */
function checkSourceAspect({ pkg, plateAssetId, sourceId, dims, format, kinds, errors, allowed, warnings, sourceMultiple }) {
  if (!sourceId || !kinds.has(sourceId) || kinds.get(sourceId) !== "still") return;
  const inputs = (pkg.assets?.[sourceId]?.gen?.inputs) || {};
  const source = resolveDimensions(
    Number(inputs.width ?? format.width ?? 1024),
    Number(inputs.height ?? format.height ?? 1024),
    sourceMultiple ?? DIM_MULTIPLE_BY_KIND.still,
  );
  const plateAspect = dims.width / dims.height;
  const sourceAspect = source.width / source.height;
  if (Math.abs(plateAspect - sourceAspect) / plateAspect <= ASPECT_TOLERANCE) return;
  const message =
    `assets.${plateAssetId}: its first frame ${sourceId} is planned at ${source.width}x${source.height} ` +
    `(aspect ${sourceAspect.toFixed(3)}) but this plate renders at ${dims.width}x${dims.height} (aspect ${plateAspect.toFixed(3)}). ` +
    "An i2v source of a different shape is centre-cropped, which cuts content off (GPU test 2); generate it at the " +
    `plate's aspect (e.g. width ${dims.width}, height ${dims.height})`;
  if (allowed) {
    warnings.push({ asset: plateAssetId, code: "PLAN_SOURCE_ASPECT_MISMATCH", message: `${message} - allowed by the caller` });
    return;
  }
  errors.push(message);
}

function sceneNamesAsset(scene, assetId) {
  return sceneAssetIds(scene).includes(assetId);
}

/** Cast members a Klein still depicts: its own `cast`, a scene that shows it, or the presenter portrait. */
function membersForStill(pkg, assetId) {
  const wanted = new Set();
  const asset = pkg.assets?.[assetId];
  if (typeof asset?.cast === "string") wanted.add(asset.cast);
  for (const scene of Array.isArray(pkg.scenes) ? pkg.scenes : []) {
    if (!sceneNamesAsset(scene, assetId) || !Array.isArray(scene.cast)) continue;
    for (const id of scene.cast) if (typeof id === "string") wanted.add(id);
  }
  const presenter = pkg.presenter;
  if (presenter && typeof presenter === "object" && presenter.portrait === assetId && typeof presenter.cast === "string") {
    wanted.add(presenter.cast);
  }
  if (!wanted.size || !Array.isArray(pkg.cast)) return [];
  const out = [];
  for (const member of pkg.cast) {
    if (!member || typeof member.id !== "string" || !wanted.has(member.id)) continue;
    if (member.ref_asset === assetId) continue;
    out.push(member);
  }
  return out;
}

function listedRefs(params) {
  const out = [];
  const first = params.reference ?? params.image;
  if (typeof first === "string" && first) out.push(first);
  for (let n = 2; n <= KLEIN_REF_CAP; n += 1) {
    const value = params[`reference_${n}`] ?? params[`_reference_${n}`];
    if (typeof value === "string" && value) out.push(value);
  }
  return out;
}

function writeRefSlots(params, refs) {
  delete params.image;
  delete params.reference;
  for (let n = 2; n <= KLEIN_REF_CAP; n += 1) {
    delete params[`reference_${n}`];
    delete params[`_reference_${n}`];
  }
  refs.forEach((value, index) => {
    if (index === 0) params.reference = value;
    else params[extraRefParam(index)] = value;
  });
}

/** Normalize every Klein ref-edit job before sizing, dependency and upload planning. */
function normalizeRefEditParams(params) {
  const refs = listedRefs(params);
  if (refs.length && (params.reference !== undefined || refs.length > 1)) writeRefSlots(params, refs);
  if (!(Number(params.megapixels) > 0)) {
    const width = Number(params.width);
    const height = Number(params.height);
    if (width > 0 && height > 0) params.megapixels = width * height / 1_000_000;
  }
  // ReferenceMultiLatent takes one area budget, never independent width/height inputs.
  delete params.width;
  delete params.height;
  return refs;
}

/**
 * Append each named cast member's ref_asset to a Klein still's reference list (cap 2,
 * existing refs first, cast members in `cast[]` order). Returns null when this still
 * does not name a cast member, so packages without cast keep the same params and cache keys.
 */
function applyCastReferences({ pkg, assetId, params, workflow, workflowSha256, errors }) {
  const members = membersForStill(pkg, assetId);
  if (!members.length) return null;
  const ready = [];
  for (const member of members) {
    const refId = member.ref_asset;
    const ref = typeof refId === "string" ? pkg.assets?.[refId] : null;
    const sha = ref && typeof ref.sha256 === "string" ? ref.sha256 : null;
    const file = ref && typeof ref.file === "string" ? ref.file : "";
    const still = ref && (ref.kind === "image" || ref.kind === "svg");
    if (!ref || !file || !sha || ref.status !== "ready" || !still) {
      errors.push(
        `assets.${assetId}: cast ${member.id} ref_asset ${JSON.stringify(refId)} is missing or not ready, so there is no reference file to upload`,
      );
      continue;
    }
    ready.push({ id: refId, sha });
  }
  if (!ready.length) return null;

  const next = listedRefs(params);
  const attached = [];
  for (const ref of ready) {
    if (next.includes(ref.id)) {
      attached.push(ref);
      continue;
    }
    if (next.length >= KLEIN_REF_CAP) {
      errors.push(`assets.${assetId}: PLAN_KLEIN_REFERENCE_UNSUPPORTED: cast ${ref.id} would exceed two connected references; choose the intended references explicitly instead of dropping a source`);
      return null;
    }
    next.push(ref.id);
    attached.push(ref);
  }
  if (!attached.length) return null;

  writeRefSlots(params, next);
  let nextWorkflow = workflow;
  let nextSha = workflowSha256;
  if (workflow !== REF_EDIT_WORKFLOW) {
    nextWorkflow = REF_EDIT_WORKFLOW;
    nextSha = refEditWorkflowSha();
  }
  return { workflow: nextWorkflow, workflowSha256: nextSha, refSha256: attached.map((ref) => ref.sha) };
}

/**
 * Plan the generation jobs for a package.
 *
 * @param {object} pkg            a comfyrizz.package/v1 document
 * @param {object} [opts]
 * @param {string[]} [opts.assets] only plan these asset ids
 * @param {boolean} [opts.includeReady] also plan assets whose status is ready/candidate
 * @param {object} [opts.workflowCapabilities] extra/replacement capability profiles, keyed by
 *   workflow path (tests use this for a graph with a motion-reference video slot; none ships yet)
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
  //: things the plan did on purpose that a reader should know about (an allowed aspect mismatch)
  const warnings = [];

  const orderedAssets = planningAssetIds(pkg, opts);
  const plannedAssetSet = new Set(orderedAssets);
  if (!only) {
    for (const assetId of Object.keys(assets).sort()) {
      if (!plannedAssetSet.has(assetId)) skipped.push({ asset: assetId, reason: "asset is not reachable from a scene or package render input" });
    }
  }

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
      skipped.push({ asset: assetId, reason: generator === "llm-svg" ? "llm-svg is CPU work (A5 sanitize + render-check), not a Comfy job" : "procedural-audio is already synthesized on CPU, not a Comfy job" });
      continue;
    }
    if (asset.origin !== "generated") {
      skipped.push({ asset: assetId, reason: `origin ${JSON.stringify(asset.origin)} is not generated` });
      continue;
    }
    const readyish = asset.status === "ready" || asset.status === "candidate" || asset.status === "rejected";
    // includeReady regenerates explicitly selected roots, not their already
    // available dependency closure. Unready dependencies still become jobs so
    // the caller can price or refuse the expanded work.
    if (readyish && (!opts.includeReady || (only && !only.has(assetId)))) {
      skipped.push({ asset: assetId, reason: `status ${JSON.stringify(asset.status)} needs no generation` });
      continue;
    }
    kinds.set(assetId, kind);
  }

  // Pass 1b: an i2v source is planned on its *plate's* lattice, not the still lattice.
  // The source still is the plate's first frame, and the plate's dims are what the graph renders, so
  // a 16-lattice source against a 64-lattice plate is a shape mismatch the aspect check has to
  // refuse (GPU test 3, N9: a package asking 960x544 for both planned a 960x544 still and a 960x576
  // plate). Resolving the source on the plate's lattice makes the pair agree by construction, so a
  // package only has to state one size for both.
  const sourceLattice = new Map();
  for (const [assetId, kind] of kinds) {
    if (kind !== "plate" && kind !== "upscale") continue;
    // RL12: a FastH3 plate's `image` is an identity reference, not the first frame of the shot, so
    // it is not planned on the plate's lattice and never coerced to the plate's aspect.
    if (assets[assetId]?.gen?.generator === "fasth3-omni") continue;
    const sourceId = assets[assetId]?.gen?.inputs?.image;
    if (typeof sourceId !== "string") continue;
    const lattice = DIM_MULTIPLE_BY_KIND[kind] ?? DIM_MULTIPLE_BY_KIND.still;
    sourceLattice.set(sourceId, Math.max(lattice, sourceLattice.get(sourceId) ?? 0));
  }
  /** The lattice a still's dims resolve on: its plate's when it is one, its own otherwise. */
  const latticeFor = (assetId) => sourceLattice.get(assetId) ?? DIM_MULTIPLE_BY_KIND.still;

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
    // VX05: prompt voice is a FastH3 direction field. An absent voice (or mode "clip") is the
    // unchanged audio-conditioned path; only an explicit prompt mode selects the no-clip graph.
    const h3Voice = gen.generator === "fasth3-omni" && gen.direction && typeof gen.direction === "object"
      ? gen.direction.voice
      : undefined;
    const h3VoiceMode = h3Voice && h3Voice.mode === "prompt" ? "prompt" : "clip";
    if (gen.direction !== undefined && gen.generator !== 'fasth3-omni') {
      errors.push(`${assetId}: structured direction is supported only by FastH3 Omni`);
    }
    const inputs = gen.inputs && typeof gen.inputs === "object" ? gen.inputs : {};
    if (gen.generator === 'flux3-klein') {
      const problem = kleinReferenceProblem(inputs);
      if (problem) { errors.push(`assets.${assetId}: ${problem}`); continue; }
    }
    const sceneIndex = sceneIndexOf(pkg, assetId);
    const scene = sceneIndex >= 0 ? pkg.scenes[sceneIndex].id : null;

    requireRelativePath(gen.workflow, `assets.${assetId}.gen.workflow`, errors);
    if (typeof gen.workflow_sha256 !== "string") {
      errors.push(`assets.${assetId}.gen.workflow_sha256 is required so the job can be cached and audited`);
    }

    const params = { ...inputs };
    // Planner-only flags are not node inputs. `text`/`allowText` steer the prompt guards below, and
    // they used to travel inside `params`, which the runner refused on the VM with "no params.json
    // mapping for text" (GPU test 3, N1) - a whole job lost to a flag the graph never sees. The
    // decision stays on the job (`allowText`) instead.
    const textAllowed = inputs.text === true || inputs.allowText === true;
    delete params.text;
    delete params.allowText;
    // Prompt defaults first, so the plate's upscale stage (which copies these params) inherits the
    // same guards, and so the guard is part of the cache key rather than a VM-side edit.
    let promptGuards = [];
    if (kind === "still" || (kind === "plate" && gen.generator !== "fasth3-omni")) {
      const sourceInputs = (typeof inputs.image === "string" && assets[inputs.image]?.gen?.inputs) || {};
      const applied = applyPromptDefaults(params, {
        kind,
        asset: assetId,
        textAllowed,
        textFrames: textAllowed || sourceInputs.text === true || sourceInputs.allowText === true,
        hasSourceImage: typeof inputs.image === "string" && inputs.image !== "",
      });
      promptGuards = applied.applied;
      warnings.push(...applied.warnings);
    }

    // The motion role (optional, R1): a UI board, a diagram, a chart backdrop or a background loop
    // must not move the frame at all, and that decides the i2v strength, the length and the framing
    // sentence. Like `text`, `role` is a planner control: it never travels into `params`, because the
    // LTX params map does not declare it and an unmapped param is refused on the VM (GPU test 3, N1).
    const roleInputs = (typeof inputs.image === "string" && assets[inputs.image]?.gen?.inputs) || {};
    const motionRole = typeof inputs.role === "string" ? inputs.role : typeof roleInputs.role === "string" ? roleInputs.role : null;
    delete params.role;
    if (kind === "plate" && gen.generator !== "fasth3-omni") {
      const motion = applyMotionRoleDefaults(params, {
        role: motionRole,
        kind,
        hasSourceImage: typeof inputs.image === "string" && inputs.image !== "",
        textFrames: textAllowed || roleInputs.text === true || roleInputs.allowText === true,
        asset: assetId,
      });
      promptGuards.push(...motion.applied);
      warnings.push(...motion.warnings);
    }
    if (kind === "presenter") {
      // H17: the narration it is generated from decides the length, and the portrait decides the
      // identity; `audio` is a package-sourced file input, so its asset is where the length is measured.
      const narration = typeof inputs.audio === "string" ? assets[inputs.audio] : null;
      const narrationFrames = narration?.media?.frames ?? (sceneIndex >= 0 ? pkg.scenes[sceneIndex].narration_duration_frames : null);
      const presenter = applyPresenterDefaults(params, { narrationFrames: narrationFrames ?? null, asset: assetId });
      promptGuards.push(...presenter.applied);
      warnings.push(...presenter.warnings.map((message) => ({ asset: assetId, code: "PLAN_PRESENTER_ADJUSTED", message })));
    }
    let workflow = gen.workflow;
    let workflowSha256 = gen.workflow_sha256 ?? null;
    if (kind === "plate" && gen.generator === "fasth3-omni" && h3VoiceMode === "prompt") {
      // The package names the graph its assets were authored against; prompt mode executes the
      // committed no-clip graph, with that graph's own hash (never the audio graph's stale one).
      workflow = FASTH3_NOCLIP_WORKFLOW;
      workflowSha256 = fastH3NoclipWorkflowSha();
    }
    let castRefSha256 = null;
    // IP58: a motion reference is admitted only when this exact graph has a video slot. The check
    // runs even when the plate also has an explicit start image, so nothing is silently ignored.
    const motionReference = resolveMotionReference({
      pkg,
      assetId,
      kind,
      gen,
      inputs,
      params,
      profile: profileForWorkflow(gen.workflow, opts.workflowCapabilities),
      errors,
    });
    if (kind === "still") {
      const cast = applyCastReferences({ pkg, assetId, params, workflow, workflowSha256, errors });
      if (cast) {
        workflow = cast.workflow;
        workflowSha256 = cast.workflowSha256;
        castRefSha256 = cast.refSha256;
      }
      if (workflow === REF_EDIT_WORKFLOW || workflow === REF2_EDIT_WORKFLOW) {
        const refs = normalizeRefEditParams(params);
        if (refs.length === 2) {
          workflow = REF2_EDIT_WORKFLOW;
          workflowSha256 = workflowSha(REF2_EDIT_WORKFLOW);
        } else if (workflow === REF2_EDIT_WORKFLOW) {
          workflow = REF_EDIT_WORKFLOW;
          workflowSha256 = refEditWorkflowSha();
        }
      }
    }
    const job = {
      id: `${assetId}.${kind}`,
      kind,
      batch:
        kind === "still"
          ? "stills"
          : kind === "plate"
            ? "plates"
            : kind === "upscale"
              ? "upscales"
              : kind === "presenter"
                ? "presenters"
                : "audio",
      asset: assetId,
      scene,
      sceneIndex: sceneIndex >= 0 ? sceneIndex : null,
      generator: gen.generator,
      workflow,
      workflowSha256,
      model: gen.model ?? null,
      modelRevision: gen.model_revision ?? null,
      deps: [],
      output: `assets/${assetId}${OUTPUT_EXT[kind]}`,
      outputKind: OUTPUT_KIND[kind],
      cacheKey: null,
    };
    if (textAllowed) job.allowText = true;

    if (kind === "still") {
      const requested = {
        width: Number(params.width ?? format.width ?? 1024),
        height: Number(params.height ?? format.height ?? 1024),
      };
      // A reference/edit graph sizes its output from the reference image at the megapixel budget, so
      // the package format is not what comes out (GPU test 3, N4: plan 1920x1080, file 1360x768 at
      // 1.0 MP). When the asset asks for megapixels, the plan states that estimate; the runner
      // measures the file it actually downloaded and apply prefers that.
      const sized = referenceSizedDims({
        params,
        kind,
        assets,
        kinds,
        format,
        multiple: latticeFor(assetId),
        referenceMultiple: typeof params.reference === "string" ? latticeFor(params.reference) : undefined,
      });
      const dims = sized ?? resolveDimensions(requested.width, requested.height, latticeFor(assetId));
      job.dims = { width: dims.width, height: dims.height };
      job.dimsAdjusted = dims.adjusted;
      if (sized) {
        job.dimsSource = "reference-megapixels";
        job.referenceDims = sized.reference;
        job.megapixels = sized.megapixels;
      } else if (Number(params.megapixels) > 0) {
        // a megapixel-sized graph whose reference this plan does not generate: the output size is not
        // the package format, and only the file the run produces can say what it is (N4)
        warnings.push({
          asset: assetId,
          code: "PLAN_REFERENCE_SIZE_UNKNOWN",
          message:
            `${assetId} is sized from its reference at ${params.megapixels} MP, so dims ${job.dims.width}x${job.dims.height} ` +
            "is the package format and not the size this job will produce; the runner measures the real file (GPU test 3, N4)",
        });
      }
      // A still only sends width/height to the workflow when the package asked for them: some
      // graphs (reference/edit conditioning) take their geometry from the reference image, and
      // inventing a width there would be a parameter the workflow cannot accept.
      if (params.width !== undefined) params.width = dims.width;
      if (params.height !== undefined) params.height = dims.height;
      if (params.cutout === true || asset.cutout === true) job.cutout = true;
      params.cutout = job.cutout === true;
    } else if (kind === "plate" && gen.generator === "fasth3-omni") {
      // RL12: FastH3 Omni is reference-conditioned video *with* native audio, and none of LTX's
      // plate rules apply to it:
      //   * its `image` and `reference` are identity/context pictures, not the first frame of the
      //     shot, so there is no framing lock, no strength and no source-aspect coercion;
      //   * there is no half-resolution stage, so there is no `stage1Dims`;
      //   * the graph's lattice is 32 pixels and its frame counts are 17n+5 at 24 fps (the model's
      //     temporal lattice), not LTX's 8n+1;
      //   * the MP4 keeps the generated audio, so the asset's own file is the render (no upscale
      //     stage is supported by this graph).
      const promptVoice = h3VoiceMode === "prompt";
      const width = Number(params.width ?? 832);
      const height = Number(params.height ?? 480);
      const requestedFrames = Number(params.frames ?? 124);
      if (![width, height, requestedFrames].every(Number.isInteger) || width < 32 || height < 32 || requestedFrames < 5 || requestedFrames > 362) {
        errors.push(`${assetId}: FastH3 requires positive integer dimensions and 5..362 requested frames`);
      }
      if (params.fps !== undefined && Number(params.fps) !== 24) errors.push(`${assetId}: FastH3 audio/video must use 24 fps`);
      if (params.upscale) errors.push(`${assetId}: FastH3 does not support the LTX upscale stage`);
      if (promptVoice) {
        if (typeof h3Voice?.description !== "string" || h3Voice.description.trim() === "") {
          errors.push(`${assetId}: PLAN_H3_NO_VOICE_DESCRIPTION prompt voice mode requires direction.voice.description; it never falls back to a clip`);
        }
        if (!Number.isInteger(h3Voice?.seed) || h3Voice.seed < 0 || h3Voice.seed > 0xffffffff) {
          errors.push(`${assetId}: PLAN_H3_VOICE_SEED_INVALID prompt voice mode requires direction.voice.seed as a uint32`);
        } else {
          params.seed = h3Voice.seed;
        }
        if (Object.prototype.hasOwnProperty.call(inputs, "audio") && inputs.audio !== undefined) {
          errors.push(`${assetId}: PLAN_H3_PROMPT_HAS_AUDIO prompt voice mode takes a written description and no audio clip; remove gen.inputs.audio`);
        }
        delete params.audio;
      }
      const requiredInputs = promptVoice ? ["image", "reference"] : ["image", "reference", "audio"];
      for (const name of requiredInputs) {
        if (typeof params[name] !== "string" || !params[name]) errors.push(`${assetId}: FastH3 template requires ${name}`);
      }
      const dims = resolveDimensions(width, height, FASTH3_DIM_MULTIPLE);
      // 17n+5, rounded up: the model's own temporal lattice.
      const frames = resolveFastH3Frames(requestedFrames);
      job.dims = { width: dims.width, height: dims.height };
      job.dimsAdjusted = dims.adjusted;
      job.frames = frames;
      job.framesAdjusted = frames !== requestedFrames;
      job.fps = FASTH3_FPS;
      job.output = `assets/${assetId}${OUTPUT_EXT.plate}`;
      params.width = dims.width;
      params.height = dims.height;
      params.frames = frames;
      params.fps = FASTH3_FPS;
      if (gen.direction !== undefined) {
        try {
          const dialogue = gen.direction.dialogue;
          // Prompt mode has no WAV to measure: estimate the line at words / 2.5 and let the same
          // slot check refuse a line that cannot finish before the cut.
          const conditioningSeconds = promptVoice
            ? estimateFastH3SpeechSeconds(dialogue?.text)
            : assets[inputs.audio]?.media?.durationSeconds;
          let prompt = buildFastH3Prompt(gen.direction, {
            slotSeconds: fastH3SlotSeconds(pkg, assetId, gen.direction?.slotSeconds),
            sourceSeconds: frames / 24,
            conditioningSeconds,
          });
          if (promptVoice && typeof h3Voice?.description === "string") {
            prompt = applyFastH3PromptVoice(prompt, {
              description: h3Voice.description,
              line: dialogue?.text,
              language: dialogue?.language,
            });
          }
          params.prompt = prompt;
        } catch (error) { errors.push(`${assetId}: ${error.message}`); }
      } else {
        warnings.push({ asset: assetId, code: 'PLAN_H3_DIRECTION_UNREVIEWED',
          message: 'Legacy FastH3 prompt: reference roles, exact-line conditioning and editorial speech fit have not been checked. Use gen.direction for structured direction.' });
      }
      if (inputs.image === inputs.reference) warnings.push({ asset: assetId, code: 'PLAN_H3_DUPLICATE_REFERENCE',
        message: 'The same image occupies both reference slots; this does not anchor a first frame. Prefer distinct identity and composition references when available.' });
      castRefSha256 = sha256Hex(canonical(promptVoice
        ? [
            { name: "image", asset: params.image, sha256: assets[params.image]?.sha256 ?? null },
            { name: "reference", asset: params.reference, sha256: assets[params.reference]?.sha256 ?? null },
            { voiceDescription: h3Voice?.description ?? null, seed: h3Voice?.seed ?? null },
          ]
        : ["image", "reference", "audio"].map(name => ({
            name, asset: params[name], sha256: assets[params[name]]?.sha256 ?? null,
          }))));
    } else if (kind === "plate") {
      // the default is a 64-multiple in 16:9 (N9); 960x544 used to be the default and came back
      // 960x512 from the graph, because half of 544 is 272 and LTX floors to 32
      const width = Number(params.width ?? 1024);
      const height = Number(params.height ?? 576);
      const dims = resolveDimensions(width, height, DIM_MULTIPLE_BY_KIND.plate);
      const requestedFrames = Number(params.frames ?? Math.round(Number(params.fps ?? 24) * 4));
      const frames = resolveFrames(requestedFrames);
      job.dims = { width: dims.width, height: dims.height };
      job.dimsAdjusted = dims.adjusted;
      // The two-stage LTX graph renders stage 1 at *half* the planned size and the latent upsampler
      // doubles it back, so `dims` is the final frame and this is the lattice the graph's own
      // EmptyLTXVLatentVideo (node 8) and i2v image scale (31) take. Recorded here because it is the
      // number the params map derives with {mul: 0.5} - the plan and the graph have to agree on it
      // (GPU test 2, issues 3 and 4: a planned 960x544 used to come back 1920x1088).
      job.stage1Dims = { width: dims.width / 2, height: dims.height / 2 };
      // N9: dims is a multiple of 64, so this half is a multiple of 32 — the lattice LTX floors to
      if (job.stage1Dims.width % 32 !== 0 || job.stage1Dims.height % 32 !== 0) {
        throw new Error(
          `${job.id}: stage1Dims ${job.stage1Dims.width}x${job.stage1Dims.height} is off the 32 lattice ` +
            `(dims ${dims.width}x${dims.height} must be a multiple of 64; GPU test 3, N9)`,
        );
      }
      job.fps = Number(params.fps ?? 24);
      job.frames = frames;
      job.framesAdjusted = frames !== requestedFrames;
      params.width = dims.width;
      params.height = dims.height;
      params.frames = frames;
      params.fps = job.fps;
      job.inputAsset = typeof params.image === "string" ? params.image : null;
      job.output = `out/intermediates/${assetId}.plate.mp4`;
      checkSourceAspect({ pkg, plateAssetId: assetId, sourceId: job.inputAsset, dims, format, kinds, errors, allowed: opts.allowAspectMismatch === true, warnings, sourceMultiple: job.inputAsset ? latticeFor(job.inputAsset) : undefined });

      if (params.upscale) {
        // H12: an upscaled plate keeps the plate as the asset's own file (1x, measured), and the
        // upscale job writes the x2 *variant* next to it. Both live in the package's media dir, so an
        // export that prefers the variant can resolve it from the package alone.
        job.output = `assets/${assetId}${OUTPUT_EXT.plate}`;
        // G6-10: the upscale stage used to be planned with the *plate's* params, so the x2 graph rendered
        // the size it was given and handed back a "variant" identical to its own source - which apply
        // refuses (SEM_ASSET_VARIANT_NOT_BIGGER) and the render therefore never happened. The dims the
        // graph is given are the target's, and they are set below, once the target and the crop are known.
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
          output: upscaleFileName(assetId, inputs),
          outputKind: "video",
          // which package field this file belongs to: `assets.<id>.variants.upscaled` (H12)
          variant: "upscaled",
          params: upscaleParams,
          // the plate this upscale reads: the asset's own file, one batch earlier
          source: `assets/${assetId}${OUTPUT_EXT.plate}`,
        };
        const scale = upscaleScale(inputs);
        const resolvedTarget = resolveDimensions(dims.width * scale, dims.height * scale, DIM_MULTIPLE_BY_KIND.upscale);
        const target = { width: resolvedTarget.width, height: resolvedTarget.height };
        const cropX = Number(format.width) && target.width > Number(format.width) ? target.width - Number(format.width) : 0;
        const cropY = Number(format.height) && target.height > Number(format.height) ? target.height - Number(format.height) : 0;
        // This is the generated raster, before delivery framing. Feeding a 1920x1080 crop
        // into the two-stage graph asks for a 960x540 base, which LTX floors off-lattice.
        // Keep the x2 target and its aspect; composition fits/crops it to the package format.
        up.dims = { ...target };
        upscaleParams.width = up.dims.width;
        upscaleParams.height = up.dims.height;
        up.upscaleTarget = target;
        if (cropX || cropY) {
          up.crop = { top: Math.floor(cropY / 2), bottom: Math.ceil(cropY / 2), left: Math.floor(cropX / 2), right: Math.ceil(cropX / 2) };
        }
        up.scale = scale;
        up.frames = frames;
        up.fps = job.fps;
        // the finals pass renders stage 1 at half the upscale target and the same upsampler doubles it
        up.stage1Dims = { width: up.dims.width / 2, height: up.dims.height / 2 };
        // the upscale pass reuses the plate's graph, so it needs the same start image: resolving
        // it here keeps the finals stage from being handed an asset id where a filename belongs
        withFileInputs(up, up.params, assetId, { pkg, kinds, errors });
        // and it inherits the plate's prompt guards, so its note says the same thing
        if (promptGuards?.length) up.promptGuards = promptGuards;
        // the finals pass reuses (or replaces) the plate graph, so it needs the same motion slot
        if (motionReference) {
          if (!hasMotionReferenceSlot(profileForWorkflow(upscaleWorkflow, opts.workflowCapabilities))) {
            errors.push(
              `PLAN_MOTION_REFERENCE_UNSUPPORTED assets.${assetId}: motion reference ${JSON.stringify(motionReference.excerpt.asset)} ` +
                `cannot be executed by the upscale graph ${upscaleWorkflow}; its capability profile declares no motion reference video slot`,
            );
          } else {
            up.fileInputs = [...(up.fileInputs || []), motionReference.fileInput];
            up.motionReference = motionReferenceProvenance(motionReference);
          }
        }
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
          ...(motionReference ? { motionRef: motionReferenceKey(motionReference) } : {}),
        });
        add(up);
      }
    } else if (kind === "presenter") {
      // Audio-conditioned LTX uses the same spatial/temporal lattice. Round up so
      // normalization never cuts the end of the conditioning narration.
      const requestedFrames = Number(params.frames ?? 97);
      const frames = resolveFrames(requestedFrames);
      params.frames = frames < requestedFrames ? frames + 8 : frames;
      job.dims = { width: params.width, height: params.height };
      job.stage1Dims = { width: params.width / 2, height: params.height / 2 };
      job.frames = params.frames;
      job.framesAdjusted = params.frames !== requestedFrames;
      job.fps = Number(params.fps ?? 24);
      params.fps = job.fps;
    } else if (kind === "audio") {
      job.text = typeof gen.caption === "string" ? gen.caption : "";
      if (!job.text) errors.push(`assets.${assetId} (kokoro) needs gen.caption for the text to speak`);
    }

    job.params = params;
    if (promptGuards?.length) {
      // what the planner appended to the caller's prompt, and why: the prompt the GPU receives is in
      // `params`, and this is the note that says it is not verbatim what the package asked for
      job.promptGuards = promptGuards;
    }
    // File-valued parameters (the start image of an i2v plate, the init image of an img2img
    // still, the reference of a reference edit) become an explicit instruction for the runner:
    // which local file to upload, and where it comes from. The graph itself is never handed an
    // asset id - that is the GPU test 2 failure this exists to prevent.
    withFileInputs(job, params, assetId, { pkg, kinds, errors });
    if (gen.generator === 'flux3-klein') {
      const problem = kleinReferenceProblem(params, { workflow: job.workflow, fileInputs: job.fileInputs });
      if (problem) errors.push(`assets.${assetId}: ${problem}`);
    }
    if (motionReference) {
      job.fileInputs = [...(job.fileInputs || []), motionReference.fileInput];
      job.motionReference = motionReferenceProvenance(motionReference);
    }
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
        ...(castRefSha256 ? { refSha256: castRefSha256 } : {}),
        ...(motionReference ? { motionRef: motionReferenceKey(motionReference) } : {}),
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
    warnings,
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
    if (job.generator === 'flux3-klein') {
      const problem = kleinReferenceProblem(job.params, job);
      if (problem) problems.push(`${job.id}: ${problem}`);
    }
    if (!BATCH_ORDER.includes(job.batch)) problems.push(`${job.id}: batch ${JSON.stringify(job.batch)} is not one of ${BATCH_ORDER.join(", ")}`);
    const pathIssue = pathProblem(job.output);
    if (pathIssue) problems.push(`${job.id}: output path ${pathIssue}`);
    if (typeof job.cacheKey !== "string" || job.cacheKey.length !== 64) problems.push(`${job.id}: cacheKey must be a sha256`);
    for (const entry of job.fileInputs || []) {
      if (!entry || typeof entry !== "object") {
        problems.push(`${job.id}: every fileInputs entry must be an object`);
        continue;
      }
      if (!isUploadParam(entry.param)) problems.push(`${job.id}: fileInputs param ${JSON.stringify(entry.param)} is not one of ${FILE_PARAMS.join(", ")}, ${MOTION_REFERENCE_INPUT} or _reference_2.._reference_10`);
      if (entry.from !== "job" && entry.from !== "package") problems.push(`${job.id}: fileInputs ${entry.param} from ${JSON.stringify(entry.from)} must be job or package`);
      const fileIssue = pathProblem(entry.path);
      if (fileIssue) problems.push(`${job.id}: fileInputs ${entry.param} path ${fileIssue}`);
      if (entry.from === "job" && !(doc.jobs || []).some((other) => other.id === entry.job)) {
        problems.push(`${job.id}: fileInputs ${entry.param} is produced by ${entry.job}, which is not in this document`);
      }
    }
    if (job.stage1Dims && job.dims) {
      // the plan states both sizes, so a plan whose stage-1 lattice is not half its output size is
      // a document that disagrees with the params map that renders it (GPU test 2, issue 3)
      const expected = { width: job.dims.width / 2, height: job.dims.height / 2 };
      if (Math.abs(job.stage1Dims.width - expected.width) > 0.5 || Math.abs(job.stage1Dims.height - expected.height) > 0.5) {
        problems.push(
          `${job.id}: stage1Dims ${job.stage1Dims.width}x${job.stage1Dims.height} is not half of dims ${job.dims.width}x${job.dims.height}`,
        );
      }
      if (!isDimensionValid(job.stage1Dims.width) || !isDimensionValid(job.stage1Dims.height)) {
        problems.push(`${job.id}: stage1Dims must be positive multiples of 32 (two-stage output dimensions must be multiples of 64)`);
      }
      if (!isFrameCountValid(job.frames)) {
        problems.push(`${job.id}: LTX frame count must be 8n+1`);
      }
    }
    for (const dep of job.deps || []) {
      if (!(doc.jobs || []).some((other) => other.id === dep)) problems.push(`${job.id}: dependency ${dep} is not in this document`);
    }
    if (job.motionReference !== undefined) {
      const motion = job.motionReference;
      if (!motion || typeof motion !== "object") {
        problems.push(`${job.id}: motionReference must be an object`);
      } else {
        const original = motion.original;
        const excerpt = motion.excerpt;
        const source = motion.source;
        if (!original || typeof original.asset !== "string" || !SHA256_RE.test(String(original.sha256 ?? ""))) {
          problems.push(`${job.id}: motionReference.original needs the original asset id and sha256`);
        }
        if (!excerpt || pathProblem(excerpt.file) || !SHA256_RE.test(String(excerpt.sha256 ?? ""))) {
          problems.push(`${job.id}: motionReference.excerpt needs a relative file and its sha256`);
        }
        if (!source || !Number.isFinite(source.inSeconds) || !Number.isFinite(source.outSeconds) || !(source.outSeconds > source.inSeconds) || !Number.isFinite(source.fps)) {
          problems.push(`${job.id}: motionReference.source needs inSeconds < outSeconds and a frame rate`);
        }
        if (!MOTION_AUDIO_POLICIES.includes(motion.audio)) {
          problems.push(`${job.id}: motionReference.audio must be one of ${MOTION_AUDIO_POLICIES.join(", ")}`);
        }
        const entry = (job.fileInputs || []).find((candidate) => candidate && candidate.param === MOTION_REFERENCE_INPUT);
        if (!entry || entry.from !== "package" || entry.path !== excerpt?.file) {
          problems.push(`${job.id}: motionReference needs exactly one motion_reference file input naming the excerpt`);
        }
      }
    }
  }
  for (const warning of doc.warnings || []) {
    if (typeof warning?.code !== "string" || !/^PLAN_[A-Z0-9_]+$/.test(warning.code) || !warning.message) {
      problems.push(`plan warning ${JSON.stringify(warning)} needs a PLAN_* code and a message`);
    }
  }
  return problems;
}
