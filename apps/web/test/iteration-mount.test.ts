// IL18: mount the iteration picker before paid generation. Easy shows cards,
// Advanced shows the grid, and an unbound project is left unchanged.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { iterationPresets } from '../src/productions/cards/iteration-card.ts';
import {
  iterationBlocksPaidGeneration,
  mountIterationLevel,
  renderIterationMount,
} from '../src/productions/cards/iteration-advanced.ts';

function estimate() {
  return {
    gpuMinutes: { low: 1, expected: 1, high: 2 },
    units: { low: 0.2, expected: 0.4, high: 0.6 },
    wallMinutes: { low: 4, expected: 5, high: 6 },
    voiceSamples: 0,
    vsCap: { ceiling: null, fraction: null, status: 'no_cap' },
    labels: ['estimate; other sessions may be running'],
  };
}

function readBody(level = null) {
  const balanced = iterationPresets().balanced;
  return {
    policy: level ? iterationPresets()[level] : null,
    level,
    estimates: { draft: estimate(), balanced: estimate(), director: estimate() },
    recommendation: { level: 'balanced', policy: balanced, reasons: ['no history: balanced'] },
    prefill: null,
    lockedShotIds: [],
    revision: 4,
  };
}

test('Easy shows cards, Advanced shows the grid, and unbound renders nothing', () => {
  const cardHtml = '<div data-iteration-card>cards</div>';
  const advancedHtml = '<div data-iteration-advanced>grid</div>';
  const easy = renderIterationMount({
    bound: true,
    mode: 'easy',
    level: null,
    cardHtml,
    advancedHtml,
  });
  const advanced = renderIterationMount({
    bound: true,
    mode: 'advanced',
    level: null,
    cardHtml,
    advancedHtml,
  });
  const unbound = renderIterationMount({
    bound: false,
    mode: 'easy',
    level: null,
    cardHtml,
    advancedHtml,
  });
  assert.match(easy, /data-surface="cards"/);
  assert.match(easy, /data-iteration-card/);
  assert.equal(easy.includes('data-iteration-advanced'), false);
  assert.match(advanced, /data-surface="grid"/);
  assert.match(advanced, /data-iteration-advanced/);
  assert.equal(unbound, '');
  assert.match(renderIterationMount({
    bound: true,
    mode: 'easy',
    level: 'balanced',
    cardHtml,
    advancedHtml,
  }), /data-iteration-change-level/);
  assert.match(renderIterationMount({
    bound: true,
    mode: 'advanced',
    level: 'balanced',
    changeOpen: true,
    cardHtml,
    advancedHtml,
  }), /data-surface="grid"/);
});

test('a level choice blocks paid generation only while it is missing, and is not spend approval', () => {
  assert.equal(iterationBlocksPaidGeneration({ bound: false, level: null, known: true }), false);
  assert.equal(iterationBlocksPaidGeneration({ bound: true, level: null, known: false }), true);
  assert.equal(iterationBlocksPaidGeneration({ bound: true, level: null, known: true }), true);
  assert.equal(iterationBlocksPaidGeneration({ bound: true, level: 'draft', known: true }), false);
  assert.equal(iterationBlocksPaidGeneration({ bound: true, level: 'custom', known: true }), false);
});

test('the mount swaps with the mode and leaves an unbound project empty', async () => {
  let mode = 'easy';
  let productionId = 'prod_0123456789abcdef01234567';
  const calls = [];
  const listeners = {};
  const host = {
    hidden: false,
    innerHTML: 'untouched',
    setAttribute() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener() {},
    querySelector() { return { focus() {} }; },
  };
  const mount = mountIterationLevel({
    host,
    getMode: () => mode,
    getProductionId: () => productionId,
    read: async () => readBody(null),
    set: async (id, input, revision) => {
      calls.push({ id, input, revision });
      return { revision: revision + 1 };
    },
  });

  await mount.refresh();
  assert.match(host.innerHTML, /data-surface="cards"/);
  assert.match(host.innerHTML, /data-iteration-choice="draft"/);
  assert.equal(mount.blocksPaidGeneration(), true);

  mode = 'advanced';
  await mount.refresh();
  assert.match(host.innerHTML, /data-surface="grid"/);
  assert.match(host.innerHTML, /data-iteration-advanced/);
  assert.match(host.innerHTML, /data-iteration-total=/);

  productionId = null;
  await mount.refresh();
  assert.equal(host.innerHTML, '');
  assert.equal(host.hidden, true);
  assert.equal(mount.blocksPaidGeneration(), false);

  productionId = 'prod_0123456789abcdef01234567';
  await mount.refresh();
  let saved;
  const pending = new Promise((resolve) => { saved = resolve; });
  const previousSet = calls.length;
  host.innerHTML = host.innerHTML;
  listeners.click({
    target: {
      closest(selector) {
        if (selector === '[data-iteration-choice]') {
          return { getAttribute: (name) => (name === 'data-iteration-choice' ? 'draft' : null) };
        }
        return null;
      },
    },
  });
  const originalLength = calls.length;
  const wait = new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (calls.length > previousSet || Date.now() - start > 500) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
  await wait;
  assert.equal(calls.length, originalLength);
  assert.equal(calls.at(-1).input.policy.level, 'draft');
  assert.equal(JSON.stringify(calls.at(-1)).includes('plan.approve'), false);
  assert.equal(JSON.stringify(calls.at(-1)).includes('actor'), false);
  assert.equal(mount.blocksPaidGeneration(), false);
  void saved;
  void pending;
});

test('main.ts mounts the picker, swaps on the mode event, and gates paid generation', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(source, /mountIterationLevel\(/);
  assert.match(source, /MODE_CHANGE_EVENT/);
  assert.match(source, /blocksPaidGeneration\(/);
  assert.match(source, /lookupBoundProductionId/);
  const runStart = source.indexOf('async function approveFromGenerateTab');
  const runEnd = source.indexOf('async function persistDraft');
  const run = source.slice(runStart, runEnd);
  assert.ok(run.indexOf('blocksPaidGeneration') < run.indexOf('approveAndGenerate'), 'the level gate runs before a paid generation request');
  assert.equal(run.includes('plan.approve'), false);
  assert.match(run, /Choosing a level is not spend approval/);
});
