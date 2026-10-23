// @ts-nocheck
// IL15W: the Easy iteration step mounts the IL15 picker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { COPY } from '../src/easy/copy.ts';
import { mountEasyLevelPicker } from '../src/easy/level-picker.ts';

function host() {
  const listeners = [];
  return {
    listeners,
    innerHTML: '',
    addEventListener(_type, fn) { listeners.push(fn); },
    removeEventListener() {},
  };
}

function click(handle, selector, value) {
  const event = {
    preventDefault() {},
    target: {
      closest(query) {
        return query === selector ? { getAttribute: () => value } : null;
      },
    },
  };
  for (const listener of handle.listeners) listener(event);
}

test('the Easy level step mounts Draft, Balanced, Director, and a way to reach Custom', () => {
  const slot = host();
  const chosen = [];
  mountEasyLevelPicker(slot, {
    value: 'draft',
    compute: 'cpu',
    onChange(level) { chosen.push(level); },
  });
  assert.match(slot.innerHTML, /data-iteration-choice="draft"/);
  assert.match(slot.innerHTML, /data-iteration-choice="balanced"/);
  assert.match(slot.innerHTML, /data-iteration-choice="director"/);
  assert.match(slot.innerHTML, />Draft</);
  assert.match(slot.innerHTML, />Balanced</);
  assert.match(slot.innerHTML, />Director</);
  assert.match(slot.innerHTML, /data-easy-level-custom/);
  assert.match(slot.innerHTML, />Custom</);
  assert.doesNotMatch(slot.innerHTML, /Iteration level: Draft/);
  assert.equal(slot.innerHTML.includes('Estimate unavailable'), false);
  assert.equal(slot.innerHTML.includes(COPY.level.fallback.split('{')[0]), false);

  click(slot, '[data-iteration-choice]', 'balanced');
  assert.deepEqual(chosen, ['balanced']);
  click(slot, '[data-easy-level-custom]', '');
  assert.deepEqual(chosen, ['balanced', 'custom']);

  const level = readFileSync(fileURLToPath(new URL('../src/easy/steps/level.ts', import.meta.url)), 'utf8');
  assert.match(level, /mountEasyLevelPicker\(/);
});

test('Recommended follows the suggestion and Fine-tune opens the editor', () => {
  const slot = host();
  const chosen = [];
  let opened = 0;
  mountEasyLevelPicker(slot, {
    value: 'draft',
    compute: 'colab',
    onChange(level) { chosen.push(level); },
    onOpenEditor() { opened += 1; },
  });
  assert.match(slot.innerHTML, /data-iteration-choice="recommended"/);
  click(slot, '[data-iteration-choice]', 'recommended');
  assert.deepEqual(chosen, ['balanced']);
  click(slot, '[data-iteration-open-advanced]', '');
  assert.equal(opened, 1);
});
