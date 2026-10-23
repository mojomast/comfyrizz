import { isDeepStrictEqual } from 'node:util';
import { ROLES, makeCharacter, primaryImage } from './model.mjs';
import { toPackageVoice } from './voice.mjs';
import { applyH3VoiceDirection } from './h3-voice-direction.mjs';
import {
  CAST_ID_RE,
  CastError,
  castIdFor,
  normalizeOverrides,
} from './cast.mjs';

export const CHARACTERS_SCHEMA = 'comfyrizz.characters/v1';
export const CHARACTER_ASSET_PREFIX = 'a_chr_';
export const T2I_WORKFLOW = 'workflows/flux3_klein_t2i.api.json';
export const REF_EDIT_WORKFLOW = 'workflows/flux3_klein_ref_edit.api.json';
export const REF_EDIT_WORKFLOW_SHA256 = 'ecf1b281737c8f3bad5afe7be79e76d7aa3595146b97a8df3e8098c21c080e09';
export const MAX_CAST = 8;
export const USER_UPLOAD_LICENSE = Object.freeze({ id: 'User-Upload', approved_by_user: true });
export const GENERATED_LICENSE = Object.freeze({ id: 'CC0-1.0' });
export const KLEIN_MODEL_LICENSE = Object.freeze({
  id: 'LicenseRef-FLUX.3-Image-Klein',
  url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein',
});

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const EXT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});
const SHA256_RE = /^[0-9a-f]{64}$/i;
const CONFIRMED_STATES = new Set(['confirmed', 'approved', 'applied']);
const UNCONFIRMED_STATES = new Set(['proposed', 'pending', 'draft', 'rejected', 'ignored']);
const KLEIN_GENERATORS = new Set(['flux3-klein']);
const ROLE_SET = new Set(ROLES);

export class CharacterBuildError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'CharacterBuildError';
    this.code = code;
    this.field = field;
    this.path = field;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new CharacterBuildError(code, field, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function uniquePush(list, value) {
  if (value !== undefined && value !== null && value !== '' && !list.includes(value)) list.push(value);
}

function castEntries(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.cast)) return value.cast;
  fail('BUILD_INVALID_INPUT', 'cast', 'cast must be an array of project cast entries');
}

function placementEntries(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.placements)) return value.placements;
  fail('BUILD_INVALID_INPUT', 'placements', 'placements must be an array');
}

function castIdValue(value, field) {
  if (typeof value !== 'string' || !CAST_ID_RE.test(value.trim())) {
    fail('BUILD_INVALID_CAST_ID', field, `${field} must match ${CAST_ID_RE}`);
  }
  return value.trim();
}

function sceneIdValue(value, field) {
  if (typeof value !== 'string' || !/^s[A-Za-z0-9_-]{0,63}$/.test(value.trim())) {
    fail('BUILD_INVALID_SCENE_ID', field, `${field} must be a scene id`);
  }
  return value.trim();
}

function optionalToken(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.trim())) {
    fail('BUILD_INVALID_OVERRIDE', field, `${field} must be a simple ASCII identifier`);
  }
  return value.trim();
}

function optionalRole(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !ROLE_SET.has(value.trim().toLowerCase())) {
    fail('BUILD_INVALID_ROLE', field, `${field} must be one of: ${ROLES.join(', ')}`);
  }
  return value.trim().toLowerCase();
}

function normalizeCastEntry(raw, index) {
  if (!isObject(raw)) fail('BUILD_INVALID_INPUT', `cast[${index}]`, `cast[${index}] must be an object`);
  const snapshotInput = isObject(raw.snapshot) ? raw.snapshot : raw;
  const snapshot = makeCharacter(snapshotInput);
  const castId = raw.castId === undefined
    ? castIdFor(snapshot.handle)
    : castIdValue(raw.castId, `cast[${index}].castId`);
  const pinnedRevision = raw.pinnedRevision === undefined
    ? snapshot.revision
    : raw.pinnedRevision;
  if (!Number.isSafeInteger(pinnedRevision) || pinnedRevision < 1) {
    fail('BUILD_INVALID_REVISION', `cast[${index}].pinnedRevision`, 'pinnedRevision must be a positive integer');
  }
  const overrides = normalizeOverrides(raw.overrides);
  return {
    castId,
    characterId: snapshot.id,
    pinnedRevision,
    snapshot,
    overrides,
    detached: raw.detached === true,
    orphaned: raw.orphaned === true,
  };
}

function normalizeCast(cast) {
  const entries = castEntries(cast);
  if (entries.length > MAX_CAST) {
    throw new CastError('CAST_LIMIT', 'cast', `a project may contain at most ${MAX_CAST} cast members`);
  }
  const out = [];
  const ids = new Set();
  const characterIds = new Set();
  const ignored = [];
  entries.forEach((raw, index) => {
    const entry = normalizeCastEntry(raw, index);
    if (ids.has(entry.castId)) {
      ignored.push({ index, castId: entry.castId, reason: 'duplicate cast id' });
      return;
    }
    if (characterIds.has(entry.characterId)) {
      ignored.push({ index, castId: entry.castId, reason: 'duplicate character' });
      return;
    }
    ids.add(entry.castId);
    characterIds.add(entry.characterId);
    out.push(entry);
  });
  return { entries: out, ignored };
}

function confirmationOf(placement) {
  if (!isObject(placement)) return false;
  if (placement.confirmed === false) return false;
  if (placement.confirmed === true) return true;
  for (const key of ['status', 'state']) {
    const value = placement[key];
    if (typeof value !== 'string') continue;
    const stateName = value.trim().toLowerCase();
    if (CONFIRMED_STATES.has(stateName)) return true;
    if (UNCONFIRMED_STATES.has(stateName)) return false;
  }
  return false;
}

function placementIds(placement) {
  const scenes = [];
  const direct = placement.scenes ?? placement.sceneIds;
  if (Array.isArray(direct)) {
    direct.forEach((scene, index) => scenes.push({ sceneId: sceneIdValue(scene, `scenes[${index}]`), index }));
  } else if (direct !== undefined && direct !== null) {
    scenes.push({ sceneId: sceneIdValue(direct, 'scenes'), index: 0 });
  }
  for (const key of ['sceneId', 'scene']) {
    if (placement[key] === undefined || placement[key] === null) continue;
    scenes.push({ sceneId: sceneIdValue(placement[key], key), index: scenes.length });
  }
  return scenes;
}

function normalizePlacements(placements, entries, pkg) {
  const byCast = new Map(entries.map((entry) => [entry.castId, entry]));
  const byCharacter = new Map(entries.map((entry) => [entry.characterId, entry]));
  const sceneIds = new Set((Array.isArray(pkg.scenes) ? pkg.scenes : [])
    .map((scene) => (isObject(scene) ? scene.id : null))
    .filter((id) => typeof id === 'string'));
  const confirmed = [];
  const ignored = [];

  placementEntries(placements).forEach((placement, index) => {
    if (!isObject(placement)) {
      ignored.push({ index, reason: 'placement is not an object' });
      return;
    }
    if (!confirmationOf(placement)) {
      ignored.push({ index, reason: 'unconfirmed' });
      return;
    }
    const entry = placement.castId !== undefined
      ? byCast.get(placement.castId)
      : (placement.characterId !== undefined ? byCharacter.get(placement.characterId) : null);
    if (!entry) {
      ignored.push({ index, reason: 'unknown cast member' });
      return;
    }
    const scenes = placementIds(placement);
    if (!scenes.length) {
      ignored.push({ index, castId: entry.castId, reason: 'no scene' });
      return;
    }
    const wardrobeId = optionalToken(
      placement.wardrobeId ?? placement.wardrobe_id,
      `placements[${index}].wardrobeId`,
    );
    const expressionId = optionalToken(
      placement.expressionId ?? placement.expression_id,
      `placements[${index}].expressionId`,
    );
    const role = optionalRole(placement.role, `placements[${index}].role`);
    for (const item of scenes) {
      if (!sceneIds.has(item.sceneId)) {
        ignored.push({ index, castId: entry.castId, sceneId: item.sceneId, reason: 'unknown scene' });
        continue;
      }
      confirmed.push({
        castId: entry.castId,
        sceneId: item.sceneId,
        ...(wardrobeId ? { wardrobeId } : {}),
        ...(expressionId ? { expressionId } : {}),
        ...(role ? { role } : {}),
      });
    }
  });

  return { confirmed, ignored };
}

function shaValue(image) {
  if (typeof image?.sha256 !== 'string' || !SHA256_RE.test(image.sha256)) {
    fail('BUILD_INVALID_IMAGE', 'visual.images', 'a character reference image needs a 64-character sha256');
  }
  return image.sha256.toLowerCase();
}

function referenceImage(snapshot) {
  const direct = primaryImage(snapshot);
  if (direct) return direct;
  const visual = snapshot.visual ?? {};
  const images = Array.isArray(visual.images) ? visual.images : [];
  const sheet = visual.sheet;
  if (sheet && sheet.status === 'ready' && typeof sheet.imgId === 'string') {
    const chosen = images.find((image) => image && image.imgId === sheet.imgId);
    if (chosen) return chosen;
  }
  return images.length === 1 ? images[0] : null;
}

function entriesOfFiles(files) {
  if (files === undefined || files === null) return new Map();
  if (files instanceof Map) return new Map(files);
  if (Array.isArray(files)) {
    const map = new Map();
    files.forEach((file, index) => {
      if (!isObject(file)) return;
      for (const key of [file.imgId, file.characterId, file.castId, file.id, index]) {
        if (key !== undefined && key !== null && !map.has(key)) map.set(key, file);
      }
    });
    return map;
  }
  if (isObject(files)) return new Map(Object.entries(files));
  fail('BUILD_INVALID_INPUT', 'files', 'files must map character images to their source bytes or path');
}

function normalizeSource(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return { path: value };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { bytes: value };
  if (value instanceof ArrayBuffer) return { bytes: Buffer.from(value) };
  if (!isObject(value)) return null;
  const path = value.path ?? value.file ?? value.source ?? value.from;
  const bytes = value.bytes ?? value.data ?? value.buffer ?? value.content;
  return {
    ...(typeof path === 'string' && path ? { path } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}),
    ...(typeof value.ext === 'string' ? { ext: value.ext } : {}),
    ...(typeof value.mime === 'string' ? { mime: value.mime } : {}),
    ...(typeof value.size === 'number' ? { size: value.size } : {}),
    ...(Number.isSafeInteger(value.width) ? { width: value.width } : {}),
    ...(Number.isSafeInteger(value.height) ? { height: value.height } : {}),
  };
}

function sourceFor(files, entry, image) {
  const keys = [image.imgId, image.sha256, entry.characterId, entry.castId, entry.snapshot.handle];
  for (const key of keys) {
    if (key === undefined || key === null) continue;
    if (!files.has(key)) continue;
    return normalizeSource(files.get(key));
  }
  return null;
}

function byteLengthOf(source) {
  if (!source) return undefined;
  if (typeof source.size === 'number' && Number.isSafeInteger(source.size) && source.size > 0) return source.size;
  const bytes = source.bytes;
  if (bytes === undefined || bytes === null) return undefined;
  if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) {
    return bytes.byteLength > 0 ? bytes.byteLength : undefined;
  }
  return undefined;
}

function extensionOf(source) {
  if (source?.ext) {
    const ext = source.ext.toLowerCase().replace(/^\./, '');
    if (IMAGE_EXTENSIONS.has(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  }
  if (source?.mime && EXT_BY_MIME[source.mime.toLowerCase()]) return EXT_BY_MIME[source.mime.toLowerCase()];
  if (typeof source?.path === 'string') {
    const match = /\.([A-Za-z0-9]+)$/.exec(source.path);
    if (match) {
      const ext = match[1].toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    }
  }
  return 'png';
}

function assetIdFor(image) {
  return `${CHARACTER_ASSET_PREFIX}${shaValue(image).slice(0, 16)}`;
}

function assetFor(snapshot, image, assetId, ext, source) {
  const generated = image.source === 'generated';
  const bytes = byteLengthOf(source);
  const asset = {
    kind: 'image',
    origin: generated ? 'generated' : 'upload',
    status: 'ready',
    file: `assets/${assetId}.${ext}`,
    sha256: shaValue(image),
    ...(bytes ? { bytes } : {}),
    media: { width: image.width, height: image.height },
    license: generated ? { ...GENERATED_LICENSE } : { ...USER_UPLOAD_LICENSE },
    redistributable: generated,
  };
  if (generated) {
    asset.gen = {
      generator: 'flux3-klein',
      model: 'flux-3-image-klein',
      caption: `${snapshot.name}, fictional character reference.`,
    };
    asset.model_license = { ...KLEIN_MODEL_LICENSE };
  } else {
    asset.source = { provider: 'upload' };
  }
  return asset;
}

function effectiveRole(entry) {
  return entry.overrides.role ?? entry.snapshot.role;
}

function selectedItem(items, id) {
  if (!Array.isArray(items)) return null;
  if (id) {
    const chosen = items.find((item) => item && item.id === id);
    if (chosen) return chosen;
  }
  return items.find((item) => item && item.default === true) ?? null;
}

function promptPrefix(member, placement, entry) {
  const snapshot = entry.snapshot;
  const visual = snapshot.visual ?? {};
  const wardrobeId = placement?.wardrobeId ?? entry.overrides.wardrobeId;
  const expressionId = placement?.expressionId ?? entry.overrides.expressionId;
  const wardrobe = selectedItem(visual.wardrobe, wardrobeId);
  const expression = selectedItem(visual.expressions, expressionId);
  const parts = [];
  uniquePush(parts, visual.identityPrompt || snapshot.summary);
  uniquePush(parts, wardrobe?.prompt);
  uniquePush(parts, expression?.prompt);
  return `Character ${snapshot.name}:${parts.length ? ` ${parts.join(', ')}` : ''}`;
}

function negativeFor(entry) {
  return typeof entry.snapshot.visual?.negative === 'string'
    ? entry.snapshot.visual.negative.trim()
    : '';
}

function joinSentences(pieces) {
  return pieces
    .map((piece) => String(piece).trim())
    .filter(Boolean)
    .join('. ')
    .replace(/\.\.+/g, '.');
}

function isKleinStill(asset) {
  if (!isObject(asset) || asset.kind !== 'image' || !isObject(asset.gen)) return false;
  if (KLEIN_GENERATORS.has(asset.gen.generator)) return true;
  return typeof asset.gen.workflow === 'string' && /flux3_klein/i.test(asset.gen.workflow);
}

function isRefEdit(asset) {
  return asset.gen.workflow === REF_EDIT_WORKFLOW || /klein_ref_edit/i.test(String(asset.gen.workflow ?? ''));
}

function workflowShaFor(files, options) {
  const direct = options.workflowSha256
    ?? options.workflow_sha256
    ?? (files instanceof Map ? files.get('workflowSha256') : files?.workflowSha256);
  if (typeof direct === 'string' && SHA256_RE.test(direct)) return direct.toLowerCase();
  return REF_EDIT_WORKFLOW_SHA256;
}

function applyStillPrompt(asset, members, placementsByCast, options, files, warnings) {
  const inputs = isObject(asset.gen.inputs) ? { ...asset.gen.inputs } : {};
  const prefixes = [];
  const negatives = [];
  for (const { entry } of members) {
    uniquePush(prefixes, promptPrefix(entry.snapshot, placementsByCast.get(entry.castId), entry));
    uniquePush(negatives, negativeFor(entry));
  }
  let prompt = typeof inputs.prompt === 'string' ? inputs.prompt.trim() : '';
  const missing = prefixes.filter((prefix) => !prompt.includes(prefix));
  if (missing.length) prompt = joinSentences([...missing, prompt]);
  if (negatives.length) {
    const clause = `Negative: ${negatives.join(', ')}`;
    const absent = negatives.filter((negative) => !prompt.includes(negative));
    if (absent.length) prompt = joinSentences([prompt, clause]);
  }
  if (prompt) inputs.prompt = prompt;

  if (isKleinStill(asset) && !isRefEdit(asset) && asset.gen.workflow === T2I_WORKFLOW) {
    asset.gen.workflow = REF_EDIT_WORKFLOW;
    asset.gen.workflow_sha256 = workflowShaFor(files, options);
    delete inputs.width;
    delete inputs.height;
    if (inputs.reference === undefined && inputs.image === undefined) {
      inputs.reference = members[0].assetId;
    }
    warnings.push({ code: 'BUILD_WORKFLOW_SWITCHED', field: 'gen.workflow', message: `${asset.gen.workflow} is a reference edit because the scene casts a character` });
  } else if (isKleinStill(asset) && isRefEdit(asset)) {
    if (inputs.reference === undefined && inputs.image === undefined) {
      inputs.reference = members[0].assetId;
    }
  }
  asset.gen.inputs = inputs;
}

function sceneAssetIds(scene) {
  const ids = [];
  if (!isObject(scene)) return ids;
  if (isObject(scene.background) && typeof scene.background.asset === 'string') ids.push(scene.background.asset);
  if (Array.isArray(scene.foreground)) {
    for (const layer of scene.foreground) {
      if (isObject(layer) && typeof layer.asset === 'string') ids.push(layer.asset);
    }
  }
  if (Array.isArray(scene.media)) {
    for (const layer of scene.media) {
      if (isObject(layer) && typeof layer.asset === 'string') ids.push(layer.asset);
    }
  }
  return ids;
}

function sidecar({ pkg, entries, builtByCast, placements, ignored, presenter, voiceSource, roleByCast }) {
  const refByCast = new Map([...builtByCast].map(([castId, built]) => [castId, built]));
  const sceneIdsByCast = new Map();
  for (const placement of placements) {
    if (!sceneIdsByCast.has(placement.castId)) sceneIdsByCast.set(placement.castId, []);
    uniquePush(sceneIdsByCast.get(placement.castId), placement.sceneId);
  }
  const cast = entries.map((entry) => {
    const built = refByCast.get(entry.castId);
    return {
      castId: entry.castId,
      characterId: entry.characterId,
      name: entry.snapshot.name,
      handle: entry.snapshot.handle,
      role: roleByCast?.get(entry.castId) ?? effectiveRole(entry),
      revision: entry.pinnedRevision,
      pinnedRevision: entry.pinnedRevision,
      detached: entry.detached,
      orphaned: entry.orphaned,
      overrides: clone(entry.overrides),
      ...(built ? {
        refAsset: built.assetId,
        ref: `${entry.characterId}@${entry.pinnedRevision}`,
        imageSha256: built.asset.sha256,
        file: built.asset.file,
      } : {}),
      scenes: sceneIdsByCast.get(entry.castId) ?? [],
      snapshot: clone(entry.snapshot),
    };
  });
  return {
    schema: CHARACTERS_SCHEMA,
    ...(typeof pkg.id === 'string' ? { packageId: pkg.id } : {}),
    ...(Number.isSafeInteger(pkg.revision) ? { packageRevision: pkg.revision } : {}),
    cast,
    assets: Object.fromEntries([...refByCast].map(([castId, built]) => [built.assetId, {
      castId,
      characterId: built.entry.characterId,
      revision: built.entry.pinnedRevision,
    }])),
    placements: placements.map((placement) => ({ ...placement })),
    presenter: presenter ? { castId: presenter, characterId: refByCast.get(presenter)?.entry.characterId ?? null } : null,
    voice: voiceSource ? { castId: voiceSource.castId, characterId: voiceSource.entry.characterId } : null,
    ignored: ignored.map((item) => ({ ...item })),
  };
}

export function applyCast(pkgInput, cast = [], placements = [], files = {}, options = {}) {
  if (!isObject(pkgInput)) fail('BUILD_INVALID_INPUT', 'pkg', 'pkg must be a package object');
  if (options === null || options === undefined) options = {};
  if (!isObject(options)) fail('BUILD_INVALID_INPUT', 'options', 'options must be an object');
  let pkg = clone(pkgInput);
  const normalized = normalizeCast(cast);
  const warnings = [];
  const ignored = [...normalized.ignored];
  const scenarios = normalizePlacements(placements, normalized.entries, pkg);
  ignored.push(...scenarios.ignored);
  const fileMap = entriesOfFiles(files);

  if (!normalized.entries.length) {
    const characters = sidecar({
      pkg,
      entries: [],
      builtByCast: new Map(),
      placements: [],
      ignored,
      presenter: null,
      voiceSource: null,
    });
    return {
      pkg,
      package: pkg,
      cast: Array.isArray(pkg.cast) ? pkg.cast : [],
      scenes: Array.isArray(pkg.scenes) ? pkg.scenes : [],
      presenter: isObject(pkg.presenter) ? pkg.presenter : null,
      voice: isObject(pkg.voice) ? pkg.voice : null,
      copies: [],
      copy: [],
      files: [],
      assetCopies: [],
      assets: {},
      characters,
      charactersJson: characters,
      sidecar: characters,
      placements: [],
      ignored,
      warnings,
      errors: [],
      changed: [],
    };
  }

  const built = [];
  const builtByCast = new Map();
  for (const entry of normalized.entries) {
    const image = referenceImage(entry.snapshot);
    if (!image) {
      ignored.push({ castId: entry.castId, reason: 'no reference image' });
      continue;
    }
    const assetId = assetIdFor(image);
    const source = sourceFor(fileMap, entry, image);
    const ext = extensionOf(source);
    const asset = assetFor(entry.snapshot, image, assetId, ext, source);
    const copy = {
      assetId,
      from: source?.path ?? null,
      to: asset.file,
      sha256: asset.sha256,
      characterId: entry.characterId,
      castId: entry.castId,
      imgId: image.imgId,
      ...(source?.bytes !== undefined ? { bytes: source.bytes } : {}),
    };
    const item = { entry, image, assetId, asset, source, copy };
    built.push(item);
    builtByCast.set(entry.castId, item);
  }

  if (built.length) {
    pkg.assets = isObject(pkg.assets) ? pkg.assets : {};
    for (const item of built) {
      if (!pkg.assets[item.assetId]) pkg.assets[item.assetId] = clone(item.asset);
    }
    pkg.cast = built.map(({ entry, assetId }) => ({
      id: entry.castId,
      name: entry.snapshot.name,
      ...(entry.snapshot.summary ? { description: entry.snapshot.summary } : {}),
      ref_asset: assetId,
    }));
  } else {
    delete pkg.cast;
  }

  const placementsByScene = new Map();
  const placementsByCast = new Map();
  const roleByCast = new Map();
  const applied = [];
  const appliedKeys = new Set();
  for (const placement of scenarios.confirmed) {
    if (!builtByCast.has(placement.castId)) {
      ignored.push({ castId: placement.castId, sceneId: placement.sceneId, reason: 'cast member has no reference image' });
      continue;
    }
    const key = `${placement.castId}\u0000${placement.sceneId}`;
    if (appliedKeys.has(key)) {
      ignored.push({ castId: placement.castId, sceneId: placement.sceneId, reason: 'duplicate placement' });
      continue;
    }
    appliedKeys.add(key);
    applied.push(placement);
    placementsByCast.set(placement.castId, placement);
    if (placement.role) roleByCast.set(placement.castId, placement.role);
    if (!placementsByScene.has(placement.sceneId)) placementsByScene.set(placement.sceneId, []);
    uniquePush(placementsByScene.get(placement.sceneId), placement.castId);
  }

  let scenes = Array.isArray(pkg.scenes) ? pkg.scenes : [];
  for (const scene of scenes) {
    if (!isObject(scene)) continue;
    const ids = placementsByScene.get(scene.id);
    if (ids && ids.length) scene.cast = [...ids];
  }

  const stillMembers = new Map();
  for (const scene of scenes) {
    if (!isObject(scene)) continue;
    const castIds = placementsByScene.get(scene.id);
    if (!castIds || !castIds.length) continue;
    for (const assetId of sceneAssetIds(scene)) {
      if (!stillMembers.has(assetId)) stillMembers.set(assetId, []);
      for (const castId of castIds) uniquePush(stillMembers.get(assetId), castId);
    }
  }
  for (const [assetId, castIds] of stillMembers) {
    const asset = pkg.assets?.[assetId];
    if (!isKleinStill(asset)) continue;
    const members = castIds
      .map((castId) => {
        const item = builtByCast.get(castId);
        return item ? { entry: item.entry, assetId: item.assetId } : null;
      })
      .filter(Boolean);
    if (!members.length) continue;
    applyStillPrompt(asset, members, placementsByCast, options, files, warnings);
  }

  let presenter = null;
  const roleOf = (entry) => roleByCast.get(entry.castId) ?? effectiveRole(entry);
  const presenters = built.filter(({ entry }) => roleOf(entry) === 'presenter');
  if (presenters.length) {
    presenter = presenters[0].entry.castId;
    pkg.presenter = {
      ...(isObject(pkg.presenter) ? pkg.presenter : {}),
      cast: presenter,
      portrait: presenter,
    };
  }

  let voiceSource = null;
  const voices = built.filter(({ entry }) => roleOf(entry) === 'narrator');
  voiceSource = voices[0] ?? presenters[0] ?? null;
  if (voiceSource) {
    try {
      pkg.voice = toPackageVoice(voiceSource.entry.snapshot.voice);
    } catch (error) {
      warnings.push({
        code: 'BUILD_VOICE_INVALID',
        field: 'voice',
        message: `character ${voiceSource.entry.snapshot.name} has an invalid voice: ${error.message}`,
      });
      voiceSource = null;
    }
  }

  let voiceDirectionErrors = [];
  if (options.model) {
    const castCharacters = new Map(normalized.entries.map((entry) => [entry.castId, entry.snapshot]));
    const directed = applyH3VoiceDirection(pkg, {
      characters: castCharacters,
      h3VoiceMode: options.h3VoiceMode,
      model: options.model,
    });
    pkg = directed.pkg;
    scenes = Array.isArray(pkg.scenes) ? pkg.scenes : [];
    voiceDirectionErrors = directed.errors;
  }

  const characters = sidecar({
    pkg,
    entries: normalized.entries,
    builtByCast,
    placements: applied,
    ignored,
    presenter,
    voiceSource,
    roleByCast,
  });

  const copies = built.map(({ copy }) => copy);
  const changed = [];
  if (built.length) changed.push('cast');
  if (applied.length) changed.push('scenes.cast');
  if (presenter) changed.push('presenter');
  if (voiceSource) changed.push('voice');
  if (copies.length) changed.push('assets');

  return {
    pkg,
    package: pkg,
    cast: Array.isArray(pkg.cast) ? pkg.cast : [],
    scenes,
    presenter: isObject(pkg.presenter) ? pkg.presenter : null,
    voice: isObject(pkg.voice) ? pkg.voice : null,
    copies,
    copy: copies,
    files: copies,
    assetCopies: copies,
    assets: Object.fromEntries(built.map(({ assetId, asset }) => [assetId, asset])),
    characters,
    charactersJson: characters,
    sidecar: characters,
    placements: applied,
    ignored,
    warnings,
    errors: voiceDirectionErrors,
    changed,
  };
}

export const buildCharacters = applyCast;
export const applyCharacterCast = applyCast;
export const planCast = applyCast;
export const charactersSidecar = (result) => result?.characters ?? null;

export function samePackage(a, b) {
  return isDeepStrictEqual(a, b);
}
