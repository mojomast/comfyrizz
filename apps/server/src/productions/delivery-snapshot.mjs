import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { canonicalJson, compileTimeline } from '../../../../packages/planner/dist/src/index.js';
import { captionsToSrt, captionsToVtt, captionsToWordVtt } from '../../../../packages/tts/dist/src/index.js';
import { isAssetRedistributable } from '../../../../packages/sources/dist/src/index.js';
import { measuredOptionsFromDir } from '../compile-package.mjs';
import { workflowSidecars } from '../workflow.mjs';
import { finalRenderFormat } from '../../../renderer/scripts/render-package-lib.mjs';

export const DELIVERY_SNAPSHOT_SCHEMA = 'comfyrizz.delivery-snapshot/v1';
export const DELIVERY_INTENTS = Object.freeze(['draft', 'final']);

const HASH_RE = /^[a-f0-9]{64}$/;
const SCENE_ID_RE = /^s[A-Za-z0-9_-]{0,63}$/;
const OPTIONAL_INPUTS = [
  'media.json',
  'audio/durations.json',
  'audio/voice-reference.wav',
  'audio/voice-reference.json',
  'audio/models.lock.json',
];

export class DeliverySnapshotError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DeliverySnapshotError';
    this.code = code;
    if (details !== undefined) Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new DeliverySnapshotError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^sha256[:=]/i, '').toLowerCase();
  return HASH_RE.test(trimmed) ? trimmed : null;
}

function nonNegative(value, label, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_REVISION', `${label} must be a non-negative integer`);
  return value;
}

export function normalizeDeliveryIntent(value, fallback = 'final') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !DELIVERY_INTENTS.includes(value)) {
    fail('INVALID_INTENT', "intent must be 'draft' or 'final'");
  }
  return value;
}

function normalizeEditor(editor) {
  if (editor === undefined || editor === null) return { version: 1, captionOverrides: [] };
  const value = Array.isArray(editor) ? { version: 1, captionOverrides: editor } : editor;
  if (!isPlainObject(value)) fail('INVALID_EDITOR', 'editor must be an object or a caption override array');
  const raw = value.captionOverrides ?? [];
  if (!Array.isArray(raw)) fail('INVALID_EDITOR', 'editor.captionOverrides must be an array');
  const captionOverrides = raw.map((item, index) => {
    if (!isPlainObject(item) || typeof item.sceneId !== 'string' || !SCENE_ID_RE.test(item.sceneId)) {
      fail('INVALID_EDITOR', `editor.captionOverrides[${index}].sceneId is invalid`);
    }
    if (!Number.isInteger(item.index) || item.index < 0) {
      fail('INVALID_EDITOR', `editor.captionOverrides[${index}].index must be a non-negative integer`);
    }
    if (typeof item.text !== 'string' || item.text.length > 2000) {
      fail('INVALID_EDITOR', `editor.captionOverrides[${index}].text must be a string of at most 2000 characters`);
    }
    return { sceneId: item.sceneId, index: item.index, text: item.text };
  });
  captionOverrides.sort((left, right) => left.sceneId.localeCompare(right.sceneId) || left.index - right.index);
  const normalized = clone(value);
  normalized.version = value.version ?? 1;
  normalized.captionOverrides = captionOverrides;
  return normalized;
}

function normalizeSelections(selections) {
  if (selections === undefined || selections === null) return [];
  if (!Array.isArray(selections)) fail('INVALID_SELECTIONS', 'selections must be an array');
  const seen = new Set();
  const out = selections.map((entry, index) => {
    if (!isPlainObject(entry)) fail('INVALID_SELECTIONS', `selections[${index}] must be an object`);
    if (typeof entry.shotId !== 'string' || entry.shotId.trim() === '') {
      fail('INVALID_SELECTIONS', `selections[${index}].shotId is required`);
    }
    if (typeof entry.takeId !== 'string' || entry.takeId.trim() === '') {
      fail('INVALID_SELECTIONS', `selections[${index}].takeId is required`);
    }
    if (seen.has(entry.shotId)) fail('INVALID_SELECTIONS', `selections[${index}].shotId is duplicated`);
    seen.add(entry.shotId);
    const digest = normalizeDigest(entry.sha256 ?? entry.hash);
    if ((entry.sha256 !== undefined || entry.hash !== undefined) && digest === null) {
      fail('INVALID_SELECTIONS', `selections[${index}].sha256 must be a sha256 hex digest`);
    }
    return { shotId: entry.shotId, takeId: entry.takeId, sha256: digest };
  });
  return out.sort((left, right) => left.shotId.localeCompare(right.shotId) || left.takeId.localeCompare(right.takeId));
}

function normalizeReferences(references) {
  if (references === undefined || references === null) return [];
  if (!Array.isArray(references)) fail('INVALID_REFERENCES', 'references must be an array');
  return references.map((entry, index) => {
    if (typeof entry === 'string') return entry;
    if (!isPlainObject(entry)) fail('INVALID_REFERENCES', `references[${index}] must be a string or object`);
    const path = entry.path ?? entry.id;
    if (typeof path !== 'string' || path.trim() === '') fail('INVALID_REFERENCES', `references[${index}].path is required`);
    const digest = normalizeDigest(entry.sha256);
    return digest === null ? path : { path, sha256: digest };
  }).sort((left, right) => String(typeof left === 'string' ? left : left.path).localeCompare(String(typeof right === 'string' ? right : right.path)));
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    fail('INVALID_PATH', `${label} must be a non-empty relative path`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) fail('INVALID_PATH', `${label} must be relative`);
  if (normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('INVALID_PATH', `${label} must not contain empty, dot or traversal segments`);
  }
  return normalized;
}

function declaredInputNames(pkg, packageDir) {
  const names = new Set(OPTIONAL_INPUTS);
  for (const asset of Object.values(pkg.assets ?? {})) {
    if (typeof asset?.file === 'string' && asset.file !== '') names.add(asset.file);
    for (const variant of Object.values(asset?.variants ?? {})) {
      if (typeof variant?.file === 'string' && variant.file !== '') names.add(variant.file);
    }
    if (asset?.origin === 'generated' && (asset.kind === 'image' || asset.kind === 'video')) {
      for (const file of [asset.file, asset.variants?.upscaled?.file]) {
        const sidecars = workflowSidecars(file);
        if (sidecars) {
          names.add(sidecars.api);
          names.add(sidecars.readme);
        }
      }
    }
  }
  for (const font of pkg.theme?.fonts ?? []) if (typeof font?.file === 'string' && font.file !== '') names.add(font.file);
  const reportPath = join(packageDir, 'audio/durations.json');
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      for (const scene of Object.values(report?.scenes ?? {})) {
        if (typeof scene?.file === 'string' && scene.file !== '') names.add(scene.file);
      }
    } catch {
      // A malformed report is still hashed as bytes.
    }
  }
  return [...names].map((name) => safeRelative(name, 'input path')).sort();
}

function hashOptionalInput(root, name) {
  const file = resolve(root, name);
  if (file !== root && !file.startsWith(root + sep)) fail('INVALID_PATH', 'input escapes the package');
  let real;
  try {
    real = realpathSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  if (real !== root && !real.startsWith(root + sep)) fail('INVALID_PATH', 'input escapes the package');
  let stat;
  try {
    stat = statSync(real);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  if (!stat.isFile()) return null;
  const bytes = readFileSync(real);
  return { sha256: hashBytes(bytes), bytes: bytes.length };
}

export function collectDeliveryInputs(pkg, packageDir) {
  if (typeof packageDir !== 'string' || packageDir.trim() === '') {
    fail('INVALID_PACKAGE_DIR', 'packageDir is required to freeze delivery inputs');
  }
  const root = realpathSync(packageDir);
  return declaredInputNames(pkg, root).map((path) => {
    const found = hashOptionalInput(root, path);
    return found === null
      ? { path, sha256: null, bytes: null }
      : { path, sha256: found.sha256, bytes: found.bytes };
  });
}

function timingSnapshot(timeline) {
  return {
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    durationInFrames: timeline.durationInFrames,
    provisional: timeline.provisional === true,
    hash: timeline.hash ?? null,
    scenes: (timeline.scenes ?? []).map((scene) => ({
      id: scene.id,
      from: scene.from,
      durationInFrames: scene.durationInFrames,
      transitionInFrames: scene.transitionInFrames ?? 0,
      transitionOutFrames: scene.transitionOutFrames ?? 0,
      narrationAsset: scene.narration_asset ?? scene.narrationAsset ?? null,
    })),
    captions: (timeline.captions ?? []).map((cue) => ({
      sceneId: cue.sceneId ?? cue.scene_id ?? null,
      from: cue.from,
      to: cue.to,
    })),
  };
}

function speechFingerprint(pkg, timeline, measured) {
  return hashText(canonicalJson({
    voice: pkg.voice ?? null,
    measured: measured ?? {},
    scenes: (timeline.scenes ?? []).map((scene) => ({
      id: scene.id,
      from: scene.from,
      durationInFrames: scene.durationInFrames,
      narration: scene.narration ?? null,
      narrationAsset: scene.narration_asset ?? scene.narrationAsset ?? null,
    })),
  }));
}

function reviewStates(reviews) {
  if (reviews === undefined || reviews === null) return [];
  if (!Array.isArray(reviews)) fail('INVALID_REVIEWS', 'reviews must be an array');
  return reviews.map((entry, index) => {
    if (!isPlainObject(entry)) fail('INVALID_REVIEWS', `reviews[${index}] must be an object`);
    if (typeof entry.decisionId !== 'string' || entry.decisionId.trim() === '') {
      fail('INVALID_REVIEWS', `reviews[${index}].decisionId is required`);
    }
    const hasOverride = entry.override !== undefined && entry.override !== null;
    const verdict = typeof entry.verdict === 'string' ? entry.verdict.trim().toLowerCase() : '';
    const state = hasOverride ? 'overridden'
      : verdict === 'approved' ? 'approved'
        : verdict === 'rejected' ? 'rejected'
          : 'unknown';
    return {
      decisionId: entry.decisionId,
      state,
      ...(verdict === '' ? {} : { verdict }),
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    };
  });
}

function rightsExclusions(pkg) {
  const excluded = [];
  for (const [assetId, asset] of Object.entries(pkg.assets ?? {})) {
    if (isAssetRedistributable(asset)) continue;
    excluded.push({
      assetId,
      ...(asset?.file ? { file: asset.file } : {}),
      ...(asset?.license?.id ? { licenseId: asset.license.id } : {}),
      reason: asset?.license?.blocked_reason
        ?? (asset?.license?.blocked ? 'licence policy blocked this asset' : 'not marked redistributable under the licence policy'),
    });
  }
  return excluded;
}

export function snapshotFingerprint(snapshot) {
  if (!isPlainObject(snapshot)) fail('INVALID_SNAPSHOT', 'snapshot must be an object');
  const { fingerprint, timeline, ...content } = snapshot;
  return hashText(canonicalJson(content));
}

/**
 * Build the one snapshot every delivery path shares. `packageDir` freezes the
 * declared source bytes; `editor` carries the UX05 caption overrides; measured
 * narration is read from the package's own audio sidecar when not supplied.
 */
export function createDeliverySnapshot({
  pkg,
  packageDir,
  editor = null,
  editorRevision = null,
  selections = null,
  measured = undefined,
  references = null,
  intent = 'final',
  format = null,
  archiveMode = 'private',
  reviews = null,
  packageRevision = undefined,
} = {}) {
  if (!isPlainObject(pkg) || typeof pkg.id !== 'string' || pkg.id === '' || !Array.isArray(pkg.scenes)) {
    fail('INVALID_PACKAGE', 'a delivery snapshot needs a package with an id and scenes');
  }
  const normalizedIntent = normalizeDeliveryIntent(intent);
  const normalizedEditor = normalizeEditor(editor);
  const captionOverrides = normalizedEditor.captionOverrides;
  const narration = measured !== undefined ? measured : (packageDir ? measuredOptionsFromDir(packageDir) : {});
  const compileOptions = {
    ...(isPlainObject(narration) ? narration : {}),
    ...(captionOverrides.length === 0 ? {} : { captionOverrides }),
  };
  const timeline = compileTimeline(pkg, compileOptions);
  const outputFormat = finalRenderFormat(pkg, format ?? {});
  const inputs = packageDir ? collectDeliveryInputs(pkg, packageDir) : [];
  const normalizedSelections = normalizeSelections(selections);
  const editorHash = hashText(canonicalJson(normalizedEditor));
  const captionRevision = hashText(JSON.stringify(captionOverrides));
  const speechSha256 = speechFingerprint(pkg, timeline, narration);
  const timing = timingSnapshot(timeline);
  const packageCopy = clone(pkg);
  const snapshot = {
    schema: DELIVERY_SNAPSHOT_SCHEMA,
    packageId: pkg.id,
    packageRevision: nonNegative(packageRevision ?? pkg.revision, 'packageRevision', 0),
    packageHash: hashText(canonicalJson(packageCopy)),
    package: packageCopy,
    editor: normalizedEditor,
    editorRevision: nonNegative(editorRevision ?? normalizedEditor.revision, 'editorRevision', 0),
    editorHash,
    captionOverrides,
    captionRevision,
    selections: normalizedSelections,
    references: normalizeReferences(references),
    intent: normalizedIntent,
    archiveMode: archiveMode === 'redistributable' ? 'redistributable' : 'private',
    format: outputFormat,
    timelineHash: timeline.hash ?? null,
    timing,
    speechSha256,
    inputs,
  };
  const fingerprint = snapshotFingerprint(snapshot);
  return { ...snapshot, timeline, fingerprint };
}

export function preflightDelivery(snapshot, options = {}) {
  if (!isPlainObject(snapshot)) fail('INVALID_SNAPSHOT', 'preflight needs a delivery snapshot');
  const intent = normalizeDeliveryIntent(snapshot.intent);
  const finalRequested = intent === 'final';
  const blockers = [];
  const warnings = [];
  const add = (code, message, details) => {
    const item = { code, message, ...(details ?? {}) };
    if (finalRequested) blockers.push(item);
    else warnings.push(item);
  };

  const reviews = reviewStates(options.reviews ?? snapshot.reviews ?? null);
  for (const review of reviews) {
    if (review.state === 'unknown') {
      add('UNKNOWN_CREATIVE_REVIEW', `review ${review.decisionId} has no human verdict`, { decisionId: review.decisionId });
    } else if (review.state === 'rejected') {
      add('REJECTED_CREATIVE_REVIEW', `review ${review.decisionId} rejected this output`, { decisionId: review.decisionId });
    }
  }

  if (snapshot.timing?.provisional === true) {
    const message = 'narration timing is provisional';
    if (finalRequested && options.requireMeasured === true) blockers.push({ code: 'PROVISIONAL_TIMING', message });
    else warnings.push({ code: 'PROVISIONAL_TIMING', message });
  }

  const missing = (snapshot.inputs ?? []).filter((input) => input.sha256 === null).map((input) => input.path);
  if (missing.length > 0) {
    const item = { code: 'MISSING_SOURCE', message: `${missing.length} declared source file(s) are not present`, paths: missing };
    if (options.requireSources === true && finalRequested) blockers.push(item);
    else warnings.push(item);
  }

  const gate = options.gate;
  if (gate && gate.ok === false) {
    add('DELIVERY_GATE_BLOCKED', 'creative review gate is not satisfied', { gate });
  }

  const facts = {
    intent,
    format: snapshot.format,
    archiveMode: snapshot.archiveMode,
    snapshotFingerprint: snapshot.fingerprint,
    timelineHash: snapshot.timelineHash,
    captionRevision: snapshot.captionRevision,
    speechSha256: snapshot.speechSha256,
    sourceCompleteness: {
      complete: missing.length === 0,
      missing,
      inputs: snapshot.inputs,
    },
    rightsExclusions: rightsExclusions(snapshot.package ?? {}),
    reviews,
  };
  const ok = blockers.length === 0;
  return { ok, final: finalRequested && ok, intent, blockers, warnings, facts };
}

export function assertDeliveryPreflight(preflight) {
  if (preflight?.ok === true) return preflight;
  const first = preflight?.blockers?.[0];
  fail(first?.code ?? 'DELIVERY_PREFLIGHT_BLOCKED', first?.message ?? 'delivery preflight is not satisfied', { preflight });
}

function checkStagedHash(path, expected) {
  const bytes = readFileSync(path);
  if (hashBytes(bytes) !== expected) fail('INPUT_CHANGED', `source changed after the snapshot was taken: ${path}`);
  return bytes;
}

/**
 * Copy the snapshot's package, editor and exact source bytes into one private
 * staging directory. The renderer and archive then read only these bytes, so a
 * source mutation during the render either does not matter or fails staging.
 */
export function stageDeliverySnapshot({ snapshot, packageDir, stagingDir = null } = {}) {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.package)) fail('INVALID_SNAPSHOT', 'staging needs a delivery snapshot');
  if (typeof packageDir !== 'string' || packageDir.trim() === '') fail('INVALID_PACKAGE_DIR', 'staging needs the package directory');
  if (snapshot.fingerprint !== snapshotFingerprint(snapshot)) fail('SNAPSHOT_MISMATCH', 'snapshot content no longer matches its fingerprint');
  const root = stagingDir === null
    ? mkdtempSync(join(tmpdir(), 'comfyrizz-delivery-'))
    : resolve(stagingDir);
  const stagedPackageDir = join(root, 'package');
  mkdirSync(stagedPackageDir, { recursive: true, mode: 0o700 });
  const packagePath = join(stagedPackageDir, 'package.json');
  writeFileSync(packagePath, `${JSON.stringify(snapshot.package, null, 2)}\n`, { mode: 0o600 });
  const editorPath = join(root, 'editor.json');
  writeFileSync(editorPath, `${JSON.stringify(snapshot.editor ?? { version: 1, captionOverrides: [] }, null, 2)}\n`, { mode: 0o600 });

  const sourceRoot = realpathSync(packageDir);
  for (const input of snapshot.inputs ?? []) {
    if (input.sha256 === null) continue;
    const relativePath = safeRelative(input.path, 'input path');
    const source = resolve(sourceRoot, relativePath);
    if (!source.startsWith(sourceRoot + sep)) fail('INVALID_PATH', 'input escapes the package');
    const sourceBytes = checkStagedHash(source, input.sha256);
    const target = join(stagedPackageDir, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, sourceBytes, { mode: 0o600 });
  }

  return {
    dir: root,
    packageDir: stagedPackageDir,
    packagePath,
    editorPath,
    snapshot,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function renderDeliveryCaptions(snapshot, options = {}) {
  const timeline = isPlainObject(snapshot?.timeline) ? snapshot.timeline : snapshot;
  if (!isPlainObject(timeline)) fail('INVALID_TIMELINE', 'captions need a delivery snapshot or compiled timeline');
  const cues = Array.isArray(timeline.captions) ? timeline.captions : [];
  const fps = options.fps ?? timeline.fps ?? 30;
  const srt = captionsToSrt(cues, fps);
  const vtt = captionsToVtt(cues, fps);
  const hasWords = cues.some((cue) => Array.isArray(cue.words) && cue.words.length > 0);
  const wordsVtt = hasWords ? captionsToWordVtt(cues, fps) : null;
  return {
    cues,
    srt,
    vtt,
    wordsVtt,
    sha256: hashText(JSON.stringify({ srt, vtt, wordsVtt })),
    speechSha256: snapshot?.speechSha256 ?? null,
  };
}

export default createDeliverySnapshot;
