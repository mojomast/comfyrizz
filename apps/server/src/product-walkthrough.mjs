import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { USER_UPLOAD_LICENSE } from './references/assign.mjs';
import { CHAT_ID_PATTERN, createReferenceStore } from './references/store.mjs';
import { validateUpload } from './references/validate.mjs';

export const PRODUCT_WALKTHROUGH_FOREGROUND_CAP = 12;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm']);
const AUDIO_VALUES = new Set(['none', 'muted', 'present']);
const SHA256_RE = /^[0-9a-f]{64}$/i;

class AdoptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdoptionError';
    this.code = code;
  }
}

function noOp(pkg) {
  return { package: pkg, adopted: [], skipped: [] };
}

function inside(root, target, { orEqual = true } = {}) {
  const rel = relative(root, target);
  if (orEqual && rel === '') return true;
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function positiveNumber(value, maximum = Number.POSITIVE_INFINITY) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum
    ? value
    : undefined;
}

function nonNegativeNumber(value, maximum = Number.POSITIVE_INFINITY) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

function originalExtension(ref) {
  const fromFile = extname(typeof ref.file === 'string' ? ref.file : '').slice(1).toLowerCase();
  const fromRecord = typeof ref.ext === 'string' ? ref.ext.toLowerCase().replace(/^\./, '') : '';
  const ext = fromFile || fromRecord;
  const allowed = ref.kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
  if (!allowed.has(ext)) {
    throw new AdoptionError('INVALID_ORIGINAL_FILE', `reference ${ref.id} has no preserved ${ref.kind} extension`);
  }
  return ext;
}

function sourcePath(store, ref) {
  if (typeof ref.file !== 'string' || !ref.file || ref.file !== basename(ref.file)) {
    throw new AdoptionError('INVALID_ORIGINAL_FILE', `reference ${ref.id} has an unsafe stored filename`);
  }
  const root = resolve(store.filesDir);
  const candidate = resolve(join(root, ref.file));
  if (!inside(root, candidate, { orEqual: false })) {
    throw new AdoptionError('PATH_ESCAPE', `reference ${ref.id} source escapes its library`);
  }
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AdoptionError('INVALID_ORIGINAL_FILE', `reference ${ref.id} original is not a regular file`);
  }
  const rootReal = resolve(realpathSync(root));
  const libraryReal = resolve(realpathSync(store.dir));
  if (!inside(libraryReal, rootReal, { orEqual: false })) {
    throw new AdoptionError('PATH_ESCAPE', `reference ${ref.id} files directory resolves outside its library`);
  }
  const sourceReal = resolve(realpathSync(candidate));
  if (!inside(rootReal, sourceReal, { orEqual: false })) {
    throw new AdoptionError('PATH_ESCAPE', `reference ${ref.id} source resolves outside its library`);
  }
  return candidate;
}

function readOriginal(store, ref) {
  const ext = originalExtension(ref);
  const file = sourcePath(store, ref);
  const bytes = readFileSync(file);
  if (bytes.length === 0) throw new AdoptionError('EMPTY_ORIGINAL', `reference ${ref.id} original is empty`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (typeof ref.sha256 === 'string' && SHA256_RE.test(ref.sha256) && ref.sha256.toLowerCase() !== sha256) {
    throw new AdoptionError('HASH_MISMATCH', `reference ${ref.id} original bytes do not match its stored hash`);
  }
  return { bytes, sha256, ext };
}

function mediaFor(ref) {
  const source = ref.media && typeof ref.media === 'object' && !Array.isArray(ref.media) ? ref.media : {};
  const media = {};
  const width = positiveInteger(ref.width ?? source.width);
  const height = positiveInteger(ref.height ?? source.height);
  const durationSeconds = nonNegativeNumber(
    ref.durationSec ?? ref.durationSeconds ?? source.durationSeconds,
    36_000,
  );
  const fps = positiveNumber(ref.fps ?? source.fps, 240);
  // ref.frames is the extracted-keyframe list, not the source video's frame
  // count. Only explicit source metadata may populate package media.frames.
  const numericFrames = typeof ref.frames === 'number' ? ref.frames : undefined;
  const frames = positiveInteger(ref.frameCount ?? ref.sourceFrames ?? numericFrames ?? source.frames);
  const audio = ref.audio ?? source.audio;
  if (width !== undefined) media.width = width;
  if (height !== undefined) media.height = height;
  if (ref.kind === 'video') {
    if (durationSeconds !== undefined) media.durationSeconds = durationSeconds;
    if (fps !== undefined) media.fps = fps;
    if (frames !== undefined) media.frames = frames;
    if (AUDIO_VALUES.has(audio)) media.audio = audio;
  }
  return media;
}

function notesFor(ref) {
  const note = typeof ref.note === 'string' ? ref.note.trim() : '';
  if (note.length <= 512) return note;
  return `${note.slice(0, 509)}...`;
}

function packageAssetFor(ref, original, assetId) {
  const media = mediaFor(ref);
  return {
    kind: ref.kind,
    origin: 'upload',
    status: 'ready',
    file: `assets/${assetId}.${original.ext}`,
    sha256: original.sha256,
    bytes: original.bytes.length,
    ...(Object.keys(media).length ? { media } : {}),
    source: {
      provider: 'upload',
      id: ref.id,
      original_file: ref.file,
    },
    license: { ...USER_UPLOAD_LICENSE },
    redistributable: false,
    notes: notesFor(ref),
  };
}

function compatibleAsset(asset, ref, original, assetId) {
  return Boolean(asset) && typeof asset === 'object'
    && asset.kind === ref.kind
    && asset.origin === 'upload'
    && asset.status === 'ready'
    && asset.sha256 === original.sha256
    && (asset.bytes === undefined || asset.bytes === original.bytes.length)
    && asset.file === `assets/${assetId}.${original.ext}`
    && asset.source?.provider === 'upload'
    && asset.license?.id === 'User-Upload'
    && asset.license?.approved_by_user === true
    && asset.redistributable === false;
}

function assetIdFor(pkg, ref, original) {
  const short = `a_ref_${original.sha256.slice(0, 16)}`;
  const existing = pkg.assets?.[short];
  if (!existing || compatibleAsset(existing, ref, original, short)) return short;
  const full = `a_ref_${original.sha256}`;
  if (pkg.assets?.[full] && !compatibleAsset(pkg.assets[full], ref, original, full)) {
    throw new AdoptionError('ASSET_ID_CONFLICT', `reference ${ref.id} collides with an unrelated package asset`);
  }
  return full;
}

function copyOriginal(runtimeDir, original, asset) {
  const runtimeRoot = resolve(runtimeDir);
  const assetsRoot = resolve(join(runtimeRoot, 'packages', 'assets'));
  mkdirSync(assetsRoot, { recursive: true, mode: 0o700 });
  const runtimeReal = resolve(realpathSync(runtimeRoot));
  const assetsReal = resolve(realpathSync(assetsRoot));
  if (!inside(runtimeReal, assetsReal, { orEqual: false })) {
    throw new AdoptionError('PATH_ESCAPE', 'package assets directory resolves outside runtimeDir');
  }
  const leaf = basename(asset.file);
  const destination = resolve(join(assetsReal, leaf));
  if (!inside(assetsReal, destination, { orEqual: false })) {
    throw new AdoptionError('PATH_ESCAPE', 'package asset destination escapes the assets directory');
  }
  try {
    const stat = lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AdoptionError('DESTINATION_CONFLICT', `package asset ${leaf} is not a regular file`);
    }
    const existing = readFileSync(destination);
    if (!existing.equals(original.bytes)) {
      throw new AdoptionError('DESTINATION_CONFLICT', `package asset ${leaf} already contains different bytes`);
    }
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  writeFileSync(destination, original.bytes, { mode: 0o600, flag: 'wx' });
}

/** Resolve a conversation's rights-asserted image on demand for generation.
 * This does not authorize placing the upload in an editorial scene. */
export function createReferenceImageAdopter({ runtimeDir, conversationId } = {}) {
  if (typeof runtimeDir !== 'string' || !runtimeDir || !CHAT_ID_PATTERN.test(conversationId ?? '')) return undefined;
  if (!existsSync(join(resolve(runtimeDir), 'references', conversationId, 'refs.json'))) return undefined;
  const store = createReferenceStore({ rootDir: runtimeDir, chatId: conversationId });
  return (id, pkg) => {
    if (typeof id !== 'string' || !/^ref_[0-9a-f]{16}$/.test(id)) return undefined;
    const ref = store.get(id);
    if (!ref || ref.kind !== 'image' || ref.rightsAsserted !== true) return undefined;
    if (!SHA256_RE.test(ref.sha256 ?? '') || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
      throw new AdoptionError('INVALID_PROVENANCE', `reference ${id} lacks a trusted hash or size`);
    }
    const original = readOriginal(store, ref);
    const validated = validateUpload({ bytes: original.bytes, filename: ref.file, declaredMime: ref.mime });
    if (!validated.ok || validated.kind !== 'image' || validated.ext !== original.ext || original.bytes.length !== ref.bytes) {
      throw new AdoptionError('INVALID_ORIGINAL_FILE', `reference ${id} bytes do not match its stored image metadata`);
    }
    const assetId = assetIdFor(pkg, ref, original);
    const asset = pkg.assets?.[assetId] ?? packageAssetFor(ref, original, assetId);
    copyOriginal(runtimeDir, original, asset);
    return { assetId, asset };
  };
}

function placementExists(scene, assetId) {
  if (scene?.background?.asset === assetId) return true;
  if (Array.isArray(scene?.media) && scene.media.some(item => item?.asset === assetId)) return true;
  return Array.isArray(scene?.foreground) && scene.foreground.some(item => item?.asset === assetId);
}

function alreadyPlaced(pkg, assetId) {
  return pkg.scenes.some(scene => placementExists(scene, assetId));
}

function rounded(value) {
  return Number(value.toFixed(6));
}

/**
 * The foreground schema has no `fit` member. Giving its panel the source
 * aspect makes the renderer's cover fill equivalent to contain: no crop, no
 * background replacement, and no changes to generated media or scene copy.
 */
function foregroundFor(assetId, ref, pkg) {
  const media = mediaFor(ref);
  const formatAspect = positiveNumber(pkg.format?.width) && positiveNumber(pkg.format?.height)
    ? pkg.format.width / pkg.format.height
    : 16 / 9;
  const sourceAspect = media.width && media.height ? media.width / media.height : formatAspect;
  const maxW = 0.72;
  const maxH = 0.56;
  let w = maxW;
  let h = w * formatAspect / sourceAspect;
  if (h > maxH) {
    h = maxH;
    w = h * sourceAspect / formatAspect;
  }
  return { asset: assetId, x: 0.5, y: 0.5, w: rounded(w), h: rounded(h), anim: 'none' };
}

function skipped(ref, sceneId, code, reason) {
  return { refId: ref.id, ...(sceneId ? { sceneId } : {}), code, reason };
}

/**
 * Adopt explicitly editorial image/video uploads into a Product Walkthrough
 * package. Selection and placement are deterministic: library order is kept,
 * and attachments are assigned once, round-robin in scene plan order.
 *
 * No model, probe, generation, or paid service is invoked. The input package
 * is never mutated; a no-selection/no-library call returns it by identity.
 */
export async function adoptProductWalkthroughAttachments({
  runtimeDir,
  conversationId,
  package: pkg,
  imagesOnly = false,
} = {}) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return noOp(pkg);
  if (typeof runtimeDir !== 'string' || !runtimeDir) return noOp(pkg);
  if (typeof conversationId !== 'string' || !CHAT_ID_PATTERN.test(conversationId)) return noOp(pkg);

  const statePath = join(resolve(runtimeDir), 'references', conversationId, 'refs.json');
  if (!existsSync(statePath)) return noOp(pkg);
  const store = createReferenceStore({ rootDir: runtimeDir, chatId: conversationId });
  const selected = store.list().filter(ref => ref
    && (ref.kind === 'image' || (!imagesOnly && ref.kind === 'video'))
    && ref.rightsAsserted === true
    && ref.usage === 'editorial'
    && (ref.kind !== 'image' || ref.editorialScope === (imagesOnly ? 'custom' : 'product-walkthrough')));
  if (!selected.length || !Array.isArray(pkg.scenes)) return noOp(pkg);

  // These layouts always render foreground, including media-only film scenes.
  const eligible = imagesOnly ? pkg.scenes.filter(scene => scene && (scene.media_only || scene.mediaOnly || ['title', 'hero', 'stat'].includes(scene.layout))) : pkg.scenes.filter(Boolean);
  const nonTitleScenes = eligible.filter(scene => scene.layout !== 'title');
  const targets = nonTitleScenes.length ? nonTitleScenes : eligible;
  if (!targets.length) {
    return {
      package: pkg,
      adopted: [],
      skipped: selected.map(ref => skipped(ref, null, 'NO_SCENES', 'package has no scenes for editorial media')),
    };
  }

  let draft = pkg;
  const adopted = [];
  const overflow = [];
  const ensureDraft = () => {
    if (draft === pkg) draft = structuredClone(pkg);
    return draft;
  };

  for (const [index, ref] of selected.entries()) {
    const target = targets[index % targets.length];
    try {
      const original = readOriginal(store, ref);
      if (imagesOnly) {
        if (!SHA256_RE.test(ref.sha256 ?? '') || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
          throw new AdoptionError('INVALID_PROVENANCE', `reference ${ref.id} lacks a trusted hash or size`);
        }
        const validated = validateUpload({ bytes: original.bytes, filename: ref.file, declaredMime: ref.mime });
        if (!validated.ok || validated.kind !== 'image' || validated.ext !== original.ext || original.bytes.length !== ref.bytes) {
          throw new AdoptionError('INVALID_ORIGINAL_FILE', `reference ${ref.id} bytes do not match its stored image metadata`);
        }
      }
      const assetId = assetIdFor(draft, ref, original);
      const existingAsset = draft.assets?.[assetId];

      if (existingAsset && alreadyPlaced(draft, assetId)) {
        copyOriginal(runtimeDir, original, existingAsset);
        adopted.push({ refId: ref.id, assetId, sceneId: target.id, slot: 'foreground', reused: true });
        continue;
      }
      const currentTarget = draft.scenes.find(scene => scene?.id === target.id) ?? target;
      const currentForeground = Array.isArray(currentTarget.foreground) ? currentTarget.foreground : [];
      if (existingAsset && currentForeground.some(item => item?.asset === assetId)) {
        copyOriginal(runtimeDir, original, existingAsset);
        adopted.push({ refId: ref.id, assetId, sceneId: target.id, slot: 'foreground', reused: true });
        continue;
      }
      if (currentForeground.length >= PRODUCT_WALKTHROUGH_FOREGROUND_CAP) {
        overflow.push(skipped(
          ref,
          target.id,
          'FOREGROUND_CAP_REACHED',
          `scene ${target.id} already has the maximum ${PRODUCT_WALKTHROUGH_FOREGROUND_CAP} foreground items`,
        ));
        continue;
      }

      const asset = existingAsset ?? packageAssetFor(ref, original, assetId);
      copyOriginal(runtimeDir, original, asset);
      const placement = foregroundFor(assetId, ref, draft);
      const next = ensureDraft();
      next.assets ??= {};
      if (!existingAsset) next.assets[assetId] = asset;
      const scene = next.scenes.find(candidate => candidate?.id === target.id);
      if (!scene) throw new AdoptionError('UNKNOWN_SCENE', `scene ${target.id} disappeared during adoption`);
      scene.foreground = [...(Array.isArray(scene.foreground) ? scene.foreground : []), placement];
      adopted.push({ refId: ref.id, assetId, sceneId: target.id, slot: 'foreground' });
    } catch (error) {
      overflow.push(skipped(
        ref,
        target.id,
        typeof error?.code === 'string' ? error.code : 'ADOPTION_FAILED',
        error?.message ?? 'editorial media could not be adopted',
      ));
    }
  }

  return { package: draft, adopted, skipped: overflow };
}

export const adoptProductWalkthroughMedia = adoptProductWalkthroughAttachments;
export default adoptProductWalkthroughAttachments;
