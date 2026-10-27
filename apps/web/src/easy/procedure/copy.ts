import type { StageStatus } from '../super-easy/stages.ts';

type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends string ? T[K] : DeepReadonly<T[K]>;
};

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const PROCEDURE_COPY = deepFreeze({
  toggle: 'Record this run',
  toggleHint: 'Saves a recording of this tab and a step log to your Downloads, for demos. When your browser asks what to share, choose this tab.',
  defaultTitle: 'Comfyrizz procedure',
  recording: 'Recording this run',
  logging: 'Logging this run (no screen recording)',
  stop: 'Stop and save',
  saving: 'Saving the recording…',
  saved: 'Saved to your Downloads: {files}',
  failed: 'The recording could not be saved.',
  started: 'Procedure capture started',
  stopped: 'Procedure capture stopped',
  finalReady: 'Final video ready',
  previewReady: 'Preview ready on This computer',
  downloaded: 'Downloaded the video',
  prompt: 'Prompt: {prompt}',
  computeCpu: 'Starting on This computer',
  computeColab: 'Making it on Google Colab',
  approvalCpu: 'Plan approved on This computer (no Google Colab spend)',
  approvalColab: 'Google Colab spend approved, up to {cap} units',
  approvalColabNoCap: 'Google Colab spend approved',
  step: 'Easy Studio: {step}',
  failure: 'Stopped: {message}',
  unsupported: 'This browser cannot record a tab, so only the step log is saved.',
  denied: 'Screen sharing was not allowed, so only the step log is saved.',
  ended: 'Screen sharing ended early; the recording stops there.',
  notThisTab: 'More than this tab was shared. Check the recording for private details before you share it.',
  stageStatus: {
    waiting: 'Waiting',
    starting: 'Starting',
    running: 'Running',
    done: 'Done',
    skipped: 'Skipped',
    error: 'Error',
  } satisfies Record<StageStatus, string>,
});
