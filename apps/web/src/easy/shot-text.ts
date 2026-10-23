import { COPY } from './copy.ts';
import { escapeHtml } from './components.ts';

export const SHOT_TEXT_MAX_HEADLINE = 80;
export const SHOT_TEXT_DEBOUNCE_MS = 400;

export interface ShotTextScene {
  id?: unknown;
  copy?: { headline?: unknown; [key: string]: unknown } | null;
  headline?: unknown;
  narration?: unknown;
  narration_text?: unknown;
  [key: string]: unknown;
}

export interface ShotTextPatch {
  headline?: string;
  narration?: string;
}

export interface SetSceneCopyCommand {
  type: 'SetSceneCopy';
  sceneId: string;
  copy: { headline: string };
}

export interface SetNarrationTextCommand {
  type: 'SetNarrationText';
  sceneId: string;
  text: string;
}

export type ShotTextCommand = SetSceneCopyCommand | SetNarrationTextCommand;

export interface ShotTextStore {
  dispatch(command: ShotTextCommand | ShotTextCommand[]): unknown;
  [key: string]: unknown;
}

export interface ShotTextHost {
  editorStore?: ShotTextStore | null;
  dispatch?: ShotTextStore['dispatch'];
  refreshNarration?(sceneId: string): unknown;
  remakeVoice?(sceneId: string): unknown;
  makeVoiceAgain?(sceneId: string): unknown;
  regenerateNarration?(sceneId: string): unknown;
  narrationRefresh?(sceneId: string): unknown;
  [key: string]: unknown;
}

export interface ShotTextBindOptions {
  host: ShotTextHost;
  sceneId: string;
  debounceMs?: number;
}

type NarrationRefresh = (sceneId: string) => unknown;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sceneKey(scene: ShotTextScene | null | undefined): string {
  const id = textOf(scene?.id);
  return (id || 'current').replace(/[^A-Za-z0-9_-]/g, '-');
}

function headlineOf(scene: ShotTextScene | null | undefined): string {
  const copy = scene?.copy;
  if (copy && typeof copy === 'object' && !Array.isArray(copy)) {
    const headline = textOf(copy.headline);
    if (headline !== '') return headline;
  }
  return textOf(scene?.headline);
}

function narrationOf(scene: ShotTextScene | null | undefined): string {
  const narration = scene?.narration;
  if (typeof narration === 'string') return narration;
  if (narration && typeof narration === 'object' && !Array.isArray(narration)) {
    const text = textOf((narration as { text?: unknown }).text);
    if (text !== '') return text;
  }
  return textOf(scene?.narration_text);
}

export function shotTextCommands(sceneId: string, patch: ShotTextPatch = {}): ShotTextCommand[] {
  const id = String(sceneId ?? '');
  const commands: ShotTextCommand[] = [];
  if (patch.headline !== undefined) {
    commands.push({
      type: 'SetSceneCopy',
      sceneId: id,
      copy: { headline: textOf(patch.headline) },
    });
  }
  if (patch.narration !== undefined) {
    commands.push({
      type: 'SetNarrationText',
      sceneId: id,
      text: textOf(patch.narration),
    });
  }
  return commands;
}

export function renderShotText(scene: ShotTextScene | null | undefined): string {
  const key = sceneKey(scene);
  const headlineId = `easy-shot-headline-${key}`;
  const narrationId = `easy-shot-narration-${key}`;
  const headline = headlineOf(scene);
  const narration = narrationOf(scene);

  return `<div class="easy-shot-text" data-easy-shot-text>
<label class="easy-shot-text-label" for="${escapeHtml(headlineId)}">${escapeHtml(COPY.plan.onScreen)}</label>
<input class="field-control easy-shot-text-headline" id="${escapeHtml(headlineId)}" type="text" maxlength="${SHOT_TEXT_MAX_HEADLINE}" value="${escapeHtml(headline)}" data-easy-shot-headline />
<label class="easy-shot-text-label" for="${escapeHtml(narrationId)}">${escapeHtml(COPY.plan.narration)}</label>
<textarea class="field-control easy-shot-text-narration" id="${escapeHtml(narrationId)}" rows="3" data-easy-shot-narration>${escapeHtml(narration)}</textarea>
<div class="easy-shot-text-voice" data-easy-voice-note hidden>
<p class="easy-shot-text-note">${escapeHtml(COPY.review.voiceNeedsUpdate)}</p>
<button type="button" class="btn btn-ghost" data-easy-remake-voice>${escapeHtml(COPY.review.remakeVoice)}</button>
</div>
</div>`;
}

function storeOf(host: ShotTextHost | null | undefined): ShotTextStore | null {
  if (!host) return null;
  if (host.editorStore && typeof host.editorStore.dispatch === 'function') return host.editorStore;
  if (typeof host.dispatch === 'function') return host as ShotTextStore;
  return null;
}

function refreshOf(host: ShotTextHost | null | undefined): NarrationRefresh | null {
  if (!host) return null;
  const candidates: unknown[] = [
    host.refreshNarration,
    host.remakeVoice,
    host.makeVoiceAgain,
    host.regenerateNarration,
    host.narrationRefresh,
  ];
  const store = storeOf(host) as Record<string, unknown> | null;
  if (store) {
    candidates.push(
      store.refreshNarration,
      store.remakeVoice,
      store.makeVoiceAgain,
      store.regenerateNarration,
      store.narrationRefresh,
    );
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'function') return candidate as NarrationRefresh;
  }
  return null;
}

export function bindShotText(el: HTMLElement, options: ShotTextBindOptions): () => void {
  const sceneId = String(options.sceneId ?? '');
  const store = storeOf(options.host);
  const input = el.querySelector<HTMLInputElement>('[data-easy-shot-headline]');
  const narration = el.querySelector<HTMLTextAreaElement>('[data-easy-shot-narration]');
  const note = el.querySelector<HTMLElement>('[data-easy-voice-note]');
  const remake = el.querySelector<HTMLElement>('[data-easy-remake-voice]');
  const wait = typeof options.debounceMs === 'number' && options.debounceMs >= 0
    ? options.debounceMs
    : SHOT_TEXT_DEBOUNCE_MS;
  const refresh = refreshOf(options.host);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function dispatch(commands: ShotTextCommand[]): void {
    if (!store || commands.length === 0) return;
    try {
      store.dispatch(commands.length === 1 ? commands[0] : commands);
    } catch {
      return;
    }
  }

  function sendHeadline(): void {
    timer = null;
    if (!input) return;
    dispatch(shotTextCommands(sceneId, { headline: input.value }));
  }

  function onHeadlineInput(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(sendHeadline, wait);
  }

  function onHeadlineChange(): void {
    if (timer === null) return;
    clearTimeout(timer);
    sendHeadline();
  }

  function showVoiceNote(): void {
    if (note) note.removeAttribute('hidden');
    if (!refresh && remake) remake.remove();
  }

  function onNarrationChange(): void {
    if (!narration) return;
    dispatch(shotTextCommands(sceneId, { narration: narration.value }));
    showVoiceNote();
  }

  function onRemakeVoice(event: Event): void {
    event.preventDefault();
    if (!refresh) return;
    try {
      refresh(sceneId);
    } catch {
      return;
    }
  }

  input?.addEventListener('input', onHeadlineInput);
  input?.addEventListener('change', onHeadlineChange);
  narration?.addEventListener('change', onNarrationChange);
  remake?.addEventListener('click', onRemakeVoice);

  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    input?.removeEventListener('input', onHeadlineInput);
    input?.removeEventListener('change', onHeadlineChange);
    narration?.removeEventListener('change', onNarrationChange);
    remake?.removeEventListener('click', onRemakeVoice);
  };
}

export const mountShotText = bindShotText;
