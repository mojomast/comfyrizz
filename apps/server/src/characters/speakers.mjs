import { createHash } from 'node:crypto';
import { resolvePreset, voiceHash as characterVoiceHash } from './voice.mjs';

export const SPEAKER_PLAN_SCHEMA = 'comfyrizz.tts-speaker-plan/v1';
export const SPEAKER_PLAN_VERSION = 1;
export const TTS_JOB_KIND = 'tts';
export const VOICE_SOURCES = Object.freeze(['cast', 'package']);
export const CAST_ID_RE = /^c[A-Za-z0-9_-]{0,63}$/;
export const VOICE_HASH_RE = /^[0-9a-f]{16,64}$/;
export const SEGMENT_HASH_VERSION = 'comfyrizz.voice-segment/v1';
export const FALLBACK_HASH_VERSION = 'comfyrizz.speaker-voice/v1';

const METADATA_FIELDS = new Set([
  'presetId',
  'sampleLines',
  'audition',
  'voiceHash',
  'voice_hash',
  'speaker',
  'castId',
  'cast_id',
  'sceneId',
  'scene_id',
]);

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_RE, '').trim();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function isPackage(value) {
  return isObject(value) && Array.isArray(value.scenes);
}

function looksLikeScene(value) {
  return isObject(value) && !Array.isArray(value.scenes) && (
    typeof value.narration === 'string'
    || typeof value.narration_spoken === 'string'
    || typeof value.spoken_text === 'string'
    || typeof value.speaker === 'string'
    || typeof value.id === 'string'
  );
}

function castArray(value) {
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    for (const key of ['cast', 'castEntries', 'projectCast']) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

function castIdOf(entry) {
  if (!isObject(entry)) return '';
  for (const key of ['castId', 'cast_id', 'id']) {
    const value = cleanText(entry[key]);
    if (value && CAST_ID_RE.test(value)) return value;
  }
  const handle = cleanText(entry.snapshot?.handle ?? entry.handle);
  if (handle && /^[A-Za-z0-9_-]{1,63}$/.test(handle)) return `c_${handle}`;
  return '';
}

function rawCastVoice(entry) {
  if (!isObject(entry)) return undefined;
  for (const value of [
    entry.voice,
    entry.snapshot?.voice,
    entry.character?.voice,
    entry.snapshot?.snapshot?.voice,
  ]) {
    if (isObject(value) && Object.keys(value).length > 0) return clone(value);
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function usableVoice(value) {
  if (typeof value === 'string') return value.trim() !== '';
  return isObject(value) && Object.keys(value).length > 0;
}

function expandVoice(value) {
  if (!isObject(value)) return value;
  const presetId = value.presetId;
  if (typeof presetId !== 'string' || presetId.trim() === '') return { ...value };
  let preset;
  try {
    preset = resolvePreset(presetId);
  } catch {
    return { ...value };
  }
  return { ...preset, ...value };
}

function preserveVoice(value, fallback) {
  const raw = expandVoice(value);
  if (!usableVoice(raw)) return null;
  if (typeof raw === 'string') {
    return Object.freeze({ enabled: true, engine: 'kokoro', voice: raw });
  }
  const engine = cleanText(raw.engine)
    || (raw.enabled === false ? 'none' : cleanText(fallback?.engine) || 'kokoro');
  const voiceName = cleanText(raw.voice) || (engine === 'none' ? '' : cleanText(fallback?.voice));
  if (engine !== 'none' && !voiceName) return null;
  const out = {};
  for (const [key, item] of Object.entries(raw)) {
    if (METADATA_FIELDS.has(key) || item === undefined) continue;
    out[key] = clone(item);
  }
  out.engine = engine;
  out.enabled = engine !== 'none' && raw.enabled !== false;
  if (voiceName) out.voice = voiceName;
  if (engine === 'none' && raw.enabled === undefined) out.enabled = false;
  return deepFreeze(out);
}

function fallbackVoice(value) {
  const voice = preserveVoice(value, undefined);
  return voice ?? deepFreeze({ enabled: false, engine: 'none' });
}

export function voiceHash(input) {
  let value = input;
  if (isObject(value) && isObject(value.voice) && value.sceneId !== undefined) value = value.voice;
  if (isObject(value) && isObject(value.spec)) value = value.spec;
  if (typeof value === 'string') value = { enabled: true, engine: 'kokoro', voice: value };
  if (!isObject(value)) throw new TypeError('voiceHash needs a voice object');
  try {
    return characterVoiceHash(value);
  } catch {
    const effective = {};
    for (const key of Object.keys(value).sort()) {
      if (METADATA_FIELDS.has(key)) continue;
      if (key === 'enabled') continue;
      effective[key] = value[key];
    }
    return createHash('sha256')
      .update(`${FALLBACK_HASH_VERSION}\n${JSON.stringify(canonical(effective))}`)
      .digest('hex')
      .slice(0, 16);
  }
}

function effectiveVoice(value, fallback) {
  const direct = preserveVoice(value, fallback);
  if (direct) return direct;
  if (!usableVoice(value)) return fallback;
  return fallback;
}

function sceneSpeaker(scene) {
  if (!isObject(scene)) return '';
  for (const key of ['speaker', 'speakerId', 'speaker_id', 'castId', 'cast_id']) {
    const value = cleanText(scene[key]);
    if (value) return value;
  }
  return '';
}

function narrationTexts(scene) {
  const display = cleanText(scene?.narration);
  const spoken = cleanText(scene?.narration_spoken) || cleanText(scene?.spoken_text) || display;
  return { display, spoken };
}

function sceneStyle(scene) {
  return cleanText(scene?.narration_style) || null;
}

function castVoicesFrom(pkg, options) {
  const map = new Map();
  const add = (entry, source) => {
    const id = castIdOf(entry);
    if (!id || map.has(id)) return;
    map.set(id, { voice: rawCastVoice(entry), source });
  };
  for (const entry of castArray(pkg?.cast)) add(entry, 'cast');
  for (const entry of castArray(options)) add(entry, 'options');
  for (const entry of castArray(options?.cast ?? options?.castEntries ?? options?.projectCast)) {
    add(entry, 'options');
  }
  if (isObject(options?.voices)) {
    for (const [id, raw] of Object.entries(options.voices)) {
      if (!CAST_ID_RE.test(id) || !usableVoice(raw) || map.has(id)) continue;
      map.set(id, { voice: clone(raw), source: 'options' });
    }
  }
  return map;
}

function contextOf(pkg, options) {
  const opts = isObject(options) ? options : {};
  const rawPackageVoice = pkg?.voice ?? opts.voice ?? opts.packageVoice ?? opts.defaultVoice;
  const defaultVoice = fallbackVoice(rawPackageVoice);
  const warnings = [];
  return {
    pkg,
    options: opts,
    defaultVoice,
    defaultVoiceHash: voiceHash(defaultVoice),
    castVoices: castVoicesFrom(pkg, opts),
    warnings,
  };
}

function normalizeArguments(first, second, third) {
  if (Array.isArray(first)) {
    if (isPackage(second)) {
      return { pkg: second, options: { cast: first, ...(isObject(third) ? third : {}) } };
    }
    return { pkg: { cast: first, scenes: [] }, options: isObject(third) ? third : {} };
  }
  if (isPackage(first)) {
    if (looksLikeScene(second)) {
      if (Array.isArray(third)) return { pkg: first, options: { cast: third } };
      return { pkg: first, options: isObject(third) ? third : {} };
    }
    if (Array.isArray(second)) {
      return { pkg: first, options: { cast: second, ...(isObject(third) ? third : {}) } };
    }
    return { pkg: first, options: isObject(second) ? second : {} };
  }
  if (looksLikeScene(first)) {
    if (isPackage(second)) {
      if (Array.isArray(third)) return { pkg: second, options: { cast: third } };
      return { pkg: second, options: isObject(third) ? third : {} };
    }
    if (Array.isArray(second)) return { pkg: { cast: second, scenes: [] }, options: isObject(third) ? third : {} };
    return { pkg: isObject(second) ? second : { scenes: [] }, options: isObject(third) ? third : {} };
  }
  return { pkg: isObject(first) ? first : { scenes: [] }, options: isObject(second) ? second : {} };
}

function resolveOne(scene, index, ctx) {
  const speaker = sceneSpeaker(scene);
  const cast = speaker ? ctx.castVoices.get(speaker) : null;
  let source = 'package';
  let voice = ctx.defaultVoice;
  let reason = null;
  if (speaker && cast && usableVoice(cast.voice)) {
    const chosen = effectiveVoice(cast.voice, ctx.defaultVoice);
    if (chosen !== ctx.defaultVoice) {
      source = 'cast';
      voice = chosen;
    } else {
      reason = 'cast voice is not usable';
    }
  } else if (speaker && cast) {
    reason = 'cast has no voice';
  } else if (speaker) {
    reason = 'unknown speaker';
    ctx.warnings.push({
      code: 'SPEAKER_UNKNOWN',
      sceneId: cleanText(scene?.id) || null,
      speaker,
      message: `scene ${cleanText(scene?.id) || index} names ${speaker}, which has no cast voice; using the package voice`,
    });
  }
  const texts = narrationTexts(scene);
  return {
    sceneId: cleanText(scene?.id) || null,
    index,
    speaker: speaker || null,
    castId: speaker || null,
    source,
    reason,
    voice,
    spec: voice,
    voiceHash: voiceHash(voice),
    engine: voice.engine ?? null,
    voiceName: voice.voice ?? null,
    narrationStyle: sceneStyle(scene),
    displayText: texts.display,
    spokenText: texts.spoken,
    hasNarration: texts.spoken !== '',
    warnings: [],
  };
}

function freezeResolution(item) {
  return deepFreeze({
    ...item,
    voice: deepFreeze(clone(item.voice)),
    spec: deepFreeze(clone(item.voice)),
  });
}

export function createSpeakerContext(pkgOrOptions, options) {
  const normalized = normalizeArguments(pkgOrOptions, options);
  return contextOf(normalized.pkg, normalized.options);
}

export function resolveSceneVoice(first, second, third) {
  let scene;
  let ctx;
  if (looksLikeScene(first) && !isPackage(first)) {
    scene = first;
    const normalized = normalizeArguments(first, second, third);
    ctx = contextOf(normalized.pkg, normalized.options);
  } else {
    const normalized = normalizeArguments(first, second, third);
    scene = second;
    ctx = contextOf(normalized.pkg, normalized.options);
  }
  if (!isObject(scene)) throw new TypeError('resolveSceneVoice needs a scene object');
  const item = resolveOne(scene, 0, ctx);
  item.warnings = ctx.warnings;
  return freezeResolution(item);
}

export const resolveVoice = resolveSceneVoice;
export const sceneVoice = resolveSceneVoice;
export const speakerVoice = resolveSceneVoice;

export function resolveSceneVoices(first, second, third) {
  const normalized = normalizeArguments(first, second, third);
  const ctx = contextOf(normalized.pkg, normalized.options);
  const scenes = Array.isArray(normalized.pkg.scenes) ? normalized.pkg.scenes : [];
  const list = scenes.map((scene, index) => freezeResolution(resolveOne(scene, index, ctx)));
  const byScene = {};
  for (const item of list) {
    if (item.sceneId) byScene[item.sceneId] = item;
  }
  Object.defineProperties(list, {
    byScene: { value: deepFreeze(byScene), enumerable: false },
    warnings: { value: deepFreeze(ctx.warnings.map((warning) => ({ ...warning }))), enumerable: false },
    defaultVoice: { value: ctx.defaultVoice, enumerable: false },
    defaultVoiceHash: { value: ctx.defaultVoiceHash, enumerable: false },
  });
  return deepFreeze(list);
}

export function resolveSceneVoiceMap(first, second, third) {
  const list = resolveSceneVoices(first, second, third);
  const map = {};
  for (const item of list) {
    if (item.sceneId) map[item.sceneId] = item;
  }
  return deepFreeze(map);
}

export const sceneVoiceMap = resolveSceneVoiceMap;

function segmentFor(items, index) {
  const first = items[0];
  const firstId = first.sceneId || `scene_${first.index + 1}`;
  const sceneIds = items.map((item) => item.sceneId);
  const speakers = [];
  for (const item of items) {
    if (item.speaker && !speakers.includes(item.speaker)) speakers.push(item.speaker);
  }
  const scenes = items.map((item) => ({
    sceneId: item.sceneId,
    index: item.index,
    speaker: item.speaker,
    castId: item.castId,
    narrationStyle: item.narrationStyle,
    text: item.displayText,
    spokenText: item.spokenText,
    voiceHash: item.voiceHash,
  }));
  const displayText = items.map((item) => item.displayText).filter(Boolean).join(' ');
  const spokenText = items.map((item) => item.spokenText).filter(Boolean).join(' ');
  const styles = [];
  for (const item of items) {
    if (item.narrationStyle && !styles.includes(item.narrationStyle)) styles.push(item.narrationStyle);
  }
  const id = `tts_${firstId}`;
  const base = {
    id,
    jobId: id,
    segmentId: id,
    index,
    kind: TTS_JOB_KIND,
    batch: 'audio',
    sceneId: first.sceneId,
    sceneIds,
    scenes,
    speaker: speakers.length === 1 ? speakers[0] : null,
    castId: speakers.length === 1 ? speakers[0] : null,
    speakers,
    source: first.source,
    voice: first.voice,
    spec: first.voice,
    voiceHash: first.voiceHash,
    engine: first.voice.engine ?? null,
    voiceName: first.voice.voice ?? null,
    text: spokenText,
    spokenText,
    displayText,
    narrationStyle: styles.length === 1 ? styles[0] : null,
    styles,
    textLength: Array.from(spokenText).length,
  };
  return deepFreeze({ ...base, segmentHash: segmentHash(base) });
}

function isVoiced(voice) {
  return Boolean(voice) && voice.enabled !== false && voice.engine !== 'none';
}

function buildSegments(resolutions, options) {
  const includeSilent = options?.includeSilent === true;
  const groupBySpeaker = options?.groupBySpeaker === true;
  const segments = [];
  let current = [];
  let key = null;
  const flush = () => {
    if (!current.length) return;
    const segment = segmentFor(current, segments.length);
    if (isVoiced(segment.voice) || includeSilent) segments.push(segment);
    current = [];
    key = null;
  };
  for (const item of resolutions) {
    if (!item.hasNarration && !includeSilent) continue;
    if (!includeSilent && !isVoiced(item.voice)) continue;
    const nextKey = groupBySpeaker
      ? `${item.voiceHash}\u0000${item.speaker ?? ''}`
      : item.voiceHash;
    if (current.length && nextKey !== key) flush();
    if (!current.length) key = nextKey;
    current.push(item);
  }
  flush();
  return segments;
}

function attachPlanMeta(list, meta) {
  for (const [name, value] of Object.entries(meta)) {
    Object.defineProperty(list, name, {
      value,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return deepFreeze(list);
}

export function planVoiceSegments(first, second, third) {
  const normalized = normalizeArguments(first, second, third);
  const ctx = contextOf(normalized.pkg, normalized.options);
  const scenes = Array.isArray(normalized.pkg.scenes) ? normalized.pkg.scenes : [];
  const resolutions = scenes.map((scene, index) => freezeResolution(resolveOne(scene, index, ctx)));
  const segments = buildSegments(resolutions, normalized.options);
  const warnings = ctx.warnings.map((warning) => ({ ...warning }));
  const plan = {
    schema: SPEAKER_PLAN_SCHEMA,
    version: SPEAKER_PLAN_VERSION,
    packageId: cleanText(normalized.pkg.id) || null,
    revision: Number.isSafeInteger(normalized.pkg.revision) ? normalized.pkg.revision : null,
    enabled: isVoiced(ctx.defaultVoice),
    defaultVoice: ctx.defaultVoice,
    defaultVoiceHash: ctx.defaultVoiceHash,
    scenes: resolutions,
    segments,
    jobs: segments,
    warnings,
  };
  const result = attachPlanMeta(segments, {
    plan,
    schema: SPEAKER_PLAN_SCHEMA,
    version: SPEAKER_PLAN_VERSION,
    packageId: plan.packageId,
    revision: plan.revision,
    enabled: plan.enabled,
    voice: ctx.defaultVoice,
    voiceHash: ctx.defaultVoiceHash,
    segments,
    jobs: segments,
    scenes: deepFreeze(resolutions),
    warnings: deepFreeze(warnings.map((warning) => ({ ...warning }))),
    defaultVoice: ctx.defaultVoice,
    defaultVoiceHash: ctx.defaultVoiceHash,
  });
  deepFreeze(plan);
  return result;
}

export const planSegments = planVoiceSegments;
export const groupVoiceSegments = planVoiceSegments;
export const speakerSegments = planVoiceSegments;
export const planSpeakerSegments = planVoiceSegments;
export const voiceSegments = planVoiceSegments;

export function planTtsJobs(first, second, third) {
  return planVoiceSegments(first, second, third);
}

export const planTts = planTtsJobs;
export const planSpeakerJobs = planTtsJobs;
export const planVoiceJobs = planTtsJobs;
export const buildTtsJobs = planTtsJobs;

export function buildTtsPlan(first, second, third) {
  const normalized = normalizeArguments(first, second, third);
  const ctx = contextOf(normalized.pkg, normalized.options);
  const scenes = Array.isArray(normalized.pkg.scenes) ? normalized.pkg.scenes : [];
  const resolutions = scenes.map((scene, index) => freezeResolution(resolveOne(scene, index, ctx)));
  const segments = buildSegments(resolutions, normalized.options);
  return deepFreeze({
    schema: SPEAKER_PLAN_SCHEMA,
    version: SPEAKER_PLAN_VERSION,
    packageId: cleanText(normalized.pkg.id) || null,
    revision: Number.isSafeInteger(normalized.pkg.revision) ? normalized.pkg.revision : null,
    enabled: isVoiced(ctx.defaultVoice),
    defaultVoice: ctx.defaultVoice,
    defaultVoiceHash: ctx.defaultVoiceHash,
    scenes: resolutions,
    segments,
    jobs: segments,
    warnings: ctx.warnings.map((warning) => ({ ...warning })),
  });
}

export const ttsPlan = buildTtsPlan;
export const makeTtsPlan = buildTtsPlan;
export const speakerPlan = buildTtsPlan;
export const planSpeakers = buildTtsPlan;

export function segmentHash(segment) {
  if (!isObject(segment)) throw new TypeError('segmentHash needs a voice segment');
  const voice = typeof segment.voiceHash === 'string'
    ? segment.voiceHash
    : voiceHash(segment.voice ?? segment.spec ?? {});
  const sceneIds = Array.isArray(segment.sceneIds)
    ? segment.sceneIds
    : (Array.isArray(segment.scenes)
      ? segment.scenes.map((scene) => (typeof scene === 'string' ? scene : scene?.sceneId))
      : []);
  const text = cleanText(segment.spokenText ?? segment.text);
  return createHash('sha256')
    .update(`${SEGMENT_HASH_VERSION}\n${voice}\n${sceneIds.map((id) => id ?? '').join(',')}\n${text}`)
    .digest('hex')
    .slice(0, 16);
}
