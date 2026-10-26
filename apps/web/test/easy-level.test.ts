// @ts-nocheck
// UR17: Easy Step 3 iteration level slot, copy and default.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY, fill } from '../src/easy/copy.ts';
import { defaultEasyState } from '../src/easy/store.ts';
import { ITERATION_PRESETS } from '../../server/src/productions/iteration.mjs';
import { describeLevel } from '../src/easy/level-copy.ts';
import { levelBlockReason, levelForState, renderLevel, step } from '../src/easy/steps/level.ts';

const FACTS = {
  hasPackage: false,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

test('describeLevel matches the Easy copy for every preset', () => {
  assert.equal(describeLevel(ITERATION_PRESETS.draft), COPY.level.summaries.draft);
  assert.equal(describeLevel(ITERATION_PRESETS.balanced), COPY.level.summaries.balanced);
  assert.equal(describeLevel(ITERATION_PRESETS.director), COPY.level.summaries.director);
});

test('the slot always exists and the fallback renders without a picker', () => {
  const state = defaultEasyState();
  const html = renderLevel(state);
  assert.match(html, /<div[^>]*data-il-slot="iteration-level-picker"/);
  assert.match(html, /data-easy-compute/);
  const fallbackText = fill(COPY.level.fallback, {
    level: COPY.level.names.draft,
    summary: COPY.level.summaries.draft,
  });
  assert.equal(html.includes(fallbackText), true);
  assert.match(html, /data-easy-level-editor/);
  assert.equal(html.includes(COPY.shell.openEditor), true);

  const body = step.render(state, FACTS);
  assert.match(body, /data-il-slot="iteration-level-picker"/);
  assert.match(body, /data-easy-compute/);
  assert.equal(body.includes(COPY.level.summaries.draft), true);

  const withPicker = renderLevel(state, { hasPicker: true });
  assert.match(withPicker, /data-il-slot="iteration-level-picker"/);
  assert.equal(withPicker.includes(COPY.level.summaries.draft), false);
});

test('the default level follows compute until the level is touched', () => {
  const cpu = { ...defaultEasyState(), compute: 'cpu', level: 'director', levelTouched: false };
  assert.equal(levelForState(cpu), 'draft');

  const colab = { ...cpu, compute: 'colab' };
  assert.equal(levelForState(colab), 'balanced');

  const touched = { ...colab, level: 'director', levelTouched: true };
  assert.equal(levelForState(touched), 'director');

  const touchedCpu = { ...cpu, level: 'balanced', levelTouched: true };
  assert.equal(levelForState(touchedCpu), 'balanced');
});

test('the level step mounts the compute choice and spend cap controls', () => {
  const colab = { ...defaultEasyState(), compute: 'colab', spendCap: 15 };
  const html = step.render(colab, FACTS);
  assert.match(html, /data-easy-compute/);
  assert.match(html, /name="easy-compute"/);
  assert.match(html, /value="cpu"/);
  assert.match(html, /value="colab"/);
  assert.match(html, /id="easy-cap"/);
  assert.match(html, /Google Colab units/);

  const cpu = { ...defaultEasyState(), compute: 'cpu' };
  const cpuHtml = step.render(cpu, FACTS);
  assert.match(cpuHtml, /value="cpu"/);
  assert.doesNotMatch(cpuHtml, /id="easy-cap"/);
});

test('Google Colab needs sign-in and a user-set spend cap', () => {
  const colab = { ...defaultEasyState(), compute: 'colab' };
  assert.equal(levelBlockReason({ ...colab, spendCap: null }, { signedIn: true }), COPY.compute.capError);
  assert.equal(levelBlockReason({ ...colab, spendCap: 0 }, { signedIn: true }), COPY.compute.capError);
  assert.equal(levelBlockReason({ ...colab, spendCap: 5 }, { signedIn: false }), COPY.compute.blockNotConnected);
  assert.equal(levelBlockReason({ ...colab, spendCap: 5 }, { signedIn: true }), null);
  assert.equal(levelBlockReason({ ...colab, spendCap: 5 }, null), COPY.compute.blockNotConnected);
  assert.equal(levelBlockReason({ ...colab, compute: 'cpu' }, null), null);
});
