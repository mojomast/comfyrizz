function titleCase(value) {
  return String(value)
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function captionMetrics(cues, { maxCps = 20, maxLine = 42, maxLines = 2 } = {}) {
  const entries = [];
  for (const cue of cues) {
    const speaker = titleCase(cue.speaker ?? '');
    const text = String(cue.text ?? '');
    const fullText = `${speaker}: ${text}`;
    const chars = fullText.length;
    const start = Number(cue.start ?? 0);
    const end = Number(cue.end ?? 0);
    const duration = end - start;
    const cps = duration > 0 ? chars / duration : 0;
    entries.push({ cue, index: entries.length, speaker, text, start, end, duration, chars, cps, fullText });
  }

  const charsList = entries.map((e) => e.chars).sort((a, b) => a - b);
  let medianChars = 0;
  if (charsList.length) {
    const mid = Math.floor(charsList.length / 2);
    medianChars =
      charsList.length % 2 === 1
        ? charsList[mid]
        : (charsList[mid - 1] + charsList[mid]) / 2;
  }

  let maxChars = 0;
  let maxCpsValue = 0;
  let longestS = 0;
  for (const e of entries) {
    if (e.chars > maxChars) maxChars = e.chars;
    if (e.cps > maxCpsValue) maxCpsValue = e.cps;
    if (e.duration > longestS) longestS = e.duration;
  }

  const overLengthThreshold = maxLine * maxLines;
  const overCps = entries
    .filter((e) => e.cps > maxCps)
    .map((e) => ({ index: e.index, speaker: e.speaker, text: e.text, start: e.start, end: e.end, chars: e.chars, cps: e.cps }));
  const overLength = entries
    .filter((e) => e.chars > overLengthThreshold)
    .map((e) => ({ index: e.index, speaker: e.speaker, text: e.text, start: e.start, end: e.end, chars: e.chars, cps: e.cps }));

  return {
    count: entries.length,
    medianChars,
    maxChars,
    overCps,
    overLength,
    maxCps: Number(maxCpsValue.toFixed(2)),
    longestS: Number(longestS.toFixed(3)),
  };
}
