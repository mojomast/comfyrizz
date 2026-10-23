import { COPY } from '../copy.ts';
import { escapeHtml } from '../components.ts';
import {
  mountVoicePick,
  renderVoicePick,
  voicesFromOptions,
  type MountedVoicePick,
  type VoiceChoice,
  type VoiceFetch,
} from '../voice-pick.ts';
import { castMemberFromEntry } from '../steps/characters.ts';
import type { EasyCastMember } from '../types.ts';
import type {
  CharacterApi,
  CharacterInput,
  CharacterRole,
  CharacterVoice,
} from '../../characters/api.ts';

const CREATE_ERROR_TEXT = "Couldn't create the character. Try again.";

export const QUICK_CHARACTER_ROLES: readonly CharacterRole[] = [
  'protagonist',
  'supporting',
  'mascot',
  'narrator',
  'presenter',
  'extra',
];

export interface QuickCharacterVoiceChoice {
  id?: string | null;
  voice?: string | null;
  engine?: string | null;
}

export interface QuickCharacterForm {
  name?: string | null;
  role?: CharacterRole | string | null;
  look?: string | null;
  fictional?: boolean;
  voice?: QuickCharacterVoiceChoice | null;
}

export interface QuickCharacterOptions {
  api: CharacterApi;
  chatId: string;
  opener?: HTMLElement | null;
  voices?: unknown;
  apiFetch?: VoiceFetch;
  onOpenLibrary?: (opener: HTMLElement | null) => void;
}

export interface RenderQuickCharacterOptions {
  idPrefix?: string;
  voices?: unknown;
  role?: CharacterRole;
}

export interface QuickCharacterControlForm {
  name?: string | null;
  fictional?: boolean;
}

function roleLabel(role: CharacterRole | string | null | undefined): string {
  const roles = COPY.characters.roles as Record<string, string>;
  return roles[String(role ?? '')] ?? roles.supporting;
}

function safeRole(role: unknown): CharacterRole {
  return QUICK_CHARACTER_ROLES.includes(role as CharacterRole)
    ? role as CharacterRole
    : 'supporting';
}

function voicePayload(voice: QuickCharacterVoiceChoice | null | undefined): CharacterVoice | null {
  const rawId = voice?.voice ?? voice?.id;
  const id = String(rawId ?? '').trim();
  if (!id) return null;
  const engine: CharacterVoice['engine'] = voice?.engine === 'qwen3-tts' || voice?.engine === 'kokoro'
    ? voice.engine
    : 'kokoro';
  return { engine, voice: id, sampleLines: [] };
}

export function quickCharacterPayload(
  form: QuickCharacterForm,
): CharacterInput & { kind: 'fictional' } {
  const look = String(form?.look ?? '').trim();
  const payload: CharacterInput & { kind: 'fictional' } = {
    name: String(form?.name ?? '').trim(),
    role: safeRole(form?.role),
    kind: 'fictional',
    visual: { identityPrompt: look },
  };
  const voice = voicePayload(form?.voice);
  if (voice) payload.voice = voice;
  return payload;
}

export function quickCharacterDisabledReason(
  form: QuickCharacterControlForm,
): string | null {
  if (!String(form?.name ?? '').trim()) return COPY.quickCharacter.needName;
  if (form?.fictional !== true) return COPY.quickCharacter.needFictional;
  return null;
}

function safePrefix(value: unknown): string {
  const prefix = String(value ?? 'easy-quick-character')
    .replace(/[^A-Za-z0-9_-]/g, '-');
  return prefix || 'easy-quick-character';
}

export function renderQuickCharacterForm(
  options: RenderQuickCharacterOptions = {},
): string {
  const prefix = safePrefix(options.idPrefix);
  const nameId = `${prefix}-name`;
  const roleId = `${prefix}-role`;
  const lookId = `${prefix}-look`;
  const pictureId = `${prefix}-picture`;
  const voiceId = `${prefix}-voice`;
  const fictionalId = `${prefix}-fictional`;
  const reasonId = `${prefix}-reason`;
  const errorId = `${prefix}-error`;
  const role = safeRole(options.role ?? 'protagonist');

  const roleOptions = QUICK_CHARACTER_ROLES.map((value) => {
    const selected = value === role ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(roleLabel(value))}</option>`;
  }).join('');

  return `<form class="easy-quick-character" data-easy-quick-form novalidate>
<div class="easy-quick-field">
<label for="${nameId}">${escapeHtml(COPY.quickCharacter.name)}</label>
<input id="${nameId}" name="name" type="text" data-easy-quick-name required aria-required="true" autocomplete="off" />
</div>
<div class="easy-quick-field">
<label for="${roleId}">${escapeHtml(COPY.quickCharacter.role)}</label>
<select id="${roleId}" name="role" data-easy-quick-role>${roleOptions}</select>
</div>
<div class="easy-quick-field">
<label for="${lookId}">${escapeHtml(COPY.quickCharacter.look)}</label>
<textarea id="${lookId}" name="look" data-easy-quick-look rows="3"></textarea>
</div>
<div class="easy-quick-field">
<label for="${pictureId}">${escapeHtml(COPY.quickCharacter.picture)}</label>
<input id="${pictureId}" name="picture" type="file" accept="image/png,image/jpeg,image/webp" data-easy-quick-picture />
</div>
<div class="easy-quick-field easy-quick-voice" data-easy-quick-voice>
${renderVoicePick({
    id: voiceId,
    label: COPY.quickCharacter.voice,
    voices: options.voices,
  })}
</div>
<div class="easy-quick-check">
<input id="${fictionalId}" name="fictional" type="checkbox" data-easy-quick-fictional required aria-required="true" />
<label for="${fictionalId}">${escapeHtml(COPY.quickCharacter.fictional)}</label>
</div>
<p class="easy-quick-more"><a href="#" data-easy-quick-more>${escapeHtml(COPY.quickCharacter.more)}</a></p>
<div class="easy-quick-actions">
<button type="button" class="btn btn-secondary" data-easy-quick-cancel>${escapeHtml(COPY.quickCharacter.cancel)}</button>
<button type="submit" class="btn btn-primary" data-easy-quick-create disabled aria-describedby="${reasonId}">${escapeHtml(COPY.quickCharacter.create)}</button>
</div>
<p class="easy-quick-reason" id="${reasonId}" data-easy-quick-reason role="status">${escapeHtml(COPY.quickCharacter.needName)}</p>
<p class="easy-quick-error" id="${errorId}" data-easy-quick-error role="alert" hidden></p>
</form>`;
}

let quickCharacterCounter = 0;

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; error?: unknown };
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    if (message) return message.slice(0, 400);
    const value = typeof record.error === 'string' ? record.error.trim() : '';
    if (value) return value.slice(0, 400);
  }
  return CREATE_ERROR_TEXT;
}

function openEditorLibrary(opener: HTMLElement | null, callback?: (opener: HTMLElement | null) => void): void {
  if (typeof callback === 'function') {
    callback(opener);
    return;
  }
  const doc = opener?.ownerDocument ?? globalThis.document;
  if (!doc) return;
  const tab = doc.getElementById('characters-tab') as HTMLElement | null;
  if (tab && typeof tab.click === 'function') {
    tab.click();
    return;
  }
  doc.dispatchEvent(new CustomEvent('cast:open-characters', { bubbles: true }));
}

export function openQuickCharacter({
  api,
  chatId,
  opener = null,
  voices,
  apiFetch,
  onOpenLibrary,
}: QuickCharacterOptions): Promise<EasyCastMember | null> {
  const doc = opener?.ownerDocument ?? globalThis.document;
  if (!doc || !doc.body) return Promise.resolve(null);

  let resolve: (value: EasyCastMember | null) => void = () => {};
  const promise = new Promise<EasyCastMember | null>((done) => {
    resolve = done;
  });

  let settled = false;
  let busy = false;
  const dialogId = `easy-quick-character-${++quickCharacterCounter}`;
  const titleId = `${dialogId}-title`;

  const dialog = doc.createElement('dialog');
  dialog.className = 'easy-dialog easy-quick-character-dialog';
  dialog.id = dialogId;
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.innerHTML = `<h2 class="easy-dialog-title" id="${titleId}">${escapeHtml(COPY.quickCharacter.title)}</h2>
${renderQuickCharacterForm({ idPrefix: dialogId, voices })}`;

  const form = dialog.querySelector<HTMLFormElement>('[data-easy-quick-form]');
  const nameInput = dialog.querySelector<HTMLInputElement>('[data-easy-quick-name]');
  const roleSelect = dialog.querySelector<HTMLSelectElement>('[data-easy-quick-role]');
  const lookInput = dialog.querySelector<HTMLTextAreaElement>('[data-easy-quick-look]');
  const pictureInput = dialog.querySelector<HTMLInputElement>('[data-easy-quick-picture]');
  const fictionalInput = dialog.querySelector<HTMLInputElement>('[data-easy-quick-fictional]');
  const createButton = dialog.querySelector<HTMLButtonElement>('[data-easy-quick-create]');
  const cancelButton = dialog.querySelector<HTMLButtonElement>('[data-easy-quick-cancel]');
  const reasonNode = dialog.querySelector<HTMLElement>('[data-easy-quick-reason]');
  const errorNode = dialog.querySelector<HTMLElement>('[data-easy-quick-error]');
  const moreLink = dialog.querySelector<HTMLAnchorElement>('[data-easy-quick-more]');
  const voiceHost = dialog.querySelector<HTMLElement>('[data-easy-quick-voice]');

  const voiceChoices: VoiceChoice[] = voicesFromOptions(voices);
  let voicePicker: MountedVoicePick | null = null;

  if (voiceHost) {
    voicePicker = mountVoicePick(voiceHost, {
      id: `${dialogId}-voice`,
      label: COPY.quickCharacter.voice,
      voices,
      apiFetch,
      onChange: () => updateCreateState(),
    });
  }

  doc.body.append(dialog);

  function finish(value: EasyCastMember | null): void {
    if (settled) return;
    settled = true;
    try { voicePicker?.destroy(); } catch {}
    voicePicker = null;
    dialog.removeEventListener('cancel', onCancel);
    dialog.removeEventListener('close', onClose);
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

  function currentVoice(): QuickCharacterVoiceChoice | null {
    const id = voicePicker?.getValue()
      ?? dialog.querySelector<HTMLSelectElement>('[data-easy-voice-select]')?.value
      ?? '';
    if (!id) return null;
    const choice = voiceChoices.find((voice) => voice.id === id);
    return choice ?? { id, voice: id };
  }

  function readForm(): QuickCharacterForm {
    return {
      name: nameInput?.value ?? '',
      role: (roleSelect?.value ?? 'supporting') as CharacterRole,
      look: lookInput?.value ?? '',
      fictional: fictionalInput?.checked === true,
      voice: currentVoice(),
    };
  }

  function updateCreateState(): void {
    const reason = quickCharacterDisabledReason(readForm());
    if (createButton) createButton.disabled = reason !== null || busy;
    if (reasonNode) {
      reasonNode.textContent = reason ?? '';
      reasonNode.hidden = reason === null;
    }
  }

  function showError(error: unknown): void {
    if (!errorNode) return;
    errorNode.textContent = errorText(error);
    errorNode.hidden = false;
  }

  async function submit(): Promise<void> {
    if (busy) return;
    const values = readForm();
    const reason = quickCharacterDisabledReason(values);
    if (reason !== null) {
      updateCreateState();
      return;
    }

    busy = true;
    if (createButton) {
      createButton.disabled = true;
      createButton.setAttribute('aria-busy', 'true');
    }
    if (errorNode) {
      errorNode.textContent = '';
      errorNode.hidden = true;
    }

    try {
      const character = await api.create(quickCharacterPayload(values), { fictional: true });
      const picture = pictureInput?.files?.[0] ?? null;
      if (picture) {
        await api.uploadImage(character.id, picture, {
          primary: true,
          filename: picture.name,
        });
      }
      const added = await api.addCast(chatId, character.id);
      finish(castMemberFromEntry(added.entry));
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      if (createButton) {
        createButton.removeAttribute('aria-busy');
        if (dialog.isConnected) updateCreateState();
      }
    }
  }

  function onInput(): void {
    updateCreateState();
  }

  function onSubmit(event: Event): void {
    event.preventDefault();
    void submit();
  }

  function onCancelClick(): void {
    finish(null);
  }

  function onMoreClick(event: Event): void {
    event.preventDefault();
    const target = opener;
    finish(null);
    openEditorLibrary(target, onOpenLibrary);
  }

  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onClose);
  form?.addEventListener('submit', onSubmit);
  nameInput?.addEventListener('input', onInput);
  roleSelect?.addEventListener('change', onInput);
  lookInput?.addEventListener('input', onInput);
  fictionalInput?.addEventListener('change', onInput);
  cancelButton?.addEventListener('click', onCancelClick);
  moreLink?.addEventListener('click', onMoreClick);

  updateCreateState();
  dialog.showModal();
  nameInput?.focus();

  return promise;
}

export default openQuickCharacter;
