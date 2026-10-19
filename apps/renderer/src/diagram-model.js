/** Scene-local diagram timing. Invalid/missing cue lists use evenly spaced beats. */
export function diagramState({ frame, fps, sceneFrames, count, cues }) {
  const valid = Array.isArray(cues) && cues.length === count && cues.every((n, i) => Number.isFinite(n) && n >= 0 && (i === 0 || n >= cues[i - 1]));
  const starts = valid ? cues.map(s => Math.round(s * fps)) : Array.from({ length: count }, (_, i) => Math.round(fps * 0.7 + i * Math.max(1, sceneFrames - fps * 3) / Math.max(1, count)));
  let active = -1;
  const cards = starts.map((start, i) => {
    if (frame >= start) active = i;
    const t = Math.max(0, Math.min(1, (frame - start) / Math.max(1, fps * 0.55)));
    return { start, reveal: 1 - (1 - t) ** 3 };
  });
  return { active, cards, progress: Math.max(0, Math.min(1, frame / Math.max(1, sceneFrames - 1))) };
}
