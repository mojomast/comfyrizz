// UR26: the This computer path. It waits on the editor's derived preview and
// never dispatches work or starts a run.

import { COPY } from './copy.ts';
import type { EasyState, StepId } from './types.ts';

export const CPU_PREVIEW_TIMEOUT_MS = 60_000;

export interface CpuPreviewDerived {
  timeline?: unknown;
  compiledSequence?: number | null;
}

export interface CpuEditorSnapshot {
  doc?: { editSequence?: number };
  derived?: CpuPreviewDerived | null;
}

export interface CpuEditorStore {
  getState(): CpuEditorSnapshot;
  subscribe?(listener: () => void): () => void;
}

export interface CpuHost {
  editorStore: CpuEditorStore;
  refreshClips(): Promise<void> | void;
  announce?(text: string): void;
  rerender?(): void;
}

export interface CpuStore {
  get(): EasyState;
  patch(partial: Partial<EasyState>): unknown;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface RunCpuGenerateOptions {
  host: CpuHost;
  store: CpuStore;
  go(step: StepId): void;
  timeoutMs?: number;
  pollMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export type CpuGenerateResult =
  | { ok: true; step: 'review' }
  | { ok: false; code: 'not-cpu' | 'timeout' | 'refresh-failed'; message: string | null };

/** A preview is compiled when the derived timeline exists and is not stale. */
export function isPreviewCompiled(snapshot: CpuEditorSnapshot | null | undefined): boolean {
  const derived = snapshot?.derived;
  if (!derived || derived.timeline === null || derived.timeline === undefined) return false;
  const compiled = derived.compiledSequence;
  const current = snapshot?.doc?.editSequence;
  if (typeof compiled === 'number' && typeof current === 'number') return compiled === current;
  return true;
}

function waitForCompiledPreview(
  editorStore: CpuEditorStore,
  timeoutMs: number,
  pollMs: number,
  setTimer: (fn: () => void, ms: number) => TimerHandle,
  clearTimer: (handle: TimerHandle) => void,
): Promise<boolean> {
  if (isPreviewCompiled(editorStore.getState())) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let interval: TimerHandle | null = null;
    let timeout: TimerHandle | null = null;
    let unsubscribe: () => void = () => {};

    function finish(ok: boolean): void {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimer(timeout);
      if (interval !== null) clearTimer(interval);
      unsubscribe();
      resolve(ok);
    }

    function check(): void {
      if (settled) return;
      if (isPreviewCompiled(editorStore.getState())) finish(true);
    }

    timeout = setTimer(() => finish(false), Math.max(0, timeoutMs));
    if (editorStore.subscribe) unsubscribe = editorStore.subscribe(check) ?? (() => {});
    check();

    if (!settled && !editorStore.subscribe && pollMs > 0) {
      const poll = (): void => {
        if (settled) return;
        if (isPreviewCompiled(editorStore.getState())) {
          finish(true);
          return;
        }
        interval = setTimer(poll, pollMs);
      };
      interval = setTimer(poll, pollMs);
    }
  });
}

/**
 * Run the free path: show that work is happening, refresh the versions, wait
 * for the editor's derived preview, then move to Review.
 */
export async function runCpuGenerate(options: RunCpuGenerateOptions): Promise<CpuGenerateResult> {
  const {
    host,
    store,
    go,
    timeoutMs = CPU_PREVIEW_TIMEOUT_MS,
    pollMs = 50,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = options;

  if (store.get().compute !== 'cpu') return { ok: false, code: 'not-cpu', message: null };

  store.patch({ generate: { status: 'running' } });
  host.rerender?.();

  try {
    await host.refreshClips();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.patch({ generate: { status: 'error' } });
    host.announce?.(message);
    return { ok: false, code: 'refresh-failed', message };
  }

  const compiled = await waitForCompiledPreview(host.editorStore, timeoutMs, pollMs, setTimer, clearTimer);
  if (!compiled) {
    store.patch({ generate: { status: 'error' } });
    host.announce?.(COPY.errors.cpuTimeout);
    return { ok: false, code: 'timeout', message: COPY.errors.cpuTimeout };
  }

  store.patch({ generate: { status: 'done' } });
  host.announce?.(COPY.generate.cpuReady);
  go('review');
  return { ok: true, step: 'review' };
}
