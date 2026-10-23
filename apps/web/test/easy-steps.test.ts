// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultEasyState } from '../src/easy/store.ts';
import { COPY } from '../src/easy/copy.ts';
import { STEPS, stepIndex, deriveStep, reachable, lockReason, readStepFromUrl, writeStepToUrl } from '../src/easy/steps.ts';

function state(overrides = {}) {
  const s = defaultEasyState();
  if (overrides.ideaText !== undefined) s.idea.text = overrides.ideaText;
  if (overrides.questionsAsked !== undefined) s.questionsAsked = overrides.questionsAsked;
  if (overrides.questions !== undefined) s.questions = overrides.questions;
  if (overrides.planStatus !== undefined) s.plan.status = overrides.planStatus;
  return s;
}

const completeIdea = 'A long enough idea text';

test('STEPS order', () => {
  assert.deepEqual([...STEPS], ['idea', 'characters', 'level', 'plan', 'generate', 'review', 'export']);
});

test('stepIndex', () => {
  assert.equal(stepIndex('idea'), 0);
  assert.equal(stepIndex('export'), 6);
});

test('rule 1: short idea returns idea', () => {
  const s = state({ ideaText: 'short' });
  const facts = { hasPackage: true, planApproved: true, actionsActive: false, allShotsKept: true, exportCurrent: true };
  assert.equal(deriveStep(s, facts), 'idea');
});

test('rule 2: no package, questions done returns characters', () => {
  const s = state({ ideaText: completeIdea, questionsAsked: true });
  const facts = { hasPackage: false, planApproved: false, actionsActive: false, allShotsKept: false, exportCurrent: false };
  assert.equal(deriveStep(s, facts), 'characters');
});

test('rule 2b: no package, pending questions returns idea', () => {
  const s = state({ ideaText: completeIdea, questionsAsked: false, questions: [{ id: 'q1' }] });
  const facts = { hasPackage: false, planApproved: false, actionsActive: false, allShotsKept: false, exportCurrent: false };
  assert.equal(deriveStep(s, facts), 'idea');
});

test('rule 3: no plan approval returns plan', () => {
  const s = state({ ideaText: completeIdea, planStatus: 'ready' });
  const facts = { hasPackage: true, planApproved: false, actionsActive: false, allShotsKept: false, exportCurrent: false };
  assert.equal(deriveStep(s, facts), 'plan');
});

test('rule 3b: stale plan returns plan', () => {
  const s = state({ ideaText: completeIdea, planStatus: 'stale' });
  const facts = { hasPackage: true, planApproved: true, actionsActive: false, allShotsKept: false, exportCurrent: false };
  assert.equal(deriveStep(s, facts), 'plan');
});

test('rule 4: actions active returns generate', () => {
  const s = state({ ideaText: completeIdea, planStatus: 'ready' });
  const facts = { hasPackage: true, planApproved: true, actionsActive: true, allShotsKept: true, exportCurrent: true };
  assert.equal(deriveStep(s, facts), 'generate');
});

test('rule 5: not all shots kept returns review', () => {
  const s = state({ ideaText: completeIdea, planStatus: 'ready' });
  const facts = { hasPackage: true, planApproved: true, actionsActive: false, allShotsKept: false, exportCurrent: true };
  assert.equal(deriveStep(s, facts), 'review');
});

test('rule 6: otherwise export', () => {
  const s = state({ ideaText: completeIdea, planStatus: 'ready' });
  const facts = { hasPackage: true, planApproved: true, actionsActive: false, allShotsKept: true, exportCurrent: true };
  assert.equal(deriveStep(s, facts), 'export');
});

test('reachable review stays open when an approved plan needs an update', () => {
  const s = state({ ideaText: completeIdea, planStatus: 'stale' });
  const facts = { hasPackage: true, planApproved: true, actionsActive: false, allShotsKept: true, exportCurrent: false };
  assert.equal(deriveStep(s, facts), 'plan');
  assert.equal(reachable('review', s, facts), true);
  assert.equal(lockReason('review', s, facts), null);
  assert.equal(reachable('export', s, facts), false);
});

test('reachable generate stays open after this computer finishes', () => {
  const s = state({ ideaText: completeIdea, planStatus: 'ready' });
  s.generate.status = 'done';
  const facts = { hasPackage: true, planApproved: false, actionsActive: false, allShotsKept: false, exportCurrent: false };
  assert.equal(reachable('generate', s, facts), true);
});

test('reachable review stays open after this computer finishes', () => {
  const s = state({ ideaText: completeIdea, planStatus: 'ready' });
  s.generate.status = 'done';
  const facts = { hasPackage: true, planApproved: false, actionsActive: false, allShotsKept: true, exportCurrent: false };
  assert.equal(reachable('review', s, facts), true);
  assert.equal(reachable('export', s, facts), false);
});

test('reachable review false before approval', () => {
  const s = state({ ideaText: completeIdea, planStatus: 'ready' });
  const facts = { hasPackage: true, planApproved: false, actionsActive: false, allShotsKept: false, exportCurrent: false };
  assert.equal(reachable('review', s, facts), false);
});

test('lockReason plan before idea complete', () => {
  const s = state({ ideaText: 'short' });
  const facts = { hasPackage: false, planApproved: false, actionsActive: false, allShotsKept: false, exportCurrent: false };
  assert.equal(lockReason('plan', s, facts), COPY.stepper.locked.plan);
});

test('URL round trip write', () => {
  assert.equal(writeStepToUrl('?package=p1', 'level'), '?package=p1&step=level');
});

test('readStepFromUrl bogus', () => {
  assert.equal(readStepFromUrl('?step=bogus'), null);
});

test('readStepFromUrl valid', () => {
  assert.equal(readStepFromUrl('?step=level'), 'level');
});
