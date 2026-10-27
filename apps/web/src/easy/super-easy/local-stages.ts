// The This-computer run builds the video in the package and the editor
// preview; the production journal stays nearly empty until an export. These
// readings let the gauges follow the run itself, and the merge only ever moves
// a gauge forward, so a real server reading is never hidden.

import {
  STAGE_STATUS_TEXT,
  type StageId,
  type StageProgress,
  type StageStatus,
  type StagesProgress,
} from './stages.ts';
import type { SuperEasyRunStage } from './run.ts';

export type SuperEasyPhase = 'idle' | SuperEasyRunStage | 'preview';

export interface LocalStageReading {
  status: StageStatus;
  fraction: number;
  statusText?: string;
}

export type LocalStageReadings = Partial<Record<StageId, LocalStageReading>>;

export interface LocalStagesInput {
  phase: SuperEasyPhase;
  /** The run stopped at this phase with a visible failure. */
  failed?: boolean;
  /** The package the run built, once the plan has adopted it. */
  pkg?: unknown;
  /** The package id the run is following; a different package is ignored. */
  packageId?: string | null;
}

export const PREVIEW_STATUS_TEXT = 'Preview ready';

const ORDER: Record<Exclude<SuperEasyPhase, 'idle'>, number> = {
  idea: 0,
  compute: 0,
  plan: 1,
  iteration: 2,
  approval: 3,
  run: 4,
  preview: 5,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function running(fraction: number, statusText?: string): LocalStageReading {
  return { status: 'running', fraction, ...(statusText ? { statusText } : {}) };
}

const DONE: LocalStageReading = { status: 'done', fraction: 1 };
const SKIPPED: LocalStageReading = { status: 'skipped', fraction: 1 };

function packageOf(input: LocalStagesInput): Record<string, unknown> | null {
  if (!isRecord(input.pkg)) return null;
  const wanted = text(input.packageId);
  if (wanted === '' || text(input.pkg.id) !== wanted) return null;
  return input.pkg;
}

function scenesOf(pkg: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(pkg.scenes) ? pkg.scenes.filter(isRecord) : [];
}

function shotsReading(pkg: Record<string, unknown>): LocalStageReading {
  return scenesOf(pkg).length > 0 ? DONE : running(0.5);
}

function charactersReading(pkg: Record<string, unknown>): LocalStageReading {
  const cast = Array.isArray(pkg.characters) ? pkg.characters : Array.isArray(pkg.cast) ? pkg.cast : [];
  return cast.length > 0 ? DONE : SKIPPED;
}

function voiceReading(pkg: Record<string, unknown>): LocalStageReading {
  const voice = isRecord(pkg.voice) ? pkg.voice : null;
  if (voice?.enabled === false || text(voice?.engine) === 'none') return SKIPPED;
  const narrated = scenesOf(pkg).some((scene) => text(scene.narration) !== '');
  return narrated ? DONE : SKIPPED;
}

/**
 * Gauge readings for what the run has visibly finished. Plan is running while
 * the script and scenes are written; once the package is adopted, Characters,
 * Shots and Voice read from it. Video never reaches Done here: only a watched
 * delivery with a playable URL finishes it.
 */
export function localStageReadings(input: LocalStagesInput): LocalStageReadings {
  if (input.phase === 'idle') return {};
  const order = ORDER[input.phase];
  if (order === 0) return {};

  const readings: LocalStageReadings = {};
  if (order === 1) {
    readings.plan = running(0.4);
  } else {
    readings.plan = DONE;
    const pkg = packageOf(input);
    if (pkg !== null) {
      readings.characters = charactersReading(pkg);
      readings.shots = shotsReading(pkg);
      readings.voice = voiceReading(pkg);
    }
    if (order === 4) readings.render = running(0.5);
    if (order === 5) readings.render = running(0.9, PREVIEW_STATUS_TEXT);
  }

  if (input.failed === true) {
    const active = order === 1 ? 'plan' : order >= 4 ? 'render' : null;
    if (active !== null) {
      readings[active] = { status: 'error', fraction: readings[active]?.fraction ?? 0 };
    }
  }
  return readings;
}

function advanced(server: StageProgress, local: LocalStageReading | undefined): StageProgress {
  if (local === undefined) return server;
  if (server.status === 'error' || server.status === 'done' || server.status === 'skipped') return server;
  const localSettled = local.status === 'done' || local.status === 'skipped' || local.status === 'error';
  if (!localSettled && server.status !== 'waiting' && server.fraction >= local.fraction) return server;
  return {
    ...server,
    status: local.status,
    statusText: local.statusText ?? STAGE_STATUS_TEXT[local.status],
    fraction: Math.min(1, Math.max(0, local.fraction)),
    error: null,
  };
}

/** The server stages, each moved forward by its local reading when that is further along. */
export function mergeLocalStages(server: StagesProgress, local: LocalStageReadings): StagesProgress {
  if (Object.keys(local).length === 0) return server;
  const stages = server.stages.map((stage) => advanced(stage, local[stage.id]));
  const raw = stages.reduce((sum, stage) => sum + stage.fraction, 0) / Math.max(1, stages.length);
  const overall = server.finalReady ? Math.min(1, raw) : Math.min(raw, 0.99);
  return { ...server, stages, overall };
}
