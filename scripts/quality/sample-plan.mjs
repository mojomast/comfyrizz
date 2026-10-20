export function samplePlan({ durationS, fps, actionWindows = [], everyS = 2 }) {
  const totalFrames = Math.round(durationS * fps);
  const lastFrame = totalFrames - 1;
  const set = new Set();
  set.add(0);
  set.add(lastFrame);
  for (const w of actionWindows) {
    const s = Math.round(w.start * fps);
    const e = Math.round(w.end * fps);
    const mid = Math.round(((w.start + w.end) / 2) * fps);
    set.add(clamp(s, 0, lastFrame));
    set.add(clamp(mid, 0, lastFrame));
    set.add(clamp(e, 0, lastFrame));
  }
  // regular intermediates every everyS seconds
  const stepFrames = Math.round(everyS * fps);
  if (stepFrames > 0) {
    for (let f = 0; f <= lastFrame; f += stepFrames) set.add(f);
  }
  return [...set].filter((f) => f >= 0 && f <= lastFrame).sort((a, b) => a - b);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function ffmpegSampleArgs(input, times, outPattern) {
  const args = [];
  for (const t of times) {
    args.push("-ss", String(t / 24).replace(/\.?0+$/, "") || "0");
  }
  // Build a single ffmpeg invocation extracting each frame via select? Simpler: per-frame not possible in one argv.
  // Spec: argv array for extraction. Provide args that reference times.
  return ["-i", input, "-vf", `select='eq(n\\,${times.join("+eq(n\\,")})'`, "-vsync", "vfr", outPattern];
}
