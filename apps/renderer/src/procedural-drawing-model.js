/** Deterministic frame state for a polyline, including distance-based marker position. */
export function drawingProgress(element, frame) {
  if (element.end <= element.start) return frame >= element.start ? 1 : 0;
  return Math.max(0, Math.min(1, (frame - element.start) / (element.end - element.start)));
}

export function pointAlong(points, progress) {
  const lengths = points.slice(1).map((point, i) => Math.hypot(point[0] - points[i][0], point[1] - points[i][1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let distance = total * Math.max(0, Math.min(1, progress));
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i] && lengths[i] > 0) {
      const t = distance / lengths[i];
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t];
    }
    distance -= lengths[i];
  }
  return points[points.length - 1];
}
