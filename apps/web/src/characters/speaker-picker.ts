/**
 * CCL4d: per-scene speaker picker + agent hint.
 *
 * Pure UI model: no I/O, no clock, no random ids and no side effects at import.
 * It reads the project cast snapshots and the package scenes, resolves the
 * effective speaker/voice the same way CCL4b does, and emits a small patch when
 * the user changes a scene's speaker. The agent only proposes a change; the
 * user confirms it.
 */

import type {
  CastEntry,
  Character,
  CharacterRole,
  CharacterVoice,
} from './api.ts';

export const SPEAKER_PICKER_SCHEMA = 'comfyrizz.speaker-picker/v1';
export const CAST_ID_RE = /^c[A-Za-z0-9_-]{0,63}$/;
export const HANDLE_RE = /^[A-Za-z0-9_-]{1,63}$/;

export const SPEAKER_AGENT_HINT =
  'Default is the narrator. The chat agent can propose a speaker; you confirm the change.';

export const ROLE_LABELS: Record<CharacterRole, string> = {
  presenter: 'Presenter',
  narrator: 'Narrator',
  protagonist: 'Protagonist',
  supporting: 'Supporting',
  mascot: 'Mascot',
  extra: 'Extra',
};

const ROLE_ORDER: CharacterRole[] = [
  'presenter',
  'narrator',
  'protagonist',
  'supporting',
  'mascot',
  'extra',
];

const ROLE_SET = new Set<string>(ROLE_ORDER);

export type SpeakerVoice = CharacterVoice | string | null;

export type SpeakerCastInput =
  | CastEntry
  | Character
  | Record<string, unknown>;

export type SpeakerSceneInput = Record<string, unknown>;

export type SpeakerCastOption = {
  castId: string;
  characterId: string;
  name: string;
  handle: string;
  role: CharacterRole;
  roleLabel: string;
  voice: SpeakerVoice;
  voiceLabel: string;
  engine: string | null;
  voiceName: string | null;
  hasVoice: boolean;
  isNarrator: boolean;
  isPresenter: boolean;
  detached: boolean;
  orphaned: boolean;
  index: number;
};

export type SpeakerWarning = {
  code: string;
  sceneId: string | null;
  speaker?: string;
  message: string;
};

export type SceneSpeakerState = {
  sceneId: string;
  index: number;
  label: string;
  /** Effective speaker shown by the picker (the narrator when unassigned). */
  speaker: string | null;
  selectedSpeakerId: string | null;
  /** True when scene.speaker is present in the project scene. */
  explicit: boolean;
  /** True when the scene relies on the narrator/package default. */
  usesDefault: boolean;
  rawSpeaker: string | null;
  unknownSpeaker: string | null;
  source: 'cast' | 'package';
  voice: SpeakerVoice;
  voiceLabel: string;
  hasVoice: boolean;
  fallbackReason: string;
  hint: string;
};

export type SpeakerPickerState = {
  schema: string;
  cast: SpeakerCastOption[];
  scenes: SceneSpeakerState[];
  defaultSpeakerId: string | null;
  narrator: SpeakerCastOption | null;
  presenter: SpeakerCastOption | null;
  packageVoice: SpeakerVoice;
  packageVoiceLabel: string;
  hint: string;
  agentHint: string;
  warnings: SpeakerWarning[];
  message: string;
  messageError: boolean;
};

export type SpeakerPatch = {
  kind: 'speaker';
  sceneId: string;
  /**
   * The value to write to the scene. `null` means "remove scene.speaker and use
   * the narrator/package default", which is how the optional schema field works.
   */
  speaker: string | null;
  castId: string | null;
  selectedSpeakerId: string | null;
  previousSpeaker: string | null;
  previousSelectedSpeakerId: string | null;
  usesDefault: boolean;
  changed: boolean;
  /** Directly applicable scene patch; `speaker: null` removes the field. */
  scene: { id: string; speaker: string | null };
  hint: string;
};

export type SpeakerPickerConfig = {
  voice?: SpeakerVoice;
  packageVoice?: SpeakerVoice;
  defaultSpeakerId?: string | null;
  narratorId?: string | null;
  onPatch?: (patch: SpeakerPatch, state: SpeakerPickerState) => void;
  onChange?: (state: SpeakerPickerState, patch: SpeakerPatch) => void;
  idPrefix?: string;
  [key: string]: unknown;
};

export type SpeakerPickerListener = (
  state: SpeakerPickerState,
  patch: SpeakerPatch | null,
) => void;

export type RenderSpeakerPickerOptions = {
  idPrefix?: string;
  disabled?: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

function normalizeHandle(value: unknown): string {
  const handle = text(value).replace(/^@/, '').toLowerCase();
  return HANDLE_RE.test(handle) ? handle : '';
}

function roleOf(value: unknown): CharacterRole {
  const role = text(value);
  return ROLE_SET.has(role) ? role as CharacterRole : 'supporting';
}

function normalizeVoice(value: unknown): SpeakerVoice {
  if (typeof value === 'string') {
    const voice = value.trim();
    return voice || null;
  }
  if (!isObject(value) || Object.keys(value).length === 0) return null;
  return clone(value) as unknown as CharacterVoice;
}

function voiceEngine(voice: SpeakerVoice): string | null {
  if (!voice) return null;
  if (typeof voice === 'string') return 'kokoro';
  const engine = text(voice.engine);
  if (engine) return engine;
  return text(voice.voice) ? 'kokoro' : null;
}

function voiceName(voice: SpeakerVoice): string | null {
  if (!voice) return null;
  if (typeof voice === 'string') return voice;
  return text(voice.voice) || null;
}

export function hasUsableVoice(voice: SpeakerVoice): boolean {
  if (!voice) return false;
  if (typeof voice === 'string') return voice.trim() !== '';
  if ((voice as unknown as Record<string, unknown>).enabled === false) return false;
  if (voiceEngine(voice) === 'none') return false;
  return Boolean(voiceName(voice));
}

export function formatVoiceLabel(voice: SpeakerVoice): string {
  if (!hasUsableVoice(voice)) return 'No voice';
  const engine = voiceEngine(voice);
  const name = voiceName(voice) ?? 'default';
  if (engine === 'qwen3-tts') return `Qwen3-TTS · ${name}`;
  if (engine === 'kokoro') return `Kokoro · ${name}`;
  return `${engine ?? 'Voice'} · ${name}`;
}

export function roleLabel(role: unknown): string {
  const key = roleOf(role);
  return ROLE_LABELS[key];
}

function castListOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (isObject(value)) {
    for (const key of ['cast', 'castEntries', 'projectCast', 'characters']) {
      if (Array.isArray(value[key])) return value[key] as unknown[];
    }
    const values = Object.values(value);
    if (values.length > 0 && values.every(isObject)) return values;
  }
  return [];
}

function sceneListOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    for (const key of ['scenes', 'storyboard', 'clips']) {
      if (Array.isArray(value[key])) return value[key] as unknown[];
    }
  }
  return [];
}

function castOptionOf(source: unknown, index: number): SpeakerCastOption | null {
  const record = asRecord(source);
  const snapshot = isObject(record.snapshot) ? record.snapshot : null;
  const overrides = isObject(record.overrides) ? record.overrides : null;

  let castId = text(record.castId) || text(record.cast_id);
  const rawId = text(record.id);
  const idIsCharacter = rawId.startsWith('chr_');
  if (!castId && CAST_ID_RE.test(rawId) && !idIsCharacter) castId = rawId;

  let handle = normalizeHandle(snapshot?.handle ?? record.handle);
  if (!castId && handle) castId = `c_${handle}`;
  if (!castId) return null;
  if (!handle) {
    const derived = castId.startsWith('c_') ? castId.slice(2) : castId;
    handle = normalizeHandle(derived);
  }

  const name = text(snapshot?.name) || text(record.name) || handle || castId;
  const characterId = text(record.characterId)
    || text(record.character_id)
    || text(snapshot?.id)
    || (rawId && (idIsCharacter || !CAST_ID_RE.test(rawId)) ? rawId : '');
  const role = roleOf(overrides?.role ?? snapshot?.role ?? record.role);
  const voice = normalizeVoice(record.voice) ?? normalizeVoice(snapshot?.voice);

  return {
    castId,
    characterId,
    name,
    handle: handle || castId,
    role,
    roleLabel: ROLE_LABELS[role],
    voice,
    voiceLabel: formatVoiceLabel(voice),
    engine: voiceEngine(voice),
    voiceName: voiceName(voice),
    hasVoice: hasUsableVoice(voice),
    isNarrator: role === 'narrator',
    isPresenter: role === 'presenter',
    detached: record.detached === true,
    orphaned: record.orphaned === true,
    index,
  };
}

export function speakerOptions(cast: unknown): SpeakerCastOption[] {
  const seen = new Set<string>();
  const options: SpeakerCastOption[] = [];
  let index = 0;
  for (const source of castListOf(cast)) {
    const option = castOptionOf(source, index);
    if (!option || seen.has(option.castId)) continue;
    seen.add(option.castId);
    options.push(option);
    index += 1;
  }
  return options;
}

function configuredDefault(
  config: SpeakerPickerConfig,
  options: SpeakerCastOption[],
  narrator: SpeakerCastOption | null,
): string | null {
  const byId = new Map(options.map(option => [option.castId, option]));
  for (const key of ['defaultSpeakerId', 'narratorId'] as const) {
    if (!(key in config)) continue;
    const value = config[key];
    if (value === null || value === '') return null;
    const raw = text(value);
    if (!raw) continue;
    if (byId.has(raw)) return raw;
    const handle = normalizeHandle(raw);
    const match = options.find(option => option.handle === handle);
    if (match) return match.castId;
    return narrator?.castId ?? null;
  }
  return narrator?.castId ?? null;
}

function resolveCastRef(
  raw: string,
  options: SpeakerCastOption[],
): SpeakerCastOption | null {
  if (CAST_ID_RE.test(raw)) {
    const match = options.find(option => option.castId === raw);
    if (match) return match;
  }
  const handle = normalizeHandle(raw);
  if (handle) {
    const match = options.find(option => option.handle === handle);
    if (match) return match;
  }
  return options.find(option => option.characterId === raw) ?? null;
}

function sceneHint(scene: {
  sceneId: string;
  voiceLabel: string;
  usesDefault: boolean;
  option: SpeakerCastOption | null;
}): string {
  const who = scene.option
    ? `@${scene.option.handle} (${scene.option.roleLabel})`
    : 'the package narrator';
  const base = `${scene.sceneId} uses ${who} with ${scene.voiceLabel}`;
  return scene.usesDefault ? `${base} (default).` : `${base}.`;
}

function buildSceneStates(
  scenes: unknown,
  options: SpeakerCastOption[],
  defaultSpeakerId: string | null,
  packageVoice: SpeakerVoice,
): { scenes: SceneSpeakerState[]; warnings: SpeakerWarning[] } {
  const byId = new Map(options.map(option => [option.castId, option]));
  const warnings: SpeakerWarning[] = [];
  const list = sceneListOf(scenes);
  const result: SceneSpeakerState[] = [];

  list.forEach((source, index) => {
    const record = asRecord(source);
    const sceneId = text(record.id)
      || text(record.sceneId)
      || text(record.scene_id)
      || `scene_${index + 1}`;
    const label = text(record.label)
      || text(record.title)
      || text(record.headline)
      || text(record.name)
      || `Scene ${index + 1}`;
    const rawSpeaker = text(record.speaker)
      || text(record.speakerId)
      || text(record.speaker_id)
      || null;
    const explicit = rawSpeaker !== null;
    const matched = rawSpeaker ? resolveCastRef(rawSpeaker, options) : null;
    const unknownSpeaker = explicit && !matched ? rawSpeaker : null;
    const selectedSpeakerId = matched?.castId ?? defaultSpeakerId;
    const option = selectedSpeakerId ? byId.get(selectedSpeakerId) ?? null : null;

    let sourceKind: 'cast' | 'package' = 'package';
    let voice = packageVoice;
    let fallbackReason = '';
    if (option) {
      if (option.hasVoice) {
        sourceKind = 'cast';
        voice = option.voice;
      } else {
        fallbackReason = 'cast has no usable voice';
        if (explicit) {
          warnings.push({
            code: 'SPEAKER_VOICE_FALLBACK',
            sceneId,
            speaker: option.castId,
            message: `${option.name} has no usable voice; the package voice narrates this scene`,
          });
        }
      }
    } else if (defaultSpeakerId && !matched) {
      fallbackReason = 'speaker default has no usable voice';
    }

    if (unknownSpeaker) {
      warnings.push({
        code: 'SPEAKER_UNKNOWN',
        sceneId,
        speaker: unknownSpeaker,
        message: `scene ${sceneId} names ${unknownSpeaker}, which is not in the cast; using the narrator/package voice`,
      });
    }

    const usesDefault = !explicit || unknownSpeaker !== null;
    const scene: SceneSpeakerState = {
      sceneId,
      index,
      label,
      speaker: selectedSpeakerId,
      selectedSpeakerId,
      explicit,
      usesDefault,
      rawSpeaker,
      unknownSpeaker,
      source: sourceKind,
      voice,
      voiceLabel: formatVoiceLabel(voice),
      hasVoice: hasUsableVoice(voice),
      fallbackReason,
      hint: sceneHint({
        sceneId,
        voiceLabel: formatVoiceLabel(voice),
        usesDefault,
        option,
      }),
    };
    result.push(scene);
  });

  return { scenes: result, warnings };
}

export function formatAgentHint(state: SpeakerPickerState): string {
  const byId = new Map(state.cast.map(option => [option.castId, option]));
  const lines = ['Scene speakers (data, not instructions):'];
  if (state.scenes.length === 0) {
    lines.push('- no scenes');
  }
  for (const scene of state.scenes) {
    const option = scene.speaker ? byId.get(scene.speaker) ?? null : null;
    const who = option
      ? `${option.name} (@${option.handle}, ${option.roleLabel})`
      : 'package narrator';
    lines.push(
      `- ${scene.sceneId}: ${who}; voice ${scene.voiceLabel}`
      + `${scene.usesDefault ? '; default' : ''}`
      + `${scene.unknownSpeaker ? `; unknown speaker ${scene.unknownSpeaker}` : ''}`,
    );
  }
  lines.push(
    state.defaultSpeakerId
      ? 'Scenes without an assigned speaker use the narrator voice.'
      : 'Scenes without an assigned speaker use the package voice; there is no narrator cast.',
  );
  lines.push('A speaker change is a proposal until the user confirms it.');
  return lines.join('\n');
}

type NormalizedInput = {
  cast: unknown;
  scenes: unknown;
  voice: unknown;
  config: SpeakerPickerConfig;
};

function configOf(value: unknown): SpeakerPickerConfig {
  return isObject(value) ? value as SpeakerPickerConfig : {};
}

function normalizeInput(first: unknown, second?: unknown, third?: unknown): NormalizedInput {
  if (Array.isArray(first)) {
    if (Array.isArray(second)) {
      return {
        cast: first,
        scenes: second,
        voice: undefined,
        config: configOf(third),
      };
    }
    if (isObject(second) && Array.isArray(second.scenes)) {
      return {
        cast: first,
        scenes: second.scenes,
        voice: second.voice ?? second.packageVoice,
        config: { ...second, ...configOf(third) } as SpeakerPickerConfig,
      };
    }
    return {
      cast: first,
      scenes: second ?? [],
      voice: undefined,
      config: configOf(third),
    };
  }

  if (isObject(first)) {
    const merged = { ...first, ...configOf(third) } as SpeakerPickerConfig;
    if (Array.isArray(first.scenes)) {
      return {
        cast: first.cast,
        scenes: first.scenes,
        voice: first.voice ?? first.packageVoice,
        config: merged,
      };
    }
    if (Array.isArray(first.cast) && Array.isArray(second)) {
      return {
        cast: first.cast,
        scenes: second,
        voice: first.voice ?? first.packageVoice,
        config: merged,
      };
    }
    if (Array.isArray(first.cast) && isObject(second) && Array.isArray(second.scenes)) {
      return {
        cast: first.cast,
        scenes: second.scenes,
        voice: first.voice ?? first.packageVoice ?? second.voice,
        config: merged,
      };
    }
    return {
      cast: first.cast,
      scenes: first.scenes ?? [],
      voice: first.voice ?? first.packageVoice,
      config: merged,
    };
  }

  return { cast: [], scenes: [], voice: undefined, config: configOf(second) };
}

export function buildSpeakerPicker(
  first: unknown,
  second?: unknown,
  third?: unknown,
): SpeakerPickerState {
  const input = normalizeInput(first, second, third);
  const config = input.config;
  const options = speakerOptions(input.cast);
  const narrator = options.find(option => option.isNarrator) ?? null;
  const presenter = options.find(option => option.isPresenter) ?? null;
  const packageVoice = normalizeVoice(
    config.voice ?? config.packageVoice ?? input.voice ?? config.packageVoice,
  );
  const defaultSpeakerId = configuredDefault(config, options, narrator);
  const built = buildSceneStates(input.scenes, options, defaultSpeakerId, packageVoice);

  const state: SpeakerPickerState = {
    schema: SPEAKER_PICKER_SCHEMA,
    cast: options,
    scenes: built.scenes,
    defaultSpeakerId,
    narrator,
    presenter,
    packageVoice,
    packageVoiceLabel: formatVoiceLabel(packageVoice),
    hint: SPEAKER_AGENT_HINT,
    agentHint: '',
    warnings: built.warnings,
    message: '',
    messageError: false,
  };
  state.agentHint = formatAgentHint(state);
  return state;
}

type SpeakerTarget = { ok: boolean; castId: string | null };

function speakerTarget(state: SpeakerPickerState, value: unknown): SpeakerTarget {
  if (value === null || value === undefined) return { ok: true, castId: null };
  if (typeof value !== 'string') return { ok: false, castId: null };
  const raw = value.trim();
  if (!raw || raw === 'default' || raw === 'package' || raw === 'auto') {
    return { ok: true, castId: null };
  }
  if (raw === 'narrator') return { ok: true, castId: state.defaultSpeakerId };
  const match = resolveCastRef(raw, state.cast);
  if (match) return { ok: true, castId: match.castId };
  return { ok: false, castId: null };
}

export function sceneSpeakerPatch(
  state: SpeakerPickerState,
  sceneId: string,
  nextSpeaker: unknown,
): SpeakerPatch | null {
  if (!state || !Array.isArray(state.scenes)) {
    throw new TypeError('sceneSpeakerPatch needs a speaker picker state');
  }
  const id = text(sceneId);
  const scene = state.scenes.find(item => item.sceneId === id);
  if (!scene) return null;

  const target = speakerTarget(state, nextSpeaker);
  if (!target.ok) return null;

  const schemaSpeaker = target.castId;
  const previousSpeaker = scene.explicit ? scene.rawSpeaker : null;
  if (!scene.explicit && schemaSpeaker === scene.speaker) return null;
  if (schemaSpeaker === previousSpeaker) return null;

  const option = target.castId
    ? state.cast.find(item => item.castId === target.castId) ?? null
    : null;
  const voiceLabel = option && option.hasVoice ? option.voiceLabel : state.packageVoiceLabel;
  const who = option ? `${option.name} (@${option.handle})` : 'the narrator/package voice';
  const usesDefault = schemaSpeaker === null;

  return {
    kind: 'speaker',
    sceneId: scene.sceneId,
    speaker: schemaSpeaker,
    castId: target.castId,
    selectedSpeakerId: target.castId,
    previousSpeaker,
    previousSelectedSpeakerId: scene.speaker,
    usesDefault,
    changed: true,
    scene: { id: scene.sceneId, speaker: schemaSpeaker },
    hint: `${scene.sceneId} now uses ${who} with ${voiceLabel}.`,
  };
}

function applyToScene<T>(scene: T, patch: SpeakerPatch): T {
  const record = asRecord(scene);
  const id = text(record.id) || text(record.sceneId) || text(record.scene_id);
  if (id !== patch.sceneId) return clone(scene);

  const next = clone(record);
  if (patch.speaker === null) {
    delete next.speaker;
    delete next.speakerId;
    delete next.speaker_id;
    return next as T;
  }
  if ('speaker' in next || (!('speakerId' in next) && !('speaker_id' in next))) {
    next.speaker = patch.speaker;
    delete next.speakerId;
    delete next.speaker_id;
  } else if ('speakerId' in next) {
    next.speakerId = patch.speaker;
  } else {
    next.speaker_id = patch.speaker;
  }
  return next as T;
}

/**
 * Apply an emitted patch without mutating the caller's package/scenes.
 * Accepts a package with `scenes`, a scene array, or one scene object.
 */
export function applySpeakerPatch<T>(target: T, patch: SpeakerPatch): T {
  if (!patch || typeof patch.sceneId !== 'string') {
    throw new TypeError('applySpeakerPatch needs a speaker patch');
  }
  if (Array.isArray(target)) {
    return target.map(scene => applyToScene(scene, patch)) as T;
  }
  if (isObject(target) && Array.isArray(target.scenes)) {
    return {
      ...clone(target),
      scenes: target.scenes.map(scene => applyToScene(scene, patch)),
    } as T;
  }
  if (isObject(target)) return applyToScene(target, patch);
  return target;
}

export class SpeakerPickerController {
  state: SpeakerPickerState;
  listeners: Set<SpeakerPickerListener>;
  destroyed: boolean;
  private sources: { cast: unknown; scenes: unknown; voice: unknown };
  private config: SpeakerPickerConfig;

  constructor(first: unknown, second?: unknown, third?: unknown) {
    const input = normalizeInput(first, second, third);
    this.sources = { cast: input.cast, scenes: input.scenes, voice: input.voice };
    this.config = input.config;
    this.listeners = new Set();
    this.destroyed = false;
    this.state = buildSpeakerPicker(
      input.cast,
      input.scenes,
      { ...this.config, voice: this.config.voice ?? input.voice },
    );
  }

  getState(): SpeakerPickerState {
    return clone(this.state);
  }

  snapshot(): SpeakerPickerState {
    return this.getState();
  }

  subscribe(listener: SpeakerPickerListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private rebuild(): void {
    this.state = buildSpeakerPicker(
      this.sources.cast,
      this.sources.scenes,
      { ...this.config, voice: this.config.voice ?? this.sources.voice },
    );
  }

  setCast(cast: unknown): SpeakerPickerState {
    this.sources.cast = cast;
    this.rebuild();
    return this.getState();
  }

  setScenes(scenes: unknown): SpeakerPickerState {
    this.sources.scenes = scenes;
    this.rebuild();
    return this.getState();
  }

  setVoice(voice: SpeakerVoice): SpeakerPickerState {
    this.sources.voice = voice;
    this.rebuild();
    return this.getState();
  }

  getScene(sceneId: string): SceneSpeakerState | null {
    return this.state.scenes.find(scene => scene.sceneId === sceneId) ?? null;
  }

  setSpeaker(sceneId: string, nextSpeaker: unknown): SpeakerPatch | null {
    if (this.destroyed) return null;
    const patch = sceneSpeakerPatch(this.state, sceneId, nextSpeaker);
    if (!patch) return null;
    this.sources.scenes = applySpeakerPatch(this.sources.scenes, patch);
    this.rebuild();
    const state = this.getState();
    try { this.config.onPatch?.(patch, state); } catch { /* optional observer */ }
    try { this.config.onChange?.(state, patch); } catch { /* optional observer */ }
    for (const listener of Array.from(this.listeners)) {
      try { listener(state, patch); } catch { /* a view must not break the picker */ }
    }
    return patch;
  }

  select(sceneId: string, nextSpeaker: unknown): SpeakerPatch | null {
    return this.setSpeaker(sceneId, nextSpeaker);
  }

  changeSpeaker(sceneId: string, nextSpeaker: unknown): SpeakerPatch | null {
    return this.setSpeaker(sceneId, nextSpeaker);
  }

  setSceneSpeaker(sceneId: string, nextSpeaker: unknown): SpeakerPatch | null {
    return this.setSpeaker(sceneId, nextSpeaker);
  }

  clearSpeaker(sceneId: string): SpeakerPatch | null {
    return this.setSpeaker(sceneId, null);
  }

  render(): string {
    return renderSpeakerPicker(this.getState(), { idPrefix: this.config.idPrefix });
  }

  toHTML(): string {
    return this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
}

function speakerOptionHtml(
  option: SpeakerCastOption,
  selected: boolean,
): string {
  const suffix = option.hasVoice ? '' : ' · no voice';
  const label = `${option.name} · ${option.roleLabel} · ${option.voiceLabel}${suffix}`;
  return `<option value="${escapeHtml(option.castId)}"${selected ? ' selected' : ''} data-has-voice="${option.hasVoice ? 'true' : 'false'}">${escapeHtml(label)}</option>`;
}

export function renderSpeakerPicker(
  state: SpeakerPickerState,
  options: RenderSpeakerPickerOptions = {},
): string {
  if (!state || !Array.isArray(state.scenes)) {
    throw new TypeError('renderSpeakerPicker needs a speaker picker state');
  }
  const prefix = options.idPrefix ?? 'speaker-picker';
  const titleId = `${prefix}-title`;
  const disabled = options.disabled === true || state.cast.length === 0;
  const disabledAttribute = disabled ? ' disabled' : '';

  const rows = state.scenes.map(scene => {
    const selectedId = scene.speaker ?? '';
    const castOptions = state.cast.map(option => speakerOptionHtml(
      option,
      option.castId === selectedId,
    ));
    const defaultOption = state.defaultSpeakerId === null
      ? `<option value=""${selectedId === '' ? ' selected' : ''}>Package narrator · ${escapeHtml(state.packageVoiceLabel)}</option>`
      : '';
    const badges = [
      scene.usesDefault
        ? '<span class="speaker-default" data-speaker-default>Default narrator</span>'
        : '<span class="speaker-assigned" data-speaker-assigned>Assigned</span>',
      scene.unknownSpeaker
        ? `<span class="speaker-warning" data-speaker-unknown>Unknown: ${escapeHtml(scene.unknownSpeaker)}</span>`
        : '',
      scene.fallbackReason
        ? `<span class="speaker-warning" data-speaker-fallback>${escapeHtml(scene.fallbackReason)}</span>`
        : '',
    ].filter(Boolean).join('');
    return `<li class="speaker-scene" data-speaker-row="${escapeHtml(scene.sceneId)}" data-speaker-source="${escapeHtml(scene.source)}" data-speaker-hint="${escapeHtml(scene.hint)}">
      <span class="speaker-scene-label">${escapeHtml(scene.label)}</span>
      <label class="speaker-select-label">
        <span class="speaker-select-caption">Speaker</span>
        <select class="speaker-select" data-speaker-select="${escapeHtml(scene.sceneId)}" aria-label="Speaker for ${escapeHtml(scene.label)}"${disabledAttribute}>
          ${defaultOption}${castOptions.join('')}
        </select>
      </label>
      <span class="speaker-voice" data-speaker-voice="${escapeHtml(scene.voiceLabel)}">${escapeHtml(scene.voiceLabel)}</span>
      <span class="speaker-badges">${badges}</span>
    </li>`;
  }).join('');

  const body = state.scenes.length === 0
    ? '<p class="speaker-empty" data-speaker-empty>No scenes yet. Add scenes before choosing speakers.</p>'
    : state.cast.length === 0
      ? `<ul class="speaker-scenes" data-speaker-scenes>${rows}</ul>
        <p class="speaker-empty" data-speaker-no-cast>No cast in this project yet. Scenes use the package voice.</p>`
      : `<ul class="speaker-scenes" data-speaker-scenes>${rows}</ul>`;

  return `<section class="speaker-picker" data-speaker-picker data-agent-hint="${escapeHtml(state.agentHint)}" aria-labelledby="${escapeHtml(titleId)}">
    <header class="speaker-picker-head">
      <h3 id="${escapeHtml(titleId)}">Speakers per scene</h3>
      <p class="speaker-hint" data-speaker-hint>${escapeHtml(state.hint)}</p>
    </header>
    ${body}
  </section>`;
}

export type SpeakerPickerHandle = {
  controller: SpeakerPickerController;
  render(): void;
  refresh(): SpeakerPickerState;
  destroy(): void;
};

export function mountSpeakerPicker(
  element: HTMLElement,
  first: unknown,
  second?: unknown,
  third?: unknown,
): SpeakerPickerHandle {
  if (!element || typeof element.addEventListener !== 'function') {
    throw new TypeError('mountSpeakerPicker requires an element');
  }
  const controller = new SpeakerPickerController(first, second, third);
  const root = element;
  const render = () => {
    root.innerHTML = renderSpeakerPicker(controller.getState());
  };
  const onChange = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const select = target.closest<HTMLSelectElement>('[data-speaker-select]');
    if (!select || !root.contains(select)) return;
    const sceneId = select.getAttribute('data-speaker-select') ?? '';
    if (!sceneId) return;
    controller.setSpeaker(sceneId, select.value || null);
  };
  const unsubscribe = controller.subscribe(() => render());
  root.addEventListener('change', onChange);
  render();
  return {
    controller,
    render,
    refresh: () => controller.getState(),
    destroy: () => {
      root.removeEventListener('change', onChange);
      unsubscribe();
      controller.destroy();
      root.innerHTML = '';
    },
  };
}

export const speakerPicker = buildSpeakerPicker;
export const buildSpeakerPickerState = buildSpeakerPicker;
export const createSpeakerPicker = (
  first: unknown,
  second?: unknown,
  third?: unknown,
): SpeakerPickerController => new SpeakerPickerController(first, second, third);
export const createSpeakerPickerController = createSpeakerPicker;
export const listSpeakers = speakerOptions;
export const castSpeakers = speakerOptions;
export const resolveDefaultSpeaker = (
  cast: unknown,
  config: SpeakerPickerConfig = {},
): string | null => {
  const options = speakerOptions(cast);
  const narrator = options.find(option => option.isNarrator) ?? null;
  return configuredDefault(config, options, narrator);
};
export const defaultSpeaker = resolveDefaultSpeaker;
export const changeSpeaker = sceneSpeakerPatch;
export const speakerPatch = sceneSpeakerPatch;
export const applyPatch = applySpeakerPatch;
export const agentHint = formatAgentHint;
export const speakerAgentHint = formatAgentHint;
