// Production delivery policy, not a claim of hackathon bonus eligibility.
// Trust lives OUTSIDE the editable/importable package. Only verified backend
// collection writes this ledger; package gen strings and uploaded sidecars do not.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { canonical } from './plan.mjs';
import { canonicalJson, compileTimeline } from '../../planner/dist/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const names = {
  'flux3-klein': ['FLUX 3 Image Klein', ['flux3_klein_t2i', 'flux3_klein_img2img', 'flux3_klein_ref_edit', 'flux3_klein_ref2_edit'], 'flux-3-image-klein-bf16.safetensors'],
  ltx25: ['LTX 2.5', ['ltx25_i2v_2stage', 'ltx25_t2v_2stage'], 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors'],
  'ltx25-a2v': ['LTX 2.5', ['ltx25_a2v_2stage'], 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors'],
  'fasth3-omni': ['MiniMax H3', ['fasth3_omni_ref2va', 'fasth3_omni_ref2v_noclip'], 'fasth3_omniref_8step_pruned_int8_convrot.safetensors'],
};

export const MODEL_CONTRIBUTION_POLICY = 'comfyrizz.comfy-contribution/v1';
export const MODEL_CONTRIBUTION_MESSAGE = 'Final video requires a visible, verified ComfyUI contribution from FLUX 3 Image Klein, LTX 2.5 or MiniMax H3. Plan a relevant generated plate or still, approve its generation, and use the completed asset in a visible scene. Native text, charts and audio can remain native. A pending job, upload claim or unused asset does not qualify.';
export const MODEL_CONTRIBUTION_PROMPT = `Production delivery requirement: every final video must use at least one relevant, meaningful visible ComfyUI-generated image or video from FLUX 3 Image Klein, LTX 2.5 or MiniMax H3. This is a per-video product requirement, not a guarantee of ecosystem bonus eligibility. For native title, chart, explainer or music visuals, plan one appropriate generated image/background plate with assets.generate_image and visibly place it in a scene; keep exact text, data, drawings, font and audio intent native. One genuine asset is sufficient; do not add an arbitrary quota. The visible contribution must occupy at least 5% of the frame for at least one second, not be hidden behind a procedural background, opaque drawing, full scrim or other plate. Preserve the exact total duration. Explain the chosen model and visual use in the proposal. If the brief explicitly forbids generated media or requires CPU/procedural-only output, explain the conflict and request a revised brief; never silently override that restriction. Planning never authorizes generation or spends credits.
Builder placement contract (when storyboard.edit is available): assets.generate_image returns asset.id and normally adds a foreground inset. To use that same image as a full-frame background, call storyboard.edit with patch.background={"asset":"the exact returned asset.id"}, omit procedural, and remove only duplicate foreground insets. The field is asset, never assetId or asset_id. Preserve unrelated overlays. Reuse an already planned eligible image instead of creating a duplicate to repair placement. Pending generation is allowed in a proposal; completed verified bytes are required at final export.`;

export function modelContributionPlanProblem(pkg) {
  const available = Object.entries(pkg?.assets ?? {}).filter(([, asset]) =>
    asset.origin === 'generated' && eligibleJob({ generator: asset.gen?.generator, workflow: asset.gen?.workflow, workflowSha256: asset.gen?.workflow_sha256 })).map(([id]) => id);
  return `The plan needs one visibly referenced supported ComfyUI image or video. Pending generation is valid at planning; do not execute generation. ${available.length
    ? `Reuse an existing eligible asset: ${JSON.stringify(available)}. Attach its exact id with storyboard.edit patch.background={"asset":"EXACT_ID"}, without procedural, or foreground:[{"asset":"EXACT_ID","x":0.5,"y":0.5,"w":0.5}]. Do not use assetId or asset_id. Preserve unrelated content. A drawing replaces the layout, so use a supported visible scene.`
    : 'Plan one relevant asset with assets.generate_image, then visibly reference its returned asset.id in a scene using background.asset or foreground[].asset.'}`;
}

export function assertGenerationBrief(brief) {
  if (/\b(?:no|without)\s+(?:ai[- ]?)?generated\s+(?:media|imagery|visuals|images?\s+(?:or|and)\s+videos?)\b|\b(?:cpu|procedural)[- ]only\b|\bnative[- ]only\s+(?:film|video|output|visuals|graphics)\b|\bonly\s+(?:cpu|procedural|native)\s+(?:rendering|visuals|graphics)\b/i.test(brief ?? '')) {
    throw Object.assign(new Error('This brief explicitly prohibits generated media, but final production videos require a visible ComfyUI model contribution. Revise the brief to allow one relevant generated plate or still; exact copy and data can remain native.'), { status: 422, code: 'COMFY_MODEL_BRIEF_CONFLICT' });
  }
}

export function contributionStore(packageDir) {
  return join(dirname(resolve(packageDir)), '.comfy-provenance');
}
function safeFile(dir, name) {
  if (typeof name !== 'string' || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..') || name.startsWith('/')) return null;
  const file = resolve(dir, name);
  try { return realpathSync(file).startsWith(realpathSync(dir) + sep) && statSync(file).isFile() ? file : null; } catch { return null; }
}
function eligibleJob(job) {
  const spec = names[job?.generator];
  if (!spec || !spec[1].some(name => job.workflow === `workflows/${name}.api.json`)) return null;
  const graph = readFileSync(join(root, job.workflow));
  if (digest(graph) !== job.workflowSha256) return null;
  const nodes = JSON.parse(graph);
  if (!Object.values(nodes).some(n => n.class_type === 'UNETLoader' && n.inputs?.unet_name === spec[2])) return null;
  return { family: spec[0], checkpoint: spec[2], nodes };
}
function readReceipt(dir, sha) {
  if (!hashPattern.test(sha ?? '')) return null;
  for (const store of [contributionStore(dir), join(root, '.comfy-provenance')]) {
    try { return JSON.parse(readFileSync(join(store, `${sha}.json`), 'utf8')); } catch { /* no trusted receipt here */ }
  }
  return null;
}
function writeReceipt(dir, receipt) {
  const store = contributionStore(dir);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const path = join(store, `${receipt.outputSha256}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Called only with the server/backend's original jobs and completed manifest.
 * Cached output cannot mint evidence: it must reuse an existing successful receipt. */
export function recordGenerationReceipts({ manifest, jobsDoc, outputDir, packageDir = outputDir, backend }) {
  const recorded = [];
  if (!['colab', 'byo-comfyui'].includes(backend)) return recorded;
  if (!manifest || !jobsDoc || !jobsDoc.hash || !manifest.run_id || manifest.jobsHash !== jobsDoc.hash) return recorded;
  const jobs = new Map((jobsDoc.jobs ?? []).map(job => [job.id, job]));
  for (const entry of manifest.jobs ?? []) {
    const job = jobs.get(entry.job);
    if (!job || entry.status !== 'succeeded' || !entry.job_id || !entry.attempt_id) continue;
    const eligible = eligibleJob(job);
    if (!eligible) continue;
    for (const output of entry.outputs ?? []) {
      if (output.workflow_submitted !== true) continue;
      if (!(output.measured?.width >= 64 && output.measured?.height >= 64)) continue;
      const relative = output.relative ?? output.file;
      const file = safeFile(outputDir, relative);
      if (!file || !hashPattern.test(output.sha256 ?? '') || digest(readFileSync(file)) !== output.sha256 || statSync(file).size <= 0) continue;
      const workflowFile = safeFile(outputDir, relative.replace(/\.[^/.]+$/, '.workflow.api.json'));
      if (!workflowFile) continue;
      const graphBytes = readFileSync(workflowFile);
      let captured;
      try { captured = JSON.parse(graphBytes); } catch { continue; }
      // A qualified loader must feed the submitted output, not sit disconnected
      // next to an unrelated graph. Only scalar parameter values may vary.
      if (Object.keys(captured).length !== Object.keys(eligible.nodes).length
        || !Object.entries(eligible.nodes).every(([id, node]) => captured[id]?.class_type === node.class_type
          && Object.entries(node.inputs ?? {}).every(([key, value]) => !Array.isArray(value) || JSON.stringify(captured[id]?.inputs?.[key]) === JSON.stringify(value)))) continue;
      // Match every loader in the pinned graph, not an LLM-declared model alias.
      const loaders = Object.entries(eligible.nodes).filter(([, n]) => /Loader$/.test(n.class_type) && !/^Load(Image|Audio)/.test(n.class_type));
      if (!loaders.every(([id, node]) => captured[id]?.class_type === node.class_type && Object.entries(node.inputs ?? {}).every(([key, value]) => typeof value !== 'string' || captured[id]?.inputs?.[key] === value))) continue;
      const receipt = { schema: MODEL_CONTRIBUTION_POLICY, status: 'succeeded', backend,
        runId: manifest.run_id, jobId: entry.job_id, attemptId: entry.attempt_id, plannedJobId: job.id,
        jobsHash: jobsDoc.hash, workflow: job.workflow, workflowSha256: job.workflowSha256,
        capturedWorkflowSha256: digest(graphBytes), generator: job.generator, model: job.model ?? null,
        family: eligible.family, checkpoint: eligible.checkpoint, outputSha256: output.sha256,
        bytes: statSync(file).size, measured: output.measured ?? null,
        conditioning: { params: job.params ?? null, deps: job.deps ?? [], refSha256: job.refSha256 ?? null,
          consumed: output.conditioning_inputs ?? [], fileInputs: job.fileInputs ?? [] },
      };
      writeReceipt(packageDir, receipt); recorded.push(receipt);
    }
  }
  return recorded;
}

function recoveryError(message) {
  return Object.assign(new Error(`Downloaded output recovery refused: ${message}`), { code: 'RECOVERY_EVIDENCE_INVALID', status: 422 });
}

/** Read-only, fail-closed validation for a SERVER-OWNED completed run. This is not
 * an upload importer. The caller must bind these documents to its durable run.
 * Expected graphs are used only for comparison; never saved as captured evidence. */
export function verifyRecoveredGeneration({ manifest, jobsDoc, outputDir, workDir, backend }) {
  const fail = message => { throw recoveryError(message); };
  if (!['colab', 'byo-comfyui'].includes(backend) || !manifest?.run_id || manifest.complete !== true
    || !jobsDoc?.jobs?.length || manifest.jobsHash !== jobsDoc.hash
    || digest(canonical({ ...jobsDoc, hash: undefined })) !== jobsDoc.hash
    || manifest.packageId !== jobsDoc.packageId || manifest.revision !== jobsDoc.revision) fail('run/jobs identity or completion mismatch');
  const entries = new Map((manifest.jobs ?? []).map(entry => [entry.job, entry]));
  if (entries.size !== jobsDoc.jobs.length || manifest.jobs.length !== entries.size
    || new Set(jobsDoc.jobs.map(job => job.id)).size !== entries.size
    || manifest.counts?.succeeded !== entries.size
    || Object.entries(manifest.counts).some(([status, count]) => status !== 'succeeded' && count !== 0)) fail('job set or completion counts mismatch');
  const verified = new Map();
  // Check every byte before extracting graphs or issuing any receipts.
  for (const job of jobsDoc.jobs) {
    const entry = entries.get(job.id), output = entry?.outputs?.[0];
    if (entry?.status !== 'succeeded' || !entry.job_id || !entry.attempt_id || entry.cache_key !== job.cacheKey
      || entry.outputs?.length !== 1 || output?.workflow_submitted !== true
      || output.relative !== job.output || output.workflow !== job.output.replace(/\.[^/.]+$/, '.workflow.api.json')
      || !(output.measured?.width >= 64 && output.measured?.height >= 64)) fail(`${job.id}: incomplete submitted output`);
    const file = safeFile(outputDir, output.relative);
    if (!file || !hashPattern.test(output.sha256 ?? '') || statSync(file).size !== output.bytes
      || digest(readFileSync(file)) !== output.sha256) fail(`${job.id}: missing or changed media`);
    const eligible = eligibleJob(job);
    // Workflow staging normally uses a server-owned symlink to the repository.
    // eligibleJob has already allowlisted this exact relative path.
    if (!eligible || !existsSync(join(workDir, job.workflow)) || digest(readFileSync(join(workDir, job.workflow))) !== job.workflowSha256) fail(`${job.id}: pinned workflow mismatch`);
    verified.set(job.id, { job, entry, output, file, eligible });
  }
  const captures = [];
  for (const item of verified.values()) {
    const { job, entry, output, file, eligible } = item;
    // Bounded first implementation: these have an audited runner mapping and
    // original captures. Other workflows fail closed until explicitly covered.
    if (!['workflows/flux3_klein_t2i.api.json', 'workflows/ltx25_i2v_2stage.api.json'].includes(job.workflow)
      || job.paramsSource) fail(`${job.id}: unsupported recovery workflow`);
    const mappingName = job.workflow.replace(/\.json$/, '.params.json');
    const mapBytes = readFileSync(join(root, mappingName));
    const stagedMap = join(workDir, mappingName);
    if (!existsSync(stagedMap) || digest(readFileSync(stagedMap)) !== digest(mapBytes)) fail(`${job.id}: parameter map mismatch`);
    const mapping = JSON.parse(mapBytes);
    const expected = structuredClone(eligible.nodes), params = { ...job.params };
    const consumed = output.conditioning_inputs;
    if (!Array.isArray(consumed) || consumed.length !== (job.fileInputs ?? []).length) fail(`${job.id}: conditioning count mismatch`);
    const annotationHashes = new Map();
    for (const input of job.fileInputs ?? []) {
      const target = mapping.map[input.param];
      if (input.from !== 'job' || !job.deps?.includes(input.job) || !mapping.files?.includes(input.param)
        || !Array.isArray(target) || Array.isArray(target[0])) fail(`${job.id}: unsupported conditioning binding`);
      const dependency = verified.get(input.job);
      const matches = consumed.filter(value => value.nodeId === target[0] && value.input === target[1]);
      const value = matches[0];
      if (!dependency || dependency.output.relative !== input.path || matches.length !== 1
        || value.sha256 !== dependency.output.sha256 || value.bytes !== dependency.output.bytes
        || typeof value.uploadedName !== 'string' || !value.uploadedName) fail(`${job.id}: consumed image mismatch`);
      params[input.param] = value.uploadedName;
      annotationHashes.set(target[0], value.sha256);
    }
    for (const name of mapping.files ?? []) if (!(job.fileInputs ?? []).some(input => input.param === name)) fail(`${job.id}: missing file input`);
    for (const [name, value] of Object.entries(params)) {
      const target = mapping.map[name];
      if (!target) {
        if (!['upscale', 'cutout', 'frames_seconds', 'text', 'allowText'].includes(name)) fail(`${job.id}: unmapped parameter ${name}`);
        continue;
      }
      for (const [id, field, options] of Array.isArray(target[0]) ? target : [target]) {
        let mapped = value;
        if (options) {
          if (Object.keys(options).join() !== 'mul' || typeof value !== 'number') fail(`${job.id}: unsupported parameter transform`);
          // These mappings halve even lattice dimensions; refuse rounding ambiguity.
          mapped = value * options.mul;
          if (!Number.isInteger(mapped)) fail(`${job.id}: nonintegral parameter transform`);
        }
        expected[id].inputs[field] = mapped;
      }
    }
    const sidecar = safeFile(outputDir, output.workflow);
    let raw, captureSource, normalized, normalization = [], pairedCaptureSha256 = null;
    if (job.output.endsWith('.mp4')) {
      let probe;
      try { probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=prompt', '-of', 'json', file], { timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })); }
      catch { fail(`${job.id}: embedded metadata unreadable`); }
      raw = probe.format?.tags?.prompt;
      if (typeof raw !== 'string' || !raw) fail(`${job.id}: embedded prompt missing`);
      captureSource = 'embedded-mp4';
      try { normalized = JSON.parse(raw); } catch { fail(`${job.id}: invalid embedded graph`); }
      if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) fail(`${job.id}: invalid embedded graph`);
      for (const [id, node] of Object.entries(normalized)) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) fail(`${job.id}: invalid embedded node`);
        if (!Object.hasOwn(node, 'is_changed')) continue;
        if (node.class_type !== 'LoadImage' || !annotationHashes.has(id)
          || !isDeepStrictEqual(node.is_changed, [annotationHashes.get(id)])) fail(`${job.id}: unexpected runtime annotation`);
        normalization.push({ nodeId: id, field: 'is_changed', value: node.is_changed });
        delete node.is_changed;
      }
      if (sidecar) {
        const bytes = readFileSync(sidecar);
        let paired;
        try { paired = JSON.parse(bytes); } catch { fail(`${job.id}: invalid paired capture`); }
        if (!isDeepStrictEqual(paired, normalized)) fail(`${job.id}: captured and embedded graphs disagree`);
        pairedCaptureSha256 = digest(bytes);
      }
    } else {
      if (!sidecar) fail(`${job.id}: captured graph missing`);
      raw = readFileSync(sidecar, 'utf8'); captureSource = 'captured-workflow';
      try { normalized = JSON.parse(raw); } catch { fail(`${job.id}: invalid captured graph`); }
    }
    if (!isDeepStrictEqual(normalized, expected)) fail(`${job.id}: submitted graph differs from pinned workflow and approved parameters`);
    const receipt = { schema: MODEL_CONTRIBUTION_POLICY, status: 'succeeded', backend,
      runId: manifest.run_id, jobId: entry.job_id, attemptId: entry.attempt_id, plannedJobId: job.id,
      jobsHash: jobsDoc.hash, workflow: job.workflow, workflowSha256: job.workflowSha256,
      capturedWorkflowSha256: digest(raw), captureSource, generator: job.generator, model: job.model ?? null,
      family: eligible.family, checkpoint: eligible.checkpoint, outputSha256: output.sha256,
      bytes: output.bytes, measured: output.measured,
      conditioning: { params: job.params ?? null, deps: job.deps ?? [], refSha256: job.refSha256 ?? null,
        consumed, fileInputs: job.fileInputs ?? [] },
      recovery: { schema: 'comfyrizz.embedded-recovery/v1', rawMediaSha256: output.sha256,
        rawMetadataSha256: digest(raw), normalizedGraphSha256: digest(canonical(normalized)),
        parameterMapSha256: digest(mapBytes), normalization, pairedCaptureSha256 },
    };
    captures.push({ receipt, raw });
  }
  return captures;
}

/** Explicit alternate collection source. No fallback in the existing recorder.
 * Validate the entire run before writing any evidence, into a NEW recovery dir. */
export function recordRecoveredGenerationReceipts({ packageDir, evidenceDir, recoveryId, ...options }) {
  if (!packageDir || !evidenceDir || !/^recovery_[a-f0-9-]+$/.test(recoveryId ?? '')) throw recoveryError('new recovery operation required');
  const captures = verifyRecoveredGeneration(options);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  for (const { receipt, raw } of captures) {
    const source = `${receipt.outputSha256}.${receipt.captureSource === 'embedded-mp4' ? 'prompt' : 'capture'}.json`;
    writeFileSync(join(evidenceDir, source), raw, { mode: 0o600, flag: 'wx' });
    receipt.recovery = { ...receipt.recovery, operationId: recoveryId, source };
    writeReceipt(packageDir, receipt);
  }
  return captures.map(({ receipt }) => receipt);
}

/** Copy only pre-existing trusted records during server-owned staging/copy. Never import ZIP receipts. */
export function copyGenerationReceipts({ pkg, sourceDir, packageDir }) {
  for (const asset of Object.values(pkg?.assets ?? {})) {
    for (const value of [asset, ...Object.values(asset.variants ?? {})]) {
      const receipt = readReceipt(sourceDir, value?.sha256);
      if (receipt?.schema === MODEL_CONTRIBUTION_POLICY && receipt.outputSha256 === value.sha256) writeReceipt(packageDir, receipt);
    }
  }
}

/** Trusted remote-render bundle entries, separate from the user's project ZIP. */
export function generationReceiptFiles(pkg, packageDir) {
  const files = [];
  for (const asset of Object.values(pkg.assets ?? {})) for (const value of [asset, ...Object.values(asset.variants ?? {})]) {
    const sha = value?.sha256;
    if (!hashPattern.test(sha ?? '')) continue;
    const path = join(contributionStore(packageDir), `${sha}.json`);
    if (existsSync(path)) files.push({ name: `.comfy-provenance/${sha}.json`, path });
  }
  return files;
}

const clip = rect => ({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), r: Math.min(1, rect.r), b: Math.min(1, rect.b) });
const area = rect => Math.max(0, rect.r - rect.x) * Math.max(0, rect.b - rect.y);
function rectangle(item, asset, pkg) {
  if (item.frame === 'pip') return null; // conservative until inset mask geometry is bound
  const w = item.w ?? 0.4;
  const h = item.h ?? w * (pkg.format.width / pkg.format.height) / ((asset?.media?.width ?? 16) / (asset?.media?.height ?? 9));
  return clip({ x: (item.x ?? .5) - w / 2, y: (item.y ?? .5) - h / 2, r: (item.x ?? .5) + w / 2, b: (item.y ?? .5) + h / 2 });
}
function containedRectangle(rect, asset, pkg, planning) {
  // Final verification replaces media with byte-bound measured dimensions.
  // Generation inputs are provisional geometry only during plan admission.
  const dimensions = planning ? asset?.media ?? asset?.gen?.inputs : asset?.media;
  const width = Number(dimensions?.width), height = Number(dimensions?.height);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return null;
  const boxWidth = rect.r - rect.x, boxHeight = rect.b - rect.y;
  const boxAspect = boxWidth * pkg.format.width / (boxHeight * pkg.format.height);
  const sourceAspect = width / height;
  const w = sourceAspect < boxAspect ? boxWidth * sourceAspect / boxAspect : boxWidth;
  const h = sourceAspect > boxAspect ? boxHeight * boxAspect / sourceAspect : boxHeight;
  return { x: rect.x + (boxWidth - w) / 2, r: rect.r - (boxWidth - w) / 2,
    y: rect.y + (boxHeight - h) / 2, b: rect.b - (boxHeight - h) / 2 };
}
function uncovered(rect, blockers) {
  const xs = [...new Set([rect.x, rect.r, ...blockers.flatMap(b => [Math.max(rect.x, Math.min(rect.r, b.x)), Math.max(rect.x, Math.min(rect.r, b.r))])])].sort((a,b) => a-b);
  const ys = [...new Set([rect.y, rect.b, ...blockers.flatMap(b => [Math.max(rect.y, Math.min(rect.b, b.y)), Math.max(rect.y, Math.min(rect.b, b.b))])])].sort((a,b) => a-b);
  let total = 0;
  for (let i = 1; i < xs.length; i++) for (let j = 1; j < ys.length; j++) {
    const x = (xs[i-1]+xs[i])/2, y = (ys[j-1]+ys[j])/2;
    if (!blockers.some(b => x >= b.x && x <= b.r && y >= b.y && y <= b.b)) total += (xs[i]-xs[i-1])*(ys[j]-ys[j-1]);
  }
  return total;
}

/** Conservative renderer-contract visibility, NOT perceptual/semantic visual QA. */
export function contributionUses(pkg, { timeline, media = {}, planning = false } = {}) {
  timeline ??= compileTimeline(pkg);
  const uses = [];
  for (const scene of timeline.scenes ?? []) {
    const authored = { ...scene, ...pkg.scenes.find(s => s.id === scene.id) };
    const stableFrames = scene.durationInFrames - (scene.transitionOutFrames ?? 0) - Math.max(scene.transitionInFrames ?? 0, 30);
    if (authored.drawing || authored.composition || stableFrames < timeline.fps) continue;
    const mediaOnly = authored.media_only === true || authored.mediaOnly === true || media.skipLayout?.includes(scene.id);
    const split = !mediaOnly && ['split', 'compare'].includes(authored.layout);
    const stacked = pkg.format.height > pkg.format.width * 1.2;
    const plateCount = Math.min(2, authored.media?.length ?? 0);
    if (!mediaOnly && authored.layout === 'code') continue;
    const foreground = split || (!mediaOnly && authored.layout === 'list' && authored.motion?.diagram) ? [] : authored.foreground ?? scene.foreground ?? [];
    const panels = foreground.map((item, index) => ({ item, index, rect: rectangle(item, pkg.assets?.[item.asset], pkg), z: item.z ?? 6 }));
    const background = split ? null : authored.background ?? scene.background;
    const candidates = [
      ...(!background?.procedural && background?.asset && Number(background.scrim ?? media.scrim?.[scene.id] ?? 0) <= .8 ? [{ id: background.asset, slot: 'background', rect: { x: 0, y: 0, r: 1, b: 1 }, z: 0, index: -1 }] : []),
      ...panels.map(p => ({ id: p.item.asset, slot: `foreground.${p.index}`, ...p })),
      ...(split ? (authored.media ?? []).slice(0, 2).flatMap((plate, index) => plate.asset && !plate.procedural ? [{ id: plate.asset, slot: `media.${index}`,
        rect: stacked ? { x: 0, y: index / plateCount, r: 1, b: (index + 1) / plateCount }
          : { x: index / plateCount, y: 0, r: (index + 1) / plateCount, b: 1 }, z: 6, index, item: plate }] : []) : []),
    ];
    for (const candidate of candidates) {
      const asset = pkg.assets?.[candidate.id];
      if (!asset || !['image', 'video'].includes(asset.kind) || (!planning && asset.status !== 'ready') || !candidate.rect || area(candidate.rect) < .05) continue;
      if (candidate.slot.startsWith('foreground.') && candidate.z < 3) continue;
      if (candidate.item?.fit === 'contain' || candidate.slot === 'background' && background?.fit === 'contain') {
        // Foreground masks/frames require their own geometry. Background and
        // split plates are centered object-fit boxes in the renderer.
        if (candidate.slot.startsWith('foreground.')) continue;
        candidate.rect = containedRectangle(candidate.rect, asset, pkg, planning);
        if (!candidate.rect || area(candidate.rect) < .05) continue;
      }
      if ((timeline.presenters ?? []).some(p => p.from < scene.from + scene.durationInFrames && p.from + p.durationInFrames > scene.from)) continue;
      if (candidate.slot.startsWith('foreground.') && candidate.z <= 6 && Number(background?.scrim ?? 0) > .8
        && panels.some(p => p.item.frame !== 'pip' && (p.item.w ?? .4) >= .95)) continue;
      if (candidate.item?.trim && !(candidate.item.trim.end > candidate.item.trim.start)) continue;
      const blockers = panels.filter(p => p.rect && (p.z > candidate.z || p.z === candidate.z && p.index > candidate.index)).map(p => p.rect);
      const visibleFraction = uncovered(candidate.rect, blockers);
      if (visibleFraction < .05) continue;
      uses.push({ sceneId: scene.id, assetId: candidate.id, slot: candidate.slot, visibleFraction, frames: scene.durationInFrames, fps: timeline.fps });
    }
  }
  return uses;
}

export function plannedModelContribution(pkg) {
  let uses;
  try { uses = contributionUses(pkg, { planning: true }); } catch { return []; }
  return uses.filter(use => {
    const asset = pkg.assets[use.assetId];
    return asset.origin === 'generated' && eligibleJob({ generator: asset.gen?.generator, workflow: asset.gen?.workflow, workflowSha256: asset.gen?.workflow_sha256 });
  }).map(use => ({ ...use, model: names[pkg.assets[use.assetId].gen.generator][0] }));
}

export function verifyModelContribution({ pkg, packageDir, timeline, media } = {}) {
  const evidence = [];
  if (packageDir) {
    if (!media && existsSync(join(packageDir, 'media.json'))) media = JSON.parse(readFileSync(join(packageDir, 'media.json'), 'utf8'));
    // Renderer panel geometry follows measured bytes, not editable media claims.
    const geometry = { ...pkg, assets: Object.fromEntries(Object.entries(pkg.assets ?? {}).map(([id, asset]) => {
      const receipt = readReceipt(packageDir, asset.sha256);
      return [id, { ...asset, media: receipt?.measured ?? { width: 1, height: 10000 } }];
    })) };
    for (const use of contributionUses(geometry, { timeline, media })) {
      const asset = pkg.assets[use.assetId];
      const file = safeFile(packageDir, asset.file);
      const receipt = readReceipt(packageDir, asset.sha256);
      if (!file || !receipt || !['colab', 'byo-comfyui'].includes(receipt.backend) || receipt.schema !== MODEL_CONTRIBUTION_POLICY || receipt.status !== 'succeeded' || receipt.outputSha256 !== asset.sha256 || receipt.bytes !== statSync(file).size || digest(readFileSync(file)) !== asset.sha256) continue;
      if (!eligibleJob({ generator: receipt.generator, workflow: receipt.workflow, workflowSha256: receipt.workflowSha256 }) || !receipt.jobId || !receipt.attemptId) continue;
      evidence.push({ ...use, receipt });
    }
  }
  return { policy: MODEL_CONTRIBUTION_POLICY, ok: evidence.length > 0, evidence, ...(evidence.length ? {} : { code: 'COMFY_MODEL_CONTRIBUTION_REQUIRED', message: MODEL_CONTRIBUTION_MESSAGE }) };
}
export function assertModelContribution(options) {
  const result = verifyModelContribution(options);
  if (!result.ok) throw Object.assign(new Error(result.message), { status: 422, code: result.code, contribution: result });
  return result;
}

// A generated source alone cannot certify an arbitrary pre-existing movie.
// Only trusted render/export completion writes this byte-bound publication proof.
export function recordRenderedContribution({ pkg, packageDir, receiptDir = packageDir, timeline, videoPath }) {
  const verified = assertModelContribution({ pkg, packageDir, timeline });
  const receipt = { schema: `${MODEL_CONTRIBUTION_POLICY}/render`, packageId: pkg.id,
    packageHash: digest(canonicalJson(pkg)), timelineHash: timeline.hash,
    videoSha256: digest(readFileSync(videoPath)), contribution: verified };
  const store = join(contributionStore(receiptDir), 'renders');
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const path = join(store, `${receipt.videoSha256}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(temporary, path);
  return receipt;
}

export function renderedContribution({ packageDir, videoSha256, pkg, timelineHash, packageId, packageHash } = {}) {
  if (!packageDir || !hashPattern.test(videoSha256 ?? '')) return null;
  try {
    const receipt = JSON.parse(readFileSync(join(contributionStore(packageDir), 'renders', `${videoSha256}.json`), 'utf8'));
    if (receipt.schema !== `${MODEL_CONTRIBUTION_POLICY}/render` || receipt.videoSha256 !== videoSha256 || !receipt.contribution?.ok) return null;
    if (pkg && receipt.packageHash !== digest(canonicalJson(pkg))) return null;
    if (packageId && receipt.packageId !== packageId || packageHash && receipt.packageHash !== packageHash || timelineHash && receipt.timelineHash !== timelineHash) return null;
    return receipt;
  } catch { return null; }
}

export function assertRenderedContribution(options) {
  const receipt = renderedContribution(options);
  if (!receipt) throw Object.assign(new Error('Final publication requires a server-verified render receipt matching the video bytes and package. Export the approved generated-media package again.'), { status: 422, code: 'COMFY_RENDER_RECEIPT_REQUIRED' });
  return receipt;
}
