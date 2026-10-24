// SE12: the pure Super Easy spend-confirm decision.
//
// This computer is free, so there is no dialog. Google Colab needs a user-set
// spend cap before the question can even be asked, and a cap never approves
// spend by itself: the confirmation is always required.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY } from './copy.ts';
import { decideSpendConfirm } from './spend-confirm.ts';

const CONFIRM_COPY = {
  title: COPY.googleColab.title,
  text: COPY.googleColab.body,
  confirmLabel: COPY.googleColab.confirm,
  cancelLabel: COPY.googleColab.cancel,
};

test('This computer makes no spend dialog, with or without a cap', () => {
  assert.deepEqual(decideSpendConfirm({ compute: 'cpu' }), { kind: 'none', dialog: null });
  assert.deepEqual(decideSpendConfirm({ compute: 'cpu', spendCap: 12 }), { kind: 'none', dialog: null });
  assert.deepEqual(decideSpendConfirm({ compute: 'cpu', spendCap: null }), { kind: 'none', dialog: null });
});

test('Google Colab without a user-set cap is blocked before any dialog', () => {
  for (const spendCap of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '12', false]) {
    const decision = decideSpendConfirm({ compute: 'colab', spendCap });
    assert.deepEqual(decision, {
      kind: 'blocked',
      reason: 'google-colab-spend-cap-required',
      dialog: null,
    }, `cap ${String(spendCap)}`);
  }
});

test('Google Colab with a user-set cap requires confirmation', () => {
  for (const spendCap of [0.5, 12, 500]) {
    const decision = decideSpendConfirm({ compute: 'colab', spendCap });
    assert.equal(decision.kind, 'confirm');
    assert.deepEqual(decision.dialog, CONFIRM_COPY);
  }
});

test('a cap never auto-approves: every paid decision still asks', () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const decision = decideSpendConfirm({ compute: 'colab', spendCap: 12 });
    assert.equal(decision.kind, 'confirm');
    for (const forbidden of ['approved', 'autoApproved', 'approval', 'proceed', 'start']) {
      assert.equal(Object.prototype.hasOwnProperty.call(decision, forbidden), false, forbidden);
    }
  }
});

test('the confirm dialog uses the shared copy and names Google Colab in full', () => {
  const { dialog } = decideSpendConfirm({ compute: 'colab', spendCap: 12 });
  assert.equal(dialog.title, COPY.googleColab.title);
  assert.equal(dialog.text, COPY.googleColab.body);
  assert.equal(dialog.confirmLabel, COPY.googleColab.confirm);
  assert.equal(dialog.cancelLabel, COPY.googleColab.cancel);
  assert.equal(dialog.cancelLabel, 'Use this computer');
  assert.ok(dialog.title.includes('Google Colab'));
  assert.ok(dialog.text.includes('Google Colab'));
  assert.ok(dialog.confirmLabel.includes('Google Colab'));
});

test('the decision is pure and deterministic without mutating its input', () => {
  const input = Object.freeze({ compute: 'colab', spendCap: 7.5 });
  const first = decideSpendConfirm(input);
  const second = decideSpendConfirm(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, { compute: 'colab', spendCap: 7.5 });

  const free = Object.freeze({ compute: 'cpu' });
  assert.deepEqual(decideSpendConfirm(free), { kind: 'none', dialog: null });
});
