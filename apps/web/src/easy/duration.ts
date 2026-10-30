/** Whole-second durations supported by the Easy controls. */
export const MIN_EASY_SECONDS = 1;
export const MAX_EASY_SECONDS = 120;
export const EASY_DURATION_PRESETS = [15, 30, 60, 90] as const;

export function isEasyDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_EASY_SECONDS && value <= MAX_EASY_SECONDS;
}
