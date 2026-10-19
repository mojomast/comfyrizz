/**
 * M2: bring the rendered mix to the same loudness target the narration master
 * uses (research: "duck it under narration with sidechaincompress, then
 * loudnorm"). Remotion mixes the buses into the render; this is the one ffmpeg
 * pass that normalises the finished file to about -16 LUFS without re-encoding
 * the picture.
 *
 *   import { normalizeMixLoudness } from './mix-loudness.mjs';
 *   const result = normalizeMixLoudness('out/demo.mp4');
 */
import { spawnSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';

/** The same target `packages/tts/scripts/narrate.mjs` normalises narration to. */
export const MIX_LOUDNESS_TARGET = Object.freeze({ integratedLufs: -16, truePeakDbtp: -1, rangeLu: 11 });

/** True when the file carries at least one audio stream. */
export function hasAudioStream(path) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'json', path], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) return false;
  try {
    return (JSON.parse(probe.stdout).streams ?? []).length > 0;
  } catch {
    return false;
  }
}

/** The integrated loudness ffmpeg measures for a file, or null when it cannot. */
export function measureLoudness(path) {
  const run = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', path, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const match = run.stderr.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const measured = JSON.parse(match[0]);
    const parsed = {
      integratedLufs: Number(measured.input_i),
      truePeakDbtp: Number(measured.input_tp),
      rangeLu: Number(measured.input_lra),
      thresholdLufs: Number(measured.input_thresh),
      targetOffsetDb: Number(measured.target_offset),
    };
    // A silent input measures -inf; there is nothing to normalise.
    if (!Number.isFinite(parsed.integratedLufs) || !Number.isFinite(parsed.thresholdLufs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** A single linear gain keeps the ducking intact; alimiter holds the true peak. */
function staticGainFilter(measured, target) {
  const gainDb = target.integratedLufs - measured.integratedLufs;
  const limit = 10 ** (target.truePeakDbtp / 20);
  return `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${limit.toFixed(6)}:level=disabled,aresample=48000`;
}

/**
 * Normalise a rendered file's audio to `target`, copying the video stream.
 *
 * Two passes: `measureLoudness` reads the file, then loudnorm applies that
 * measurement with `linear=true`, which is a single gain and does NOT pump the
 * quiet stretches. One-pass loudnorm is dynamic and would undo the sidechain
 * duck (the bed comes back ~8 dB louder once the voice stops). The audio is
 * resampled to 48 kHz, because loudnorm otherwise leaves AAC at 96 kHz.
 * Returns `{ applied: false, reason }` for a silent file, otherwise the measured
 * input and output loudness. The file is replaced in place.
 */
export function normalizeMixLoudness(path, { target = MIX_LOUDNESS_TARGET, onLog = () => {} } = {}) {
  if (!hasAudioStream(path)) return { applied: false, reason: 'no audio stream' };
  const measured = measureLoudness(path);
  // A silent mix has nothing to normalise; leave it as it is.
  if (!measured) return { applied: false, reason: 'silent audio' };
  const shared = `I=${target.integratedLufs}:TP=${target.truePeakDbtp}:LRA=${target.rangeLu}`;
  const linear = `loudnorm=${shared}:measured_I=${measured.integratedLufs}:measured_TP=${measured.truePeakDbtp}:measured_LRA=${measured.rangeLu}:measured_thresh=${measured.thresholdLufs}:offset=${measured.targetOffsetDb}:linear=true:print_format=json,aresample=48000`;
  const tmp = `${path}.loudnorm.mp4`;
  const runLoudnorm = filter => spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-nostats', '-i', path, '-map', '0', '-c:v', 'copy', '-af', filter, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', tmp],
    { encoding: 'utf8' },
  );
  let run = runLoudnorm(linear);
  // loudnorm refuses linear mode when the gain would clip past the ceiling; fall
  // back to one static gain (still not dynamic) rather than re-introducing the pump.
  if (run.status !== 0) {
    onLog('warning: linear loudnorm refused; applying a static gain instead');
    run = runLoudnorm(staticGainFilter(measured, target));
  }
  if (run.status !== 0) {
    rmSync(tmp, { force: true });
    throw new Error(`loudnorm failed: ${(run.stderr || '').slice(-800)}`);
  }
  const match = run.stderr.match(/\{[\s\S]*\}/);
  let measuredOut = null;
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      measuredOut = {
        inputIntegratedLufs: Number(parsed.input_i),
        inputTruePeakDbtp: Number(parsed.input_tp),
        outputIntegratedLufs: Number(parsed.output_i),
        outputTruePeakDbtp: Number(parsed.output_tp),
      };
    } catch {
      measuredOut = null;
    }
  }
  renameSync(tmp, path);
  onLog(`normalised mix loudness to ${target.integratedLufs} LUFS (two-pass linear, 48 kHz)`);
  return { applied: true, target, measured: measuredOut, input: measured };
}
