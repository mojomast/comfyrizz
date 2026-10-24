import { COPY } from './copy.ts';
import { summarizeProgress } from '../../productions/cards/progress.ts';

export const STAGE_IDS = Object.freeze([
  'plan',
  'characters',
  'shots',
  'voice',
  'render',
] as const);

export type StageId = (typeof STAGE_IDS)[number];

export const STAGE_STATUSES = Object.freeze([
  'waiting',
  'starting',
  'running',
  'done',
  'skipped',
  'error',
] as const);

export type StageStatus = (typeof STAGE_STATUSES)[number];

export const STAGE_STATUS_TEXT: Readonly<Record<StageStatus, string>> = Object.freeze({
  waiting: 'Waiting',
  starting: 'Starting',
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  error: 'Error',
});

export const STAGE_LABELS: Readonly<Record<StageId, string>> = Object.freeze({
  plan: COPY.stages.plan,
  characters: COPY.stages.characters,
  shots: COPY.stages.shots,
  voice: COPY.stages.voice,
  render: COPY.stages.video,
});

export interface StageProgress {
  id: StageId;
  label: string;
  status: StageStatus;
  statusText: string;
  fraction: number;
  error: string | null;
}

export interface StagesProgress {
  stages: StageProgress[];
  overall: number;
  finalReady: boolean;
  complete: boolean;
}

interface StageReading {
  status: StageStatus;
  fraction: number;
  error: string | null;
}

const DONE_STATUSES = new Set([
  'done',
  'complete',
  'completed',
  'ready',
  'approved',
  'finished',
  'success',
  'succeeded',
]);

const SKIPPED_STATUSES = new Set(['skipped', 'skip', 'not_needed']);

const ERROR_STATUSES = new Set(['error', 'failed', 'failure']);

const RUNNING_STATUSES = new Set([
  'running',
  'working',
  'in_progress',
  'in-progress',
  'processing',
  'generating',
  'rendering',
  'review',
]);

const STARTING_STATUSES = new Set(['starting', 'started', 'beginning', 'preparing']);

const WAITING_STATUSES = new Set([
  'waiting',
  'pending',
  'queued',
  'idle',
  'planned',
  'draft',
  'not_started',
]);

const READY_STATES = new Set([
  'ready',
  'done',
  'complete',
  'completed',
  'delivered',
  'accepted',
  'available',
]);

const FRACTION_KEYS = ['fraction', 'progress', 'ratio'] as const;
const DONE_COUNT_KEYS = ['done', 'completed', 'finished', 'readyCount', 'completedCount'] as const;
const TOTAL_COUNT_KEYS = ['total', 'expected', 'count', 'totalCount'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = nonEmptyText(value);
    if (text !== '') return text;
  }
  return '';
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function reading(status: StageStatus, fraction = 0, error: string | null = null): StageReading {
  return { status, fraction: clampFraction(fraction), error };
}

function waiting(): StageReading {
  return reading('waiting');
}

function normalizeStatus(value: unknown): StageStatus | null {
  const key = nonEmptyText(value).toLowerCase();
  if (DONE_STATUSES.has(key)) return 'done';
  if (SKIPPED_STATUSES.has(key)) return 'skipped';
  if (ERROR_STATUSES.has(key)) return 'error';
  if (RUNNING_STATUSES.has(key)) return 'running';
  if (STARTING_STATUSES.has(key)) return 'starting';
  if (WAITING_STATUSES.has(key)) return 'waiting';
  return null;
}

function errorOf(value: Record<string, unknown>): string | null {
  const error = value.error;
  if (typeof error === 'string') {
    const text = error.trim();
    return text === '' ? null : text;
  }
  if (error === true) return 'Error';
  if (isRecord(error)) {
    const text = firstText(error.message, error.detail, error.reason, error.code);
    return text === '' ? 'Error' : text;
  }
  return null;
}

function fractionOf(value: Record<string, unknown>): number | null {
  for (const key of FRACTION_KEYS) {
    const number = finiteNumber(value[key]);
    if (number !== null) return clampFraction(number);
  }
  return null;
}

function firstCount(value: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const number = nonNegativeInteger(value[key]);
    if (number !== null) return number;
  }
  return null;
}

function countsOf(value: Record<string, unknown>): { fraction: number; done: number; total: number } | null {
  const total = firstCount(value, TOTAL_COUNT_KEYS);
  if (total === null || total === 0) return null;
  const done = Math.min(firstCount(value, DONE_COUNT_KEYS) ?? 0, total);
  return { fraction: done / total, done, total };
}

function readCollection(values: readonly unknown[]): StageReading {
  if (values.length === 0) return waiting();
  const readings = values.map((value) => readStageValue(value));
  const errors = readings.filter((entry) => entry.status === 'error' && entry.error !== null);
  const fraction = readings.reduce((sum, entry) => sum + entry.fraction, 0) / readings.length;
  if (errors.length > 0) return reading('error', fraction, errors[0].error);

  const complete = readings.filter((entry) => entry.status === 'done' || entry.status === 'skipped').length;
  if (complete === readings.length) return reading('done', 1);
  if (complete > 0 || readings.some((entry) => entry.status === 'running' || entry.status === 'starting')) {
    return reading('running', fraction);
  }
  return waiting();
}

function readStageValue(value: unknown): StageReading {
  if (value === undefined || value === null || value === false) return waiting();
  if (value === true) return reading('done', 1);

  if (typeof value === 'number') {
    const fraction = clampFraction(value);
    return fraction >= 1 ? reading('done', 1) : fraction > 0 ? reading('running', fraction) : waiting();
  }

  if (Array.isArray(value)) return readCollection(value);
  if (!isRecord(value)) return waiting();

  const error = errorOf(value);
  if (error !== null) {
    return reading('error', fractionOf(value) ?? countsOf(value)?.fraction ?? 0, error);
  }

  const rawStatus = firstText(value.status, value.state);
  const status = normalizeStatus(rawStatus);
  if (rawStatus !== '' && status === null) return waiting();

  if (status === 'skipped' || value.skipped === true) return reading('skipped', 1);
  if (status === 'error') return reading('error', fractionOf(value) ?? countsOf(value)?.fraction ?? 0, 'Error');
  if (status === 'done') return reading('done', 1);
  if (status === 'starting') return reading('starting', fractionOf(value) ?? 0);
  if (status === 'running') {
    return reading('running', fractionOf(value) ?? countsOf(value)?.fraction ?? 0);
  }
  if (status === 'waiting') return waiting();

  if (value.ready === true || value.complete === true || value.completed === true || value.done === true) {
    return reading('done', 1);
  }

  const counts = countsOf(value);
  if (counts !== null) {
    return counts.done >= counts.total
      ? reading('done', 1)
      : reading('running', counts.fraction);
  }

  const fraction = fractionOf(value);
  if (fraction !== null) {
    return fraction >= 1 ? reading('done', 1) : fraction > 0 ? reading('running', fraction) : waiting();
  }

  if (value.started === true) return reading('starting', 0);
  return waiting();
}

function shotInput(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && (Array.isArray(value.shots) || Array.isArray(value.shotIds))) return value;
  return undefined;
}

function readShotsValue(value: unknown): StageReading {
  const input = shotInput(value);
  if (input === undefined) return readStageValue(value);

  const summary = summarizeProgress(input);
  if (summary.total === 0) return waiting();
  const fraction = summary.approved / summary.total;
  if (summary.counts.failed > 0) {
    const count = summary.counts.failed;
    return reading('error', fraction, `${count} shot${count === 1 ? '' : 's'} failed`);
  }
  if (summary.approved === summary.total) return reading('done', 1);
  return reading('running', fraction);
}

function productionOf(root: Record<string, unknown> | null): Record<string, unknown> | null {
  if (root === null) return null;
  return isRecord(root.production) ? root.production : root;
}

function finalVideoReady(value: unknown): boolean {
  if (value === true) return true;
  if (!isRecord(value)) return false;
  if (value.ready === true || value.complete === true || value.completed === true || value.available === true) {
    return true;
  }
  const state = firstText(value.status, value.state).toLowerCase();
  if (READY_STATES.has(state)) return true;
  return nonEmptyText(value.deliveryId) !== ''
    || nonEmptyText(value.url) !== ''
    || nonEmptyText(value.videoUrl) !== '';
}

function readFinalReady(root: Record<string, unknown> | null): boolean {
  if (root === null) return false;
  if (root.finalVideo !== undefined && finalVideoReady(root.finalVideo)) return true;
  if (root.delivery !== undefined && finalVideoReady(root.delivery)) return true;
  if (nonEmptyText(root.latestDeliveryId) !== '') return true;
  const production = productionOf(root);
  return production !== null
    && production !== root
    && nonEmptyText(production.latestDeliveryId) !== '';
}

function explicitStage(
  root: Record<string, unknown> | null,
  production: Record<string, unknown> | null,
  id: StageId,
): unknown {
  if (root !== null && root[id] !== undefined) return root[id];
  if (production !== null && production[id] !== undefined) return production[id];
  return undefined;
}

function readPlan(root: Record<string, unknown> | null, production: Record<string, unknown> | null): StageReading {
  const explicit = explicitStage(root, production, 'plan');
  if (explicit !== undefined) return readStageValue(explicit);
  if (production === null) return waiting();

  const brief = nonEmptyText(production.briefVersionId);
  const script = nonEmptyText(production.scriptVersionId);
  if (brief !== '' && script !== '') return reading('done', 1);
  if (brief !== '' || script !== '') return reading('running', 0.5);
  return waiting();
}

function bindingsOf(production: Record<string, unknown> | null): readonly unknown[] {
  return production !== null && Array.isArray(production.characterBindings)
    ? production.characterBindings
    : [];
}

function readCharacters(
  root: Record<string, unknown> | null,
  production: Record<string, unknown> | null,
): StageReading {
  const explicit = explicitStage(root, production, 'characters');
  if (explicit !== undefined) return readStageValue(explicit);

  const bindings = bindingsOf(production);
  if (bindings.length === 0) return waiting();
  const done = bindings.filter((binding) => {
    if (!isRecord(binding)) return false;
    const state = readStageValue(binding);
    if (state.status === 'error') return false;
    return state.status === 'done'
      || state.status === 'skipped'
      || nonEmptyText(binding.artifactId) !== ''
      || nonEmptyText(binding.imageUrl) !== ''
      || nonEmptyText(binding.image) !== '';
  }).length;
  if (done === bindings.length) return reading('done', 1);
  return done > 0 ? reading('running', done / bindings.length) : waiting();
}

function readShots(root: Record<string, unknown> | null, production: Record<string, unknown> | null): StageReading {
  const explicit = explicitStage(root, production, 'shots');
  if (explicit !== undefined) return readShotsValue(explicit);
  if (production !== null && Array.isArray(production.shotIds)) {
    return readShotsValue({ shotIds: production.shotIds });
  }
  return waiting();
}

function readVoice(root: Record<string, unknown> | null, production: Record<string, unknown> | null): StageReading {
  const explicit = explicitStage(root, production, 'voice');
  if (explicit !== undefined) return readStageValue(explicit);

  const bindings = bindingsOf(production);
  if (bindings.length === 0) return waiting();
  const withVoice = bindings.filter((binding) => isRecord(binding)
    && (nonEmptyText(binding.voiceId) !== '' || nonEmptyText(binding.voice) !== '')).length;
  if (withVoice === bindings.length) return reading('done', 1);
  return withVoice > 0 ? reading('running', withVoice / bindings.length) : waiting();
}

function readRender(
  root: Record<string, unknown> | null,
  production: Record<string, unknown> | null,
  finalReady: boolean,
): StageReading {
  if (finalReady) return reading('done', 1);

  const explicit = explicitStage(root, production, 'render');
  if (explicit === undefined) return waiting();

  const state = readStageValue(explicit);
  if (state.status === 'error') return state;
  if (state.status === 'skipped') return state;
  if (state.status === 'done' || state.fraction >= 1) {
    return reading('running', 0.99);
  }
  return state;
}

function stageProgress(id: StageId, state: StageReading): StageProgress {
  return {
    id,
    label: STAGE_LABELS[id],
    status: state.status,
    statusText: STAGE_STATUS_TEXT[state.status],
    fraction: state.fraction,
    error: state.error,
  };
}

function assemble(states: Record<StageId, StageReading>, finalReady: boolean): StagesProgress {
  const stages = STAGE_IDS.map((id) => stageProgress(id, states[id]));
  const raw = stages.reduce((sum, stage) => sum + stage.fraction, 0) / STAGE_IDS.length;
  const overall = finalReady ? clampFraction(raw) : Math.min(clampFraction(raw), 0.99);
  const complete = finalReady
    && stages.every((stage) => stage.status === 'done' || stage.status === 'skipped');
  return { stages, overall, finalReady, complete };
}

export function readStages(input: unknown): StagesProgress {
  const root = isRecord(input) ? input : null;
  if (root !== null && root.loading === true) {
    return assemble({
      plan: waiting(),
      characters: waiting(),
      shots: waiting(),
      voice: waiting(),
      render: waiting(),
    }, false);
  }

  const production = productionOf(root);
  const finalReady = readFinalReady(root);
  return assemble({
    plan: readPlan(root, production),
    characters: readCharacters(root, production),
    shots: readShots(root, production),
    voice: readVoice(root, production),
    render: readRender(root, production, finalReady),
  }, finalReady);
}
