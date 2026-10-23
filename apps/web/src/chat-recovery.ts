/**
 * IP40R: the decision surface for a conversation stuck in RECOVERY_CONFLICT.
 *
 * The server never chooses for the user. These helpers are pure so the panel
 * can be tested without a DOM: `discard` is the safe default (it only reverts
 * an exactly-identified partial package write), and `retry` asks the client to
 * run a fresh turn with a new turnId.
 */
export type RecoveryConflict = {
  /** Conversation id injected by the chat panel before a request is built. */
  id?: string;
  conversationId?: string;
  turnId?: string | null;
  projectId?: string | null;
  expected?: number | null;
  found?: number | null;
};

type RecoveryBody = {
  recoveryConflict?: RecoveryConflict | null;
  code?: string;
};

/** GET restore bodies carry `recoveryConflict`; POST errors carry the code. */
export function isRecoveryConflict(body: unknown): body is RecoveryBody & { recoveryConflict: RecoveryConflict } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as RecoveryBody;
  if (value.code === 'RECOVERY_CONFLICT') return true;
  return Boolean(value.recoveryConflict && typeof value.recoveryConflict === 'object');
}

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char] ?? char);

/**
 * The recovery choice replaces the composer actions. Discard is first and
 * focused because it is the default, and either choice keeps takes/clips.
 */
export function recoveryPanelHtml(
  conflict: RecoveryConflict | null | undefined,
  esc: (value: unknown) => string = escape,
): string {
  const turnId = esc(conflict?.turnId ?? '');
  return `<section class="chat-recovery" role="alertdialog" aria-labelledby="chat-recovery-title" aria-describedby="chat-recovery-detail" data-recovery-turn-id="${turnId}">
      <h3 id="chat-recovery-title">This conversation needs a decision</h3>
      <p id="chat-recovery-detail">The last turn may have only partly saved. Choose how to continue.</p>
      <div class="chat-recovery-actions"><button type="button" id="chat-recovery-discard" class="btn btn-primary" autofocus>Discard and restore last good save</button><button type="button" id="chat-recovery-retry" class="btn btn-secondary">Retry the turn</button></div>
      <p class="hint">Your takes and generated clips are kept either way.</p>
    </section>`;
}

export function recoveryRequest(
  choice: 'discard' | 'retry',
  conflict: RecoveryConflict | null | undefined,
): { method: 'POST'; path: string; body: { choice: 'discard' | 'retry'; expected: number | null } } {
  const id = conflict?.id ?? conflict?.conversationId ?? '';
  return {
    method: 'POST',
    path: `/api/agent/chat/${encodeURIComponent(id)}/recovery`,
    body: { choice, expected: conflict?.found ?? null },
  };
}
