// SE12: decide whether Super Easy must ask before spending.
//
// Pure: no clock, randomness, DOM, network or stored state. This module never
// approves spend. It only reports whether a confirmation dialog is needed.
// This computer is free, so it has no dialog. Google Colab is blocked until
// the user sets a spend cap, and even with a cap the paid path still waits for
// the user's explicit confirmation. A cap alone never starts a paid run.

import { COPY } from './copy.ts';
import type { Compute } from '../types.ts';

export interface SpendConfirmInput {
  /** Where the video is made. */
  compute: Compute;
  /** The user's Google Colab spend cap, or null/undefined when none is set. */
  spendCap?: number | null;
}

export interface SpendConfirmDialog {
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel: string;
}

export type SpendConfirmReason = 'google-colab-spend-cap-required';

export type SpendConfirmDecision =
  | { kind: 'none'; dialog: null }
  | { kind: 'blocked'; reason: SpendConfirmReason; dialog: null }
  | { kind: 'confirm'; dialog: SpendConfirmDialog };

const CONFIRM_DIALOG: SpendConfirmDialog = Object.freeze({
  title: COPY.googleColab.title,
  text: COPY.googleColab.body,
  confirmLabel: COPY.googleColab.confirm,
  cancelLabel: COPY.googleColab.cancel,
});

function hasUserSpendCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Decide what must happen before generation can spend.
 *
 * - This computer: `none`, because the video is free.
 * - Google Colab without a user-set cap: `blocked`, with no dialog.
 * - Google Colab with a user-set cap: `confirm`, with the shared copy.
 *
 * A `confirm` decision is still not an approval. The caller must show the
 * dialog and act only on the user's answer; cancel keeps This computer.
 */
export function decideSpendConfirm(input: SpendConfirmInput): SpendConfirmDecision {
  if (input.compute === 'cpu') return { kind: 'none', dialog: null };
  if (!hasUserSpendCap(input.spendCap)) {
    return { kind: 'blocked', reason: 'google-colab-spend-cap-required', dialog: null };
  }
  return { kind: 'confirm', dialog: CONFIRM_DIALOG };
}
