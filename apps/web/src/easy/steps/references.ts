// UR39: reference images on the Idea step.
//
// The seven role ids are hard-coded here. The references panel list is a
// superset, and the Idea step only offers these seven.
// Thumbnails are the IL `thumbnailUrl` when the reference already has one.

import { COPY } from '../copy.ts';
import { escapeHtml } from '../components.ts';
import { confirmDialog } from '../dialog.ts';
import { createReferenceApi, type ReferenceApiFetch } from '../../references/api.ts';

const EASY_REFERENCE_ROLE_IDS = ['style', 'subject', 'character', 'background', 'logo', 'product', 'other'] as const;

export type EasyReferenceRole = (typeof EASY_REFERENCE_ROLE_IDS)[number];

export interface EasyReference {
  id: string;
  name: string;
  role: EasyReferenceRole;
  note: string;
  thumbnailUrl: string | null;
}

export interface EasyReferencesHost {
  createConversation: () => Promise<{ chatId?: string } | null | undefined>;
}

export interface MountEasyReferencesOptions {
  api: EasyReferencesHost;
  apiFetch: ReferenceApiFetch;
  state: { chatId: string | null };
  references?: readonly EasyReference[];
  confirm?: typeof confirmDialog;
  onChange?: (references: EasyReference[]) => void;
  onError?: (error: unknown) => void;
}

const FILE_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#6d8cff" d="M6 2h8l6 6v14H6z"/><path fill="#e6e8ee" d="M14 2v6h6"/></svg>',
)}`;

function isRole(value: unknown): value is EasyReferenceRole {
  return typeof value === 'string' && (EASY_REFERENCE_ROLE_IDS as readonly string[]).includes(value);
}

function roleOf(value: unknown): EasyReferenceRole {
  return isRole(value) ? value : 'other';
}

function fileName(reference: Pick<EasyReference, 'name'>): string {
  const name = reference.name.trim();
  return name || 'image';
}

interface UploadedReference {
  id?: unknown;
  label?: unknown;
  name?: unknown;
  role?: unknown;
  note?: unknown;
  thumbnailUrl?: unknown;
  reference?: UploadedReference;
}

function asRecord(result: unknown): UploadedReference {
  if (!result || typeof result !== 'object') return {};
  const record = result as UploadedReference;
  if (record.reference && typeof record.reference === 'object') return record.reference;
  return record;
}

export function referenceFromRecord(result: unknown): EasyReference {
  const record = asRecord(result);
  const named = typeof record.label === 'string' && record.label
    ? record.label
    : (typeof record.name === 'string' && record.name ? record.name : '');
  const id = typeof record.id === 'string' && record.id ? record.id : 'ref';
  return {
    id,
    name: named || 'image',
    role: roleOf(record.role),
    note: typeof record.note === 'string' ? record.note : '',
    thumbnailUrl: typeof record.thumbnailUrl === 'string' && record.thumbnailUrl ? record.thumbnailUrl : null,
  };
}

function roleOptions(selected: EasyReferenceRole): string {
  return EASY_REFERENCE_ROLE_IDS.map((id) => {
    const label = COPY.references.roles[id];
    const current = id === selected ? ' selected' : '';
    return `<option value="${escapeHtml(id)}"${current}>${escapeHtml(label)}</option>`;
  }).join('');
}

function renderRow(reference: EasyReference): string {
  const id = escapeHtml(reference.id);
  const thumb = reference.thumbnailUrl
    ? `<img class="easy-ref-thumb" alt="" src="${escapeHtml(reference.thumbnailUrl)}" />`
    : `<img class="easy-ref-icon" data-easy-ref-icon alt="" src="${FILE_ICON}" />`;
  return `<li data-easy-ref="${id}">
    ${thumb}
    <span class="easy-ref-name">${escapeHtml(fileName(reference))}</span>
    <label>${escapeHtml(COPY.references.useFor)}
      <select data-easy-ref-role="${id}" aria-label="${escapeHtml(COPY.references.useFor)}">
        ${roleOptions(reference.role)}
      </select>
    </label>
    <label>${escapeHtml(COPY.references.note)}
      <input type="text" data-easy-ref-note="${id}" value="${escapeHtml(reference.note)}" />
    </label>
    <button type="button" data-easy-ref-remove="${id}">${escapeHtml(COPY.references.remove)}</button>
  </li>`;
}

/** Inner HTML for the Idea step's `[data-easy-references]` host. */
export function renderEasyReferences(references: readonly EasyReference[]): string {
  const rows = references.map(renderRow).join('');
  return `<label class="easy-ref-add">${escapeHtml(COPY.references.add)}
      <input type="file" multiple accept="image/*" data-easy-ref-add />
    </label>
    <ul class="easy-ref-list">${rows}</ul>`;
}

function filesFrom(input: EventTarget | null): File[] {
  if (!input || !('files' in input)) return [];
  const list = (input as HTMLInputElement).files;
  if (!list) return [];
  return [...list].filter((file) => !file.type || file.type.startsWith('image/'));
}

export function mountEasyReferences(host: HTMLElement, options: MountEasyReferencesOptions): () => void {
  let references = (options.references ?? []).map((reference) => ({ ...reference }));
  const confirm = options.confirm ?? confirmDialog;
  let referenceApi: ReturnType<typeof createReferenceApi> | null = null;

  function paint(): void {
    host.innerHTML = renderEasyReferences(references);
  }

  function publish(): void {
    options.onChange?.(references.map((reference) => ({ ...reference })));
  }

  async function ensureApi(): Promise<ReturnType<typeof createReferenceApi>> {
    if (!options.state.chatId) {
      const created = await options.api.createConversation();
      const chatId = created?.chatId;
      if (typeof chatId !== 'string' || !chatId) throw new Error('conversation unavailable');
      options.state.chatId = chatId;
    }
    if (!referenceApi) {
      referenceApi = createReferenceApi({
        apiFetch: options.apiFetch,
        chatId: () => options.state.chatId,
      });
    }
    return referenceApi;
  }

  async function onChange(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    try {
      if (target instanceof HTMLInputElement && target.hasAttribute('data-easy-ref-add')) {
        const files = filesFrom(target);
        target.value = '';
        if (!files.length) return;
        const api = await ensureApi();
        for (const file of files) {
          references = [...references, referenceFromRecord(await api.upload(file))];
        }
        paint();
        publish();
        return;
      }
      const roleId = target.getAttribute('data-easy-ref-role');
      if (roleId && target instanceof HTMLSelectElement) {
        const role = roleOf(target.value);
        const api = await ensureApi();
        const updated = referenceFromRecord(await api.patch(roleId, { role }));
        references = references.map((reference) => (reference.id === roleId ? { ...reference, ...updated, role } : reference));
        paint();
        publish();
        return;
      }
      const noteId = target.getAttribute('data-easy-ref-note');
      if (noteId && target instanceof HTMLInputElement) {
        const note = target.value;
        const api = await ensureApi();
        const updated = referenceFromRecord(await api.patch(noteId, { note }));
        references = references.map((reference) => (reference.id === noteId ? { ...reference, ...updated, note } : reference));
        paint();
        publish();
      }
    } catch (error) {
      options.onError?.(error);
    }
  }

  async function onClick(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('[data-easy-ref-remove]');
    if (!(button instanceof HTMLElement)) return;
    const id = button.getAttribute('data-easy-ref-remove');
    if (!id) return;
    const current = references.find((reference) => reference.id === id);
    if (!current) return;
    try {
      const ok = await confirm({
        title: COPY.references.removeTitle,
        text: fileName(current),
        confirmLabel: COPY.references.remove,
        cancelLabel: COPY.quickCharacter.cancel,
        opener: button,
      });
      if (!ok) return;
      const api = await ensureApi();
      await api.delete(id);
      references = references.filter((reference) => reference.id !== id);
      paint();
      publish();
    } catch (error) {
      options.onError?.(error);
    }
  }

  host.addEventListener('change', onChange);
  host.addEventListener('click', onClick);
  paint();
  return () => {
    host.removeEventListener('change', onChange);
    host.removeEventListener('click', onClick);
  };
}
