import { COPY, fill } from './copy.ts';
import { escapeHtml } from './components.ts';
import { openDialog } from './dialog.ts';
import { apiFetch as defaultApiFetch } from '../editor/api.ts';
import type {
  AuditionCandidate,
  AuditionPanelOptions,
} from '../characters/audition-panel.ts';

const PREVIEW_ERROR = "Couldn't play this voice. Try again.";
const KEEP_ACTION = '__easy_voice_keep__';

const ENGINE_NAME = /\b(?:kokoro|qwen(?:3-tts)?)\b/gi;
const LABEL_SEPARATORS = [' · ', ' | ', ' — ', ' – ', ' - ', ', '];

const PREVIEW_KEYS = [
  'previewUrl',
  'preview_url',
  'previewURL',
  'audioUrl',
  'audio_url',
  'audioURL',
  'sampleUrl',
  'sample_url',
  'url',
  'src',
  'href',
];

export interface VoiceChoice {
  id: string;
  voice: string;
  name: string;
  character: string;
  label: string;
  previewUrl: string | null;
  engine: string | null;
  language: string | null;
}

export interface RenderVoicePickOptions {
  id: string;
  label: string;
  voices: unknown;
  value?: string | null;
}

export type VoiceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MountVoicePickOptions extends RenderVoicePickOptions {
  apiFetch?: VoiceFetch;
  openDialog?: typeof openDialog;
  loadPanel?: () => Promise<typeof import('../characters/audition-panel.ts')>;
  onChange?: (voice: VoiceChoice | null) => void;
}

export interface MountedVoicePick {
  getValue(): string;
  setValue(value: string): void;
  destroy(): void;
}

interface ActivePreview {
  audio: HTMLAudioElement;
  url: string | null;
}

let activePreview: ActivePreview | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pickText(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

function cleanDisplay(value: string): string {
  return value
    .replace(ENGINE_NAME, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,·|–—-]+|[\s,·|–—-]+$/g, '')
    .trim();
}

function splitLabel(value: string): { name: string; character: string } {
  const label = value.trim();
  for (const separator of LABEL_SEPARATORS) {
    const index = label.indexOf(separator);
    if (index <= 0) continue;
    const name = label.slice(0, index).trim();
    const character = label.slice(index + separator.length).trim();
    if (name) return { name, character };
  }
  return { name: label, character: '' };
}

function capitaliseName(value: string): string {
  if (!value) return '';
  if (value !== value.toLowerCase()) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function joinLabel(name: string, character: string): string {
  return character ? `${name}, ${character}` : name;
}

function previewUrlFrom(
  record: Record<string, unknown>,
  nested: Record<string, unknown> | null,
): string | null {
  const direct = pickText(record, PREVIEW_KEYS);
  if (direct) return direct;
  for (const key of ['preview', 'audio', 'sample']) {
    const child = asRecord(record[key]);
    if (!child) continue;
    const found = pickText(child, PREVIEW_KEYS);
    if (found) return found;
  }
  if (nested) {
    const nestedUrl = pickText(nested, PREVIEW_KEYS);
    if (nestedUrl) return nestedUrl;
    for (const key of ['preview', 'audio', 'sample']) {
      const child = asRecord(nested[key]);
      if (!child) continue;
      const found = pickText(child, PREVIEW_KEYS);
      if (found) return found;
    }
  }
  return null;
}

export function normalizeVoice(value: unknown): VoiceChoice | null {
  if (typeof value === 'string') {
    const parsed = splitLabel(cleanDisplay(value));
    const name = capitaliseName(parsed.name);
    if (!name) return null;
    return {
      id: name,
      voice: name,
      name,
      character: parsed.character,
      label: joinLabel(name, parsed.character),
      previewUrl: null,
      engine: null,
      language: null,
    };
  }

  const record = asRecord(value);
  if (!record) return null;

  const nested = asRecord(record.voice);
  const rawLabel = cleanDisplay(pickText(record, [
    'label',
    'displayLabel',
    'display_label',
    'voiceLabel',
    'voice_label',
  ]));
  const labelParts = splitLabel(rawLabel);

  let name = cleanDisplay(pickText(record, [
    'displayName',
    'display_name',
    'name',
    'voiceName',
    'voice_name',
    'title',
    'voiceLabel',
    'voice_label',
  ]));
  let character = cleanDisplay(pickText(record, [
    'character',
    'characterLabel',
    'character_label',
    'persona',
    'style',
    'tone',
    'accent',
    'delivery',
    'description',
  ]));

  const nestedName = nested ? cleanDisplay(pickText(nested, [
    'displayName',
    'display_name',
    'name',
    'displayLabel',
    'display_label',
    'label',
    'title',
  ])) : '';
  const nestedCharacter = nested ? cleanDisplay(pickText(nested, [
    'character',
    'characterLabel',
    'character_label',
    'persona',
    'style',
    'tone',
    'accent',
    'delivery',
    'description',
  ])) : '';

  if (!name) name = nestedName || labelParts.name;
  if (!character) character = nestedCharacter || labelParts.character;

  if (name && !character) {
    const splitName = splitLabel(name);
    if (splitName.character) {
      name = splitName.name;
      character = splitName.character;
    }
  }

  name = capitaliseName(name);

  const directId = pickText(record, [
    'id',
    'voiceId',
    'voice_id',
    'candidateId',
    'candidate_id',
    'presetId',
    'preset_id',
  ]);
  const nestedId = nested ? pickText(nested, [
    'id',
    'voiceId',
    'voice_id',
    'candidateId',
    'candidate_id',
    'voice',
  ]) : '';
  const voiceValue = typeof record.voice === 'string' ? record.voice.trim() : '';
  const id = directId || nestedId || voiceValue || name;
  const voice = nested
    ? (pickText(nested, ['voice', 'voiceId', 'voice_id', 'id']) || id)
    : (voiceValue || id);

  if (!id) return null;
  const displayName = name || id;

  return {
    id,
    voice: voice || id,
    name: displayName,
    character,
    label: joinLabel(displayName, character),
    previewUrl: previewUrlFrom(record, nested),
    engine: pickText(record, ['engine', 'voiceEngine', 'voice_engine'])
      || (nested ? pickText(nested, ['engine', 'voiceEngine', 'voice_engine']) : '')
      || null,
    language: pickText(record, ['language', 'lang'])
      || (nested ? pickText(nested, ['language', 'lang']) : '')
      || null,
  };
}

function dedupeVoices(values: readonly VoiceChoice[]): VoiceChoice[] {
  const result: VoiceChoice[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.id || value.label;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeList(values: readonly unknown[]): VoiceChoice[] {
  const parsed: VoiceChoice[] = [];
  for (const value of values) {
    const voice = normalizeVoice(value);
    if (voice) parsed.push(voice);
  }
  return dedupeVoices(parsed);
}

export function voicesFromOptions(value: unknown): VoiceChoice[] {
  if (Array.isArray(value)) return normalizeList(value);

  const record = asRecord(value);
  if (!record) return [];

  const values: unknown[] = [];
  for (const key of ['voices', 'options', 'presets', 'kokoroVoices', 'qwenSpeakers', 'speakers']) {
    const list = record[key];
    if (Array.isArray(list)) values.push(...list);
  }
  if (values.length) return normalizeList(values);

  const single = normalizeVoice(value);
  return single ? [single] : [];
}

function selectedFor(voices: readonly VoiceChoice[], value: unknown): VoiceChoice | null {
  if (typeof value === 'string' && value) {
    const found = voices.find((voice) => voice.id === value);
    if (found) return found;
  }
  return voices[0] ?? null;
}

export function renderVoicePick(options: RenderVoicePickOptions): string {
  const id = String(options?.id ?? '').trim();
  const label = String(options?.label ?? '').trim();
  const safeId = escapeHtml(id);
  const voices = Array.isArray(options?.voices)
    ? normalizeList(options.voices)
    : voicesFromOptions(options?.voices);
  const selected = selectedFor(voices, options?.value);

  const optionHtml = voices.map((voice) => {
    const isSelected = selected?.id === voice.id ? ' selected' : '';
    return `<option value="${escapeHtml(voice.id)}"${isSelected}>${escapeHtml(voice.label)}</option>`;
  }).join('');

  const playName = selected?.name || label || COPY.voice.play;
  const playLabel = fill(COPY.voice.playLabel, { name: playName });

  return `<div class="easy-voice-pick" data-easy-voice-pick="${safeId}">
<label class="easy-voice-pick-label" for="${safeId}">${escapeHtml(label)}</label>
<div class="easy-voice-pick-row">
<select class="easy-voice-pick-select" id="${safeId}" name="${safeId}" data-easy-voice-select="${safeId}">${optionHtml}</select>
<button type="button" class="btn btn-secondary easy-voice-pick-play" data-easy-voice-play="${safeId}" aria-label="${escapeHtml(playLabel)}">${escapeHtml(COPY.voice.play)}</button>
<button type="button" class="btn btn-secondary easy-voice-pick-compare" data-easy-voice-compare="${safeId}">${escapeHtml(COPY.voice.compare)}</button>
</div>
<audio class="easy-voice-pick-audio" data-easy-voice-audio="${safeId}" preload="none" hidden></audio>
<p class="easy-voice-pick-note" data-easy-voice-note="${safeId}" role="status" hidden></p>
</div>`;
}

export function voicePickLine(voice: unknown): string {
  const choice = normalizeVoice(voice);
  return choice ? fill(COPY.characters.voiceLine, { name: choice.name }) : COPY.characters.noVoice;
}

function stopActivePreview(): void {
  const active = activePreview;
  if (!active) return;
  activePreview = null;
  try { active.audio.pause(); } catch {}
  try {
    active.audio.removeAttribute('src');
    active.audio.load();
  } catch {}
  if (active.url) {
    try { URL.revokeObjectURL(active.url); } catch {}
  }
}

function voiceCandidate(voice: VoiceChoice): AuditionCandidate {
  return {
    candidateId: voice.id,
    label: voice.label,
    engine: voice.engine ?? 'kokoro',
    voice: voice.voice,
    language: voice.language ?? undefined,
  };
}

function findCompareDialog(root: HTMLElement): HTMLDialogElement | null {
  const dialogs = Array.from(root.ownerDocument.querySelectorAll('dialog[open]'));
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index];
    if (dialog.querySelector('[data-easy-voice-compare-host]')) {
      return dialog as HTMLDialogElement;
    }
  }
  return null;
}

function clickDialogAction(dialog: HTMLDialogElement | null, value: string): void {
  if (!dialog) return;
  const buttons = Array.from(dialog.querySelectorAll('button'));
  for (const button of buttons) {
    if ((button as HTMLButtonElement).value === value) {
      (button as HTMLButtonElement).click();
      return;
    }
  }
}

export function mountVoicePick(
  el: HTMLElement,
  options: MountVoicePickOptions,
): MountedVoicePick {
  if (!el) throw new TypeError('mountVoicePick requires an element');

  const fetchImpl = options.apiFetch ?? defaultApiFetch;
  const open = options.openDialog ?? openDialog;
  const loadPanel = options.loadPanel
    ?? (() => import('../characters/audition-panel.ts'));

  let disposed = false;
  let comparing = false;
  let playing = false;
  let keptId: string | null = null;
  let panel: { destroy(): void } | null = null;

  el.innerHTML = renderVoicePick(options);

  const selectNode = el.querySelector<HTMLSelectElement>('[data-easy-voice-select]');
  const playNode = el.querySelector<HTMLButtonElement>('[data-easy-voice-play]');
  const compareNode = el.querySelector<HTMLButtonElement>('[data-easy-voice-compare]');
  const audioNode = el.querySelector<HTMLAudioElement>('[data-easy-voice-audio]');
  const noteNode = el.querySelector<HTMLElement>('[data-easy-voice-note]');

  if (!selectNode || !playNode || !compareNode || !audioNode || !noteNode) {
    return {
      getValue: () => selectNode?.value ?? '',
      setValue: () => {},
      destroy: () => { el.innerHTML = ''; },
    };
  }

  const select: HTMLSelectElement = selectNode;
  const playButton: HTMLButtonElement = playNode;
  const compareButton: HTMLButtonElement = compareNode;
  const audio: HTMLAudioElement = audioNode;
  const note: HTMLElement = noteNode;

  const voices = Array.isArray(options.voices)
    ? normalizeList(options.voices)
    : voicesFromOptions(options.voices);

  function selectedVoice(): VoiceChoice | null {
    const found = voices.find((voice) => voice.id === select.value);
    return found ?? voices[0] ?? null;
  }

  function setNote(text: string): void {
    note.textContent = text;
    note.hidden = !text;
  }

  function paintPlayState(): void {
    const voice = selectedVoice();
    const name = voice?.name || options.label || COPY.voice.play;
    playButton.setAttribute('aria-label', fill(COPY.voice.playLabel, { name }));
    playButton.textContent = playing ? COPY.voice.stop : COPY.voice.play;
  }

  function stopOwnPreview(): void {
    if (activePreview?.audio === audio) stopActivePreview();
    playing = false;
    paintPlayState();
  }

  function setSelected(id: string): void {
    if (!id) return;
    const voice = voices.find((item) => item.id === id);
    if (!voice) return;
    select.value = voice.id;
    paintPlayState();
    options.onChange?.(voice);
  }

  async function togglePlay(): Promise<void> {
    const voice = selectedVoice();
    if (!voice) return;
    if (playing) {
      stopOwnPreview();
      return;
    }
    if (!voice.previewUrl) {
      setNote(PREVIEW_ERROR);
      return;
    }

    setNote('');
    stopActivePreview();
    playing = false;
    paintPlayState();
    playButton.disabled = true;
    playButton.setAttribute('aria-busy', 'true');

    try {
      const response = await fetchImpl(voice.previewUrl);
      if (!response.ok) throw new Error(PREVIEW_ERROR);
      const blob = await response.blob();
      if (disposed) return;
      const url = URL.createObjectURL(blob);
      audio.src = url;
      activePreview = { audio, url };
      playing = true;
      paintPlayState();
      const playback = audio.play();
      if (playback && typeof playback.catch === 'function') {
        playback.catch(() => {
          if (disposed) return;
          stopOwnPreview();
          setNote(PREVIEW_ERROR);
        });
      }
    } catch {
      if (!disposed) setNote(PREVIEW_ERROR);
    } finally {
      playButton.disabled = false;
      playButton.removeAttribute('aria-busy');
    }
  }

  function comparisonPair(): [VoiceChoice, VoiceChoice] | null {
    const current = selectedVoice();
    if (!current) return null;
    const other = voices.find((voice) => voice.id !== current.id);
    if (!other) return null;
    return [current, other];
  }

  async function openCompare(): Promise<void> {
    if (comparing) return;
    const pair = comparisonPair();
    setNote('');
    if (!pair) {
      setNote(COPY.voice.compareUnavailable);
      return;
    }

    comparing = true;
    keptId = null;
    const [first, second] = pair;
    let dialog: HTMLDialogElement | null = null;

    try {
      const opened = open({
        title: COPY.voice.compareTitle,
        bodyHtml: '<div class="easy-voice-compare" data-easy-voice-compare-host></div>',
        actions: [{ label: 'Keep', value: KEEP_ACTION, kind: 'primary' as const }],
        opener: compareButton,
      });

      dialog = findCompareDialog(el);
      dialog?.querySelector('.easy-dialog-actions')?.setAttribute('hidden', '');
      const host = dialog?.querySelector<HTMLElement>('[data-easy-voice-compare-host]') ?? null;
      if (!host) throw new Error('compare host unavailable');

      const candidates = [voiceCandidate(first), voiceCandidate(second)];
      const character = {
        id: `easy-voice-${options.id}`,
        revision: 0,
      } as unknown as AuditionPanelOptions['character'];

      const module = await loadPanel();
      panel = module.mountAuditionPanel(host, {
        api: {
          update: async () => ({ revision: 1 } as unknown as AuditionPanelOptions['character']),
        },
        character,
        candidates,
        onChange: (state) => {
          if (!state.selectedId) return;
          if (!candidates.some((candidate) => candidate.candidateId === state.selectedId)) return;
          keptId = state.selectedId;
          clickDialogAction(dialog, KEEP_ACTION);
        },
      });

      const result = await opened;
      if (result === KEEP_ACTION && keptId) setSelected(keptId);
    } catch {
      if (dialog && dialog.open) {
        try { dialog.close(); } catch {}
      }
      if (!disposed) setNote(COPY.voice.compareUnavailable);
    } finally {
      try { panel?.destroy(); } catch {}
      panel = null;
      comparing = false;
    }
  }

  function onSelectChange(): void {
    stopOwnPreview();
    setNote('');
    options.onChange?.(selectedVoice());
  }

  function onAudioEnded(): void {
    if (activePreview?.audio === audio) {
      if (activePreview.url) {
        try { URL.revokeObjectURL(activePreview.url); } catch {}
      }
      activePreview = null;
    }
    playing = false;
    paintPlayState();
  }

  function onPlayClick(): void {
    void togglePlay();
  }

  function onCompareClick(): void {
    void openCompare();
  }

  select.addEventListener('change', onSelectChange);
  playButton.addEventListener('click', onPlayClick);
  compareButton.addEventListener('click', onCompareClick);
  audio.addEventListener('ended', onAudioEnded);
  paintPlayState();

  return {
    getValue: () => select.value,
    setValue: (value: string) => setSelected(String(value ?? '')),
    destroy(): void {
      disposed = true;
      select.removeEventListener('change', onSelectChange);
      playButton.removeEventListener('click', onPlayClick);
      compareButton.removeEventListener('click', onCompareClick);
      audio.removeEventListener('ended', onAudioEnded);
      if (activePreview?.audio === audio) stopActivePreview();
      try { panel?.destroy(); } catch {}
      panel = null;
      el.innerHTML = '';
    },
  };
}
