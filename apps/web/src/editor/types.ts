/**
 * Editor state shapes shared by the timeline and the CA-1 store contract.
 * CA-1 owns the store implementation; these fields are what the timeline reads.
 */
import type { PackageV1 } from '../../../../packages/schema/types';
import type { NarrationChunk } from '../../../../packages/planner/src/package-types.ts';
import type { Timeline } from '../../../../packages/planner/src/timeline.ts';
import type { Command } from './commands.ts';

export type { NarrationChunk, Timeline };

/** Source in/out for one scene asset, in source frames. Placement stays on the compiled timeline. */
export interface MediaRange {
  sceneId: string;
  assetId: string;
  /** Inclusive. */
  inFrame: number;
  /** Exclusive. */
  outFrame: number;
}

/**
 * Canonical project document. The package is the source of truth.
 * Measured narration stays keyed by scene id so a reorder never rewrites a combined WAV.
 */
export interface ProjectDoc {
  package: PackageV1;
  measured: Record<string, NarrationChunk[]>;
  mediaRanges: MediaRange[];
  revision: number;
}

/** Compiler output. `compiled` is authoritative for durations and caption placement. */
export interface DerivedState {
  compiled: Timeline | null;
  error: string | null;
}

/** Session state. It is not an undo step, except selection restored with a document undo. */
export interface SessionState {
  selectedIds: string[];
  anchorId: string | null;
  /** Integer project frame. */
  playhead: number;
  /** Pixels per frame. */
  zoom: number;
  scrollPx: number;
  snap: boolean;
  /**
   * Transient gesture from `preview()`. The stand-in does not compile while this is set.
   * A commit `dispatch` replaces it.
   */
  preview: Command | null;
}

export type SaveStatus = 'saved' | 'pending' | 'offline' | 'conflict';

export type Result = { ok: true; note?: string } | { ok: false; reason: string };

export const SAVE_STATUS_TEXT: Record<SaveStatus, string> = {
  saved: 'Saved',
  pending: 'Saving…',
  offline: 'Offline — changes kept on this device',
  conflict: 'Save conflict — recovery copy kept',
};
