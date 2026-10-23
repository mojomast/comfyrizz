import { COPY } from '../copy.ts';
import { escapeHtml } from '../components.ts';
import type {
  AddCastResult,
  Character,
  CharacterApi,
} from '../../characters/api.ts';

const LOADING_TEXT = 'Loading your characters…';
const LOAD_ERROR_TEXT = "Couldn't load your characters.";
const ADD_ERROR_TEXT = "Couldn't add that character. Try again.";

let libraryDialogCounter = 0;

export interface LibraryPickerOptions {
  api: CharacterApi;
  chatId: string;
  opener?: HTMLElement | null;
}

export interface NamedCharacter {
  name?: string | null;
}

export function filterCharacters<T extends NamedCharacter>(
  characters: readonly T[],
  query: string,
): T[] {
  const term = String(query ?? '').trim().toLowerCase();
  const list = Array.isArray(characters) ? characters : [];
  if (!term) return [...list];
  return list.filter((character) => String(character?.name ?? '').toLowerCase().includes(term));
}

function roleLabel(role: unknown): string {
  const roles = COPY.characters.roles as Record<string, string>;
  return roles[String(role ?? '')] ?? '';
}

function displayName(character: Pick<Character, 'name'>): string {
  const name = String(character?.name ?? '').trim();
  return name || 'Character';
}

function initialFor(name: string): string {
  return name.slice(0, 1).toUpperCase() || '?';
}

export function renderLibraryItem(character: Character): string {
  const id = escapeHtml(character.id);
  const name = displayName(character);
  const role = roleLabel(character.role);
  return `<li class="easy-library-item" data-library-character="${id}">
<span class="easy-library-media">
<img class="easy-library-thumb" data-library-thumb="${id}" alt="" loading="lazy" decoding="async" hidden />
<span class="easy-library-thumb-empty" data-library-thumb-empty="${id}" aria-hidden="true">${escapeHtml(initialFor(name))}</span>
</span>
<span class="easy-library-text">
<span class="easy-library-name">${escapeHtml(name)}</span>
<span class="easy-library-role">${escapeHtml(role)}</span>
</span>
<button type="button" class="btn btn-secondary easy-library-add" data-library-add="${id}" aria-label="Add ${escapeHtml(name)}">${escapeHtml(COPY.characters.pickerAdd)}</button>
</li>`;
}

export function openLibraryPicker({
  api,
  chatId,
  opener,
}: LibraryPickerOptions): Promise<AddCastResult | null> {
  const doc = opener?.ownerDocument ?? globalThis.document;
  if (!doc) return Promise.resolve(null);

  let characters: Character[] = [];
  let settled = false;
  let resolve: (value: AddCastResult | null) => void = () => {};
  const objectUrls: string[] = [];
  const promise = new Promise<AddCastResult | null>((done) => {
    resolve = done;
  });

  const dialog = doc.createElement('dialog');
  const dialogId = `easy-library-picker-${++libraryDialogCounter}`;
  const titleId = `${dialogId}-title`;
  const searchId = `${dialogId}-search`;
  dialog.className = 'easy-dialog easy-library-dialog';
  dialog.id = dialogId;
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.innerHTML = `<h2 class="easy-dialog-title" id="${titleId}">${escapeHtml(COPY.characters.pickerTitle)}</h2>
<label class="easy-library-search" for="${searchId}">${escapeHtml(COPY.characters.pickerSearch)}
<input id="${searchId}" type="search" data-library-search autocomplete="off" />
</label>
<p class="easy-library-status" data-library-status role="status" aria-live="polite">${escapeHtml(LOADING_TEXT)}</p>
<ul class="easy-library-list" data-library-list></ul>
<div class="easy-dialog-actions">
<button type="button" class="btn btn-secondary" data-library-cancel>${escapeHtml(COPY.quickCharacter.cancel)}</button>
</div>`;

  const searchInput = dialog.querySelector<HTMLInputElement>('[data-library-search]');
  const list = dialog.querySelector<HTMLElement>('[data-library-list]');
  const status = dialog.querySelector<HTMLElement>('[data-library-status]');

  function imageFor(id: string): HTMLImageElement | null {
    for (const image of dialog.querySelectorAll<HTMLImageElement>('img[data-library-thumb]')) {
      if (image.getAttribute('data-library-thumb') === id) return image;
    }
    return null;
  }

  function emptyFor(id: string): HTMLElement | null {
    for (const item of dialog.querySelectorAll<HTMLElement>('[data-library-thumb-empty]')) {
      if (item.getAttribute('data-library-thumb-empty') === id) return item;
    }
    return null;
  }

  function revokeObjectUrls(): void {
    if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.length = 0;
  }

  function paintList(): void {
    if (!list) return;
    const filtered = filterCharacters(characters, searchInput?.value ?? '');
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = filtered.length
      ? filtered.map(renderLibraryItem).join('')
      : `<li class="easy-library-empty">${escapeHtml(COPY.characters.pickerEmpty)}</li>`;
    void loadThumbnails(filtered);
  }

  async function loadThumbnails(items: readonly Character[]): Promise<void> {
    const fetchThumb = api.primaryThumb;
    if (typeof fetchThumb !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return;
    }
    for (const character of items) {
      try {
        const blob = await fetchThumb.call(api, character.id);
        if (settled || !blob) continue;
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        const image = imageFor(character.id);
        if (!image) continue;
        image.src = url;
        image.hidden = false;
        const empty = emptyFor(character.id);
        if (empty) empty.hidden = true;
      } catch {
        continue;
      }
    }
  }

  async function loadCharacters(): Promise<void> {
    if (list) list.setAttribute('aria-busy', 'true');
    try {
      characters = await api.listCharacters();
      if (settled) return;
      if (status) status.textContent = '';
      paintList();
    } catch {
      if (settled) return;
      if (status) status.textContent = LOAD_ERROR_TEXT;
      if (list) {
        list.setAttribute('aria-busy', 'false');
        list.innerHTML = '';
      }
    }
  }

  function finish(value: AddCastResult | null): void {
    if (settled) return;
    settled = true;
    dialog.removeEventListener('cancel', onCancel);
    dialog.removeEventListener('close', onClose);
    dialog.removeEventListener('click', onClick);
    searchInput?.removeEventListener('input', onInput);
    revokeObjectUrls();
    if (dialog.open) dialog.close();
    dialog.remove();
    if (opener && typeof opener.focus === 'function') opener.focus();
    resolve(value);
  }

  function onCancel(event: Event): void {
    event.preventDefault();
    finish(null);
  }

  function onClose(): void {
    finish(null);
  }

  function onInput(): void {
    paintList();
  }

  function onClick(event: Event): void {
    const target = event.target as Element | null;
    const button = target && 'closest' in target ? target.closest<HTMLButtonElement>('button') : null;
    if (!button) return;
    if (button.matches('[data-library-cancel]')) {
      finish(null);
      return;
    }
    const characterId = button.getAttribute('data-library-add');
    if (!characterId) return;
    button.disabled = true;
    if (status) status.textContent = '';
    api.addCast(chatId, characterId).then(
      (result) => finish(result),
      () => {
        if (settled) return;
        button.disabled = false;
        if (status) status.textContent = ADD_ERROR_TEXT;
      },
    );
  }

  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onClose);
  dialog.addEventListener('click', onClick);
  searchInput?.addEventListener('input', onInput);
  doc.body.append(dialog);
  dialog.showModal();
  searchInput?.focus();
  void loadCharacters();

  return promise;
}
