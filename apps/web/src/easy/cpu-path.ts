// UR26: the This computer path. It waits on the editor's derived preview and
// never dispatches work or starts a run.

import { COPY } from './copy.ts';
import type { EasyState, StepId } from './types.ts';

export const CPU_PREVIEW_TIMEOUT_MS = 60_000;

/** Generators that run without a GPU. Same set as the server final gate. */
export const CPU_GENERATORS = new Set(['llm-svg']);

export interface StudioClip {
  clipId: string;
  state?: string;
  sceneId?: string;
  assetId?: string;
  takeCount?: number;
}

export interface StudioAsset {
  gen?: { generator?: string } | null;
  status?: string;
  origin?: string;
  kind?: string;
}

export interface StudioGate {
  ok: boolean;
  approved: number;
  total: number;
  blocking: Array<{ clipId: string; state: string; sceneId?: string }>;
}

/**
 * The studio's review gate. A This-computer clip with no versions is kept, and
 * a ready uploaded or stock still image is already the chosen source. Ready
 * uploaded or stock video and audio are not, and a talking-head clip is not.
 * A clip that already has versions, and every other clip, still has to be kept.
 */
export function studioClipGate(
  clips: readonly StudioClip[] | null | undefined,
  assets: Record<string, StudioAsset> | null | undefined,
): StudioGate {
  const list = Array.isArray(clips) ? clips : [];
  const blocking: StudioGate['blocking'] = [];
  let approved = 0;
  for (const clip of list) {
    if (!clip || typeof clip.clipId !== 'string') continue;
    const asset = clip.assetId ? assets?.[clip.assetId] : undefined;
    const generator = asset?.gen?.generator;
    const takes = typeof clip.takeCount === 'number' ? clip.takeCount : 0;
    const importedStill = asset?.kind === 'image'
      && asset.status === 'ready'
      && (asset.origin === 'upload' || asset.origin === 'stock');
    if ((importedStill || (typeof generator === 'string' && CPU_GENERATORS.has(generator))) && takes === 0) {
      approved += 1;
      continue;
    }
    if (clip.state === 'approved') {
      approved += 1;
      continue;
    }
    blocking.push({
      clipId: clip.clipId,
      state: typeof clip.state === 'string' && clip.state ? clip.state : 'unknown',
      ...(typeof clip.sceneId === 'string' && clip.sceneId ? { sceneId: clip.sceneId } : {}),
    });
  }
  return { ok: blocking.length === 0, approved, total: list.length, blocking };
}

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

export interface CpuPreviewArtifact {
  kind: 'preview';
  compiledSequence: number | null;
  editSequence: number | null;
  playable: true;
}

/**
 * A This-computer run hands off a playable preview, not a finished MP4. The
 * caller keeps those states separate: `previewReady` is measured from the
 * editor's derived timeline, while `finalReady` stays false until a watched
 * delivery provides an actual playable URL.
 */
export type CpuGenerateResult =
  | {
      ok: true;
      step: 'review';
      previewReady: true;
      finalReady: false;
      artifact: CpuPreviewArtifact;
    }
  | {
      ok: false;
      code: 'not-cpu' | 'timeout' | 'refresh-failed';
      message: string | null;
      /** The same screen can safely offer Try again for a transient failure. */
      retryable: boolean;
    };

function previewArtifactOf(snapshot: CpuEditorSnapshot | null | undefined): CpuPreviewArtifact {
  const compiled = snapshot?.derived?.compiledSequence;
  const edited = snapshot?.doc?.editSequence;
  return {
    kind: 'preview',
    compiledSequence: typeof compiled === 'number' ? compiled : null,
    editSequence: typeof edited === 'number' ? edited : null,
    playable: true,
  };
}

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

  if (store.get().compute !== 'cpu') {
    return { ok: false, code: 'not-cpu', message: null, retryable: false };
  }

  store.patch({ generate: { status: 'running' } });
  host.rerender?.();

  try {
    await host.refreshClips();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.patch({ generate: { status: 'error' } });
    host.announce?.(message);
    return { ok: false, code: 'refresh-failed', message, retryable: true };
  }

  const compiled = await waitForCompiledPreview(host.editorStore, timeoutMs, pollMs, setTimer, clearTimer);
  if (!compiled) {
    store.patch({ generate: { status: 'error' } });
    host.announce?.(COPY.errors.cpuTimeout);
    return { ok: false, code: 'timeout', message: COPY.errors.cpuTimeout, retryable: true };
  }

  store.patch({ generate: { status: 'done' } });
  host.announce?.(COPY.generate.cpuReady);
  go('review');
  return {
    ok: true,
    step: 'review',
    previewReady: true,
    finalReady: false,
    artifact: previewArtifactOf(host.editorStore.getState()),
  };
}
