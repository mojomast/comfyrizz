/**
 * Characters tab (CC16).
 *
 * Wires the character library (CC11), the project cast strip (CC12) and the
 * character editor drawer into one tab. The controller and render helpers are
 * dependency free so they can be exercised with a fake API and no DOM; the
 * `mount...` helper is the only part that touches browser globals, and nothing
 * happens at import time.
 */

import type { CastEntry, Character } from './api.ts';
import {
  CharacterLibraryController,
  mountCharacterLibrary,
  renderCharacterLibrary,
  type CharacterLibraryApi,
  type LibraryMountHandle,
  type LibraryProjectPin,
  type LibraryState,
} from './library.ts';
import {
  CastStripController,
  mountCastStrip,
  renderCastStrip,
  type CastStripApi,
  type CastStripHandle,
  type CastStripState,
} from './cast-strip.ts';
import {
  mountCharacterEditor,
  renderCharacterEditor,
  type CharacterEditorApi,
  type CharacterEditorState,
  type EditorMountHandle,
  type VoiceOptions,
} from './editor.ts';

export type CharactersTabView = 'library' | 'editor';

export type CharactersTabApi = CharacterLibraryApi & CastStripApi & Record<string, unknown>;

export type CharactersTabOptions = {
  api: CharactersTabApi;
  /** A chat id, or a getter for the live project-chat conversation id. */
  chatId?: string | (() => string | null | undefined) | null;
  /** Create (and persist) a conversation id when the user adds a character. */
  ensureChatId?: (() => string | null | undefined) | null;
  library?: Character[] | Map<string, Character> | Record<string, Character> | null;
  project?: Record<string, LibraryProjectPin | number>;
  loadThumbs?: boolean;
  voiceOptions?: Partial<VoiceOptions> | null;
  apiFetch?: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null;
  objectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  onChange?: (state: CharactersTabState) => void;
  onCastChanged?: (cast: CastEntry[]) => void;
  log?: (message: string) => void;
};

export type CharactersTabState = {
  view: CharactersTabView;
  selectedId: string;
  chatId: string | null;
  library: LibraryState;
  cast: CastStripState | null;
  editor: CharacterEditorState | null;
  message: string;
  messageError: boolean;
};

export type RenderCharactersTabOptions = {
  idPrefix?: string;
  includeCast?: boolean;
  includeEditor?: boolean;
};

export function charactersTabState(overrides: Partial<CharactersTabState> = {}): CharactersTabState {
  return {
    view: 'library',
    selectedId: '',
    chatId: null,
    library: {
      characters: [],
      loading: false,
      error: '',
      message: '',
      selectedId: '',
      project: {},
      thumbUrls: {},
    },
    cast: null,
    editor: null,
    message: '',
    messageError: false,
    ...overrides,
  };
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

/** Project pins keyed by character id, derived from the project's cast entries. */
export function pinsFromCast(cast: readonly CastEntry[] | null | undefined): Record<string, LibraryProjectPin> {
  const pins: Record<string, LibraryProjectPin> = {};
  for (const entry of Array.isArray(cast) ? cast : []) {
    if (!entry || typeof entry.characterId !== 'string') continue;
    pins[entry.characterId] = {
      revision: Number.isFinite(entry.pinnedRevision) ? Number(entry.pinnedRevision) : Number(entry.snapshot?.revision ?? 0),
      castId: entry.castId,
      detached: entry.detached === true,
      orphaned: entry.orphaned === true,
    };
  }
  return pins;
}

export function renderCharactersTab(
  state: CharactersTabState | CharactersTabState['library'] | Character[],
  options: RenderCharactersTabOptions = {},
): string {
  const value = Array.isArray(state)
    ? charactersTabState({ library: { ...charactersTabState().library, characters: state } })
    : 'characters' in state
      ? charactersTabState({ library: state as LibraryState })
      : state as CharactersTabState;
  const prefix = options.idPrefix ?? 'characters';
  const status = value.messageError
    ? `<p class="chr-status chr-status-error" data-characters-status role="alert">${escapeHtml(value.message)}</p>`
    : value.message
      ? `<p class="chr-status" data-characters-status role="status" aria-live="polite">${escapeHtml(value.message)}</p>`
      : '<p class="chr-status" data-characters-status role="status" aria-live="polite"></p>';
  const library = renderCharacterLibrary(value.library);
  const editor = options.includeEditor !== false && value.editor
    ? renderCharacterEditor(value.editor)
    : '';
  const cast = options.includeCast !== false && value.cast
    ? renderCastStrip(value.cast, { idPrefix: `${prefix}-cast`, busy: value.cast.busy })
    : '';
  return `<section class="chr-tab drawer" data-characters-tab aria-label="Characters">
    <header class="chr-tab-header drawer-header">
      <div>
        <h1>Characters</h1>
        <p class="chr-hint">Define a character once, then cast it in every video. The chat agent proposes placements; you confirm them.</p>
      </div>
      <button type="button" class="chr-btn chr-btn-quiet btn btn-ghost btn-sm" data-characters-close aria-label="Close characters">Close</button>
    </header>
    ${status}
    <div class="chr-tab-body drawer-body">
      <div class="chr-tab-library" data-characters-library>${library}</div>
      ${editor ? `<div class="chr-tab-editor" data-characters-editor>${editor}</div>` : ''}
    </div>
    ${cast ? `<div class="chr-tab-cast" data-characters-cast>${cast}</div>` : ''}
  </section>`;
}

/**
 * State holder used by the mount helper and by tests. It owns the library and
 * cast controllers but never renders the editor itself.
 */
export class CharactersTabController {
  api: CharactersTabApi;
  options: CharactersTabOptions;
  library: CharacterLibraryController;
  cast: CastStripController | null;
  listeners: Set<(state: CharactersTabState) => void>;
  state: CharactersTabState;
  destroyed: boolean;
  private overrideChatId: string | null;
  private unsubscribeLibrary: (() => void) | null;

  constructor(options: CharactersTabOptions) {
    if (!options || typeof options !== 'object' || !options.api) {
      throw new TypeError('CharactersTabController requires an api');
    }
    this.options = options;
    this.api = options.api;
    this.listeners = new Set();
    this.destroyed = false;
    this.overrideChatId = typeof options.chatId === 'string' ? options.chatId : null;
    this.state = charactersTabState({
      chatId: this.resolveChatId(false),
    });
    this.library = new CharacterLibraryController({
      api: options.api,
      project: options.project,
      loadThumbs: options.loadThumbs ?? false,
      ...(options.objectUrl ? { objectUrl: options.objectUrl } : {}),
      ...(options.revokeObjectUrl ? { revokeObjectUrl: options.revokeObjectUrl } : {}),
    });
    this.unsubscribeLibrary = this.library.subscribe(() => this.notify());
    if (Array.isArray(options.library)) {
      this.library.setCharacters(options.library as Character[]);
    }
    this.cast = null;
    const chatId = this.resolveChatId(false);
    if (chatId) this.openCast(chatId);
  }

  subscribe(listener: (state: CharactersTabState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): CharactersTabState {
    return {
      view: this.state.view,
      selectedId: this.state.selectedId,
      chatId: this.state.chatId,
      library: this.library.getState(),
      cast: this.cast ? this.cast.snapshot() : null,
      editor: null,
      message: this.state.message,
      messageError: this.state.messageError,
    };
  }

  getState(): CharactersTabState {
    return this.snapshot();
  }

  render(): string {
    return renderCharactersTab(this.getState());
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
    try { this.options.onChange?.(snapshot); } catch { /* optional observer */ }
  }

  setMessage(message: string, error = false): void {
    this.state.message = message;
    this.state.messageError = error;
    this.notify();
  }

  resolveChatId(ensure: boolean): string | null {
    if (this.overrideChatId) return this.overrideChatId;
    const source = this.options.chatId;
    const value = typeof source === 'function' ? source() : source ?? null;
    if (value) return String(value);
    if (!ensure || typeof this.options.ensureChatId !== 'function') return null;
    try {
      const created = this.options.ensureChatId();
      if (created) this.overrideChatId = String(created);
      return created ? String(created) : null;
    } catch {
      return null;
    }
  }

  setChatId(chatId: string | null | undefined): void {
    const value = chatId ? String(chatId) : null;
    this.overrideChatId = value;
    this.state.chatId = value;
    if (value) {
      if (!this.cast || this.cast.chatId !== value) this.openCast(value, false);
    } else if (this.cast) {
      this.cast.destroy();
      this.cast = null;
    }
    this.notify();
  }

  private openCast(chatId: string, load = true): void {
    this.cast?.destroy();
    this.cast = new CastStripController({
      api: this.api,
      chatId,
      library: this.library.getState().characters,
    });
    this.state.chatId = chatId;
    if (load) void this.refreshCast();
  }

  async load(): Promise<CharactersTabState> {
    this.state.message = '';
    this.state.messageError = false;
    await this.library.load();
    await this.refreshCast(true);
    this.notify();
    return this.snapshot();
  }

  reload(): Promise<CharactersTabState> {
    return this.load();
  }

  async refreshCast(_force = false): Promise<CastStripState | null> {
    const chatId = this.resolveChatId(false);
    if (!chatId) {
      this.state.chatId = null;
      this.notify();
      return null;
    }
    if (!this.cast || this.cast.chatId !== chatId) {
      this.openCast(chatId, false);
    }
    if (!this.cast) return null;
    this.cast.setLibrary(this.library.getState().characters);
    const result = await this.cast.load();
    this.library.setProject(pinsFromCast(result.cast));
    this.state.chatId = chatId;
    try { this.options.onCastChanged?.(result.cast); } catch { /* optional observer */ }
    this.notify();
    return result;
  }

  async addToProject(characterId: string, chatId?: string): Promise<CastEntry | null> {
    const target = chatId ?? this.resolveChatId(true);
    if (!target) {
      this.setMessage('Start a chat before adding a character to a project.', true);
      return null;
    }
    try {
      if (!this.cast || this.cast.chatId !== target) this.openCast(target, false);
      const result = await this.library.addToProject(characterId, target);
      const entry = (result as { entry?: CastEntry } | null)?.entry ?? null;
      this.setMessage(`${characterId} added to the project.`);
      await this.refreshCast(true);
      return entry;
    } catch (error) {
      this.setMessage(`Could not add ${characterId} to the project: ${messageOf(error)}`, true);
      return null;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
    this.unsubscribeLibrary?.();
    this.unsubscribeLibrary = null;
    this.cast?.destroy();
    this.cast = null;
    this.library.destroy();
  }
}

export function createCharactersTab(options: CharactersTabOptions): CharactersTabController {
  return new CharactersTabController(options);
}

export const createCharactersController = createCharactersTab;
export const CharactersController = CharactersTabController;

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 400);
  const text = String(error ?? '').trim();
  return text ? text.slice(0, 400) : 'Unexpected error';
}

const TAB_SKELETON = `<section class="chr-tab-shell drawer" data-characters-tab>
  <header class="chr-tab-head drawer-header">
    <div>
      <h1>Characters</h1>
      <p class="chr-hint">Define a character once, then reuse it in every video. The chat agent proposes placements; you confirm them.</p>
    </div>
    <button type="button" class="chr-btn chr-btn-quiet btn btn-ghost btn-sm" data-characters-close aria-label="Close characters">Close</button>
  </header>
  <div class="chr-tab-body drawer-body">
    <div class="chr-tab-library" data-characters-library-host></div>
    <div class="chr-tab-editor" data-character-editor-host hidden></div>
  </div>
</section>`;

export type MountCharactersTabOptions = CharactersTabOptions & {
  /** Root panel. May also be passed as the first argument. */
  root?: HTMLElement;
  /** Optional tab button that toggles the panel. */
  tab?: HTMLElement | null;
  /** Optional host for the project cast strip above the chat composer. */
  castStripHost?: HTMLElement | null;
  idPrefix?: string;
  open?: boolean;
  onSaved?: (character: Character) => void;
  onOpenCharacter?: (character: Character) => void;
};

export type CharactersTabHandle = {
  controller: CharactersTabController;
  library: LibraryMountHandle;
  cast: CastStripHandle | null;
  refresh: () => Promise<void>;
  refreshCast: () => Promise<void>;
  addToProject: (characterId: string) => Promise<CastEntry | null>;
  open: () => void;
  close: () => void;
  openCharacter: (character: Character | string) => Promise<void>;
  setChatId: (chatId: string | null | undefined) => void;
  destroy: () => void;
};

type RootLike = HTMLElement | MountCharactersTabOptions;

function isElement(value: unknown): value is HTMLElement {
  return Boolean(value)
    && typeof value === 'object'
    && (typeof (value as HTMLElement).addEventListener === 'function')
    && !('api' in (value as Record<string, unknown>));
}

function resolveRoot(rootOrOptions: RootLike, maybeOptions?: MountCharactersTabOptions): { root: HTMLElement; options: MountCharactersTabOptions } {
  if (isElement(rootOrOptions)) {
    if (!maybeOptions) throw new TypeError('mountCharactersTab requires options');
    return { root: rootOrOptions, options: maybeOptions };
  }
  const options = rootOrOptions as MountCharactersTabOptions;
  if (options.root) return { root: options.root, options };
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) throw new TypeError('mountCharactersTab requires a root element');
  const root = doc.createElement('section');
  root.id = 'characters-pane';
  root.className = 'pane characters-pane';
  (doc.body ?? doc.documentElement).append(root);
  return { root, options };
}

function query<T extends HTMLElement>(root: HTMLElement, selector: string): T | null {
  const value = typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
  return value as T | null;
}

/**
 * Mount the Characters tab. Supports both `(root, options)` and `(options)`.
 * Only browser hosts touch the DOM; no side effects run at import time.
 */
export function mountCharactersTab(
  rootOrOptions: RootLike,
  maybeOptions?: MountCharactersTabOptions,
): CharactersTabHandle {
  const { root, options } = resolveRoot(rootOrOptions, maybeOptions);
  if (!options.api) throw new TypeError('mountCharactersTab requires an api');

  const controller = new CharactersTabController(options);
  const idPrefix = options.idPrefix ?? 'characters';

  root.classList.add('characters-pane', 'drawer');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Characters');

  // Reset full-screen takeover inline styles so right-side drawer rules take effect
  root.style.inset = '';
  root.style.top = '0';
  root.style.right = '0';
  root.style.bottom = '0';
  root.style.left = 'auto';
  root.style.padding = '0';
  root.style.background = '';
  root.style.overflow = '';

  root.innerHTML = TAB_SKELETON;
  const libraryHost = query<HTMLElement>(root, '[data-characters-library-host]') ?? root;
  const editorHost = query<HTMLElement>(root, '[data-character-editor-host]');
  let editor: EditorMountHandle | null = null;
  let castHandle: CastStripHandle | null = null;
  let castChatId: string | null = null;
  let open = options.open !== false;

  const tab = options.tab ?? null;
  let opener: HTMLElement | null = tab;

  function enhanceLibraryEmpty(): void {
    const emptyEl = libraryHost.querySelector<HTMLElement>('[data-empty]');
    if (!emptyEl || emptyEl.classList.contains('empty-state')) return;
    emptyEl.className = 'empty-state chr-empty';
    emptyEl.innerHTML = `
      <span class="empty-state-icon" aria-hidden="true">👤</span>
      <h3 class="empty-state-title">No characters yet</h3>
      <p class="empty-state-line">Create one to reuse it across videos.</p>
      <div class="empty-state-cta">
        <button type="button" class="btn btn-primary btn-sm chr-btn chr-btn-primary" data-new-character>Create character</button>
      </div>
    `;
  }

  function setOpen(value: boolean): void {
    if (open === value) return;
    open = value;
    root.hidden = !open;
    if (tab) {
      tab.setAttribute('aria-selected', open ? 'true' : 'false');
      tab.setAttribute('aria-expanded', open ? 'true' : 'false');
      tab.classList?.toggle?.('active', open);
    }
    if (open) {
      if (typeof document !== 'undefined' && document.activeElement && document.activeElement !== document.body && document.activeElement !== root) {
        opener = document.activeElement as HTMLElement;
      } else if (tab) {
        opener = tab;
      }
      void refreshCast();
      enhanceLibraryEmpty();
      try {
        const closeBtn = query<HTMLElement>(root, '[data-characters-close]');
        const focusable = closeBtn ?? root.querySelector<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])');
        focusable?.focus();
      } catch {
        /* ignore in non-browser env */
      }
    } else {
      if (opener && typeof opener.focus === 'function') {
        try {
          opener.focus();
        } catch {
          /* ignore */
        }
      }
    }
  }

  function setLibraryMessage(message: string, error = false): void {
    const target = libraryHandle.controller;
    target.state.message = message;
    target.state.error = error ? message : '';
    target.notify();
  }

  function closeEditor(): void {
    editor?.destroy();
    editor = null;
    if (editorHost) {
      editorHost.hidden = true;
      editorHost.innerHTML = '';
    }
    controller.state.view = 'library';
    controller.state.selectedId = '';
    controller.notify();
  }

  function openEditor(character: Character | null): void {
    if (!editorHost) return;
    closeEditor();
    editorHost.hidden = false;
    controller.state.view = 'editor';
    controller.state.selectedId = character?.id ?? '';
    editor = mountCharacterEditor(editorHost, {
      api: options.api as unknown as CharacterEditorApi,
      character,
      ...(options.voiceOptions ? { voiceOptions: options.voiceOptions } : {}),
      ...(options.apiFetch ? { apiFetch: options.apiFetch } : {}),
      onClose: closeEditor,
      onSaved: saved => {
        void libraryHandle.reload();
        try { options.onSaved?.(saved); } catch { /* optional observer */ }
        options.log?.(`Saved character ${saved.name || saved.id} v${saved.revision}`);
      },
    });
    controller.notify();
  }

  async function openCharacter(character: Character | string): Promise<void> {
    if (typeof character !== 'string') {
      try { options.onOpenCharacter?.(character); } catch { /* optional observer */ }
      openEditor(character);
      return;
    }
    const known = controller.library.getState().characters.find(item => item.id === character) ?? null;
    if (known) {
      try { options.onOpenCharacter?.(known); } catch { /* optional observer */ }
      openEditor(known);
      return;
    }
    try {
      const loader = (options.api as CharacterEditorApi).get;
      const loaded = typeof loader === 'function'
        ? await loader.call(options.api, character)
        : null;
      if (loaded) {
        try { options.onOpenCharacter?.(loaded); } catch { /* optional observer */ }
        openEditor(loaded);
      } else {
        setLibraryMessage('That character could not be found.', true);
      }
    } catch (error) {
      setLibraryMessage(`Could not open the character: ${messageOf(error)}`, true);
    }
  }

  async function refreshCast(): Promise<void> {
    const host = options.castStripHost;
    if (!host) return;
    const chatId = controller.resolveChatId(false);
    if (!chatId) {
      if (castHandle) {
        castHandle.destroy();
        castHandle = null;
        castChatId = null;
      }
      controller.cast = null;
      controller.state.chatId = null;
      host.innerHTML = `<section class="cast-strip panel" data-cast-strip>
        <div class="empty-state cast-empty" data-cast-empty>
          <span class="empty-state-icon" aria-hidden="true">💬</span>
          <h3 class="empty-state-title">No characters in this project yet</h3>
          <p class="empty-state-line">Start a chat to add characters to the project.</p>
        </div>
      </section>`;
      return;
    }
    if (!castHandle || castChatId !== chatId) {
      castHandle?.destroy();
      castChatId = chatId;
      castHandle = mountCastStrip(host, {
        api: options.api,
        chatId,
        library: libraryHandle?.controller.getState().characters ?? controller.library.getState().characters,
        idPrefix: `${idPrefix}-cast`,
      });
    }
    castHandle.controller.setLibrary(libraryHandle.controller.getState().characters);
    await castHandle.refresh();
    const state = castHandle.controller.getState();
    const pins = pinsFromCast(state.cast);
    controller.library.setProject(pins);
    libraryHandle.controller.setProject(pins);
    controller.cast = castHandle.controller;
    controller.state.chatId = chatId;
    controller.notify();
    try { options.onCastChanged?.(state.cast); } catch { /* optional observer */ }
  }

  async function addToProject(characterId: string): Promise<CastEntry | null> {
    const chatId = controller.resolveChatId(true);
    if (!chatId) {
      setLibraryMessage('Start a chat before adding a character to a project.', true);
      return null;
    }
    try {
      const result = await libraryHandle.controller.addToProject(characterId, chatId);
      const entry = (result as { entry?: CastEntry } | null)?.entry ?? null;
      setLibraryMessage('');
      await refreshCast();
      options.log?.(`Added a character to the project cast`);
      return entry;
    } catch (error) {
      setLibraryMessage(`Could not add the character: ${messageOf(error)}`, true);
      return null;
    }
  }

  const libraryHandle = mountCharacterLibrary(libraryHost, {
    api: options.api,
    loadThumbs: options.loadThumbs ?? true,
    ...(options.project ? { project: options.project } : {}),
    onOpen: character => { void openCharacter(character); },
    onNew: () => openEditor(null),
    onAddToProject: character => { void addToProject(character.id); },
  });

  const unsubscribeLibrarySync = libraryHandle.controller.subscribe(() => {
    const state = libraryHandle.controller.getState();
    controller.library.setCharacters(state.characters);
    controller.library.setProject(state.project);
    enhanceLibraryEmpty();
  });

  const onRootClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('[data-characters-close]')) {
      setOpen(false);
      return;
    }
  };

  const onKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Escape') return;
    if (editor) {
      (event as KeyboardEvent).preventDefault?.();
      (event as KeyboardEvent).stopPropagation?.();
      closeEditor();
      try {
        const newBtn = libraryHost.querySelector<HTMLElement>('[data-new-character]');
        newBtn?.focus();
      } catch {
        /* ignore */
      }
    } else if (open) {
      (event as KeyboardEvent).preventDefault?.();
      (event as KeyboardEvent).stopPropagation?.();
      setOpen(false);
    }
  };

  const onDocClick = (event: Event) => {
    if (!open) return;
    const target = (event as MouseEvent).target as Node | null;
    if (!target) return;
    if (root.contains(target)) return;
    if (tab && (tab === target || tab.contains(target))) return;
    const castHost = options.castStripHost;
    if (castHost && castHost.contains(target)) return;
    setOpen(false);
  };

  const onTabClick = () => {
    opener = tab;
    setOpen(!open);
  };

  const onCastClick = (event: Event) => {
    const target = (event as MouseEvent).target as HTMLElement | null;
    if (target?.closest?.('[data-cast-open-characters]')) {
      opener = target.closest<HTMLElement>('[data-cast-open-characters]') ?? tab ?? null;
      setOpen(true);
    }
  };

  const onCastCustom = () => {
    opener = tab ?? null;
    setOpen(true);
  };

  root.addEventListener('click', onRootClick);
  root.addEventListener('keydown', onKeyDown);
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onDocClick);
  }
  tab?.addEventListener('click', onTabClick);
  if (options.castStripHost) {
    options.castStripHost.addEventListener('click', onCastClick);
    options.castStripHost.addEventListener('cast:open-characters', onCastCustom);
  }

  setOpen(open);
  enhanceLibraryEmpty();
  void refreshCast();

  return {
    controller,
    library: libraryHandle,
    get cast() { return castHandle; },
    refresh: async () => {
      await libraryHandle.reload();
      await refreshCast();
    },
    refreshCast,
    addToProject,
    open: () => setOpen(true),
    close: () => setOpen(false),
    openCharacter,
    setChatId: chatId => {
      controller.setChatId(chatId);
      void refreshCast();
    },
    destroy: () => {
      root.removeEventListener('click', onRootClick);
      root.removeEventListener('keydown', onKeyDown);
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('click', onDocClick);
      }
      tab?.removeEventListener('click', onTabClick);
      if (options.castStripHost) {
        options.castStripHost.removeEventListener('click', onCastClick);
        options.castStripHost.removeEventListener('cast:open-characters', onCastCustom);
      }
      editor?.destroy();
      castHandle?.destroy();
      unsubscribeLibrarySync();
      libraryHandle.destroy();
      controller.cast = null;
      controller.destroy();
      root.innerHTML = '';
    },
  };
}

export const mountCharacters = mountCharactersTab;
export const mountCharacterTab = mountCharactersTab;
export const mountCharacterCreator = mountCharactersTab;
export const mountCharactersPanel = mountCharactersTab;
export const mountCharacterWorkspace = mountCharactersTab;

export const renderCharacters = renderCharactersTab;
export const renderCharacterTab = renderCharactersTab;
export const renderCharacterCreator = renderCharactersTab;
export const renderCharactersPanel = renderCharactersTab;
export default mountCharactersTab;
