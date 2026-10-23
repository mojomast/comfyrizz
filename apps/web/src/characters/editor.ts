/**
 * Character editor drawer (CC11).
 *
 * Six collapsible sections: Identity, Look, Wardrobe, Expressions, Voice and
 * Bible. The editor is a plain state machine with an injected API, clock-free
 * and side-effect free at import, so the tests can drive it with a fake API and
 * no DOM. Autosave happens on blur through `saveField`/`blurField`, which
 * patches only the field that changed.
 */

import type {
  Character,
  CharacterBible,
  CharacterImage,
  CharacterInput,
  CharacterPatch,
  CharacterRole,
  CharacterVisual,
  CharacterVoice,
  ExpressionItem,
  WardrobeItem,
} from './api.ts';

export const EDITOR_SECTIONS = Object.freeze([
  { id: 'identity', title: 'Identity' },
  { id: 'look', title: 'Look' },
  { id: 'voice', title: 'Voice' },
  { id: 'bible', title: 'Bible' },
] as const);

export const SECTION_IDS = Object.freeze(EDITOR_SECTIONS.map(section => section.id));
export const SECTIONS = EDITOR_SECTIONS;

export const FICTIONAL_NOTICE =
  'This is a fictional character, not a real person. Real people and user photos are not supported.';

export const IMAGE_VIEWS = Object.freeze([
  'front',
  'three_quarter',
  'side',
  'back',
  'expression',
  'full_body',
  'other',
] as const);

export const IMAGE_VIEW_LABELS: Record<string, string> = {
  front: 'Front',
  three_quarter: 'Three-quarter',
  side: 'Side',
  back: 'Back',
  expression: 'Expression',
  full_body: 'Full body',
  other: 'Other',
};

export const CHARACTER_ROLES: readonly CharacterRole[] = Object.freeze([
  'presenter',
  'narrator',
  'protagonist',
  'supporting',
  'mascot',
  'extra',
]);

export const ROLE_LABELS: Record<CharacterRole, string> = {
  presenter: 'Presenter',
  narrator: 'Narrator',
  protagonist: 'Protagonist',
  supporting: 'Supporting',
  mascot: 'Mascot',
  extra: 'Extra',
};

export const MAX_SAMPLE_LINES = 5;
export const MAX_SAMPLE_LINE_CHARS = 200;

export type CharacterDraft = {
  name: string;
  handle: string;
  role: CharacterRole;
  kind: 'fictional';
  summary: string;
  visual: CharacterVisual;
  voice: CharacterVoice;
  bible: CharacterBible;
  tags: string[];
};

export type VoiceOption = {
  id: string;
  label: string;
  language?: string;
};

export type VoicePreset = {
  id: string;
  label: string;
  voice?: Record<string, unknown>;
};

export type VoiceOptions = {
  version?: number;
  presets: VoicePreset[];
  kokoroVoices: VoiceOption[];
  qwenSpeakers: VoiceOption[];
  capabilities?: Record<string, unknown>;
};

export type AuditionState = {
  disabled: boolean;
  reason: string;
  label: string;
};

export type AuditionStatus = {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  message: string;
  file: string;
  url: string;
};

export type CharacterEditorState = {
  character: Character | null;
  draft: CharacterDraft;
  mode: 'create' | 'edit';
  fictional: boolean;
  dirty: boolean;
  saving: boolean;
  revision: number;
  message: string;
  messageError: boolean;
  voiceOptions: VoiceOptions;
  voiceOptionsLoaded: boolean;
  voiceOptionsError: string;
  audition: AuditionStatus;
  imageUrls: Record<string, string>;
  qwenAvailable: boolean;
};

export type CharacterEditorApi = {
  get?: (id: string, signal?: AbortSignal) => Promise<Character>;
  create?: (input: CharacterInput, options?: { fictional?: boolean }) => Promise<Character>;
  update?: (
    id: string,
    patch: CharacterPatch,
    options?: { signal?: AbortSignal },
  ) => Promise<Character>;
  patch?: (
    id: string,
    patch: CharacterPatch,
    options?: { signal?: AbortSignal },
  ) => Promise<Character>;
  remove?: (id: string, signal?: AbortSignal) => Promise<void>;
  delete?: (id: string, signal?: AbortSignal) => Promise<void>;
  uploadImage?: (
    id: string,
    file: unknown,
    options?: Record<string, unknown>,
  ) => Promise<{ image?: CharacterImage; character?: Character }>;
  voiceOptions?: (signal?: AbortSignal) => Promise<VoiceOptions | Record<string, unknown>>;
  getVoiceOptions?: (signal?: AbortSignal) => Promise<VoiceOptions | Record<string, unknown>>;
  audition?: (
    character: unknown,
    line?: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  thumb?: (id: string, imgId: string, signal?: AbortSignal) => Promise<Blob>;
  imageFile?: (id: string, imgId: string, signal?: AbortSignal) => Promise<Blob>;
  [key: string]: unknown;
};

export type CharacterEditorOptions = {
  api: CharacterEditorApi;
  character?: Character | null;
  initial?: Character | null;
  value?: Character | null;
  id?: string;
  characterId?: string;
  fictional?: boolean;
  voiceOptions?: Partial<VoiceOptions> | null;
  loadVoiceOptions?: ((signal?: AbortSignal) => Promise<VoiceOptions | Record<string, unknown>>) | null;
  fetchVoiceOptions?: ((signal?: AbortSignal) => Promise<VoiceOptions | Record<string, unknown>>) | null;
  apiFetch?: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null;
  audition?: ((
    character: unknown,
    line?: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>) | null;
  qwenAvailable?: boolean;
  onChange?: (state: CharacterEditorState) => void;
};

type Listener = (state: CharacterEditorState) => void;

const ARRAY_PATHS = new Set([
  'tags',
  'visual.palette',
  'visual.wardrobe',
  'visual.expressions',
  'visual.images',
  'voice.sampleLines',
  'voice.blend',
  'bible.mannerisms',
  'bible.catchphrases',
  'bible.do',
  'bible.dont',
]);

const NUMBER_PATHS = new Set(['visual.seed', 'voice.speed']);
const BOOLEAN_PATHS = new Set<string>();

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function blankVisual(): CharacterVisual {
  return {
    identityPrompt: '',
    negative: '',
    style: '',
    palette: [],
    wardrobe: [],
    expressions: [],
    images: [],
    sheet: { status: 'none' },
    seed: null,
    identity: { method: 'klein_ref' },
  };
}

export function blankVoice(): CharacterVoice {
  return { engine: 'none', sampleLines: [] };
}

export function blankBible(): CharacterBible {
  return {
    personality: '',
    mannerisms: [],
    catchphrases: [],
    speakingStyle: '',
    do: [],
    dont: [],
    notes: '',
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function blankDraft(): CharacterDraft {
  return {
    name: '',
    handle: '',
    role: 'mascot',
    kind: 'fictional',
    summary: '',
    visual: blankVisual(),
    voice: blankVoice(),
    bible: blankBible(),
    tags: [],
  };
}

export function draftFromCharacter(character: Character): CharacterDraft {
  const visual: Record<string, unknown> = isPlainObject(character?.visual) ? character.visual : {};
  const voice: Record<string, unknown> = isPlainObject(character?.voice) ? character.voice : {};
  const bible: Record<string, unknown> = isPlainObject(character?.bible) ? character.bible : {};
  return {
    name: asString(character?.name),
    handle: asString(character?.handle),
    role: character?.role && CHARACTER_ROLES.includes(character.role) ? character.role : 'mascot',
    kind: 'fictional',
    summary: asString(character?.summary),
    visual: {
      ...blankVisual(),
      ...clone(visual),
      palette: asArray<string>(visual.palette),
      wardrobe: asArray<WardrobeItem>(visual.wardrobe),
      expressions: asArray<ExpressionItem>(visual.expressions),
      images: asArray<CharacterImage>(visual.images),
      sheet: isPlainObject(visual.sheet) ? { ...visual.sheet } : { status: 'none' },
      identity: isPlainObject(visual.identity) ? { ...visual.identity } : { method: 'klein_ref' },
      seed: typeof visual.seed === 'number' ? visual.seed : null,
    } as CharacterVisual,
    voice: {
      ...blankVoice(),
      ...clone(voice),
      sampleLines: asArray<string>(voice.sampleLines).map(String).slice(0, MAX_SAMPLE_LINES),
    } as CharacterVoice,
    bible: {
      ...blankBible(),
      ...clone(bible),
      mannerisms: asArray<string>(bible.mannerisms).map(String),
      catchphrases: asArray<string>(bible.catchphrases).map(String),
      do: asArray<string>(bible.do).map(String),
      dont: asArray<string>(bible.dont).map(String),
    } as CharacterBible,
    tags: asArray<string>(character?.tags).map(String),
  };
}

function splitLines(value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(Boolean);
}

function normalizeValue(path: string, value: unknown): unknown {
  if (ARRAY_PATHS.has(path)) {
    if (Array.isArray(value)) {
      if (path === 'visual.images' || path === 'visual.wardrobe' || path === 'visual.expressions' || path === 'voice.blend') {
        return clone(value);
      }
      return value.map(item => String(item).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      if (path === 'visual.palette') {
        return value.split(/[,\n]/).map(item => item.trim()).filter(Boolean).slice(0, 6);
      }
      return splitLines(value);
    }
    return [];
  }
  if (NUMBER_PATHS.has(path)) {
    if (value === '' || value === null || value === undefined) return path === 'visual.seed' ? null : undefined;
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (BOOLEAN_PATHS.has(path)) return Boolean(value);
  if (typeof value === 'string') {
    if (path === 'handle') return value.trim().replace(/^@/, '').toLowerCase();
    if (path === 'name' || path === 'summary') return value.trim();
    return value;
  }
  return value;
}

function pathValue(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]!;
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function nestedPatch(path: string, value: unknown): CharacterPatch {
  const parts = path.split('.');
  if (parts.length === 1) return { [parts[0]!]: value } as CharacterPatch;
  const top = parts[0]!;
  const nested: Record<string, unknown> = {};
  setPath(nested, parts.slice(1).join('.'), value);
  return { [top]: nested } as CharacterPatch;
}

function sameValue(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 400);
  const text = String(error ?? '').trim();
  return text ? text.slice(0, 400) : 'The character could not be saved.';
}

function method<T extends (...args: never[]) => unknown>(
  source: Record<string, unknown> | null | undefined,
  names: string[],
): T | null {
  if (!source) return null;
  for (const name of names) {
    const candidate = source[name];
    if (typeof candidate === 'function') return candidate.bind(source) as T;
  }
  return null;
}

function normalizeVoiceOption(value: unknown): VoiceOption | null {
  if (typeof value === 'string') return value.trim() ? { id: value.trim(), label: value.trim() } : null;
  if (!isPlainObject(value)) return null;
  const id = asString(value.id ?? value.voice ?? value.name).trim();
  if (!id) return null;
  return {
    id,
    label: asString(value.label ?? value.name ?? id) || id,
    ...(typeof value.language === 'string' ? { language: value.language } : {}),
  };
}

export function normalizeVoiceOptions(value: unknown): VoiceOptions {
  const source = isPlainObject(value) ? value : {};
  const presets = asArray<unknown>(source.presets)
    .map(item => {
      if (!isPlainObject(item)) return null;
      const id = asString(item.id).trim();
      if (!id) return null;
      return {
        id,
        label: asString(item.label) || id,
        ...(isPlainObject(item.voice) ? { voice: clone(item.voice) } : {}),
      } as VoicePreset;
    })
    .filter((item): item is VoicePreset => item !== null);
  const kokoro = asArray<unknown>(source.kokoroVoices ?? source.voices)
    .map(normalizeVoiceOption)
    .filter((item): item is VoiceOption => item !== null);
  const qwen = asArray<unknown>(source.qwenSpeakers ?? source.speakers)
    .map(normalizeVoiceOption)
    .filter((item): item is VoiceOption => item !== null);
  return {
    ...(Number.isSafeInteger(source.version) ? { version: Number(source.version) } : {}),
    presets,
    kokoroVoices: kokoro,
    qwenSpeakers: qwen,
    ...(isPlainObject(source.capabilities) ? { capabilities: clone(source.capabilities) } : {}),
  };
}

export function emptyEditorState(overrides: Partial<CharacterEditorState> = {}): CharacterEditorState {
  return {
    character: null,
    draft: blankDraft(),
    mode: 'create',
    fictional: false,
    dirty: false,
    saving: false,
    revision: 0,
    message: '',
    messageError: false,
    voiceOptions: normalizeVoiceOptions(null),
    voiceOptionsLoaded: false,
    voiceOptionsError: '',
    audition: { status: 'idle', message: '', file: '', url: '' },
    imageUrls: {},
    qwenAvailable: false,
    ...overrides,
  };
}

function voicePatchFromPreset(preset: VoicePreset): Partial<CharacterVoice> {
  const source = isPlainObject(preset.voice) ? preset.voice : {};
  const voice: Partial<CharacterVoice> = {};
  if (source.engine === 'kokoro' || source.engine === 'qwen3-tts' || source.engine === 'none') {
    voice.engine = source.engine;
  }
  if (typeof source.voice === 'string') voice.voice = source.voice;
  if (typeof source.speed === 'number' && Number.isFinite(source.speed)) voice.speed = source.speed;
  if (Array.isArray(source.blend)) voice.blend = clone(source.blend) as CharacterVoice['blend'];
  if (source.chunking === 'sentence' || source.chunking === 'paragraph') voice.chunking = source.chunking;
  if (source.qwen_mode === 'custom' || source.qwen_mode === 'design') voice.qwen_mode = source.qwen_mode;
  if (typeof source.delivery === 'string') voice.delivery = source.delivery;
  if (typeof source.persona === 'string') voice.persona = source.persona;
  if (source.language === 'en-us') voice.language = 'en-us';
  return voice;
}

function editableSnapshot(draft: CharacterDraft): CharacterInput {
  return {
    name: draft.name,
    handle: draft.handle,
    role: draft.role,
    kind: 'fictional',
    summary: draft.summary,
    visual: clone(draft.visual),
    voice: clone(draft.voice),
    bible: clone(draft.bible),
    tags: clone(draft.tags),
  };
}

function imageList(character: Character | null, draft: CharacterDraft): CharacterImage[] {
  const images = character?.visual?.images ?? draft.visual.images;
  return Array.isArray(images) ? images : [];
}

export class CharacterEditorController {
  api: CharacterEditorApi;
  options: CharacterEditorOptions;
  state: CharacterEditorState;
  listeners: Set<Listener>;
  onChange?: (state: CharacterEditorState) => void;
  objectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  destroyed: boolean;
  qwenAvailable: boolean;
  original: Character | null;

  constructor(options: CharacterEditorOptions) {
    if (!options || typeof options !== 'object' || !options.api) {
      throw new TypeError('CharacterEditorController requires an api');
    }
    this.options = options;
    this.api = options.api;
    this.listeners = new Set();
    this.onChange = options.onChange;
    this.destroyed = false;
    this.qwenAvailable = options.qwenAvailable === true;
    this.objectUrl = (blob: Blob) => {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('URL.createObjectURL is not available');
      }
      return URL.createObjectURL(blob);
    };
    this.revokeObjectUrl = (url: string) => {
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(url);
        }
      } catch {
        // best effort
      }
    };
    const character = options.character ?? options.initial ?? options.value ?? null;
    this.original = character ? clone(character) : null;
    const draft = character ? draftFromCharacter(character) : blankDraft();
    this.state = emptyEditorState({
      character: character ? clone(character) : null,
      draft,
      mode: character ? 'edit' : 'create',
      fictional: options.fictional ?? (character ? character.kind === 'fictional' : false),
      revision: character?.revision ?? 0,
      voiceOptions: normalizeVoiceOptions(options.voiceOptions ?? null),
      voiceOptionsLoaded: Boolean(options.voiceOptions),
      qwenAvailable: this.qwenAvailable,
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): CharacterEditorState {
    return {
      character: this.state.character ? clone(this.state.character) : null,
      draft: clone(this.state.draft),
      mode: this.state.mode,
      fictional: this.state.fictional,
      dirty: this.state.dirty,
      saving: this.state.saving,
      revision: this.state.revision,
      message: this.state.message,
      messageError: this.state.messageError,
      voiceOptions: clone(this.state.voiceOptions),
      voiceOptionsLoaded: this.state.voiceOptionsLoaded,
      voiceOptionsError: this.state.voiceOptionsError,
      audition: { ...this.state.audition },
      imageUrls: { ...this.state.imageUrls },
      qwenAvailable: this.state.qwenAvailable,
    };
  }

  getState(): CharacterEditorState {
    return this.snapshot();
  }

  render(): string {
    return renderCharacterEditor(this.getState());
  }

  toHTML(): string {
    return this.render();
  }

  notify(): void {
    if (this.destroyed) return;
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { /* a view must not break saving */ }
    }
    try { this.onChange?.(snapshot); } catch { /* optional observer */ }
  }

  setMessage(message: string, isError = false): void {
    this.state.message = message;
    this.state.messageError = isError;
    this.notify();
  }

  setFictional(value: boolean): void {
    this.state.fictional = value === true;
    this.state.dirty = true;
    if (!this.state.fictional) {
      this.state.message = 'Confirm that this character is fictional before saving.';
      this.state.messageError = true;
    } else if (this.state.messageError) {
      this.state.message = '';
      this.state.messageError = false;
    }
    this.notify();
  }

  acknowledgeFictional(): void {
    this.setFictional(true);
  }

  canSave(): boolean {
    return this.state.fictional && !this.state.saving;
  }

  applyCharacter(character: Character): void {
    this.original = clone(character);
    this.state.character = clone(character);
    this.state.draft = draftFromCharacter(character);
    this.state.mode = 'edit';
    this.state.revision = Number.isSafeInteger(character.revision) ? character.revision : 0;
    this.state.dirty = false;
    this.state.saving = false;
  }

  async load(id?: string): Promise<Character | null> {
    const target = id ?? this.options.id ?? this.options.characterId ?? this.state.character?.id;
    if (!target) return this.state.character;
    const get = method<(id: string, signal?: AbortSignal) => Promise<Character>>(
      this.api as Record<string, unknown>,
      ['get', 'getCharacter'],
    );
    if (!get) throw new Error('the character api has no get method');
    this.state.saving = true;
    this.notify();
    try {
      const character = await get(target);
      this.applyCharacter(character);
      this.state.fictional = character.kind === 'fictional';
      this.state.message = '';
      this.state.messageError = false;
      this.notify();
      return this.state.character;
    } catch (error) {
      this.state.saving = false;
      this.state.message = errorMessage(error);
      this.state.messageError = true;
      this.notify();
      return null;
    }
  }

  open(id: string): Promise<Character | null> {
    return this.load(id);
  }

  async loadVoiceOptions(force = false): Promise<VoiceOptions> {
    if (this.state.voiceOptionsLoaded && !force
      && (this.state.voiceOptions.presets.length > 0
        || this.state.voiceOptions.kokoroVoices.length > 0
        || this.state.voiceOptions.qwenSpeakers.length > 0)) {
      return clone(this.state.voiceOptions);
    }
    const loader = this.options.loadVoiceOptions
      ?? this.options.fetchVoiceOptions
      ?? method<(signal?: AbortSignal) => Promise<unknown>>(
        this.api as Record<string, unknown>,
        ['voiceOptions', 'getVoiceOptions', 'fetchVoiceOptions', 'listVoiceOptions'],
      );
    try {
      let value: unknown;
      if (loader) {
        value = await loader();
      } else if (this.options.apiFetch) {
        const response = await this.options.apiFetch('/api/voice-options', {});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        value = await response.json();
      } else {
        throw new Error('voice options are not connected');
      }
      this.state.voiceOptions = normalizeVoiceOptions(value);
      this.state.voiceOptionsLoaded = true;
      this.state.voiceOptionsError = '';
      this.notify();
      return clone(this.state.voiceOptions);
    } catch (error) {
      this.state.voiceOptionsError = errorMessage(error);
      this.notify();
      return clone(this.state.voiceOptions);
    }
  }

  getVoiceOptions(): VoiceOptions {
    return clone(this.state.voiceOptions);
  }

  voicesFor(engine?: string): VoiceOption[] {
    const value = engine ?? this.state.draft.voice.engine;
    if (value === 'qwen3-tts') return clone(this.state.voiceOptions.qwenSpeakers);
    if (value === 'kokoro') return clone(this.state.voiceOptions.kokoroVoices);
    return [];
  }

  /** Set one field in the draft without making a request. */
  setField(path: string, value: unknown): void {
    const normalized = normalizeValue(path, value);
    setPath(this.state.draft as unknown as Record<string, unknown>, path, normalized);
    this.state.dirty = true;
    this.notify();
  }

  patchDraft(patch: CharacterPatch): void {
    if (!isPlainObject(patch)) return;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (isPlainObject(value) && isPlainObject(this.state.draft[key as keyof CharacterDraft])) {
        for (const [child, childValue] of Object.entries(value)) {
          if (childValue === undefined) continue;
          this.setField(`${key}.${child}`, childValue);
        }
      } else {
        this.setField(key, value);
      }
    }
  }

  /**
   * Autosave one field. This is the blur handler: unchanged values are a
   * no-op and a changed value produces exactly one PATCH for that field.
   */
  async saveField(path: string, value: unknown): Promise<boolean> {
    if (!path) return false;
    const normalized = normalizeValue(path, value);
    const current = pathValue(this.state.draft, path);
    if (sameValue(current, normalized) && !this.state.dirty) return false;
    setPath(this.state.draft as unknown as Record<string, unknown>, path, normalized);
    this.state.dirty = true;

    if (!this.state.fictional) {
      this.state.message = 'Confirm that this character is fictional before saving.';
      this.state.messageError = true;
      this.notify();
      return false;
    }
    if (this.state.mode === 'create' || !this.state.character) {
      this.state.message = 'Click Create character to save this draft.';
      this.state.messageError = false;
      this.notify();
      return false;
    }
    if (this.state.saving) return false;

    this.state.saving = true;
    this.notify();
    let updated: Character;
    try {
      updated = await this.patch(this.state.character.id, nestedPatch(path, normalized));
    } catch (error) {
      this.state.saving = false;
      this.state.message = errorMessage(error);
      this.state.messageError = true;
      this.notify();
      return false;
    }
    if (updated && typeof updated === 'object') this.applyCharacter(updated);
    else {
      const character = this.state.character ? clone(this.state.character) : null;
      if (character) {
        character.revision = (Number.isSafeInteger(character.revision) ? character.revision : 0) + 1;
        character.visual = clone(this.state.draft.visual);
        character.voice = clone(this.state.draft.voice);
        character.bible = clone(this.state.draft.bible);
        this.applyCharacter(character);
      }
    }
    this.state.message = 'Saved.';
    this.state.messageError = false;
    this.notify();
    return true;
  }

  async blurField(path: string, value: unknown): Promise<boolean> {
    return this.saveField(path, value);
  }

  async onBlur(path: string, value: unknown): Promise<boolean> {
    return this.saveField(path, value);
  }

  autosave(path: string, value: unknown): Promise<boolean> {
    return this.saveField(path, value);
  }

  autosaveField(path: string, value: unknown): Promise<boolean> {
    return this.saveField(path, value);
  }

  async savePath(path: string, value: unknown): Promise<boolean> {
    return this.saveField(path, value);
  }

  async save(): Promise<boolean> {
    if (!this.state.fictional) {
      this.state.message = 'Confirm that this character is fictional before saving.';
      this.state.messageError = true;
      this.notify();
      return false;
    }
    if (this.state.saving) return false;
    const create = method<(input: CharacterInput, options?: { fictional?: boolean }) => Promise<Character>>(
      this.api as Record<string, unknown>,
      ['create', 'createCharacter'],
    );
    const input = editableSnapshot(this.state.draft);
    this.state.saving = true;
    this.state.message = '';
    this.state.messageError = false;
    this.notify();
    try {
      let character: Character;
      if (this.state.mode === 'create' || !this.state.character) {
        if (!create) throw new Error('the character api has no create method');
        character = await create(input, { fictional: true });
      } else {
        character = await this.patch(this.state.character.id, input as CharacterPatch);
      }
      this.applyCharacter(character);
      this.state.fictional = true;
      this.state.message = 'Saved.';
      this.state.messageError = false;
      this.notify();
      return true;
    } catch (error) {
      this.state.saving = false;
      this.state.message = errorMessage(error);
      this.state.messageError = true;
      this.notify();
      return false;
    }
  }

  create(): Promise<boolean> {
    return this.save();
  }

  async patch(id: string, patch: CharacterPatch): Promise<Character> {
    const update = method<(
      id: string,
      patch: CharacterPatch,
      options?: { signal?: AbortSignal },
    ) => Promise<Character>>(
      this.api as Record<string, unknown>,
      ['update', 'patch', 'patchCharacter', 'updateCharacter'],
    );
    if (!update) throw new Error('the character api has no update method');
    return update(id, patch);
  }

  async remove(): Promise<boolean> {
    const character = this.state.character;
    if (!character) return false;
    const remove = method<(id: string, signal?: AbortSignal) => Promise<void>>(
      this.api as Record<string, unknown>,
      ['remove', 'delete', 'deleteCharacter'],
    );
    if (!remove) throw new Error('the character api has no delete method');
    try {
      await remove(character.id);
      this.state.character = null;
      this.state.mode = 'create';
      this.state.draft = blankDraft();
      this.state.revision = 0;
      this.state.message = 'Character deleted.';
      this.state.messageError = false;
      this.notify();
      return true;
    } catch (error) {
      this.state.message = errorMessage(error);
      this.state.messageError = true;
      this.notify();
      return false;
    }
  }

  images(): CharacterImage[] {
    return imageList(this.state.character, this.state.draft);
  }

  /** Mark exactly one image as the primary identity image. */
  async setPrimary(imgId: string): Promise<boolean> {
    const images = this.images();
    const target = images.find(image => image.imgId === imgId);
    if (!target) {
      this.state.message = 'That image is not on this character.';
      this.state.messageError = true;
      this.notify();
      return false;
    }
    if (target.primary) return false;
    const next = images.map(image => ({ ...image, primary: image.imgId === imgId }));
    this.state.draft.visual.images = next;
    if (this.state.character) this.state.character.visual.images = next;
    this.state.dirty = true;
    if (this.state.mode === 'create' || !this.state.character) {
      this.notify();
      return true;
    }
    try {
      const updated = await this.patch(this.state.character.id, { visual: { images: next } });
      if (updated && typeof updated === 'object') this.applyCharacter(updated);
      this.state.message = 'Primary image updated.';
      this.state.messageError = false;
      this.notify();
      return true;
    } catch (error) {
      this.state.message = errorMessage(error);
      this.state.messageError = true;
      this.notify();
      return false;
    }
  }

  markPrimary(imgId: string): Promise<boolean> {
    return this.setPrimary(imgId);
  }

  setPrimaryImage(imgId: string): Promise<boolean> {
    return this.setPrimary(imgId);
  }

  togglePrimary(imgId: string): Promise<boolean> {
    return this.setPrimary(imgId);
  }

  setVoice(patch: Partial<CharacterVoice>): void {
    this.state.draft.voice = { ...this.state.draft.voice, ...clone(patch) };
    this.state.dirty = true;
    this.notify();
  }

  choosePreset(presetId: string): boolean {
    const preset = this.state.voiceOptions.presets.find(item => item.id === presetId);
    if (!preset) return false;
    const voice = voicePatchFromPreset(preset);
    this.state.draft.voice = {
      ...this.state.draft.voice,
      ...voice,
      presetId,
    };
    this.state.dirty = true;
    this.notify();
    return true;
  }

  selectEngine(engine: CharacterVoice['engine']): boolean {
    if (engine !== 'kokoro' && engine !== 'qwen3-tts' && engine !== 'none') return false;
    const voices = this.voicesFor(engine);
    const voice: CharacterVoice = {
      ...this.state.draft.voice,
      engine,
      ...(engine === 'none' ? {} : { voice: voices[0]?.id ?? this.state.draft.voice.voice }),
      ...(engine === 'qwen3-tts' ? { qwen_mode: this.state.draft.voice.qwen_mode ?? 'custom' } : {}),
    };
    if (engine === 'none') delete voice.voice;
    this.state.draft.voice = voice;
    this.state.dirty = true;
    this.notify();
    return true;
  }

  addVoice(presetId: string): boolean {
    return this.choosePreset(presetId);
  }

  addSampleLine(line = ''): boolean {
    const lines = this.state.draft.voice.sampleLines;
    if (lines.length >= MAX_SAMPLE_LINES) return false;
    lines.push(String(line).slice(0, MAX_SAMPLE_LINE_CHARS));
    this.state.dirty = true;
    this.notify();
    return true;
  }

  removeSampleLine(index: number): boolean {
    const lines = this.state.draft.voice.sampleLines;
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) return false;
    lines.splice(index, 1);
    this.state.dirty = true;
    this.notify();
    return true;
  }

  setVoiceOptions(value: Partial<VoiceOptions>): void {
    this.state.voiceOptions = normalizeVoiceOptions(value);
    this.state.voiceOptionsLoaded = true;
    this.state.voiceOptionsError = '';
    this.notify();
  }

  auditionState(): AuditionState {
    const voice = this.state.draft.voice;
    if (voice.engine === 'none') {
      return { disabled: true, reason: 'Choose a voice before auditioning.', label: 'Audition' };
    }
    if (!voice.voice) {
      return { disabled: true, reason: 'Choose a voice before auditioning.', label: 'Audition' };
    }
    if (voice.engine === 'qwen3-tts' && !this.qwenAvailable) {
      return {
        disabled: true,
        reason: 'Qwen narration needs a local or remote runtime before it can be auditioned.',
        label: 'Audition',
      };
    }
    if (this.state.audition.status === 'loading') {
      return { disabled: true, reason: 'Rendering the audition…', label: 'Auditioning…' };
    }
    return { disabled: false, reason: '', label: 'Audition' };
  }

  async audition(line?: string): Promise<AuditionStatus> {
    const availability = this.auditionState();
    if (availability.disabled && availability.reason.includes('runtime')) {
      this.state.audition = {
        status: 'unavailable',
        message: availability.reason,
        file: '',
        url: '',
      };
      this.notify();
      return { ...this.state.audition };
    }
    if (this.state.draft.voice.engine === 'none' || !this.state.draft.voice.voice) {
      this.state.audition = {
        status: 'unavailable',
        message: availability.reason || 'Choose a voice before auditioning.',
        file: '',
        url: '',
      };
      this.notify();
      return { ...this.state.audition };
    }
    const fn = this.options.audition
      ?? method<(
        character: unknown,
        line?: string,
        options?: Record<string, unknown>,
      ) => Promise<unknown>>(this.api as Record<string, unknown>, ['audition']);
    if (!fn) {
      this.state.audition = {
        status: 'unavailable',
        message: 'Auditioning is not available in this build.',
        file: '',
        url: '',
      };
      this.notify();
      return { ...this.state.audition };
    }
    const chosenLine = String(
      line ?? this.state.draft.voice.sampleLines[0] ?? 'Hello! This is what I sound like.',
    ).slice(0, MAX_SAMPLE_LINE_CHARS);
    this.state.audition = { status: 'loading', message: 'Rendering the audition…', file: '', url: '' };
    this.notify();
    try {
      const result = await fn(this.state.draft, chosenLine, {
        characterId: this.state.character?.id,
        voice: clone(this.state.draft.voice),
      });
      const record = isPlainObject(result) ? result : { url: String(result ?? '') };
      const ok = record.ok !== false;
      const file = asString(record.file ?? record.relativePath);
      const url = asString(record.url ?? record.href);
      if (!ok) {
        this.state.audition = {
          status: 'error',
          message: asString(record.message ?? record.error) || 'The audition could not be generated.',
          file,
          url,
        };
      } else {
        this.state.audition = {
          status: 'ready',
          message: asString(record.message) || 'Audition ready.',
          file,
          url,
        };
      }
    } catch (error) {
      this.state.audition = {
        status: 'error',
        message: errorMessage(error),
        file: '',
        url: '',
      };
    }
    this.notify();
    return { ...this.state.audition };
  }

  auditionVoice(line?: string): Promise<AuditionStatus> {
    return this.audition(line);
  }

  async uploadImage(file: unknown, options: Record<string, unknown> = {}): Promise<CharacterImage | null> {
    const character = this.state.character;
    if (!character) {
      this.state.message = 'Create the character before uploading images.';
      this.state.messageError = true;
      this.notify();
      return null;
    }
    const upload = method<(
      id: string,
      file: unknown,
      options?: Record<string, unknown>,
    ) => Promise<{ image?: CharacterImage; character?: Character }>>(
      this.api as Record<string, unknown>,
      ['uploadImage', 'upload'],
    );
    if (!upload) throw new Error('the character api has no uploadImage method');
    try {
      const result = await upload(character.id, file, options);
      if (result?.character) this.applyCharacter(result.character);
      else if (result?.image) {
        this.state.draft.visual.images = [...this.state.draft.visual.images, result.image];
        this.notify();
      }
      return result?.image ?? null;
    } catch (error) {
      this.state.message = errorMessage(error);
      this.state.messageError = true;
      this.notify();
      return null;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const url of Object.values(this.state.imageUrls)) this.revokeObjectUrl(url);
    this.state.imageUrls = {};
    this.listeners.clear();
  }
}

export const EditorController = CharacterEditorController;
export const CharacterEditor = CharacterEditorController;
export const Editor = CharacterEditorController;

export function createCharacterEditor(options: CharacterEditorOptions): CharacterEditorController {
  return new CharacterEditorController(options);
}

export const createEditor = createCharacterEditor;

/* ------------------------------------------------------------------ render */

function optionsHtml(
  values: Array<{ id: string; label: string }>,
  current: string | undefined,
  allowEmpty = false,
): string {
  const present = current !== undefined && values.some(value => value.id === current);
  const empty = allowEmpty
    ? `<option value=""${!current ? ' selected' : ''}>None</option>`
    : current && !present
      ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`
      : '';
  return `${empty}${values.map(value => `<option value="${escapeHtml(value.id)}"${value.id === current ? ' selected' : ''}>${escapeHtml(value.label)}</option>`).join('')}`;
}

function listText(value: unknown): string {
  return Array.isArray(value) ? value.map(item => String(item)).join('\n') : '';
}

function renderImageList(state: CharacterEditorState): string {
  const images = state.draft.visual.images ?? [];
  if (images.length === 0) return '<p class="chr-empty-small" data-no-images>No images yet. Upload a front-facing image to lock the identity.</p>';
  return `<ul class="chr-image-list">${images.map(image => {
    const url = state.imageUrls[image.imgId];
    return `<li class="chr-image${image.primary ? ' is-primary' : ''}" data-image-id="${escapeHtml(image.imgId)}">
      ${url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">` : '<span class="chr-image-placeholder" aria-hidden="true"></span>'}
      <span class="chr-image-meta"><span class="chr-chip">${escapeHtml(IMAGE_VIEW_LABELS[image.view] ?? image.view)}</span>${image.primary ? '<span class="chr-chip chr-chip-primary" data-primary-badge>Primary</span>' : ''}</span>
      <button type="button" class="chr-btn chr-btn-quiet" data-action="set-primary" data-img-id="${escapeHtml(image.imgId)}"${image.primary ? ' disabled aria-pressed="true"' : ' aria-pressed="false"'}>${image.primary ? 'Primary' : 'Make primary'}</button>
    </li>`;
  }).join('')}</ul>`;
}

function renderIdentity(state: CharacterEditorState): string {
  const draft = state.draft;
  return `<details class="chr-section" data-section="identity" open aria-labelledby="chr-identity-title">
    <summary id="chr-identity-title" class="chr-section-summary">Identity</summary>
    <div class="chr-field-grid">
      <label class="chr-field">Name<input data-field="name" name="name" maxlength="80" autocomplete="off" value="${escapeHtml(draft.name)}"></label>
      <label class="chr-field">@handle<input data-field="handle" name="handle" maxlength="32" autocapitalize="off" spellcheck="false" value="${escapeHtml(draft.handle)}"></label>
      <label class="chr-field">Role<select data-field="role" name="role">${optionsHtml(
        CHARACTER_ROLES.map(role => ({ id: role, label: ROLE_LABELS[role] })),
        draft.role,
      )}</select></label>
      <label class="chr-field chr-field-wide">Summary<textarea data-field="summary" name="summary" maxlength="400" rows="2">${escapeHtml(draft.summary)}</textarea></label>
    </div>
    <label class="chr-check chr-fictional">
      <input type="checkbox" data-fictional name="fictional" required aria-required="true"${state.fictional ? ' checked' : ''}>
      <span><strong>Fictional only.</strong> This is a fictional character, not a real person.</span>
    </label>
    <p class="chr-hint">${escapeHtml(FICTIONAL_NOTICE)}</p>
    <div class="chr-section-actions">
      <button type="button" class="chr-btn chr-btn-primary" data-action="save"${state.fictional && !state.saving ? '' : ' disabled'}>${state.saving ? 'Saving…' : state.mode === 'create' ? 'Create character' : 'Save changes'}</button>
      <button type="button" class="chr-btn chr-btn-danger" data-action="delete"${state.character ? '' : ' disabled'}>Delete</button>
    </div>
  </details>`;
}

function renderLook(state: CharacterEditorState): string {
  const visual = state.draft.visual;
  return `<details class="chr-section" data-section="look" aria-labelledby="chr-look-title">
    <summary id="chr-look-title" class="chr-section-summary">Look</summary>
    <div class="chr-look-images" data-image-slots>${renderImageList(state)}</div>
    <div class="chr-upload-row">
      <label class="chr-file">Upload image<input type="file" data-upload-image accept="image/png,image/jpeg,image/webp"${state.character ? '' : ' disabled'}></label>
      <span class="chr-hint">PNG, JPEG or WEBP up to 20 MB.${state.character ? '' : ' Create the character first.'}</span>
    </div>
    <div class="chr-field-grid">
      <label class="chr-field chr-field-wide">Identity prompt<textarea data-field="visual.identityPrompt" maxlength="600" rows="3" placeholder="small round coffee bean, glossy brown, big white eyes">${escapeHtml(visual.identityPrompt)}</textarea></label>
      <label class="chr-field chr-field-wide">Negative<textarea data-field="visual.negative" maxlength="300" rows="2" placeholder="no human face, no text">${escapeHtml(visual.negative)}</textarea></label>
      <label class="chr-field">Style<input data-field="visual.style" maxlength="400" value="${escapeHtml(visual.style ?? '')}"></label>
      <label class="chr-field">Locked seed<input data-field="visual.seed" type="number" step="1" value="${visual.seed ?? ''}" placeholder="none"></label>
      <label class="chr-field chr-field-wide">Palette<input data-field="visual.palette" value="${escapeHtml((visual.palette ?? []).join(', '))}" placeholder="#5b3a1e, #f4e9dc"></label>
    </div>
  </details>`;
}

function renderWardrobe(state: CharacterEditorState): string {
  const wardrobe = state.draft.visual.wardrobe ?? [];
  return `<details class="chr-section" aria-labelledby="chr-wardrobe-title">
    <summary id="chr-wardrobe-title" class="chr-section-summary">Wardrobe</summary>
    ${wardrobe.length === 0
      ? '<p class="chr-empty-small" data-no-wardrobe>No wardrobe items yet.</p>'
      : `<ul class="chr-item-list">${wardrobe.map(item => `<li data-wardrobe-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.label)}${item.default ? ' · default' : ''}</span><span class="chr-hint">${escapeHtml(item.prompt)}</span></li>`).join('')}</ul>`}
  </details>`;
}

function renderExpressions(state: CharacterEditorState): string {
  const expressions = state.draft.visual.expressions ?? [];
  return `<details class="chr-section" aria-labelledby="chr-expressions-title">
    <summary id="chr-expressions-title" class="chr-section-summary">Expressions</summary>
    ${expressions.length === 0
      ? '<p class="chr-empty-small" data-no-expressions>No expressions yet.</p>'
      : `<ul class="chr-item-list">${expressions.map(item => `<li data-expression-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.label)}</span><span class="chr-hint">${escapeHtml(item.prompt)}</span></li>`).join('')}</ul>`}
  </details>`;
}

type RenderableState = CharacterEditorState & {
  auditionStateNotice?: AuditionState;
};

function auditionFor(state: CharacterEditorState): AuditionState {
  const voice = state.draft.voice;
  if (voice.engine === 'none' || !voice.voice) {
    return { disabled: true, reason: 'Choose a voice before auditioning.', label: 'Audition' };
  }
  if (voice.engine === 'qwen3-tts' && !state.qwenAvailable) {
    return {
      disabled: true,
      reason: 'Qwen narration needs a local or remote runtime before it can be auditioned.',
      label: 'Audition',
    };
  }
  if (state.audition.status === 'loading') {
    return { disabled: true, reason: 'Rendering the audition…', label: 'Auditioning…' };
  }
  return { disabled: false, reason: '', label: 'Audition' };
}

function renderVoice(state: RenderableState): string {
  const voice = state.draft.voice;
  const availability = auditionFor(state);
  const voices = voice.engine === 'qwen3-tts'
    ? state.voiceOptions.qwenSpeakers
    : voice.engine === 'kokoro'
      ? state.voiceOptions.kokoroVoices
      : [];
  return `<details class="chr-section" data-section="voice" aria-labelledby="chr-voice-title">
    <summary id="chr-voice-title" class="chr-section-summary">Voice</summary>
    <div class="chr-field-grid">
      <label class="chr-field">Preset<select data-voice-preset>${optionsHtml(
        state.voiceOptions.presets.map(preset => ({ id: preset.id, label: preset.label })),
        voice.presetId,
        true,
      )}</select></label>
      <label class="chr-field">Engine<select data-field="voice.engine">${optionsHtml([
        { id: 'kokoro', label: 'Kokoro · local CPU' },
        { id: 'qwen3-tts', label: 'Qwen · directed' },
        { id: 'none', label: 'No voice' },
      ], voice.engine)}</select></label>
      <label class="chr-field">Voice<select data-field="voice.voice"${voice.engine === 'none' ? ' disabled' : ''}>${optionsHtml(voices, voice.voice, true)}</select></label>
      <label class="chr-field">Speed<input data-field="voice.speed" type="number" min="0.5" max="1.5" step="0.01" value="${voice.speed ?? 1}"${voice.engine === 'kokoro' ? '' : ' disabled'}></label>
      ${voice.engine === 'qwen3-tts' ? `<label class="chr-field chr-field-wide">Delivery<textarea data-field="voice.delivery" maxlength="400" rows="2" placeholder="Warm, curious, conversational.">${escapeHtml(voice.delivery ?? '')}</textarea></label>
      <label class="chr-field chr-field-wide">Designed persona<textarea data-field="voice.persona" maxlength="600" rows="2">${escapeHtml(voice.persona ?? '')}</textarea></label>` : ''}
    </div>
    <div class="chr-subsection">
      <h4>Sample lines</h4>
      <ul class="chr-sample-lines">${(voice.sampleLines ?? []).map((line, index) => `<li><input data-sample-line="${index}" maxlength="200" value="${escapeHtml(line)}" aria-label="Sample line ${index + 1}"><button type="button" class="chr-btn chr-btn-quiet" data-action="remove-sample-line" data-index="${index}" aria-label="Remove sample line ${index + 1}">Remove</button></li>`).join('')}</ul>
      <button type="button" class="chr-btn chr-btn-quiet" data-action="add-sample-line"${(voice.sampleLines ?? []).length >= MAX_SAMPLE_LINES ? ' disabled' : ''}>Add sample line</button>
    </div>
    <div class="chr-audition">
      <button type="button" class="chr-btn" data-action="audition"${availability.disabled ? ' disabled' : ''}${availability.reason ? ` title="${escapeHtml(availability.reason)}"` : ''}>${escapeHtml(availability.label)}</button>
      <span class="chr-hint" data-audition-reason role="status">${escapeHtml(availability.reason || state.audition.message)}</span>
      ${state.audition.url ? `<audio controls src="${escapeHtml(state.audition.url)}"></audio>` : ''}
    </div>
  </details>`;
}

function renderBible(state: CharacterEditorState): string {
  const bible = state.draft.bible;
  return `<details class="chr-section" data-section="bible" aria-labelledby="chr-bible-title">
    <summary id="chr-bible-title" class="chr-section-summary">Bible</summary>
    <div class="chr-field-grid">
      <label class="chr-field chr-field-wide">Personality<textarea data-field="bible.personality" maxlength="600" rows="3">${escapeHtml(bible.personality)}</textarea></label>
      <label class="chr-field chr-field-wide">Speaking style<textarea data-field="bible.speakingStyle" maxlength="300" rows="2">${escapeHtml(bible.speakingStyle)}</textarea></label>
      <label class="chr-field">Mannerisms<textarea data-field="bible.mannerisms" data-list rows="3" placeholder="One per line">${escapeHtml(listText(bible.mannerisms))}</textarea></label>
      <label class="chr-field">Catchphrases<textarea data-field="bible.catchphrases" data-list rows="3" placeholder="One per line">${escapeHtml(listText(bible.catchphrases))}</textarea></label>
      <label class="chr-field">Do<textarea data-field="bible.do" data-list rows="3" placeholder="One per line">${escapeHtml(listText(bible.do))}</textarea></label>
      <label class="chr-field">Don't<textarea data-field="bible.dont" data-list rows="3" placeholder="One per line">${escapeHtml(listText(bible.dont))}</textarea></label>
      <label class="chr-field chr-field-wide">Notes<textarea data-field="bible.notes" maxlength="1000" rows="4">${escapeHtml(bible.notes)}</textarea></label>
    </div>
  </details>`;
}

export type EditorRenderOptions = {
  title?: string;
  closeLabel?: string;
  voiceOptions?: Partial<VoiceOptions> | null;
  qwenAvailable?: boolean;
  fictional?: boolean;
};

export function renderCharacterEditor(
  state: CharacterEditorState | Character | Record<string, unknown>,
  options: EditorRenderOptions = {},
): string {
  let value: RenderableState;
  if (state && typeof state === 'object' && 'draft' in state) {
    value = state as RenderableState;
  } else if (state && typeof state === 'object' && 'character' in state) {
    const source = state as Record<string, unknown>;
    const character = isPlainObject(source.character) ? source.character as unknown as Character : null;
    value = emptyEditorState({
      ...(character ? {
        character,
        draft: draftFromCharacter(character),
        mode: 'edit' as const,
        revision: character.revision,
      } : {}),
      fictional: typeof source.fictional === 'boolean' ? source.fictional : character ? character.kind === 'fictional' : false,
      voiceOptions: normalizeVoiceOptions(source.voiceOptions ?? options.voiceOptions ?? null),
      voiceOptionsLoaded: Boolean(source.voiceOptions ?? options.voiceOptions),
      qwenAvailable: source.qwenAvailable === true || options.qwenAvailable === true,
    });
  } else {
    const character = state as Character;
    value = emptyEditorState({
      character,
      draft: draftFromCharacter(character),
      mode: 'edit',
      fictional: options.fictional ?? (character.kind === 'fictional'),
      revision: character.revision,
      voiceOptions: normalizeVoiceOptions(options.voiceOptions ?? null),
      voiceOptionsLoaded: Boolean(options.voiceOptions),
      qwenAvailable: options.qwenAvailable === true,
    });
  }
  const title = options.title ?? (value.mode === 'create' ? 'New character' : value.draft.name || 'Character');
  const status = value.messageError
    ? `<p class="chr-status chr-status-error" data-editor-status role="alert">${escapeHtml(value.message)}</p>`
    : `<p class="chr-status" data-editor-status role="status" aria-live="polite">${escapeHtml(value.message)}</p>`;
  return `<aside class="chr-drawer" data-character-editor data-mode="${escapeHtml(value.mode)}" aria-label="${escapeHtml(title)}">
    <header class="chr-drawer-header">
      <div>
        <p class="chr-eyebrow">${value.mode === 'create' ? 'Library' : `v${value.revision}`}</p>
        <h2>${escapeHtml(title)}</h2>
      </div>
      <div class="chr-drawer-header-actions">
        ${value.revision ? `<span class="chr-chip" data-editor-revision>v${value.revision}</span>` : ''}
        <button type="button" class="chr-icon-btn" data-action="close" aria-label="${escapeHtml(options.closeLabel ?? 'Close editor')}">×</button>
      </div>
    </header>
    ${status}
    <div class="chr-drawer-body">
      ${renderIdentity(value)}
      ${renderLook(value)}
      ${renderWardrobe(value)}
      ${renderExpressions(value)}
      ${renderVoice(value)}
      ${renderBible(value)}
    </div>
  </aside>`;
}

export const renderEditor = renderCharacterEditor;
export const renderCharacterDrawer = renderCharacterEditor;
export const renderEditorDrawer = renderCharacterEditor;
export const renderCharacterEditorDrawer = renderCharacterEditor;

/* ------------------------------------------------------------------- mount */

export type EditorMountOptions = CharacterEditorOptions & {
  onClose?: () => void;
  onSaved?: (character: Character) => void;
};

export type EditorMountHandle = {
  controller: CharacterEditorController;
  render: () => void;
  destroy: () => void;
};

function elementValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown {
  if (element instanceof HTMLInputElement && element.type === 'checkbox') return element.checked;
  return element.value;
}

/** Optional DOM mount. No browser global is touched until this is called. */
export function mountCharacterEditor(
  element: HTMLElement,
  options: EditorMountOptions,
): EditorMountHandle {
  const controller = new CharacterEditorController(options);
  const root = element;
  let unsubscribe: (() => void) | null = null;

  const render = () => {
    root.innerHTML = renderCharacterEditor(controller.getState());
  };

  const onBlur = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!target || !target.dataset || typeof target.dataset.field !== 'string') return;
    if (target instanceof HTMLSelectElement && target.dataset.field === 'voice.engine') return;
    void controller.saveField(target.dataset.field, elementValue(target));
  };

  const onChange = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!target) return;
    if (target.dataset?.fictional !== undefined) {
      controller.setFictional((target as HTMLInputElement).checked);
      return;
    }
    if (target.dataset?.field === 'voice.engine') {
      controller.selectEngine(target.value as CharacterVoice['engine']);
      void controller.saveField('voice.engine', target.value);
      return;
    }
    if (target.dataset?.voicePreset !== undefined) {
      if (controller.choosePreset(target.value)) {
        void controller.saveField('voice', controller.state.draft.voice);
      }
      return;
    }
    if (typeof target.dataset?.sampleLine === 'string') {
      const index = Number(target.dataset.sampleLine);
      const lines = controller.state.draft.voice.sampleLines;
      if (Number.isInteger(index) && index >= 0 && index < lines.length) {
        lines[index] = target.value.slice(0, MAX_SAMPLE_LINE_CHARS);
        controller.setVoice({ sampleLines: lines });
      }
      return;
    }
    if (typeof target.dataset?.field === 'string') {
      if (target.tagName === 'SELECT') void controller.saveField(target.dataset.field, target.value);
    }
  };

  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const action = target.closest<HTMLElement>('[data-action]');
    if (!action) return;
    const name = action.dataset.action;
    if (name === 'close') options.onClose?.();
    else if (name === 'save') {
      void controller.save().then(ok => {
        if (ok && controller.state.character) options.onSaved?.(controller.state.character);
      });
    } else if (name === 'delete') void controller.remove();
    else if (name === 'set-primary') {
      const imgId = action.dataset.imgId;
      if (imgId) void controller.setPrimary(imgId);
    } else if (name === 'audition') void controller.audition();
    else if (name === 'add-sample-line') controller.addSampleLine();
    else if (name === 'remove-sample-line') controller.removeSampleLine(Number(action.dataset.index));
  };

  const onUpload = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    const file = target?.files?.[0];
    if (file) void controller.uploadImage(file);
  };

  unsubscribe = controller.subscribe(render);
  root.addEventListener('blur', onBlur, true);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  root.addEventListener('change', onUpload);
  render();
  void controller.loadVoiceOptions();
  if (!options.character && (options.id || controller.state.character)) {
    void controller.load();
  }

  return {
    controller,
    render,
    destroy: () => {
      root.removeEventListener('blur', onBlur, true);
      root.removeEventListener('change', onChange);
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onUpload);
      unsubscribe?.();
      controller.destroy();
      root.innerHTML = '';
    },
  };
}

export const mountEditor = mountCharacterEditor;
export const mountEditorDrawer = mountCharacterEditor;
export const mountDrawer = mountCharacterEditor;
export default CharacterEditorController;
