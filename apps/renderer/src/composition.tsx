import React, { useMemo, useState } from 'react';
import { Audio, Sequence, staticFile, useCurrentFrame } from 'remotion';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import { TimelinePlayer } from './player';
import type { MediaDimsMap, MediaSidecar } from './media';
import type { InlineAsset } from './components';
import { dbToLinear } from './audio-mix-model.js';
import { resolvePackageComposition } from './composition-model.js';
import { resolveMediaSrc } from './media-src.js';
import { LookLayer, type LookSidecar } from './look-layer';
import { MasterMusicMuteProvider } from './media';
import { MusicReactiveOverlay, type MusicReactive } from './music-reactive';
import { palette } from './theme';

export type MediaSources = Record<string, string>;

/** Audio that disappears instead of crashing when its file is not in this clone. */
export function SafeAudio({ file, volume, gains, loop, src, trimBefore, durationInFrames }: { file: string; volume?: number; gains?: number[]; loop?: boolean; src?: string; trimBefore?: number; durationInFrames?: number }) {
  const frame = useCurrentFrame();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  // G6-11: a looped <Audio> hands the volume function a media-relative frame, which
  // is fractional at a fractional-duration loop boundary and fell through to the old
  // `?? 1` default, so the second pass of the bed played at full level. Index the
  // composition (or enclosing <Sequence>) frame instead, rounded, and default to 0.
  const level = gains ? gains[Math.min(Math.max(0, Math.round(frame)), gains.length - 1)] ?? 0 : volume;
  return (
    <Audio
      src={src ?? staticFile(file)}
      pauseWhenBuffering
      {...(level !== undefined ? { volume: level } : {})}
      {...(loop ? { loop } : {})}
      {...(trimBefore !== undefined ? { trimBefore } : {})}
      {...(durationInFrames !== undefined ? { durationInFrames } : {})}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * IP51P: map a resolved scene-audio window to Remotion's source trim. A scene
 * without `audio_trim` resolves no startSeconds, so this spreads nothing and the
 * `<Audio>` props stay exactly as before.
 */
function sourceTrim(item: { [key: string]: unknown }, fps: number) {
  const startSeconds = item.startSeconds;
  if (typeof startSeconds !== 'number') return {};
  const trimBefore = Math.max(0, Math.round(startSeconds * fps));
  const endSeconds = item.endSeconds;
  return {
    trimBefore,
    ...(typeof endSeconds === 'number' ? { durationInFrames: Math.max(0, Math.round(endSeconds * fps) - trimBefore) } : {}),
  };
}

/**
 * The package composition shared by the MP4 renderer and the web Player.
 * `mediaSources` contains preview-only ticket/blob URLs. Leave it unset for export.
 */
export function PackageComposition({
  pkg,
  timeline,
  scenes,
  generatedAssets,
  media,
  missingMedia,
  mediaDims,
  mixAudio = true,
  reducedMotion = false,
  mediaSources = null,
  look = null,
}: {
  pkg: PackageV1;
  timeline: Timeline;
  scenes?: Scene[];
  generatedAssets?: Record<string, InlineAsset>;
  media?: MediaSidecar;
  missingMedia?: string[];
  mediaDims?: MediaDimsMap;
  mixAudio?: boolean;
  reducedMotion?: boolean;
  mediaSources?: MediaSources | null;
  look?: LookSidecar | null;
}) {
  const resolved = useMemo(
    () => resolvePackageComposition(pkg, timeline, { missingMedia, mixAudio }),
    [pkg, timeline, missingMedia, mixAudio],
  );
  const src = (file: string) => resolveMediaSrc(file, mediaSources, staticFile);
  const mix = resolved.mix;
  const fps = timeline.fps ?? 30;
  const missing = new Set(missingMedia ?? []);
  const masterMusic = resolved.mixAudio && mix.music?.master === true;
  const musicTrim = mix.music && typeof mix.music.startSeconds === 'number' && typeof mix.music.endSeconds === 'number'
    ? { startSeconds: mix.music.startSeconds, endSeconds: mix.music.endSeconds }
    : null;
  return (
    <MasterMusicMuteProvider enabled={masterMusic}>
      {resolved.narration && !resolved.narration.missing ? <Audio src={src(resolved.narration.file)} pauseWhenBuffering /> : null}
      {resolved.mixAudio ? (
        <>
          {mix.music && !missing.has(mix.music.file) ? (
            <SafeAudio
              file={mix.music.file}
              src={src(mix.music.file)}
              gains={mix.music.gains}
              loop={mix.music.loop}
              {...(musicTrim ? { trimBefore: Math.max(0, Math.round(musicTrim.startSeconds * fps)) } : {})}
              {...(typeof mix.music.durationInFrames === 'number' ? { durationInFrames: mix.music.durationInFrames } : {})}
            />
          ) : null}
          {mix.dialogue.map(dialogue =>
            missing.has(dialogue.file) ? null : (
              <Sequence key={`dlg-${dialogue.sceneId}`} from={dialogue.from} durationInFrames={dialogue.durationInFrames}>
                <SafeAudio file={dialogue.file} src={src(dialogue.file)} gains={dialogue.gains} {...sourceTrim(dialogue, fps)} />
              </Sequence>
            ),
          )}
          {mix.ambience.map(ambience =>
            missing.has(ambience.file) ? null : (
              <Sequence key={ambience.sceneId} from={ambience.from} durationInFrames={ambience.durationInFrames}>
                <SafeAudio file={ambience.file} src={src(ambience.file)} gains={ambience.gains} {...sourceTrim(ambience, fps)} />
              </Sequence>
            ),
          )}
          {mix.sfx.map((sfx, index) =>
            missing.has(sfx.file) ? null : (
              <Sequence key={`${sfx.assetId}-${index}`} from={sfx.from} durationInFrames={sfx.durationInFrames}>
                <SafeAudio file={sfx.file} src={src(sfx.file)} volume={dbToLinear(sfx.gainDb)} />
              </Sequence>
            ),
          )}
        </>
      ) : null}
      {mix.music?.reactive ? (
        <MusicReactiveOverlay
          src={src(mix.music.file)}
          missing={missing.has(mix.music.file)}
          trim={musicTrim}
          reactive={mix.music.reactive as MusicReactive}
          color={palette(pkg)[2]}
        />
      ) : null}
      <LookLayer look={look} palette={pkg.theme?.palette}>
        <TimelinePlayer
          pkg={pkg}
          timeline={timeline}
          fontSources={mediaSources}
          {...(scenes ? { scenes } : {})}
          generatedAssets={generatedAssets}
          media={media}
          missingMedia={missingMedia}
          mediaDims={mediaDims}
          {...(resolved.captions ? { captions: resolved.captions } : {})}
          {...(resolved.lyrics ? { lyrics: resolved.lyrics } : {})}
          reducedMotion={reducedMotion}
        />
      </LookLayer>
    </MasterMusicMuteProvider>
  );
}
