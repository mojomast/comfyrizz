/** Delivery-size and dwell checks over the exact compiled caption timeline.
 * These are diagnostics, not perceptual approval. They never rewrite speech.
 */
export function checkCaptionQuality({ timeline, pkg, playerWidth = 342, minFontPx = 16, minDwell = 0.8, maxCps = 20 }) {
  const fps = timeline.fps;
  if (!(Number.isFinite(fps) && fps > 0)) throw new TypeError('Caption QA requires a positive fps');
  const style = pkg?.captions?.style ?? (timeline.height > timeline.width ? 'big-word' : 'sentence');
  const fontSize = { sentence: 40, karaoke: 44, 'word-pop': 44, 'big-word': 96 }[style];
  const findings = [];
  const add = (cue, code, message) => findings.push({ severity: 'warning', code, frame: cue.from,
    timeSeconds: cue.from / fps, sceneId: cue.sceneId ?? null, message });
  const cues = timeline.captions ?? [];
  for (const cue of cues) {
    const duration = (cue.to - cue.from) / fps;
    if (!Number.isFinite(duration) || duration <= 0) {
      add(cue, 'CAPTION_INVALID_SPAN', 'Caption has no valid positive display interval.');
      continue;
    }
    if (style === 'sentence' && duration < minDwell) {
      add(cue, 'CAPTION_SHORT_DWELL', `Sentence caption appears for ${duration.toFixed(2)}s; review phrase grouping and reading time.`);
    }
    const cps = Array.from(String(cue.text ?? '')).length / duration;
    if (cps > maxCps) add(cue, 'CAPTION_READING_SPEED', `Caption requires ${cps.toFixed(1)} characters/second (target <= ${maxCps}).`);
  }
  if (cues.length && Number.isFinite(fontSize) && timeline.width > 0) {
    const projected = fontSize * playerWidth / timeline.width;
    if (projected < minFontPx) add(cues[0], 'CAPTION_PLAYBACK_SIZE',
      `At a ${playerWidth}px-wide player the burned caption font scales to ${projected.toFixed(1)}px. Review actual playback size or provide scalable closed captions.`);
  }
  return findings;
}
