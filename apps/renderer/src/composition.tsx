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

export type MediaAuth = { packageId: string; token: string; origin?: string };

/** Audio that disappears instead of crashing when its file is not in this clone. */
export function SafeAudio({ file, volume, gains, loop, src }: { file: string; volume?: number; gains?: number[]; loop?: boolean; src?: string }) {
  const frame = useCurrentFrame();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  // G6-11: a looped <Audio> hands the volume function a media-relative frame, which
  // is fractional at a fractional-duration loop boundary and fell through to the old
  // `?? 1` default, so the second pass of the bed played at full level. Index the
  // composition (or enclosing <Sequence>) frame instead, rounded, and default to 0.
  const level = gains ? gains[Math.min(Math.max(0, Math.round(frame)), gains.length - 1)] ?? 0 : volume;
  return <Audio src={src ?? staticFile(file)} {...(level !== undefined ? { volume: level } : {})} {...(loop ? { loop } : {})} onError={() => setFailed(true)} />;
}

/**
 * The package composition shared by the MP4 renderer and the web Player.
 * `mediaAuth` is preview-only. Leave it unset for export so files stay on staticFile.
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
  mediaAuth = null,
}: {
  pkg: PackageV1;
  timeline: Timeline;
  scenes?: Scene[];
  generatedAssets?: Record<string, InlineAsset>;
  media?: MediaSidecar;
  missingMedia?: string[];
  mediaDims?: MediaDimsMap;
  mixAudio?: boolean;
  mediaAuth?: MediaAuth | null;
}) {
  const resolved = useMemo(
    () => resolvePackageComposition(pkg, timeline, { missingMedia, mixAudio }),
    [pkg, timeline, missingMedia, mixAudio],
  );
  const src = (file: string) => resolveMediaSrc(file, mediaAuth, staticFile);
  const mix = resolved.mix;
  const missing = new Set(missingMedia ?? []);
  return (
    <>
      {resolved.narration && !resolved.narration.missing ? <Audio src={src(resolved.narration.file)} /> : null}
      {resolved.mixAudio ? (
        <>
          {mix.music && !missing.has(mix.music.file) ? (
            <SafeAudio file={mix.music.file} src={src(mix.music.file)} gains={mix.music.gains} loop={mix.music.loop} />
          ) : null}
          {mix.ambience.map(ambience =>
            missing.has(ambience.file) ? null : (
              <Sequence key={ambience.sceneId} from={ambience.from} durationInFrames={ambience.durationInFrames}>
                <SafeAudio file={ambience.file} src={src(ambience.file)} gains={ambience.gains} />
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
      <TimelinePlayer
        pkg={pkg}
        timeline={timeline}
        {...(scenes ? { scenes } : {})}
        generatedAssets={generatedAssets}
        media={media}
        missingMedia={missingMedia}
        mediaDims={mediaDims}
        {...(resolved.captions ? { captions: resolved.captions } : {})}
      />
    </>
  );
}
