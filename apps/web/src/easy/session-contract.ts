/**
 * UX00 project/session contract (comfyrizz.easy-session/v1).
 *
 * Shared by the Super Easy and Studio journeys (UX06, UX07, UX08). It adds no
 * separate authority record: `EasyState` in `./types.ts` stays the stored record and
 * readiness is derived from evidence, never stored as a flag.
 */
import type { EasyState } from './types.ts';

export const EASY_SESSION_CONTRACT = 'comfyrizz.easy-session/v1';

/**
 * `preview_ready`: a compiled, playable preview of the current edit exists.
 * `export_ready`: an actual final artifact exists for the current package
 * revision. Preview readiness never implies export readiness.
 */
export const RESULT_READINESS = ['none', 'preview_ready', 'export_ready'] as const;
export type ResultReadiness = (typeof RESULT_READINESS)[number];

export interface ResultEvidence {
  /** The compiled timeline belongs to the current edit sequence. */
  previewCompiled: boolean;
  /** A delivered artifact identity (not a Blob or ticket URL) and the package revision it rendered. */
  finalArtifact: { artifactId: string; revision: number } | null;
  /** Current package revision; null before the package exists. */
  packageRevision: number | null;
}

export function resultReadiness(evidence: ResultEvidence): ResultReadiness {
  const artifact = evidence.finalArtifact;
  if (artifact
    && typeof artifact.artifactId === 'string'
    && artifact.artifactId !== ''
    && evidence.packageRevision !== null
    && artifact.revision === evidence.packageRevision) {
    return 'export_ready';
  }
  return evidence.previewCompiled ? 'preview_ready' : 'none';
}

/**
 * Identity an async result or event was started under. `generation` is
 * incremented by every start-new/switch-project operation; ids fill in from
 * null as the project is created.
 */
export interface ProjectSessionRef {
  generation: number;
  packageId: string | null;
  chatId: string | null;
  productionId: string | null;
}

const SESSION_IDS = ['packageId', 'chatId', 'productionId'] as const;

/**
 * True when a result tagged `started` may still update `current`. A different
 * generation is always stale; within one generation an id that both sides
 * know must match, so a late project-A event cannot update project B.
 */
export function isCurrentSession(started: ProjectSessionRef, current: ProjectSessionRef): boolean {
  if (started.generation !== current.generation) return false;
  return SESSION_IDS.every((key) => started[key] === null || current[key] === null || started[key] === current[key]);
}

/**
 * New-project classification of every `EasyState` field. A clean start resets
 * project identity, content, decisions, spend authority and export state, and
 * carries only device/workflow preferences. The previous project is left
 * untouched in its own storage key.
 */
export const NEW_PROJECT_RESET = Object.freeze([
  'packageId',
  'chatId',
  'productionId',
  'idea',
  'questions',
  'questionsAsked',
  'answers',
  'cast',
  'narration',
  'videoType',
  'songTrim',
  'lyricsStyle',
  'lyricsLrc',
  'attachmentSignature',
  'attachmentRevision',
  'spendCap',
  'planHash',
  'builtPackageInputsHash',
  'proposalCheckpoint',
  'plan',
  'generate',
  'review',
  'exported',
] as const satisfies readonly (keyof EasyState)[]);

export const NEW_PROJECT_CARRY = Object.freeze([
  'version',
  'offline',
  'level',
  'levelTouched',
  'compute',
  'motionModel',
] as const satisfies readonly (keyof EasyState)[]);

type Classified = (typeof NEW_PROJECT_RESET)[number] | (typeof NEW_PROJECT_CARRY)[number];
type Unclassified = Exclude<keyof EasyState, Classified>;
const everyFieldClassified: Unclassified extends never ? true : never = true;
void everyFieldClassified;
