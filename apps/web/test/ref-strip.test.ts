// RW10: reference review strip. Node has no DOM, so this uses a tiny fake root
// that records the rendered HTML and dispatches delegated clicks.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { REF_GATE_STATES } from '../../../packages/schema/src/ref-review.mjs';
import { renderRefStrip } from '../src/productions/ref-strip.ts';

const SHA_PENDING = 'a'.repeat(64);
const SHA_HELD = 'b'.repeat(64);
const SHA_CURRENT = 'c'.repeat(64);

class FakeRoot {
  constructor() {
    this.innerHTML = '';
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, target) {
    const event = {
      type,
      target,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

function fakeTarget(attributes = {}) {
  return {
    closest(selector) {
      if (!Object.hasOwn(attributes, selector)) return null;
      const values = attributes[selector];
      return {
        getAttribute(name) { return values[name] ?? null; },
      };
    },
  };
}

function clickBadge(root, jobId) {
  return root.dispatch('click', fakeTarget({ '[data-ref-badge]': { 'data-ref-badge': jobId } }));
}

function clickOverride(root, jobId) {
  return root.dispatch('click', fakeTarget({ '[data-ref-override]': { 'data-ref-override': jobId } }));
}

function clickConfirm(root, jobId) {
  return root.dispatch('click', fakeTarget({ '[data-ref-override-yes]': { 'data-ref-override-yes': jobId } }));
}

function clickCancel(root, jobId) {
  return root.dispatch('click', fakeTarget({ '[data-ref-override-cancel]': { 'data-ref-override-cancel': jobId } }));
}

function clickClose(root) {
  return root.dispatch('click', fakeTarget({ '[data-ref-why-close]': { 'data-ref-why-close': 'true' } }));
}

function heldVerdict(overrides = {}) {
  return {
    schema: 'comfyrizz.ref-review.verdict/v1',
    jobId: 'still_held',
    keyframeSha256: SHA_HELD,
    reviewer: 'pi',
    overall: 'fail',
    checks: [
      { dimension: 'identity', pass: true, severity: 'hard', evidence: 'copper hair, centre part' },
      { dimension: 'anatomy', pass: false, severity: 'hard', evidence: 'left hand has six fingers' },
      { dimension: 'framing', pass: false, severity: 'soft', evidence: 'slightly wider than planned' },
    ],
    fixHints: ['left hand rests on the sill, five fingers clearly visible'],
    ...overrides,
  };
}

function entry(state, overrides = {}) {
  const jobId = `still_${state}`;
  const sha = state === 'held' ? SHA_HELD : state === 'pending' ? SHA_PENDING : SHA_CURRENT;
  return {
    jobId,
    keyframeSha256: sha,
    state,
    attempt: 0,
    verdict: state === 'held' ? heldVerdict({ jobId, keyframeSha256: sha }) : null,
    ...overrides,
  };
}

test('the strip renders one labelled badge per gate state', () => {
  const root = new FakeRoot();
  const states = REF_GATE_STATES.map(state => entry(state));

  renderRefStrip(root, { states, regenJobsUsed: 2, cap: 6 });

  for (const state of REF_GATE_STATES) {
    const jobId = `still_${state}`;
    assert.match(root.innerHTML, new RegExp(`data-ref-badge="${jobId}"`));
    assert.match(root.innerHTML, new RegExp(`data-ref-state="${state}"`));
    assert.match(root.innerHTML, new RegExp(`aria-label="${jobId}: ${state}"`));
  }
  assert.equal((root.innerHTML.match(/data-ref-badge="/g) ?? []).length, REF_GATE_STATES.length);
  // Text labels, so no state depends on colour alone.
  assert.match(root.innerHTML, />Pending review</);
  assert.match(root.innerHTML, />Reviewing</);
  assert.match(root.innerHTML, />Accepted</);
  assert.match(root.innerHTML, />Regenerating</);
  assert.match(root.innerHTML, />Held</);
  assert.match(root.innerHTML, />Overridden</);
});

test('the regen meter states the used count and makes a cap of 1 plain', () => {
  const root = new FakeRoot();
  renderRefStrip(root, { states: [entry('pending')], regenJobsUsed: 0, cap: 6 });
  assert.match(root.innerHTML, /regens used 0 of 6 for this production/);

  renderRefStrip(root, { states: [entry('pending')], regenJobsUsed: 1, cap: 1 });
  assert.match(root.innerHTML, /regens used 1 of 1/);
  assert.match(root.innerHTML, /1 regen for this production/);
});

test('clicking a badge opens a why-drawer with failed checks and fix hints only', () => {
  const root = new FakeRoot();
  const evidenceCalls = [];
  const states = [entry('held'), entry('accepted')];

  renderRefStrip(root, {
    states,
    regenJobsUsed: 1,
    cap: 6,
    onOpenEvidence: input => evidenceCalls.push(input),
  });
  assert.doesNotMatch(root.innerHTML, /left hand has six fingers/);

  clickBadge(root, 'still_held');

  assert.match(root.innerHTML, /Why still_held is held/);
  assert.match(root.innerHTML, /anatomy/);
  assert.match(root.innerHTML, /hard/);
  assert.match(root.innerHTML, /left hand has six fingers/);
  assert.match(root.innerHTML, /framing/);
  assert.match(root.innerHTML, /soft/);
  assert.match(root.innerHTML, /slightly wider than planned/);
  assert.match(root.innerHTML, /five fingers clearly visible/);
  assert.doesNotMatch(root.innerHTML, /copper hair, centre part/);
  assert.deepEqual(evidenceCalls, [{ jobId: 'still_held', keyframeSha256: SHA_HELD }]);

  clickClose(root);
  assert.doesNotMatch(root.innerHTML, /left hand has six fingers/);
});

test('held badges show Override but call back only after the confirm step', () => {
  const root = new FakeRoot();
  const calls = [];
  renderRefStrip(root, {
    states: [entry('held'), entry('accepted')],
    regenJobsUsed: 1,
    cap: 6,
    onOverride: input => calls.push(input),
  });

  assert.match(root.innerHTML, /data-ref-override="still_held"/);
  assert.doesNotMatch(root.innerHTML, /data-ref-override="still_accepted"/);

  clickOverride(root, 'still_held');
  assert.match(root.innerHTML, /data-ref-override-confirm="still_held"/);
  assert.match(root.innerHTML, /Confirm override/);
  assert.deepEqual(calls, []);

  clickCancel(root, 'still_held');
  assert.doesNotMatch(root.innerHTML, /data-ref-override-confirm="still_held"/);
  assert.deepEqual(calls, []);

  clickOverride(root, 'still_held');
  clickConfirm(root, 'still_held');
  assert.deepEqual(calls, [{ jobId: 'still_held', keyframeSha256: SHA_HELD }]);
});

test('override sends the current sha from the latest state data', () => {
  const root = new FakeRoot();
  const calls = [];
  const options = {
    states: [entry('held')],
    regenJobsUsed: 0,
    cap: 6,
    onOverride: input => calls.push(input),
  };
  renderRefStrip(root, options);

  renderRefStrip(root, {
    ...options,
    states: [entry('held', { keyframeSha256: SHA_CURRENT })],
  });
  clickOverride(root, 'still_held');
  clickConfirm(root, 'still_held');

  assert.deepEqual(calls, [{ jobId: 'still_held', keyframeSha256: SHA_CURRENT }]);
});
