// Duration is a creative target, not an exact-frame promise. Keep the tolerance
// bounded so a small narration/transition adjustment never becomes a different film.
export function durationAcceptance(targetSeconds) {
  const target = Number(targetSeconds);
  if (!Number.isFinite(target) || target <= 0) return null;
  const toleranceSeconds = Math.min(6, Math.max(2, target * 0.15));
  return {
    targetSeconds: target,
    toleranceSeconds,
    minSeconds: Math.max(1, target - toleranceSeconds),
    maxSeconds: target + toleranceSeconds,
  };
}

export function durationWithinTarget(actualSeconds, targetSeconds) {
  const actual = Number(actualSeconds);
  const acceptance = durationAcceptance(targetSeconds);
  if (!acceptance || !Number.isFinite(actual)) return true;
  return actual >= acceptance.minSeconds - 0.001 && actual <= acceptance.maxSeconds + 0.001;
}

export function durationRangeText(targetSeconds) {
  const acceptance = durationAcceptance(targetSeconds);
  if (!acceptance) return 'unspecified';
  return `${acceptance.minSeconds.toFixed(2)}–${acceptance.maxSeconds.toFixed(2)} seconds`;
}
