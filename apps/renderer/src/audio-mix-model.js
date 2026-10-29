/**
 * M2: the renderer side of the M1 sound design. Kept free of JSX/Remotion so it
 * can be unit-tested on plain Node (see test/audio-mix.test.mjs).
 *
 * The package declares the mix (`pkg.audio`: a music bed, native dialogue, plate
 * ambience and short SFX); this module turns that into per-frame linear gains the
 * Remotion `<Audio>` nodes can read. A package with no `audio` block resolves to
 * an empty mix, so a video without sound design renders exactly as before.
 *
 * A FastH3 Omni plate's native audio is dialogue: it gets its own unity-gain bus
 * and is never ducked. LTX plate audio and FastH3 shots without a dialogue
 * direction stay on the ambience bus.
 *
 * Ducking is a sidechain under the narration: the music bed and the ambience bus
 * drop by `reduction_db` while a caption cue is speaking, with a 20 ms attack and
 * a 300 ms release (the ffmpeg `sidechaincompress` defaults in the research).
 * Word timestamps, when K1 measured them, widen the cue to the spoken words.
 *
 * @typedef {import('../../../packages/schema/types').PackageV1} PackageV1
 * @typedef {import('../../../packages/schema/types').AudioDuck} AudioDuck
 * @typedef {import('../../../packages/planner/dist/src/index.js').Timeline} Timeline
 */

export const AUDIO_MIX_DEFAULTS = Object.freeze({
  musicGainDb: -18,
  musicFadeInSeconds: 0.5,
  musicFadeOutSeconds: 1,
  musicLoop: true,
  dialogueGainDb: 0,
  ambienceGainDb: -24,
  sfxGainDb: -6,
  duckReductionDb: -12,
  duckAttackMs: 20,
  duckReleaseMs: 300,
  /** Fallback length for an SFX clip the package did not measure (seconds). */
  sfxSeconds: 1,
});

/** dBFS -> linear amplitude. 0 dB is 1, -6 dB is about 0.5. */
export function dbToLinear(db) {
  return Math.pow(10, Number(db) / 20);
}

/** Linear amplitude -> dBFS. */
export function linearToDb(linear) {
  return 20 * Math.log10(Number(linear));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object';
}

function readyAudio(asset) {
  return isObject(asset) && asset.kind === 'audio' && asset.status === 'ready' && typeof asset.file === 'string' && asset.file.length > 0;
}

/** The opt-in source window for a supplied master song. */
export function normalizeMusicTrim(music) {
  const trim = isObject(music?.trim) ? music.trim : null;
  if (!trim) return null;
  const { startSeconds, endSeconds } = trim;
  if (
    typeof startSeconds !== 'number' ||
    typeof endSeconds !== 'number' ||
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    return null;
  }
  return { startSeconds, endSeconds };
}

/** Amplitude-only presentation settings; deliberately no beat/lyric inference. */
export function normalizeMusicReactive(music) {
  const reactive = isObject(music?.reactive) ? music.reactive : null;
  if (!reactive || (reactive.style !== 'waveform' && reactive.style !== 'bars')) return null;
  return {
    style: reactive.style,
    intensity: typeof reactive.intensity === 'number' && Number.isFinite(reactive.intensity)
      ? Math.max(0, Math.min(1, reactive.intensity))
      : 0.7,
  };
}

/** New music-video packages opt in; legacy music beds keep their old routing. */
export function isMasterMusic(music) {
  return Boolean(normalizeMusicTrim(music) || normalizeMusicReactive(music));
}

/** Same authoritative sole-master routing used by playback and export finishing. */
export function hasMasterMusic(pkg) {
  const music = pkg?.audio?.music;
  return isMasterMusic(music) && readyAudio(pkg?.assets?.[music?.asset]);
}

function trimDurationInFrames(trim, fps) {
  return Math.max(1, Math.round((trim.endSeconds - trim.startSeconds) * fps));
}

/**
 * A trimmed master owns the export length as well as its source window. Round
 * once here so Remotion metadata, gains and the incremental frame check agree.
 */
export function compositionDurationInFrames(pkg, timeline) {
  const music = pkg?.audio?.music;
  const trim = normalizeMusicTrim(music);
  if (!trim || !readyAudio(pkg?.assets?.[music?.asset])) return Math.max(0, timeline?.durationInFrames ?? 0);
  const fps = typeof timeline?.fps === 'number' && timeline.fps > 0 ? timeline.fps : 30;
  return trimDurationInFrames(trim, fps);
}

/** Clip only the effective duration; committed scene timing remains untouched. */
export function timelineWithMasterMusicDuration(pkg, timeline) {
  const durationInFrames = compositionDurationInFrames(pkg, timeline);
  if (!timeline || durationInFrames === timeline.durationInFrames) return timeline;
  return { ...timeline, durationInFrames };
}

function readyPlateWithAudio(asset) {
  return (
    isObject(asset) &&
    asset.kind === 'video' &&
    asset.status === 'ready' &&
    typeof asset.file === 'string' &&
    asset.file.length > 0 &&
    asset.media?.audio === 'present'
  );
}

/** A plate whose generation direction asked for spoken dialogue. */
function hasNativeDialogue(asset) {
  return isObject(asset?.gen?.direction?.dialogue);
}

/**
 * IP51: the window a scene's audio actually plays. `null` means the legacy
 * scene-bound placement. A linked trim is derived from the current picture
 * trim and the placed scene duration, so re-timing the scene keeps the audio
 * attached; only an unlinked trim stores an independent J/L window.
 */
function audioPlacement(scene, timed, fps) {
  const trim = isObject(scene?.audio_trim) ? scene.audio_trim : null;
  if (!trim) return null;
  const offsetFrames = Number.isInteger(trim.offsetFrames) ? trim.offsetFrames : 0;
  const from = timed.from + offsetFrames;
  if (trim.linked === true) {
    const picture = isObject(scene.background?.trim) ? scene.background.trim : null;
    const startSeconds =
      typeof picture?.startSeconds === 'number' && Number.isFinite(picture.startSeconds) && picture.startSeconds >= 0
        ? picture.startSeconds
        : 0;
    const durationInFrames = Math.max(0, Math.floor(timed.durationInFrames ?? 0));
    return { from, durationInFrames, startSeconds, endSeconds: startSeconds + durationInFrames / fps };
  }
  const startSeconds = trim.startSeconds;
  const endSeconds = trim.endSeconds;
  if (
    typeof startSeconds !== 'number' ||
    typeof endSeconds !== 'number' ||
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    return null;
  }
  return {
    from,
    durationInFrames: Math.max(1, Math.round((endSeconds - startSeconds) * fps)),
    startSeconds,
    endSeconds,
  };
}

/** Gains for a trimmed window, indexed by output frame. */
function timedGains(envelope, from, durationInFrames, base) {
  const out = new Array(Math.max(0, durationInFrames));
  for (let frame = 0; frame < out.length; frame += 1) {
    out[frame] = (envelope[from + frame] ?? 1) * base;
  }
  return out;
}

/** Fill the ducking defaults from the schema. */
export function normalizeDuck(duck) {
  const source = isObject(duck) ? duck : {};
  return {
    enabled: source.enabled !== false,
    reductionDb: typeof source.reduction_db === 'number' ? source.reduction_db : AUDIO_MIX_DEFAULTS.duckReductionDb,
    attackMs: typeof source.attack_ms === 'number' ? source.attack_ms : AUDIO_MIX_DEFAULTS.duckAttackMs,
    releaseMs: typeof source.release_ms === 'number' ? source.release_ms : AUDIO_MIX_DEFAULTS.duckReleaseMs,
  };
}

/** Merge overlapping/adjacent [from, to) frame intervals, sorted. */
function mergeIntervals(intervals) {
  const sorted = intervals.filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && to > from).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/**
 * When the narration is speaking, in absolute frames. Caption cues are the base;
 * K1 word timestamps widen a cue to its first and last spoken word so a bed does
 * not pump back up inside a sentence. A package with no captions is silent.
 * @param {Timeline} timeline
 * @returns {Array<[number, number]>}
 */
export function narrationIntervals(timeline) {
  const intervals = [];
  for (const cue of timeline?.captions ?? []) {
    let from = cue.from;
    let to = cue.to;
    if (Array.isArray(cue.words) && cue.words.length > 0) {
      from = Math.min(from, ...cue.words.map(word => word.from));
      to = Math.max(to, ...cue.words.map(word => word.to));
    }
    intervals.push([from, to]);
  }
  return mergeIntervals(intervals);
}

function inIntervals(intervals, frame) {
  for (const [from, to] of intervals) {
    if (frame >= from && frame < to) return true;
    if (from > frame) break;
  }
  return false;
}

/** One-pole coefficient for a time constant, at frame resolution. */
function frameCoefficient(ms, fps) {
  const tau = Math.max(1e-4, Number(ms) / 1000);
  return 1 - Math.exp(-1 / (tau * Math.max(1, fps)));
}

/**
 * A per-frame linear multiplier (1 = untouched, `dbToLinear(reductionDb)` = fully
 * ducked). Attack when the narration starts, release when it stops.
 * @returns {number[]}
 */
export function duckEnvelope(frames, fps, intervals, duck) {
  const total = Math.max(0, Math.floor(frames));
  const out = new Array(total).fill(1);
  const normalized = normalizeDuck(duck);
  if (!normalized.enabled || intervals.length === 0) return out;
  const reduced = dbToLinear(normalized.reductionDb);
  const attack = frameCoefficient(normalized.attackMs, fps);
  const release = frameCoefficient(normalized.releaseMs, fps);
  let level = 1;
  for (let frame = 0; frame < total; frame += 1) {
    const target = inIntervals(intervals, frame) ? reduced : 1;
    level += (target - level) * (target < level ? attack : release);
    out[frame] = level;
  }
  return out;
}

/** Music fades, applied on top of the duck envelope (1 in the middle). */
function fadeEnvelope(frames, fps, fadeInSeconds, fadeOutSeconds) {
  const out = new Array(frames).fill(1);
  const fadeIn = Math.round(Math.max(0, fadeInSeconds) * fps);
  const fadeOut = Math.round(Math.max(0, fadeOutSeconds) * fps);
  for (let frame = 0; frame < frames; frame += 1) {
    let gain = 1;
    if (fadeIn > 0 && frame < fadeIn) gain *= frame / fadeIn;
    const fromEnd = frames - 1 - frame;
    if (fadeOut > 0 && fromEnd < fadeOut) gain *= fromEnd / fadeOut;
    out[frame] = gain;
  }
  return out;
}

/**
 * The frame a scene-seam sound belongs to. `scene-start` is the scene's first
 * frame; `scene-end`/`transition` is where its out-transition begins.
 * @returns {number | null}
 */
export function sfxFrame(timeline, sfx) {
  const scene = (timeline?.scenes ?? []).find(item => item.id === sfx?.scene);
  if (!scene) return null;
  const fps = timeline?.fps ?? 30;
  const seam = sfx.at === 'scene-start' ? scene.from : scene.from + scene.durationInFrames - (scene.transitionOutFrames ?? 0);
  const frame = Math.round(seam + (sfx.offset_seconds ?? 0) * fps);
  return Math.max(0, Math.min((timeline?.durationInFrames ?? frame) - 1, frame));
}

/**
 * Resolve `pkg.audio` + the timeline into the buses the renderer draws.
 *
 * @param {PackageV1} pkg
 * @param {Timeline} timeline
 * @returns {{
 *   enabled: boolean,
 *   music: null | { assetId: string, file: string, gainDb: number, fadeInSeconds: number, fadeOutSeconds: number, loop: boolean, duck: ReturnType<typeof normalizeDuck>, gains: number[], master?: boolean, startSeconds?: number, endSeconds?: number, durationInFrames?: number, reactive?: { style: 'waveform' | 'bars', intensity: number } },
 *   dialogue: Array<{ assetId: string, file: string, sceneId: string, from: number, durationInFrames: number, gainDb: number, duck: ReturnType<typeof normalizeDuck>, gains: number[] }>,
 *   ambience: Array<{ assetId: string, file: string, sceneId: string, from: number, durationInFrames: number, gainDb: number, duck: ReturnType<typeof normalizeDuck>, gains: number[] }>,
 *   sfx: Array<{ assetId: string, file: string, sceneId: string, from: number, durationInFrames: number, gainDb: number }>,
 * }}
 */
export function resolveAudioMix(pkg, timeline, { includeDirectSources = false } = {}) {
  const assets = pkg?.assets ?? {};
  const audio = isObject(pkg?.audio) ? pkg.audio : includeDirectSources ? {} : null;
  const mix = { enabled: false, music: null, dialogue: [], ambience: [], sfx: [] };
  if (!audio) return mix;
  const fps = timeline?.fps ?? 30;
  const frames = Math.max(0, timeline?.durationInFrames ?? 0);
  const intervals = narrationIntervals(timeline);
  const timelineScenes = new Map((timeline?.scenes ?? []).map(scene => [scene.id, scene]));

  if (isObject(audio.music) && readyAudio(assets[audio.music.asset])) {
    const music = audio.music;
    const trim = normalizeMusicTrim(music);
    const reactive = normalizeMusicReactive(music);
    const master = isMasterMusic(music);
    const musicFrames = trim ? trimDurationInFrames(trim, fps) : frames;
    const gainDb = typeof music.gain_db === 'number' ? music.gain_db : master ? 0 : AUDIO_MIX_DEFAULTS.musicGainDb;
    const fadeIn = typeof music.fade_in_seconds === 'number' ? music.fade_in_seconds : master ? 0 : AUDIO_MIX_DEFAULTS.musicFadeInSeconds;
    const fadeOut = typeof music.fade_out_seconds === 'number' ? music.fade_out_seconds : master ? 0 : AUDIO_MIX_DEFAULTS.musicFadeOutSeconds;
    const duck = master ? normalizeDuck({ ...(isObject(music.duck) ? music.duck : {}), enabled: false }) : normalizeDuck(music.duck);
    const envelope = duckEnvelope(musicFrames, fps, intervals, duck);
    const fades = fadeEnvelope(musicFrames, fps, fadeIn, fadeOut);
    const base = dbToLinear(gainDb);
    mix.music = {
      assetId: music.asset,
      file: assets[music.asset].file,
      gainDb,
      fadeInSeconds: fadeIn,
      fadeOutSeconds: fadeOut,
      loop: master ? false : music.loop !== false,
      duck,
      gains: envelope.map((gain, frame) => gain * fades[frame] * base),
      ...(trim ? { startSeconds: trim.startSeconds, endSeconds: trim.endSeconds, durationInFrames: musicFrames } : {}),
      ...(reactive ? { reactive } : {}),
      ...(master ? { master: true } : {}),
    };
  }

  const masterMusic = mix.music?.master === true;
  const dialogue = isObject(audio.dialogue) ? audio.dialogue : {};
  if (!masterMusic && dialogue.enabled !== false) {
    const gainDb = typeof dialogue.gain_db === 'number' ? dialogue.gain_db : AUDIO_MIX_DEFAULTS.dialogueGainDb;
    const duck = normalizeDuck({ enabled: false });
    const base = dbToLinear(gainDb);
    for (const scene of pkg?.scenes ?? []) {
      // Explicit in-picture playback already carries this source at unity.
      // Legacy muted/unspecified plates retain the independent mix-bus route.
      const asset = assets[scene?.background?.asset];
      if (scene.background?.muted === false && asset?.gen?.generator === 'fasth3-omni') continue;
      if (!readyPlateWithAudio(asset) || !hasNativeDialogue(asset)) continue;
      const timed = timelineScenes.get(scene.id);
      if (!timed) continue;
      const placement = audioPlacement(scene, timed, fps);
      const from = placement ? placement.from : timed.from;
      const durationInFrames = placement ? placement.durationInFrames : timed.durationInFrames;
      mix.dialogue.push({
        assetId: scene.background.asset,
        file: asset.file,
        sceneId: scene.id,
        from,
        durationInFrames,
        ...(placement ? { startSeconds: placement.startSeconds, endSeconds: placement.endSeconds } : {}),
        gainDb,
        duck,
        gains: new Array(Math.max(0, durationInFrames)).fill(base),
      });
    }
  }

  if (!masterMusic && isObject(audio.ambience) && audio.ambience.enabled !== false) {
    const gainDb = typeof audio.ambience.gain_db === 'number' ? audio.ambience.gain_db : AUDIO_MIX_DEFAULTS.ambienceGainDb;
    const duck = normalizeDuck(audio.ambience.duck);
    const envelope = duckEnvelope(frames, fps, intervals, duck);
    const base = dbToLinear(gainDb);
    for (const scene of pkg?.scenes ?? []) {
      const asset = assets[scene?.background?.asset];
      if (scene.background?.muted === false && asset?.gen?.generator === 'fasth3-omni') continue;
      if (!readyPlateWithAudio(asset) || hasNativeDialogue(asset)) continue;
      const timed = timelineScenes.get(scene.id);
      if (!timed) continue;
      const placement = audioPlacement(scene, timed, fps);
      mix.ambience.push({
        assetId: scene.background.asset,
        file: asset.file,
        sceneId: scene.id,
        from: placement ? placement.from : timed.from,
        durationInFrames: placement ? placement.durationInFrames : timed.durationInFrames,
        ...(placement ? { startSeconds: placement.startSeconds, endSeconds: placement.endSeconds } : {}),
        gainDb,
        duck,
        gains: placement
          ? timedGains(envelope, placement.from, placement.durationInFrames, base)
          : envelope.slice(timed.from, timed.from + timed.durationInFrames).map(gain => gain * base),
      });
    }
  }

  for (const sfx of masterMusic ? [] : audio.sfx ?? []) {
    if (!isObject(sfx) || !readyAudio(assets[sfx.asset])) continue;
    const from = sfxFrame(timeline, sfx);
    if (from === null) continue;
    const asset = assets[sfx.asset];
    const seconds = typeof asset.media?.durationSeconds === 'number' ? asset.media.durationSeconds : AUDIO_MIX_DEFAULTS.sfxSeconds;
    mix.sfx.push({
      assetId: sfx.asset,
      file: asset.file,
      sceneId: sfx.scene,
      from,
      durationInFrames: Math.max(1, Math.round(seconds * fps)),
      gainDb: typeof sfx.gain_db === 'number' ? sfx.gain_db : AUDIO_MIX_DEFAULTS.sfxGainDb,
    });
  }

  // Incremental export concatenates picture with -an, so its final mux must
  // reconstruct audio that full Remotion renders directly inside MediaFill.
  // Keep this opt-in: adding it to the full composition would double the source.
  if (includeDirectSources && !masterMusic) {
    for (const scene of pkg?.scenes ?? []) {
      if (scene.drawing || scene.composition) continue;
      const plates = scene.media_only !== true && ['split', 'compare'].includes(scene.layout)
        ? (scene.media ?? []).slice(0, 2)
        : scene.media_only === true || ['title', 'hero', 'list', 'stat', 'chart'].includes(scene.layout) ? [scene.background] : [];
      const timed = timelineScenes.get(scene.id);
      if (!timed) continue;
      for (const plate of plates) {
        const asset = assets[plate?.asset];
        if (plate?.procedural || plate?.muted !== false || asset?.gen?.generator !== 'fasth3-omni' || !readyPlateWithAudio(asset)) continue;
        const startSeconds = plate.trim?.startSeconds ?? 0;
        const track = {
          assetId: plate.asset, file: asset.file, sceneId: scene.id,
          from: timed.from, durationInFrames: timed.durationInFrames,
          startSeconds, endSeconds: startSeconds + timed.durationInFrames / fps,
          gainDb: 0, duck: normalizeDuck({ enabled: false }),
          gains: new Array(timed.durationInFrames).fill(1),
        };
        (hasNativeDialogue(asset) ? mix.dialogue : mix.ambience).push(track);
      }
    }
  }
  mix.enabled = Boolean(mix.music) || mix.dialogue.length > 0 || mix.ambience.length > 0 || mix.sfx.length > 0;
  return mix;
}
