import {
  PRESERVE_KEYS,
  validateIterationScope,
} from '../../../server/src/productions/iteration-scope.mjs';
import { readIteration } from '../productions/client.ts';
import type {
  IterationLevel,
  IterationRead,
  ProductionApiFetch,
} from '../productions/client.ts';
import type {
  AnnotationTime,
  Region,
  ViewerState,
} from './model.ts';

export type IterationElement =
  | 'character'
  | 'voice_line'
  | 'background'
  | 'motion'
  | 'framing'
  | 'lighting'
  | 'audio'
  | 'other';

export type PreserveKey =
  | 'character'
  | 'voice'
  | 'background'
  | 'motion'
  | 'framing'
  | 'lighting'
  | 'audio'
  | 'timing';

export interface IterationTarget {
  packageId: string;
  clipId?: string;
  takeId?: string;
  assetId?: string;
  shotId?: string;
}

export interface IterationScope {
  target: IterationTarget;
  element: IterationElement;
  elementRef?: { characterId: string } | { lineId: string };
  region?: Region;
  time?: AnnotationTime;
  note: string;
  preserve: PreserveKey[];
}

export interface IterateCharacter {
  characterId: string;
  name?: string;
}

export interface IterateVoiceLine {
  lineId: string;
  text?: string;
}

export interface IteratePanelAsset {
  characters?: readonly IterateCharacter[];
  voiceLines?: readonly IterateVoiceLine[];
}

export interface IteratePanelOptions {
  document: Document;
  host: HTMLElement;
  asset: IteratePanelAsset;
  target: IterationTarget;
  viewer: ViewerState;
  productionId: string;
  apiFetch?: ProductionApiFetch;
  onSubmit(scope: IterationScope): void;
}

export interface IteratePanelHandle {
  readonly element: HTMLFormElement;
  readonly ready: Promise<void>;
  destroy(): void;
}

interface ElementChoice {
  element: IterationElement;
  elementRef?: IterationScope['elementRef'];
  label: string;
}

const preserveKeys = PRESERVE_KEYS as readonly PreserveKey[];

const FIXED_ELEMENTS: readonly IterationElement[] = [
  'background',
  'motion',
  'framing',
  'lighting',
  'audio',
  'other',
];

const ELEMENT_LABELS: Record<IterationElement, string> = {
  character: 'Character',
  voice_line: 'Voice line',
  background: 'Background',
  motion: 'Motion',
  framing: 'Framing',
  lighting: 'Lighting',
  audio: 'Audio',
  other: 'Other',
};

const ELEMENT_PRESERVE: Record<IterationElement, PreserveKey | null> = {
  character: 'character',
  voice_line: 'voice',
  background: 'background',
  motion: 'motion',
  framing: 'framing',
  lighting: 'lighting',
  audio: 'audio',
  other: null,
};

const PRESERVE_LABELS: Record<PreserveKey, string> = {
  character: 'Character',
  voice: 'Voice',
  background: 'Background',
  motion: 'Motion',
  framing: 'Framing',
  lighting: 'Lighting',
  audio: 'Audio',
  timing: 'Timing',
};

const LEVEL_LABELS: Record<IterationLevel, string> = {
  draft: 'Draft',
  balanced: 'Balanced',
  director: 'Director',
  custom: 'Custom',
};

let panelSequence = 0;

function choicesFor(asset: IteratePanelAsset): ElementChoice[] {
  const choices: ElementChoice[] = [];
  for (const character of asset.characters ?? []) {
    if (typeof character.characterId !== 'string' || character.characterId.trim() === '') continue;
    const name = typeof character.name === 'string' && character.name.trim() !== ''
      ? character.name
      : character.characterId;
    choices.push({
      element: 'character',
      elementRef: { characterId: character.characterId },
      label: `Character: ${name}`,
    });
  }
  for (const line of asset.voiceLines ?? []) {
    if (typeof line.lineId !== 'string' || line.lineId.trim() === '') continue;
    const text = typeof line.text === 'string' && line.text.trim() !== '' ? line.text : line.lineId;
    choices.push({
      element: 'voice_line',
      elementRef: { lineId: line.lineId },
      label: `Voice line: ${text}`,
    });
  }
  for (const element of FIXED_ELEMENTS) {
    choices.push({ element, label: ELEMENT_LABELS[element] });
  }
  return choices;
}

function copyTime(time: AnnotationTime): AnnotationTime {
  return 'at' in time ? { at: time.at } : { in: time.in, out: time.out };
}

function levelText(read: IterationRead, shotId: string | undefined): string {
  const level = read.level ?? read.policy?.level ?? null;
  if (level === null) return 'Level: not set';
  const label = LEVEL_LABELS[level];
  const currentPolicy = read.policy;
  if (!currentPolicy) return `Level: ${label}`;

  const video = currentPolicy.stages.video;
  const override = shotId === undefined
    ? undefined
    : currentPolicy.shotOverrides[shotId]?.stages?.video;
  const takes = override?.takes ?? video.takes;
  const rounds = override?.rounds ?? video.rounds;
  const total = takes * rounds;
  if (!Number.isFinite(total) || total < 0) return `Level: ${label}`;
  return `Level: ${label}, up to ${total} ${total === 1 ? 'take' : 'takes'} per shot`;
}

function validationMessage(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'The iteration request is not valid.';
}

export function mountIteratePanel(options: IteratePanelOptions): IteratePanelHandle {
  const document = options.document;
  const host = options.host;
  if (!document || typeof document.createElement !== 'function') {
    throw new TypeError('mountIteratePanel requires an injected document');
  }
  if (!host) throw new TypeError('mountIteratePanel requires a host element');
  if (typeof options.onSubmit !== 'function') {
    throw new TypeError('mountIteratePanel requires onSubmit');
  }

  panelSequence += 1;
  const radioName = `iterate-element-${panelSequence}`;
  const errorId = `iterate-error-${panelSequence}`;
  const choices = choicesFor(options.asset);
  const selectedPreserve = new Set<PreserveKey>(preserveKeys);
  const radioButtons: HTMLInputElement[] = [];
  const preserveInputs = new Map<PreserveKey, HTMLInputElement>();
  const abortController = new AbortController();
  let selectedIndex = 0;
  let destroyed = false;

  const form = document.createElement('form');
  form.className = 'iterate-panel';
  form.noValidate = true;
  form.setAttribute('data-iterate-panel', '');

  const heading = document.createElement('h3');
  heading.textContent = 'Iterate on an element';
  form.appendChild(heading);

  const level = document.createElement('p');
  level.className = 'iterate-level hint';
  level.setAttribute('data-iterate-level', '');
  level.setAttribute('role', 'status');
  level.setAttribute('aria-live', 'polite');
  level.textContent = 'Level: loading…';
  form.appendChild(level);

  const radioGroup = document.createElement('div');
  radioGroup.className = 'iterate-elements';
  radioGroup.setAttribute('data-iterate-elements', '');
  radioGroup.setAttribute('role', 'radiogroup');
  radioGroup.setAttribute('aria-label', 'Element to iterate');
  form.appendChild(radioGroup);

  const preserveGroup = document.createElement('fieldset');
  preserveGroup.className = 'iterate-preserve';
  preserveGroup.setAttribute('data-iterate-preserve-group', '');
  const preserveLegend = document.createElement('legend');
  preserveLegend.textContent = 'Preserve';
  preserveGroup.appendChild(preserveLegend);
  form.appendChild(preserveGroup);

  const noteLabel = document.createElement('label');
  noteLabel.className = 'iterate-note-label';
  const noteLabelText = document.createElement('span');
  noteLabelText.textContent = 'What should change?';
  const note = document.createElement('textarea');
  note.className = 'iterate-note';
  note.name = 'note';
  note.rows = 4;
  note.maxLength = 500;
  note.required = true;
  note.setAttribute('maxlength', '500');
  note.setAttribute('data-iterate-note', '');
  note.setAttribute('aria-label', 'Iteration note');
  note.setAttribute('aria-describedby', errorId);
  noteLabel.append(noteLabelText, note);
  form.appendChild(noteLabel);

  const error = document.createElement('p');
  error.id = errorId;
  error.className = 'iterate-error';
  error.setAttribute('data-iterate-error', '');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  form.appendChild(error);

  const approval = document.createElement('p');
  approval.className = 'iterate-approval hint';
  approval.setAttribute('data-iterate-approval', '');
  approval.textContent = 'This asks the agent to propose a plan. You approve any Google Colab spend.';
  form.appendChild(approval);

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'btn btn-primary';
  submitButton.setAttribute('data-iterate-submit', '');
  submitButton.textContent = 'Ask the agent for a plan';
  form.appendChild(submitButton);

  const syncPreserve = (): void => {
    const changed = ELEMENT_PRESERVE[choices[selectedIndex]!.element];
    for (const key of preserveKeys) {
      const input = preserveInputs.get(key);
      if (!input) continue;
      const isChanged = key === changed;
      input.disabled = isChanged;
      input.checked = isChanged ? false : selectedPreserve.has(key);
      input.setAttribute('aria-disabled', isChanged ? 'true' : 'false');
    }
  };

  const select = (index: number, moveFocus = false): void => {
    if (destroyed || index < 0 || index >= choices.length) return;
    selectedIndex = index;
    radioButtons.forEach((radio, radioIndex) => {
      const selected = radioIndex === selectedIndex;
      radio.checked = selected;
      radio.tabIndex = selected ? 0 : -1;
      radio.setAttribute('aria-checked', selected ? 'true' : 'false');
      radio.setAttribute('tabindex', selected ? '0' : '-1');
    });
    syncPreserve();
    if (moveFocus) radioButtons[selectedIndex]?.focus();
  };

  choices.forEach((choice, index) => {
    const label = document.createElement('label');
    label.className = 'iterate-element-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = radioName;
    radio.value = String(index);
    radio.tabIndex = -1;
    radio.setAttribute('role', 'radio');
    radio.setAttribute('aria-label', choice.label);
    radio.setAttribute('aria-checked', 'false');
    radio.setAttribute('tabindex', '-1');
    radio.setAttribute('data-iterate-element', choice.element);
    radio.addEventListener('click', () => { select(index); });
    const text = document.createElement('span');
    text.textContent = choice.label;
    label.append(radio, text);
    radioGroup.appendChild(label);
    radioButtons.push(radio);
  });

  for (const key of preserveKeys) {
    const label = document.createElement('label');
    label.className = 'iterate-preserve-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'preserve';
    input.value = key;
    input.checked = true;
    input.setAttribute('data-iterate-preserve', key);
    input.addEventListener('change', () => {
      if (input.checked) selectedPreserve.add(key);
      else selectedPreserve.delete(key);
      syncPreserve();
    });
    const text = document.createElement('span');
    text.textContent = PRESERVE_LABELS[key];
    label.append(input, text);
    preserveGroup.appendChild(label);
    preserveInputs.set(key, input);
  }

  const onRadioKeyDown = (event: KeyboardEvent): void => {
    if (destroyed || event.defaultPrevented) return;
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (selectedIndex + 1) % choices.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (selectedIndex - 1 + choices.length) % choices.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = choices.length - 1;
    } else if (event.key === ' ' || event.key === 'Spacebar') {
      next = radioButtons.indexOf(event.target as HTMLInputElement);
    } else {
      return;
    }
    if (next < 0) return;
    event.preventDefault();
    select(next, true);
  };

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (destroyed) return;
    const choice = choices[selectedIndex]!;
    const changed = ELEMENT_PRESERVE[choice.element];
    const annotation = options.viewer.annotation;
    const candidate = {
      target: { ...options.target },
      element: choice.element,
      ...(choice.elementRef === undefined ? {} : { elementRef: { ...choice.elementRef } }),
      ...(annotation.region === undefined ? {} : { region: { ...annotation.region } }),
      ...(annotation.time === undefined ? {} : { time: copyTime(annotation.time) }),
      note: note.value,
      preserve: preserveKeys.filter(key => key !== changed && selectedPreserve.has(key)),
    };

    let scope: IterationScope;
    try {
      scope = validateIterationScope(candidate) as IterationScope;
    } catch (caught) {
      error.textContent = validationMessage(caught);
      error.hidden = false;
      return;
    }
    error.textContent = '';
    error.hidden = true;
    options.onSubmit(scope);
  };

  radioGroup.addEventListener('keydown', onRadioKeyDown);
  form.addEventListener('submit', onSubmit);
  select(0);
  host.appendChild(form);

  const ready = (async (): Promise<void> => {
    try {
      const current = await readIteration(options.productionId, {
        ...(options.apiFetch === undefined ? {} : { apiFetch: options.apiFetch }),
        signal: abortController.signal,
      });
      if (destroyed) return;
      level.textContent = levelText(current, options.target.shotId);
    } catch {
      if (destroyed || abortController.signal.aborted) return;
      level.textContent = 'Level: unavailable';
    }
  })();

  return {
    element: form,
    ready,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      abortController.abort();
      radioGroup.removeEventListener('keydown', onRadioKeyDown);
      form.removeEventListener('submit', onSubmit);
      if (form.parentNode) form.parentNode.removeChild(form);
    },
  };
}
