import type { ProductionIntent } from './production-intent.js';

type Package = Record<string, any>;

/** Only primary picture slots that SceneView actually renders. */
export function nativeFilmPlates(scene: Package): Package[] {
  if (scene.drawing || scene.composition) return [];
  if (scene.media_only !== true && ['split', 'compare'].includes(scene.layout)) {
    return (Array.isArray(scene.media) ? scene.media : []).slice(0, 2).filter((plate: any) => plate?.asset && !plate.procedural);
  }
  return scene.background?.asset && !scene.background.procedural && (scene.media_only === true || ['title', 'hero', 'list', 'stat', 'chart'].includes(scene.layout))
    ? [scene.background] : [];
}

function isH3(asset: Package | undefined): boolean {
  return asset?.kind === 'video' && asset.gen?.generator === 'fasth3-omni';
}

function masterMusic(pkg: Package): boolean {
  const music = pkg.audio?.music;
  return Boolean(music?.asset && (music.trim || music.reactive));
}

export function nativeCharacterSpeech(pkg: Package, intent: ProductionIntent): boolean {
  return intent.generatedFilm && !intent.narrationRequested && !intent.wordless && !intent.silent
    && (intent.speechRequested || (pkg.scenes ?? []).some((scene: Package) => nativeFilmPlates(scene).some(plate => {
      const asset = pkg.assets?.[plate.asset];
      return isH3(asset) && typeof asset.gen?.direction?.dialogue?.text === 'string';
    })));
}

/** Deterministic playback policy; never rewrites dialogue, assets or timing. */
export function applyNativeFilmAudio(pkg: Package, intent: ProductionIntent): Package {
  if (!intent.generatedFilm) return pkg;
  const nativeSpeech = nativeCharacterSpeech(pkg, intent);
  const noNarrator = nativeSpeech || intent.wordless || intent.silent;
  const authoritativeMusic = masterMusic(pkg);
  const scenes = (pkg.scenes ?? []).map((scene: Package) => {
    const next = { ...scene };
    if (noNarrator) {
      delete next.narration;
      delete next.narration_asset;
      delete next.narration_duration_frames;
      if (next.motion?.cue_phrases) {
        next.motion = { ...next.motion };
        delete next.motion.cue_phrases;
      }
    }
    const plates = nativeFilmPlates(scene);
    const route = (plate: Package) => {
      const asset = pkg.assets?.[plate.asset];
      if (!plates.includes(plate) || !isH3(asset)) return plate;
      // A source's explicit silent marking and an uploaded sole-master song
      // retain precedence. Otherwise native speech/foley plays once, in-place.
      return { ...plate, muted: intent.silent || authoritativeMusic || asset.media?.audio === 'muted', loop: false, speed: 1 };
    };
    if (scene.background) next.background = route(scene.background);
    if (Array.isArray(scene.media)) next.media = scene.media.map(route);
    return next;
  });
  return {
    ...pkg, scenes, ...(noNarrator ? { voice: { enabled: false, engine: 'none' } } : {}),
    ...(intent.silent ? {
      // Silence also closes the legacy mix/narration routes, not just the
      // visible video element. Otherwise the ambience bus replays muted plates.
      audio: { ambience: { enabled: false } },
      assets: Object.fromEntries(Object.entries(pkg.assets ?? {}).map(([id, value]) => {
        const asset = value as Package;
        return [id, asset?.kind === 'video' ? { ...asset, media: { ...asset.media, audio: 'muted' } } : asset];
      })),
    } : {}),
  };
}

/** Acceptance gate for stale, imported or subsequently edited packages. */
export function nativeFilmAudioProblems(pkg: Package, intent: ProductionIntent): Array<{ code: string; message: string }> {
  if (!intent.generatedFilm) return [];
  const problems: Array<{ code: string; message: string }> = [];
  const nativeSpeech = nativeCharacterSpeech(pkg, intent);
  const authoritativeMusic = masterMusic(pkg);
  if (nativeSpeech && pkg.voice?.enabled === true) problems.push({ code: 'NATIVE_DIALOGUE_NARRATOR', message: 'The brief requests native character dialogue, not a separate narrator. Disable package.voice; preserve every exact H3 dialogue line and its measured conditioning asset.' });
  if (nativeSpeech && authoritativeMusic) problems.push({ code: 'NATIVE_DIALOGUE_MASTER_MUSIC', message: 'An authoritative music master mutes native character speech. Resolve the conflicting audio plan before approval; never substitute narration for H3 dialogue.' });
  for (const scene of pkg.scenes ?? []) {
    if (nativeSpeech && (scene.narration || scene.narration_asset || scene.narration_duration_frames)) {
      problems.push({ code: 'NATIVE_DIALOGUE_NARRATION', message: `${scene.id}: remove the detached scene.narration/narration_asset fields. Spoken lines belong in the existing H3 gen.direction.dialogue, not a second Kokoro track.` });
    }
    for (const plate of nativeFilmPlates(scene)) {
      const asset = pkg.assets?.[plate.asset];
      if (!isH3(asset)) continue;
      if (intent.wordless && !intent.silent && !authoritativeMusic && asset.gen?.direction?.dialogue) problems.push({ code: 'NATIVE_WORDLESS_DIALOGUE', message: `${scene.id}: a wordless film cannot carry an audible H3 dialogue performance. Preserve the directed native soundscape and resolve this shot's speech conflict before approval.` });
      const audible = !intent.silent && !authoritativeMusic && asset.media?.audio !== 'muted';
      if (audible && plate.muted !== false) problems.push({ code: 'NATIVE_AUDIO_MUTED', message: `${scene.id}: explicitly set the visible H3 plate muted:false, loop:false, speed:1 so native speech/room tone is audible at natural speed; retain its existing asset ID.` });
      if ((!audible && plate.muted !== true) || (intent.silent && asset.media?.audio !== 'muted')) problems.push({ code: 'NATIVE_AUDIO_SILENCE', message: `${scene.id}: full silence or an authoritative music master requires the H3 source to remain muted.` });
      if (audible && (plate.speed !== 1 || plate.loop !== false)) problems.push({ code: 'NATIVE_AUDIO_PLAYBACK', message: `${scene.id}: H3 native audio requires explicit speed:1 and loop:false; fix timing allocation rather than repeating or stretching a performance.` });
      if (!intent.silent && !authoritativeMusic && asset.gen?.direction?.dialogue && asset.media?.audio === 'muted') problems.push({ code: 'NATIVE_DIALOGUE_SOURCE_MUTED', message: `${scene.id}: the H3 dialogue asset is marked muted. Restore its native source audio rather than adding detached narration.` });
    }
  }
  return problems;
}
