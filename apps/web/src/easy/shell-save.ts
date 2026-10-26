import { COPY } from './copy.ts';
import type { SaveState, SaveStateSource } from '../editor/save-state.ts';

/**
 * The Studio header is a consumer of the UX05 save-state contract. It never
 * assumes a save succeeded because an edit happened; every label comes from
 * the acknowledged state published by the editor store.
 */
export function saveStatusText(state: SaveState): string {
  switch (state.status) {
    case 'saved':
      return COPY.shell.saved;
    case 'pending':
      return COPY.shell.saving;
    case 'offline':
      return COPY.shell.offline;
    case 'conflict':
      return COPY.shell.conflict;
    case 'rejected': {
      const reason = typeof state.error === 'string' && state.error.trim() ? state.error.trim() : '';
      return reason ? `Save failed: ${reason}` : 'Save failed';
    }
    default:
      return COPY.shell.offline;
  }
}

export interface ShellSaveController {
  refresh(): void;
  destroy(): void;
}

function offlineState(): SaveState {
  return {
    status: 'offline',
    editSequence: 0,
    acknowledgedSequence: 0,
    acknowledgedRevision: null,
    currentRevision: null,
    error: null,
  };
}

export function mountShellSave(
  element: HTMLElement,
  source: Pick<SaveStateSource, 'saveState' | 'subscribeSaveState'> | null | undefined,
): ShellSaveController {
  let stopped = false;
  let unsubscribe: (() => void) | null = null;

  function paint(state: SaveState): void {
    if (stopped) return;
    element.textContent = saveStatusText(state);
    element.setAttribute('data-status', state.status);
    if (state.status === 'rejected') {
      element.setAttribute('title', saveStatusText(state));
    } else {
      element.removeAttribute('title');
    }
  }

  function refresh(): void {
    if (stopped) return;
    let state: SaveState;
    try {
      state = source ? source.saveState() : offlineState();
    } catch {
      state = offlineState();
    }
    paint(state);
  }

  refresh();

  if (source && typeof source.subscribeSaveState === 'function') {
    try {
      unsubscribe = source.subscribeSaveState((state) => paint(state));
    } catch {
      unsubscribe = null;
    }
  }

  return {
    refresh,
    destroy(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
