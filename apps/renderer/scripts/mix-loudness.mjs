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
    return {
      integratedLufs: Number(measured.input_i),
      truePeakDbtp: Number(measured.input_tp),
      rangeLu: Number(measured.input_lra),
    };
  } catch {
    return null;
  }
}

/**
 * Normalise a rendered file's audio to `target`, copying the video stream.
 * Returns `{ applied: false, reason }` for a silent file, otherwise the measured
 * input and output loudness. The file is replaced in place.
 */
export function normalizeMixLoudness(path, { target = MIX_LOUDNESS_TARGET, onLog = () => {} } = {}) {
  if (!hasAudioStream(path)) return { applied: false, reason: 'no audio stream' };
  const tmp = `${path}.loudnorm.mp4`;
  const filter = `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakDbtp}:LRA=${target.rangeLu}:print_format=json`;
  const run = spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-nostats', '-i', path, '-map', '0', '-c:v', 'copy', '-af', filter, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    rmSync(tmp, { force: true });
    throw new Error(`loudnorm failed: ${(run.stderr || '').slice(-800)}`);
  }
  const match = run.stderr.match(/\{[\s\S]*\}/);
  let measured = null;
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      measured = {
        inputIntegratedLufs: Number(parsed.input_i),
        inputTruePeakDbtp: Number(parsed.input_tp),
        outputIntegratedLufs: Number(parsed.output_i),
        outputTruePeakDbtp: Number(parsed.output_tp),
      };
    } catch {
      measured = null;
    }
  }
  renameSync(tmp, path);
  onLog(`normalised mix loudness to ${target.integratedLufs} LUFS`);
  return { applied: true, target, measured };
}
