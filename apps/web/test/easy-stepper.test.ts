// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultEasyState } from '../src/easy/store.ts';
import { COPY, fill } from '../src/easy/copy.ts';
import { STEPS } from '../src/easy/steps.ts';
import { renderStepper } from '../src/easy/stepper.ts';

const completeIdea = 'A long enough idea text';

const lockedFacts = {
  hasPackage: false,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

function baseState() {
  const state = defaultEasyState();
  state.idea.text = completeIdea;
  state.questionsAsked = true;
  return state;
}

test('seven step buttons render in order', () => {
  const html = renderStepper({ current: 'level', state: baseState(), facts: lockedFacts, needsUpdate: [] });
  const steps = [...html.matchAll(/<button[^>]*data-step="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(steps, [...STEPS]);
  assert.equal(steps.length, 7);
});

test('exactly one step is current', () => {
  const html = renderStepper({ current: 'level', state: baseState(), facts: lockedFacts, needsUpdate: [] });
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, /data-step="level"[^>]*aria-current="step"/);
});

test('a locked step is disabled and exposes its reason', () => {
  const state = defaultEasyState();
  state.idea.text = 'short';
  const html = renderStepper({ current: 'idea', state, facts: lockedFacts, needsUpdate: [] });
  assert.match(html, /data-step="plan"[^>]*aria-disabled="true"/);
  assert.ok(html.includes(COPY.stepper.locked.plan));
  assert.match(html, /<span class="sr-only">Describe your idea first<\/span>/);
});

test('a done step starts with the hidden Done prefix', () => {
  const html = renderStepper({ current: 'level', state: baseState(), facts: lockedFacts, needsUpdate: [] });
  assert.match(html, /data-step="idea"[^>]*><span class="sr-only">Done: <\/span>Idea/);
  assert.match(html, /data-step="characters"[^>]*><span class="sr-only">Done: <\/span>Characters/);
});

test('the compact label reads Step 3 of 7 with the step name', () => {
  const html = renderStepper({ current: 'level', state: baseState(), facts: lockedFacts, needsUpdate: [] });
  const label = fill(COPY.stepper.compact, { n: 3, total: 7, name: COPY.level.compactName });
  assert.equal(label, 'Step 3 of 7 · Level');
  assert.match(html, /<button[^>]*class="stepper-compact"[^>]*>Step 3 of 7 · Level<\/button>/);
});

test('a step that needs an update shows a dot and hidden status text', () => {
  const html = renderStepper({ current: 'plan', state: baseState(), facts: lockedFacts, needsUpdate: ['plan'] });
  assert.match(html, /data-step="plan"[^>]*>.*class="stepper-dot".*<span class="sr-only">Needs update<\/span>/s);
});
