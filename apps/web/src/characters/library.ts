/**
 * Character library grid (CC11).
 *
 * The controller and every render helper are dependency free: state can be
 * hydrated from a fake API and rendered to a string without a DOM. `mount...`
 * is the only function that touches browser globals, and nothing happens at
 * import time.
 */

import type { Character, CharacterRole } from './api.ts';

export const LIBRARY_LIMIT = 50;
export const MAX_CHARACTERS = 50;
export const MAX_LIBRARY_CHARACTERS = 50;

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

export const ENGINE_LABELS: Record<string, string> = {
  kokoro: 'Kokoro',
  'qwen3-tts': 'Qwen',
  none: 'No voice',
};

export type CharacterListResult = Character[] | { characters?: Character[] | null };

export type LibraryThumbApi = {
  primaryThumb?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  fetchPrimaryThumb?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  thumb?: (id: string, imgId: string, signal?: AbortSignal) => Promise<Blob>;
};

export type CharacterLibraryApi = {
  list?: (signal?: AbortSignal) => Promise<CharacterListResult>;
  listCharacters?: (signal?: AbortSignal) => Promise<CharacterListResult>;
  addCast?: (
    chatId: string,
    characterId: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  addToProject?: (
    chatId: string,
    characterId: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  primaryThumb?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  fetchPrimaryThumb?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  [key: string]: unknown;
};

export type LibraryProjectPin = {
  revision: number;
  castId?: string;
  detached?: boolean;
  orphaned?: boolean;
};

export type LibraryState = {
  characters: Character[];
  loading: boolean;
  error: string;
  message: string;
  selectedId: string;
  /** Pinned project revisions keyed by character id. */
  project: Record<string, LibraryProjectPin>;
  thumbUrls: Record<string, string>;
};

export type LibraryCardStatus = {
  inProject: boolean;
  revision?: number;
  updateAvailable: boolean;
  detached: boolean;
  orphaned: boolean;
};

export type LibraryRenderOptions = {
  thumbUrls?: Record<string, string>;
  project?: Record<string, LibraryProjectPin | number>;
  selectedId?: string;
  loading?: boolean;
  error?: string;
  emptyText?: string;
  addLabel?: string;
  showAddToProject?: boolean;
};

export type LibraryControllerOptions = {
  api: CharacterLibraryApi;
  project?: Record<string, LibraryProjectPin | number>;
  onChange?: (state: LibraryState) => void;
  /** Blob -> URL hook. Defaults to URL.createObjectURL when available. */
  objectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  /** Fetch primary thumbs through the authed API. Off by default. */
  loadThumbs?: boolean;
};

type Listener = (state: LibraryState) => void;

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

function charactersFrom(result: CharacterListResult | null | undefined): Character[] {
  if (Array.isArray(result)) return result as Character[];
  if (result && Array.isArray(result.characters)) return result.characters;
  return [];
}

function pinOf(value: LibraryProjectPin | number | undefined): LibraryProjectPin | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? { revision: value } : undefined;
  if (value && typeof value === 'object') {
    return {
      ...value,
      revision: Number.isFinite(value.revision) ? Number(value.revision) : 0,
    };
  }
  return undefined;
}

export function normalizeProjectPins(
  project?: Record<string, LibraryProjectPin | number>,
): Record<string, LibraryProjectPin> {
  const out: Record<string, LibraryProjectPin> = {};
  for (const [id, value] of Object.entries(project ?? {})) {
    const pin = pinOf(value);
    if (pin) out[id] = pin;
  }
  return out;
}

export function emptyLibraryState(project?: Record<string, LibraryProjectPin | number>): LibraryState {
  return {
    characters: [],
    loading: false,
    error: '',
    message: '',
    selectedId: '',
    project: normalizeProjectPins(project),
    thumbUrls: {},
  };
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as CharacterRole] ?? String(role || 'Character');
}

export function characterVoiceLabel(character: Pick<Character, 'voice'>): string {
  const voice = character?.voice;
  const engine = String(voice?.engine ?? 'none');
  const label = ENGINE_LABELS[engine] ?? engine;
  if (engine === 'none') return label;
  const id = String(voice?.voice ?? '').trim();
  return id ? `${label} · ${id}` : label;
}

export function cardStatus(
  character: Character,
  project?: Record<string, LibraryProjectPin | number>,
): LibraryCardStatus {
  const pin = pinOf(project?.[character.id]);
  if (!pin) {
    return { inProject: false, updateAvailable: false, detached: false, orphaned: false };
  }
  return {
    inProject: true,
    revision: pin.revision,
    updateAvailable: pin.revision > 0 && character.revision > pin.revision && !pin.detached,
    detached: pin.detached === true,
    orphaned: pin.orphaned === true,
  };
}

function primaryImage(character: Character) {
  const images = Array.isArray(character?.visual?.images) ? character.visual.images : [];
  return images.find(image => image?.primary === true) ?? images[0] ?? null;
}

function renderCard(
  character: Character,
  options: LibraryRenderOptions,
): string {
  const status = cardStatus(character, options.project);
  const thumb = options.thumbUrls?.[character.id];
  const selected = options.selectedId === character.id;
  const image = primaryImage(character);
  const media = thumb
    ? `<img class="chr-card-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">`
    : `<span class="chr-card-thumb chr-card-thumb-empty" aria-hidden="true">${escapeHtml(
      String(character.name ?? '?').trim().slice(0, 1).toUpperCase() || '?',
    )}</span>`;
  const version = Number.isSafeInteger(character.revision) ? `v${character.revision}` : '';
  const projectLabel = status.inProject
    ? `In project v${status.revision ?? 0}`
    : 'Not in project';
  const update = status.updateAvailable
    ? `<span class="chr-update-badge" data-update-available>Library has v${character.revision}</span>`
    : '';
  const flags = [
    status.detached ? '<span class="chr-flag" data-detached>Detached</span>' : '',
    status.orphaned ? '<span class="chr-flag chr-flag-warn" data-orphaned>Orphaned</span>' : '',
  ].join('');
  const add = options.showAddToProject === false
    ? ''
    : status.inProject
      ? `<button type="button" class="chr-btn chr-btn-quiet" data-open-character="${escapeHtml(character.id)}">Edit</button>`
      : `<button type="button" class="chr-btn" data-add-character="${escapeHtml(character.id)}">Add to project</button>`;
  return `<li><article class="chr-card${selected ? ' is-selected' : ''}" data-character-id="${escapeHtml(character.id)}" data-role="${escapeHtml(character.role)}" aria-label="${escapeHtml(character.name)}">
    <button type="button" class="chr-card-open" data-open-character="${escapeHtml(character.id)}">
      ${media}
      <span class="chr-card-body">
        <span class="chr-card-title"><span class="chr-card-name" data-character-name>${escapeHtml(character.name)}</span>${version ? `<span class="chr-card-version" data-character-revision>${escapeHtml(version)}</span>` : ''}</span>
        <span class="chr-card-handle">@${escapeHtml(character.handle)}</span>
        <span class="chr-card-chips">
          <span class="chr-chip chr-role-chip" data-role-chip>${escapeHtml(roleLabel(character.role))}</span>
          <span class="chr-chip chr-voice-chip" data-voice-chip>${escapeHtml(characterVoiceLabel(character))}</span>
        </span>
        <span class="chr-card-project" data-project-status>${escapeHtml(projectLabel)}</span>
        ${update}${flags}
      </span>
    </button>
    ${image ? '' : '<span class="chr-card-warning" data-no-image>No image yet</span>'}
    <div class="chr-card-actions">${add}</div>
  </article></li>`;
}

export function renderLibraryGrid(
  state: LibraryState | Character[],
  options: LibraryRenderOptions = {},
): string {
  const characters = Array.isArray(state) ? state : state.characters;
  const project = options.project
    ?? (Array.isArray(state) ? undefined : state.project);
  const thumbUrls = options.thumbUrls
    ?? (Array.isArray(state) ? undefined : state.thumbUrls);
  const selectedId = options.selectedId
    ?? (Array.isArray(state) ? undefined : state.selectedId);
  if (characters.length === 0) {
    if (options.loading) return '<p class="chr-empty" role="status">Loading characters…</p>';
    return `<p class="chr-empty" data-empty>${escapeHtml(options.emptyText ?? 'No characters yet. Create one to reuse it across videos.')}</p>`;
  }
  return `<ul class="chr-grid" data-character-grid>${characters.map(character => renderCard(character, {
    ...options,
    project,
    thumbUrls,
    selectedId,
  })).join('')}</ul>`;
}

export function renderCharacterLibrary(
  state: LibraryState | Character[],
  options: LibraryRenderOptions = {},
): string {
  const value = Array.isArray(state) ? emptyLibraryState(options.project) : state;
  const characters = Array.isArray(state) ? state : value.characters;
  const count = characters.length;
  const loading = options.loading ?? value.loading;
  const error = options.error ?? value.error;
  const status = error
    ? `<p class="chr-status chr-status-error" data-library-error role="alert">${escapeHtml(error)}</p>`
    : `<p class="chr-status" data-library-status role="status" aria-live="polite">${escapeHtml(value.message ?? '')}</p>`;
  return `<section class="chr-library" aria-label="Character library" data-character-library>
    <header class="chr-library-header">
      <div>
        <h2>Characters</h2>
        <p class="chr-hint">Define a character once, then reuse it in every video.</p>
      </div>
      <div class="chr-library-actions">
        <span class="chr-count" data-library-count aria-label="${count} character${count === 1 ? '' : 's'}">${count}</span>
        <button type="button" class="chr-btn chr-btn-primary" data-new-character>New character</button>
      </div>
    </header>
    ${status}
    ${renderLibraryGrid({ ...value, characters, loading, error }, {
      ...options,
      project: options.project ?? value.project,
      thumbUrls: options.thumbUrls ?? value.thumbUrls,
      selectedId: options.selectedId ?? value.selectedId,
      loading,
    })}
  </section>`;
}

export const renderLibrary = renderCharacterLibrary;
export const renderCharacterGrid = renderLibraryGrid;
export const renderCharacterLibraryGrid = renderCharacterLibrary;

export function renderCharacterCard(
  character: Character,
  options: LibraryRenderOptions = {},
): string {
  return renderCard(character, options);
}

export const renderLibraryCard = renderCharacterCard;

export class CharacterLibraryController {
  api: CharacterLibraryApi;
  state: LibraryState;
  listeners: Set<Listener>;
  onChange?: (state: LibraryState) => void;
  objectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  loadThumbs: boolean;
  destroyed: boolean;

  constructor(options: LibraryControllerOptions) {
    if (!options || typeof options !== 'object' || !options.api) {
      throw new TypeError('CharacterLibraryController requires an api');
    }
    this.api = options.api;
    this.state = emptyLibraryState(options.project);
    this.listeners = new Set();
    this.onChange = options.onChange;
    this.objectUrl = options.objectUrl ?? ((blob: Blob) => {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('URL.createObjectURL is not available');
      }
      return URL.createObjectURL(blob);
    });
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => {
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(url);
        }
      } catch {
        // revoking is best effort
      }
    });
    this.loadThumbs = options.loadThumbs === true;
    this.destroyed = false;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): LibraryState {
    return {
      characters: this.state.characters.map(character => clone(character)),
      loading: this.state.loading,
      error: this.state.error,
      message: this.state.message,
      selectedId: this.state.selectedId,
      project: normalizeProjectPins(this.state.project),
      thumbUrls: { ...this.state.thumbUrls },
    };
  }

  getState(): LibraryState {
    return this.snapshot();
  }

  render(): string {
    return renderCharacterLibrary(this.getState());
  }

  toHTML(): string {
    return this.render();
  }

  notify(): void {
    if (this.destroyed) return;
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { /* a view must not break a load */ }
    }
    try { this.onChange?.(snapshot); } catch { /* optional observer */ }
  }

  setProject(project: Record<string, LibraryProjectPin | number> | undefined): void {
    this.state.project = normalizeProjectPins(project);
    this.notify();
  }

  setSelected(id: string): void {
    this.state.selectedId = String(id ?? '');
    this.notify();
  }

  setCharacters(characters: Character[]): void {
    this.state.characters = characters.map(character => clone(character));
    this.notify();
  }

  async list(): Promise<Character[]> {
    const list = this.api.list
      ?? this.api.listCharacters;
    if (typeof list !== 'function') throw new Error('the character api has no list method');
    const result = await list.call(this.api);
    return charactersFrom(result as CharacterListResult);
  }

  async load(): Promise<Character[]> {
    this.state.loading = true;
    this.state.error = '';
    this.notify();
    try {
      const characters = await this.list();
      this.state.characters = characters.map(character => clone(character));
      this.state.loading = false;
      if (this.loadThumbs) await this.loadPrimaryThumbs();
      this.notify();
      return this.state.characters.map(character => clone(character));
    } catch (error) {
      this.state.loading = false;
      this.state.error = errorMessage(error);
      this.notify();
      return [];
    }
  }

  reload(): Promise<Character[]> {
    return this.load();
  }

  async loadPrimaryThumbs(signal?: AbortSignal): Promise<void> {
    const fetchThumb = this.api.primaryThumb ?? this.api.fetchPrimaryThumb;
    if (typeof fetchThumb !== 'function') return;
    for (const character of this.state.characters) {
      try {
        const blob = await fetchThumb.call(this.api, character.id, signal);
        if (!blob) continue;
        const previous = this.state.thumbUrls[character.id];
        if (previous) this.revokeObjectUrl(previous);
        this.state.thumbUrls[character.id] = this.objectUrl(blob);
      } catch {
        // A missing thumb leaves the initial fallback in place.
      }
    }
    this.notify();
  }

  /** Add the library character to a project chat through the cast wrapper. */
  async addToProject(
    characterId: string,
    chatId: string,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    const add = this.api.addCast ?? this.api.addToProject;
    if (typeof add !== 'function') throw new Error('the character api has no addCast method');
    const result = await add.call(this.api, chatId, characterId, options);
    this.state.message = `Added ${characterId} to the project.`;
    this.notify();
    return result;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const url of Object.values(this.state.thumbUrls)) this.revokeObjectUrl(url);
    this.state.thumbUrls = {};
    this.listeners.clear();
  }
}

export const LibraryController = CharacterLibraryController;
export const CharacterLibrary = CharacterLibraryController;
export const LibraryGrid = CharacterLibraryController;

export function createCharacterLibrary(options: LibraryControllerOptions): CharacterLibraryController {
  return new CharacterLibraryController(options);
}

export const createLibrary = createCharacterLibrary;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 400);
  const text = String(error ?? '').trim();
  return text ? text.slice(0, 400) : 'Could not load the character library.';
}

export type LibraryMountOptions = LibraryControllerOptions & {
  onOpen?: (character: Character) => void;
  onNew?: () => void;
  onAddToProject?: (character: Character) => void;
  chatId?: string;
};

export type LibraryMountHandle = {
  controller: CharacterLibraryController;
  render: () => void;
  reload: () => Promise<Character[]>;
  destroy: () => void;
};

/** Optional DOM mount. No browser global is touched until this is called. */
export function mountCharacterLibrary(
  element: HTMLElement,
  options: LibraryMountOptions,
): LibraryMountHandle {
  const controller = new CharacterLibraryController({ ...options, loadThumbs: options.loadThumbs ?? true });
  const root = element;
  let unsubscribe: (() => void) | null = null;

  const render = () => {
    root.innerHTML = renderCharacterLibrary(controller.getState());
  };

  const findCharacter = (id: string) => controller.state.characters.find(character => character.id === id);

  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const open = target.closest<HTMLElement>('[data-open-character]');
    if (open) {
      const character = findCharacter(open.dataset.openCharacter ?? '');
      if (character) options.onOpen?.(character);
      return;
    }
    const add = target.closest<HTMLElement>('[data-add-character]');
    if (add) {
      const character = findCharacter(add.dataset.addCharacter ?? '');
      if (!character) return;
      if (options.onAddToProject) options.onAddToProject(character);
      else if (options.chatId) void controller.addToProject(character.id, options.chatId);
      return;
    }
    if (target.closest('[data-new-character]')) options.onNew?.();
  };

  unsubscribe = controller.subscribe(render);
  root.addEventListener('click', onClick);
  render();
  void controller.load();

  return {
    controller,
    render,
    reload: () => controller.load(),
    destroy: () => {
      root.removeEventListener('click', onClick);
      unsubscribe?.();
      controller.destroy();
      root.innerHTML = '';
    },
  };
}

export const mountLibrary = mountCharacterLibrary;
export default CharacterLibraryController;
