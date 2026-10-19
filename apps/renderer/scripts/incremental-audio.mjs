/**
 * M2: the incremental (render-changes) path mixes the sound design with ffmpeg.
 * The full render lets Remotion read per-frame gains, but the incremental path
 * concatenates already-rendered segments and muxes the audio afterwards, so the
 * buses are combined here. Ducking uses ffmpeg's `sidechaincompress` under the
 * narration (the research's own tool); the finished file is then normalised to
 * the -16 LUFS master. A package with no `audio` block keeps the old single
 * narration mux, byte-for-byte.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dbToLinear, resolveAudioMix } from '../src/audio-mix-model.js';
import { narrationAudio } from '../src/audio-model.js';
import { MIX_LOUDNESS_TARGET, normalizeMixLoudness } from './mix-loudness.mjs';

/** Sidechain ratio that approximates a fixed dB reduction (ffmpeg has no duck preset). */
function duckRatio(reductionDb) {
  return Math.max(1.5, Math.min(20, Math.abs(Number(reductionDb) || 12) / 2));
}

function adelayMs(frame, fps) {
  return Math.max(0, Math.round((frame / Math.max(1, fps)) * 1000));
}

/**
 * Mux the package's audio (narration + music bed + ambience + SFX) onto a silent
 * segment concat. Returns `{ audio, loudness }`; `audio` is null when the result
 * is silent. Missing bus files are skipped, like the P-fix4 narration fallback.
 */
export function muxPackageAudio({ silentPath, outputPath, packageDir, pkg, timeline, onLog = () => {}, mixAudio = true }) {
  const fps = timeline?.fps ?? 30;
  const durationSeconds = (timeline?.durationInFrames ?? 0) / Math.max(1, fps);
  const narration = narrationAudio(pkg);
  const narrationPath = narration ? join(packageDir, narration.file) : null;
  const hasNarration = Boolean(narrationPath && existsSync(narrationPath));
  if (narrationPath && !hasNarration) onLog(`warning: media not in this clone: ${narration.file}; exporting silent`);

  const mix = mixAudio ? resolveAudioMix(pkg, timeline) : { enabled: false, music: null, ambience: [], sfx: [] };
  const buses = [];
  if (mix.music && existsSync(join(packageDir, mix.music.file))) {
    buses.push({ kind: 'music', path: join(packageDir, mix.music.file), gainDb: mix.music.gainDb, duck: mix.music.duck, loop: mix.music.loop, fadeIn: mix.music.fadeInSeconds ?? 0, fadeOut: mix.music.fadeOutSeconds ?? 0 });
  }
  for (const ambience of mix.ambience) {
    if (existsSync(join(packageDir, ambience.file))) {
      buses.push({ kind: 'ambience', path: join(packageDir, ambience.file), gainDb: ambience.gainDb, duck: ambience.duck, from: ambience.from, seconds: ambience.durationInFrames / fps });
    }
  }
  for (const sfx of mix.sfx) {
    if (existsSync(join(packageDir, sfx.file))) {
      buses.push({ kind: 'sfx', path: join(packageDir, sfx.file), gainDb: sfx.gainDb, from: sfx.from, seconds: sfx.durationInFrames / fps });
    }
  }

  if (!hasNarration && buses.length === 0) {
    return { audio: null, loudness: null };
  }

  // The music bed's fades live in the model; re-read them from the package.
  const music = mix.music;
  const fadeIn = music && typeof pkg.audio?.music?.fade_in_seconds === 'number' ? pkg.audio.music.fade_in_seconds : 0.5;
  const fadeOut = music && typeof pkg.audio?.music?.fade_out_seconds === 'number' ? pkg.audio.music.fade_out_seconds : 1;
  if (buses[0]?.kind === 'music') {
    buses[0].fadeIn = fadeIn;
    buses[0].fadeOut = fadeOut;
  }

  const inputs = ['-i', silentPath];
  const filters = [];
  const mixLabels = [];
  let inputIndex = 1;
  const duckedBuses = buses.filter(bus => bus.duck?.enabled !== false);
  const voiceConsumers = hasNarration ? duckedBuses.length + 1 : 0;
  const voiceSplit = [];
  if (hasNarration) {
    inputs.push('-i', narrationPath);
    if (voiceConsumers === 1) {
      filters.push(`[${inputIndex}:a]anull[v0]`);
      voiceSplit.push('v0');
    } else {
      const labels = Array.from({ length: voiceConsumers }, (_, index) => `v${index}`);
      filters.push(`[${inputIndex}:a]anull,asplit=${voiceConsumers}${labels.map(label => `[${label}]`).join('')}`);
      voiceSplit.push(...labels);
    }
    mixLabels.push(`[${voiceSplit[voiceConsumers - 1]}]`);
    inputIndex += 1;
  }
  let voiceCursor = 0;
  buses.forEach((bus, busIndex) => {
    if (bus.loop) inputs.push('-stream_loop', '-1', '-i', bus.path);
    else inputs.push('-i', bus.path);
    const index = inputIndex;
    inputIndex += 1;
    const raw = `b${busIndex}`;
    const parts = [`volume=${dbToLinear(bus.gainDb).toFixed(6)}`];
    if (bus.kind === 'music') {
      if (bus.fadeIn > 0) parts.push(`afade=t=in:st=0:d=${bus.fadeIn}`);
      if (bus.fadeOut > 0) parts.push(`afade=t=out:st=${Math.max(0, durationSeconds - bus.fadeOut)}:d=${bus.fadeOut}`);
      parts.push(`atrim=0:${durationSeconds}`);
    } else {
      parts.push(`adelay=${adelayMs(bus.from, fps)}:all=1`);
      parts.push(`atrim=0:${Math.max(0, (bus.from / fps) + bus.seconds)}`);
    }
    parts.push('asetpts=N/SR/TB');
    filters.push(`[${index}:a]${parts.join(',')}[${raw}]`);
    let label = raw;
    if (bus.duck?.enabled !== false && hasNarration) {
      const ducked = `d${busIndex}`;
      const sidechain = `[${voiceSplit[voiceCursor++]}]`;
      filters.push(
        `[${raw}]${sidechain}sidechaincompress=threshold=0.02:ratio=${duckRatio(bus.duck?.reductionDb ?? -12).toFixed(2)}:attack=${bus.duck?.attackMs ?? 20}:release=${bus.duck?.releaseMs ?? 300}:makeup=1[${ducked}]`,
      );
      label = ducked;
    }
    mixLabels.push(`[${label}]`);
  });

  filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:normalize=0[mixed]`);

  const args = [
    '-y', '-hide_banner', '-nostats',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v', '-map', '[mixed]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart',
    outputPath,
  ];
  const run = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`audio mix failed: ${(run.stderr || '').slice(-800)}`);
  // Two-pass linear loudnorm, not the old inline one-pass: dynamic loudnorm pumps
  // the quiet stretches and undoes the sidechain duck (G6-11).
  const normalised = normalizeMixLoudness(outputPath, { onLog });
  onLog(`mixed ${mixLabels.length} audio source(s) and normalised to ${MIX_LOUDNESS_TARGET.integratedLufs} LUFS`);
  return { audio: { sources: mixLabels.length, loudness: MIX_LOUDNESS_TARGET }, loudness: MIX_LOUDNESS_TARGET, normalised };
}
