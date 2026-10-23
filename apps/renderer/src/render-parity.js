/**
 * IP56: the pure render-parity report.
 *
 * The report compares what the Player/remotion still shows with what the encoded
 * MP4 actually contains, and what the renderer's own audio plan promises with
 * what the finished file actually plays. Every measurement is supplied by the
 * ffmpeg/ffprobe script; this module stays free of child processes and media
 * decoding so the rules can be tested with fabricated numbers.
 *
 * The audio windows come from `planAudioBuses` (the exact plan the incremental
 * mix executes) and `narrationAudio` (the same helper the composition uses), so
 * a package's music, dialogue, ambience, SFX and narration are all covered.
 *
 * @typedef {import('../../../packages/schema/types').PackageV1} PackageV1
 * @typedef {import('../../../packages/planner/dist/src/index.js').Timeline} Timeline
 */
import { planAudioBuses } from '../scripts/incremental-audio.mjs';
import { resolveAudioMix } from './audio-mix-model.js';
import { narrationAudio } from './audio-model.js';

/** Stable report schema id (IP56). */
export const RENDER_PARITY_SCHEMA = 'comfyrizz.render-parity/v1';

/** Mean absolute RGB channel difference allowed between a still and its encoded frame. */
export const FRAME_CONTENT_TOLERANCE = 12;

/** A window at or below this RMS level counts as silent (dBFS). */
export const AUDIO_SILENCE_FLOOR_DBFS = -50;

/** Mix vs dialogue-plate-alone tolerance for the L-cut and no-double checks (LU). */
export const AUDIO_LOUDNESS_TOLERANCE_LU = 3;

/** Full render vs incremental mix level tolerance per audio window (dB). */
export const INCREMENTAL_LEVEL_TOLERANCE_DB = 1.5;

/** Audio stream duration may differ from the video by at most this many frames. */
export const AUDIO_DURATION_TOLERANCE_FRAMES = 1;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatDb(value) {
  if (value === -Infinity) return '-inf dBFS';
  if (!finite(value)) return 'unmeasured';
  return `${value.toFixed(1)} dBFS`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([from, to]) => finite(from) && finite(to) && to > from)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function clock(from, to) {
  return `w:${Math.round(from)}-${Math.round(to)}`;
}

/**
 * The audible and silent windows of the renderer's audio plan, in timeline
 * frames. Bus windows come from `planAudioBuses`; a dialogue window that runs
 * past its scene's visual end also yields the post-cut (L-cut) window, with the
 * matching source span so the caller can measure the plate alone.
 *
 * Silent gap windows are included so a plan cannot hide a missing bus behind a
 * vague "the whole timeline has some audio" check.
 *
 * @param {{ pkg: PackageV1, timeline: Timeline }} input
 * @returns {Array<{
 *   id: string, busId: string, kind: string, sceneId: string | null,
 *   from: number, to: number, expectedAudible: boolean,
 *   file: string | null, gainDb: number | null,
 *   sourceStartSeconds: number | null, sourceEndSeconds: number | null,
 *   lCut: boolean, cutFrame: number | null,
 * }>}
 */
export function audioPlanWindows({ pkg, timeline } = {}) {
  if (!pkg || !timeline) throw new Error('audioPlanWindows needs a package and a timeline');
  const fps = finite(timeline.fps) && timeline.fps > 0 ? timeline.fps : 30;
  const durationFrames = Math.max(0, Math.floor(timeline.durationInFrames ?? 0));
  const windows = [];

  const narration = narrationAudio(pkg);
  if (narration) {
    windows.push({
      id: clock(0, durationFrames),
      busId: 'narration',
      kind: 'narration',
      sceneId: null,
      from: 0,
      to: durationFrames,
      expectedAudible: true,
      file: narration.file,
      gainDb: 0,
      sourceStartSeconds: 0,
      sourceEndSeconds: durationFrames / fps,
      lCut: false,
      cutFrame: null,
    });
  }

  const scenes = new Map((timeline.scenes ?? []).map(scene => [scene.id, scene]));
  // planAudioBuses is the executed plan but intentionally carries no scene id
  // (the ffmpeg graph does not need one). resolveAudioMix is the renderer's
  // resolved mix and names the source scene, so join the two by file + start.
  const mix = resolveAudioMix(pkg, timeline);
  const sceneBusIds = new Map();
  for (const item of [...mix.dialogue, ...mix.ambience, ...mix.sfx]) {
    if (typeof item.sceneId === 'string' && typeof item.file === 'string') {
      sceneBusIds.set(`${item.file}\u0000${item.from}`, item.sceneId);
    }
  }
  for (const bus of planAudioBuses({ pkg, timeline })) {
    const busSceneId =
      typeof bus.sceneId === 'string'
        ? bus.sceneId
        : sceneBusIds.get(`${bus.file}\u0000${bus.from}`) ?? null;
    const busId = busSceneId ? `${bus.kind}:${busSceneId}` : bus.kind;
    const rawFrom = bus.kind === 'music' ? 0 : Math.round(bus.from ?? 0);
    const from = clamp(rawFrom, 0, durationFrames);
    const to = bus.kind === 'music'
      ? durationFrames
      : clamp(from + Math.max(0, Math.round((bus.seconds ?? 0) * fps)), 0, durationFrames);
    if (to <= from) continue;
    const sourceStart = typeof bus.startSeconds === 'number' ? bus.startSeconds : 0;
    const toSource = frame => sourceStart + (frame - rawFrom) / fps;
    const gainDb = finite(bus.gainDb) ? bus.gainDb : 0;
    windows.push({
      id: clock(from, to),
      busId,
      kind: bus.kind,
      sceneId: busSceneId,
      from,
      to,
      expectedAudible: true,
      file: typeof bus.file === 'string' ? bus.file : null,
      gainDb,
      sourceStartSeconds: toSource(from),
      sourceEndSeconds: toSource(to),
      lCut: false,
      cutFrame: null,
    });

    // IP51: an L-cut is the part of a dialogue window that plays after the
    // plate's own visual cut. It is a separate window so a dialogue that dies at
    // the cut cannot hide behind the earlier, correctly mixed part.
    if (bus.kind !== 'dialogue' || !busSceneId) continue;
    const scene = scenes.get(busSceneId);
    if (!scene) continue;
    const cutFrame = Math.round((scene.from ?? 0) + (scene.durationInFrames ?? 0));
    if (cutFrame <= from || cutFrame >= to) continue;
    windows.push({
      id: clock(cutFrame, to),
      busId,
      kind: 'dialogue',
      sceneId: busSceneId,
      from: cutFrame,
      to,
      expectedAudible: true,
      file: typeof bus.file === 'string' ? bus.file : null,
      gainDb,
      sourceStartSeconds: toSource(cutFrame),
      sourceEndSeconds: toSource(to),
      lCut: true,
      cutFrame,
    });
  }

  const coverage = mergeIntervals(windows.filter(window => window.expectedAudible).map(window => [window.from, window.to]));
  let cursor = 0;
  const addGap = (from, to) => {
    if (to <= from) return;
    windows.push({
      id: clock(from, to),
      busId: 'silence',
      kind: 'silence',
      sceneId: null,
      from,
      to,
      expectedAudible: false,
      file: null,
      gainDb: null,
      sourceStartSeconds: null,
      sourceEndSeconds: null,
      lCut: false,
      cutFrame: null,
    });
  };
  for (const [from, to] of coverage) {
    addGap(cursor, from);
    cursor = Math.max(cursor, to);
  }
  addGap(cursor, durationFrames);

  return windows.sort((a, b) => a.from - b.from || a.to - b.to || a.busId.localeCompare(b.busId));
}

/**
 * Build the schema report from measurements. This function is pure: it decides
 * pass/fail from the numbers it is given and never touches ffmpeg.
 *
 * @param {{
 *   video: { width: number, height: number, fps: number, frames: number, durationSeconds: number },
 *   expectedVideo: { width: number, height: number, fps: number, frames: number, durationSeconds: number },
 *   frameContent: Array<{ frame: number, meanAbsDiff: number }>,
 *   audioWindows: ReturnType<typeof audioPlanWindows> & Array<{ measuredDbfs: number, plateAloneDbfs?: number }>,
 *   audioStream: { present: boolean, durationSeconds: number | null },
 *   incremental: {
 *     windows: Array<{ id: string, busId: string, fullDbfs: number, incrementalDbfs: number }>,
 *     audioDurationSeconds: number | null,
 *   },
 * }} input
 */
export function buildParityReport(input = {}) {
  const { video, expectedVideo, frameContent, audioWindows, audioStream, incremental } = input;
  if (!video) throw new Error('render parity needs the measured video');
  if (!expectedVideo) throw new Error('render parity needs the compiled timeline');
  if (!Array.isArray(frameContent) || frameContent.length === 0) {
    throw new Error('render parity needs at least one measured frame-content sample');
  }
  if (!Array.isArray(audioWindows) || audioWindows.length === 0) {
    throw new Error('expectedAudio is required: the package has no audio plan windows');
  }
  if (!audioWindows.some(window => window.expectedAudible)) {
    throw new Error('expectedAudio is required: the audio plan has no audible bus');
  }
  if (!audioStream) throw new Error('expectedAudio is required: the encoded audio stream was not measured');
  if (!incremental || !Array.isArray(incremental.windows) || incremental.windows.length === 0) {
    throw new Error('render parity needs the incremental audio measurement');
  }

  const fps = finite(expectedVideo.fps) && expectedVideo.fps > 0 ? expectedVideo.fps : 30;
  const frameSeconds = 1 / fps;
  const checks = [];
  const add = (name, ok, expected, actual) => checks.push({ name, ok: Boolean(ok), expected, actual });

  add(
    'video-size',
    video.width === expectedVideo.width && video.height === expectedVideo.height,
    `${expectedVideo.width}x${expectedVideo.height}`,
    `${video.width}x${video.height}`,
  );
  add(
    'video-fps',
    finite(video.fps) && Math.abs(video.fps - expectedVideo.fps) < 1e-3,
    `${expectedVideo.fps} fps`,
    `${video.fps} fps`,
  );
  add('video-frames', video.frames === expectedVideo.frames, `${expectedVideo.frames} frames`, `${video.frames} frames`);
  const durationDiff = Math.abs((video.durationSeconds ?? NaN) - expectedVideo.durationSeconds);
  add(
    'video-duration',
    finite(video.durationSeconds) && durationDiff <= frameSeconds + 1e-6,
    `${expectedVideo.durationSeconds.toFixed(3)} s`,
    `${finite(video.durationSeconds) ? video.durationSeconds.toFixed(3) : 'unmeasured'} s`,
  );

  for (const sample of frameContent) {
    const diff = sample.meanAbsDiff;
    add(
      `frame-content@${sample.frame}`,
      finite(diff) && diff <= FRAME_CONTENT_TOLERANCE,
      `mean |channel difference| <= ${FRAME_CONTENT_TOLERANCE}/255`,
      `${finite(diff) ? diff.toFixed(2) : 'unmeasured'}/255`,
    );
  }

  add('audio-present', audioStream.present === true, 'an audio stream', audioStream.present ? 'present' : 'missing');
  const audioDurationOk =
    finite(audioStream.durationSeconds) &&
    Math.abs(audioStream.durationSeconds - expectedVideo.durationSeconds) <= AUDIO_DURATION_TOLERANCE_FRAMES * frameSeconds + 1e-6;
  add(
    'audio-stream-duration',
    audioDurationOk,
    `${expectedVideo.durationSeconds.toFixed(3)} s (within ${AUDIO_DURATION_TOLERANCE_FRAMES} frame)`,
    `${finite(audioStream.durationSeconds) ? audioStream.durationSeconds.toFixed(3) : 'unmeasured'} s`,
  );

  for (const window of audioWindows) {
    const measured = window.measuredDbfs;
    const audible = measured === -Infinity ? false : finite(measured) ? measured > AUDIO_SILENCE_FLOOR_DBFS : false;
    const expectedAudible = window.expectedAudible === true;
    add(
      `audio-window@${window.busId}@${window.id}`,
      finite(measured) || measured === -Infinity
        ? expectedAudible
          ? audible
          : !audible
        : false,
      expectedAudible
        ? `audible (RMS > ${AUDIO_SILENCE_FLOOR_DBFS} dBFS)`
        : `silent (RMS <= ${AUDIO_SILENCE_FLOOR_DBFS} dBFS)`,
      formatDb(measured),
    );

    if (window.kind !== 'dialogue') continue;
    if (!finite(window.plateAloneDbfs) && window.plateAloneDbfs !== -Infinity) continue;
    const plate = window.plateAloneDbfs;
    const diff = finite(measured) && finite(plate) ? Math.abs(measured - plate) : null;
    const label = `mix ${formatDb(measured)}, plate alone ${formatDb(plate)} at ${window.gainDb ?? 0} dB${diff === null ? '' : `, ${diff.toFixed(1)} LU difference`}`;
    add(
      `no-double-audio@${window.busId}@${window.id}`,
      diff !== null && diff <= AUDIO_LOUDNESS_TOLERANCE_LU,
      `mix is within ${AUDIO_LOUDNESS_TOLERANCE_LU} LU of the dialogue plate alone at its gain`,
      label,
    );
    if (window.lCut === true) {
      add(
        `l-cut@${window.busId}@${window.cutFrame}`,
        diff !== null && diff <= AUDIO_LOUDNESS_TOLERANCE_LU,
        `dialogue continues across the cut: |mix - plate alone| <= ${AUDIO_LOUDNESS_TOLERANCE_LU} LU`,
        `scene ${window.sceneId ?? 'unknown'} cut frame ${window.cutFrame}: ${label}`,
      );
    }
  }

  const incrementalProblems = [];
  let incrementalOk = true;
  for (const window of incremental.windows) {
    const full = window.fullDbfs;
    const inc = window.incrementalDbfs;
    const fullMeasured = finite(full) || full === -Infinity;
    const incMeasured = finite(inc) || inc === -Infinity;
    const fullAudible = full === -Infinity ? false : finite(full) ? full > AUDIO_SILENCE_FLOOR_DBFS : false;
    const incAudible = inc === -Infinity ? false : finite(inc) ? inc > AUDIO_SILENCE_FLOOR_DBFS : false;
    const verdictOk = fullMeasured && incMeasured && fullAudible === incAudible;
    const levelDiff = finite(full) && finite(inc) ? Math.abs(full - inc) : null;
    const levelOk = levelDiff !== null && levelDiff <= INCREMENTAL_LEVEL_TOLERANCE_DB;
    const ok = verdictOk && levelOk;
    if (!ok) {
      incrementalOk = false;
      const detail = [`full ${formatDb(full)}`, `incremental ${formatDb(inc)}`];
      if (levelDiff !== null) {
        detail.push(`${levelDiff.toFixed(1)} dB difference${levelOk ? '' : ` > ${INCREMENTAL_LEVEL_TOLERANCE_DB} dB`}`);
      }
      if (!verdictOk) {
        detail.push(`verdict ${fullAudible ? 'audible' : 'silent'} vs ${incAudible ? 'audible' : 'silent'}`);
      }
      incrementalProblems.push(`${window.id}${window.busId ? ` [${window.busId}]` : ''}: ${detail.join(', ')}`);
    }
    add(
      `incremental-audio@${window.busId}@${window.id}`,
      ok,
      `same audible/silent verdict and |full - incremental| <= ${INCREMENTAL_LEVEL_TOLERANCE_DB} dB`,
      `full ${formatDb(full)}, incremental ${formatDb(inc)}${levelDiff === null ? '' : `, ${levelDiff.toFixed(1)} dB difference`}`,
    );
  }

  // The incremental mux is normalised exactly like the full-render copy, so the
  // reference for "same duration as the full render" is that copy's audio
  // stream (it carries the same AAC encoder padding), not the raw video clock.
  const referenceIncrementalDuration = finite(incremental.fullAudioDurationSeconds)
    ? incremental.fullAudioDurationSeconds
    : expectedVideo.durationSeconds;
  const incrementalKeys = new Set(incremental.windows.map(window => `${window.busId}@${window.id}`));
  const missingIncremental = audioWindows
    .filter(window => !incrementalKeys.has(`${window.busId}@${window.id}`))
    .map(window => `${window.busId}@${window.id}`);
  if (missingIncremental.length > 0) {
    incrementalOk = false;
    incrementalProblems.push(`missing windows: ${missingIncremental.join(', ')}`);
  }

  const incrementalDurationOk =
    finite(incremental.audioDurationSeconds) &&
    Math.abs(incremental.audioDurationSeconds - referenceIncrementalDuration) <= AUDIO_DURATION_TOLERANCE_FRAMES * frameSeconds + 1e-6;
  if (!incrementalDurationOk) {
    incrementalOk = false;
    incrementalProblems.push(
      `duration ${finite(incremental.audioDurationSeconds) ? `${incremental.audioDurationSeconds.toFixed(3)} s` : 'unmeasured'} vs full ${referenceIncrementalDuration.toFixed(3)} s`,
    );
  }
  add(
    'incremental-audio',
    incrementalOk,
    `per-window levels <= ${INCREMENTAL_LEVEL_TOLERANCE_DB} dB, same verdicts, duration matches the full render within ${AUDIO_DURATION_TOLERANCE_FRAMES} frame`,
    incrementalProblems.length > 0
      ? incrementalProblems.join('; ')
      : `all ${incremental.windows.length} window(s) agree within ${INCREMENTAL_LEVEL_TOLERANCE_DB} dB`,
  );
  add(
    'incremental-audio-duration',
    incrementalDurationOk,
    `${referenceIncrementalDuration.toFixed(3)} s from the full render (within ${AUDIO_DURATION_TOLERANCE_FRAMES} frame)`,
    `${finite(incremental.audioDurationSeconds) ? incremental.audioDurationSeconds.toFixed(3) : 'unmeasured'} s`,
  );

  const mismatches = checks.filter(check => !check.ok).map(check => check.name);
  return {
    schema: RENDER_PARITY_SCHEMA,
    ok: mismatches.length === 0,
    checks,
    mismatches,
    summary: {
      schema: RENDER_PARITY_SCHEMA,
      checks: checks.length,
      passed: checks.length - mismatches.length,
      failed: mismatches.length,
      framesSampled: frameContent.length,
      audioWindows: audioWindows.length,
    },
  };
}

/** Render a report as the human-readable summary + one line per check. */
export function formatParityReport(report) {
  const lines = [`${report.schema}: ${report.ok ? 'OK' : 'FAILED'} (${report.summary.passed}/${report.summary.checks} checks)`];
  for (const check of report.checks) {
    lines.push(`${check.name}: ${check.ok ? 'ok' : 'FAIL'} — expected ${check.expected}; actual ${check.actual}`);
  }
  if (!report.ok) lines.push(`mismatches: ${report.mismatches.join(', ')}`);
  return lines.join('\n');
}
