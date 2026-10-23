// IL15W: the Easy iteration step uses the IL15 cards before a production exists.
// Choosing a card records a level only. It does not approve a spend.

import {
  iterationCardOnKey,
  iterationPresets,
  readIterationCard,
  renderIterationCard,
  type IterationCardModel,
  type IterationChoice,
} from '../productions/cards/iteration-card.ts';
import type { IterationRead } from '../productions/client.ts';
import type { Level } from './types.ts';

export interface EasyLevelPickerOptions {
  value: Level;
  compute: string;
  onChange: (level: Level) => void;
  onOpenEditor?: () => void;
}

interface ChoiceNode {
  getAttribute?: (name: string) => string | null;
}

const UNAVAILABLE_ESTIMATE = '<p class="iteration-estimate" data-iteration-estimate>Estimate unavailable</p>';

function recommendedLevel(compute: string): 'draft' | 'balanced' {
  return compute === 'colab' ? 'balanced' : 'draft';
}

function cardModel(value: Level, compute: string): IterationCardModel {
  const presets = iterationPresets();
  const suggested = recommendedLevel(compute);
  const selected: IterationChoice | null = value === 'draft' || value === 'balanced' || value === 'director'
    ? value
    : null;
  const read = {
    policy: null,
    level: null,
    estimates: { draft: null, balanced: null, director: null },
    recommendation: {
      level: suggested,
      policy: presets[suggested],
      reasons: ['A good match for a new video.'],
    },
    prefill: null,
    lockedShotIds: [],
    revision: 0,
  } as unknown as IterationRead;
  return readIterationCard(read, {
    selected,
    focus: selected ?? 'recommended',
  });
}

function customControl(pressed: boolean): string {
  const state = pressed ? 'true' : 'false';
  return `<p class="easy-level-custom"><button type="button" data-easy-level-custom aria-pressed="${state}">Custom</button></p>`;
}

function closest(event: Event, selector: string): ChoiceNode | null {
  const target = event.target as { closest?: (query: string) => ChoiceNode | null } | null;
  if (!target || typeof target.closest !== 'function') return null;
  return target.closest(selector);
}

export function mountEasyLevelPicker(slot: HTMLElement, options: EasyLevelPickerOptions): { destroy: () => void } {
  let value = options.value;
  let model = cardModel(value, options.compute);

  function paint(): void {
    model = cardModel(value, options.compute);
    const html = renderIterationCard(model).replaceAll(UNAVAILABLE_ESTIMATE, '');
    slot.innerHTML = html + customControl(value === 'custom');
  }

  function applyChoice(choice: IterationChoice): void {
    const level = choice === 'recommended' ? recommendedLevel(options.compute) : choice;
    value = level;
    options.onChange(level);
    paint();
  }

  function onClick(event: Event): void {
    const choiceNode = closest(event, '[data-iteration-choice]');
    if (choiceNode) {
      event.preventDefault();
      const name = choiceNode.getAttribute?.('data-iteration-choice');
      if (name === 'draft' || name === 'balanced' || name === 'director' || name === 'recommended') {
        applyChoice(name);
      }
      return;
    }
    if (closest(event, '[data-easy-level-custom]')) {
      event.preventDefault();
      value = 'custom';
      options.onChange('custom');
      paint();
      return;
    }
    if (closest(event, '[data-iteration-open-advanced]')) {
      event.preventDefault();
      options.onOpenEditor?.();
    }
  }

  function onKey(event: Event): void {
    const key = (event as KeyboardEvent).key;
    if (typeof key !== 'string' || key === '') return;
    const result = iterationCardOnKey(model, key);
    if (!result.handled || result.choice === null) return;
    event.preventDefault();
    applyChoice(result.choice);
  }

  slot.addEventListener('click', onClick);
  slot.addEventListener('keydown', onKey);
  paint();

  return {
    destroy() {
      slot.removeEventListener('click', onClick);
      slot.removeEventListener('keydown', onKey);
    },
  };
}
