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
import { compositionDurationInFrames, dbToLinear, resolveAudioMix } from '../src/audio-mix-model.js';
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
 * IP51P: the pure bus plan for the incremental mix. Scene audio with `audio_trim`
 * carries its source in/out so the ffmpeg pass can seek into the file; a scene
 * without it yields the legacy bus with no `startSeconds`/`endSeconds` keys.
 * Kept separate from `muxPackageAudio` so timing can be tested without ffmpeg.
 */
export function planAudioBuses({ pkg, timeline, mixAudio = true }) {
  const fps = timeline?.fps ?? 30;
  const mix = mixAudio ? resolveAudioMix(pkg, timeline) : { enabled: false, music: null, dialogue: [], ambience: [], sfx: [] };
  const buses = [];
  if (mix.music) {
    buses.push({
      kind: 'music',
      file: mix.music.file,
      gainDb: mix.music.gainDb,
      duck: mix.music.duck,
      loop: mix.music.loop,
      fadeIn: mix.music.fadeInSeconds ?? 0,
      fadeOut: mix.music.fadeOutSeconds ?? 0,
      ...(typeof mix.music.durationInFrames === 'number' ? { seconds: mix.music.durationInFrames / fps } : {}),
      ...(typeof mix.music.startSeconds === 'number' ? { startSeconds: mix.music.startSeconds } : {}),
      ...(typeof mix.music.endSeconds === 'number' ? { endSeconds: mix.music.endSeconds } : {}),
    });
  }
  // IP51D: native dialogue sits between the music bed and the ambience. Its
  // `duck` is disabled by the model, so the mux never sidechains it.
  for (const dialogue of mix.dialogue ?? []) {
    buses.push({
      kind: 'dialogue',
      file: dialogue.file,
      gainDb: dialogue.gainDb,
      duck: dialogue.duck,
      from: dialogue.from,
      seconds: dialogue.durationInFrames / fps,
      ...(typeof dialogue.startSeconds === 'number' ? { startSeconds: dialogue.startSeconds } : {}),
      ...(typeof dialogue.endSeconds === 'number' ? { endSeconds: dialogue.endSeconds } : {}),
    });
  }
  for (const ambience of mix.ambience) {
    buses.push({
      kind: 'ambience',
      file: ambience.file,
      gainDb: ambience.gainDb,
      duck: ambience.duck,
      from: ambience.from,
      seconds: ambience.durationInFrames / fps,
      ...(typeof ambience.startSeconds === 'number' ? { startSeconds: ambience.startSeconds } : {}),
      ...(typeof ambience.endSeconds === 'number' ? { endSeconds: ambience.endSeconds } : {}),
    });
  }
  for (const sfx of mix.sfx) {
    buses.push({ kind: 'sfx', file: sfx.file, gainDb: sfx.gainDb, from: sfx.from, seconds: sfx.durationInFrames / fps });
  }
  return buses;
}

/**
 * Mux the package's audio (narration + music bed + ambience + SFX) onto a silent
 * segment concat. Returns `{ audio, loudness }`; `audio` is null when the result
 * is silent. Missing bus files are skipped, like the P-fix4 narration fallback.
 */
export function muxPackageAudio({ silentPath, outputPath, packageDir, pkg, timeline, onLog = () => {}, mixAudio = true }) {
  const fps = timeline?.fps ?? 30;
  const durationSeconds = compositionDurationInFrames(pkg, timeline) / Math.max(1, fps);
  const masterMusic = mixAudio && resolveAudioMix(pkg, timeline).music?.master === true;
  const narration = masterMusic ? null : narrationAudio(pkg);
  const narrationPath = narration ? join(packageDir, narration.file) : null;
  const hasNarration = Boolean(narrationPath && existsSync(narrationPath));
  if (narrationPath && !hasNarration) onLog(`warning: media not in this clone: ${narration.file}; exporting silent`);

  const buses = planAudioBuses({ pkg, timeline, mixAudio })
    .filter(bus => existsSync(join(packageDir, bus.file)))
    .map(bus => ({ ...bus, path: join(packageDir, bus.file) }));

  if (!hasNarration && buses.length === 0) {
    return { audio: null, loudness: null };
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
    // Music and scene buses share exact source in/out semantics. Reset before
    // fades/delays so second zero is the trimmed master's first sample.
    if (typeof bus.startSeconds === 'number' || typeof bus.endSeconds === 'number') {
      const start = Math.max(0, typeof bus.startSeconds === 'number' ? bus.startSeconds : 0);
      const end = typeof bus.endSeconds === 'number' ? Math.max(start, bus.endSeconds) : start + bus.seconds;
      parts.push(`atrim=start=${start}:end=${end}`, 'asetpts=PTS-STARTPTS');
    }
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
  const normalised = normalizeMixLoudness(outputPath, { onLog, pkg: mixAudio ? pkg : null });
  const loudness = normalised.applied ? MIX_LOUDNESS_TARGET : null;
  onLog(`mixed ${mixLabels.length} audio source(s); ${normalised.applied ? `normalised to ${MIX_LOUDNESS_TARGET.integratedLufs} LUFS` : normalised.reason}`);
  return { audio: { sources: mixLabels.length, loudness }, loudness, normalised };
}
