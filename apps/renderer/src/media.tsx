import React from 'react';
import { AbsoluteFill, Img, Loop, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Asset, ForegroundItem, PackageV1 } from '../../../packages/schema/types';
import { fontFamily, textColors } from './theme';

export type { MediaSidecar, LowerThirdContent, ResolvedSceneMedia } from './media-model';
export { resolveSceneMedia } from './media-model';

/** A raster/video asset stretched over the frame, looped to fill the scene. */
export function MediaFill({
  asset,
  sceneFrames,
  fit = 'cover',
  loop = true,
  muted = true,
  speed,
  trim,
}: {
  asset: Asset;
  sceneFrames: number;
  fit?: 'cover' | 'contain';
  loop?: boolean;
  muted?: boolean;
  speed?: number;
  trim?: { startSeconds: number; endSeconds?: number };
}) {
  const { fps } = useVideoConfig();
  const src = staticFile(asset.file ?? '');
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: fit };
  if (asset.kind === 'image') return <Img src={src} style={style} />;
  const sourceFrames = asset.media?.frames ?? 97;
  const sourceFps = asset.media?.fps ?? 24;
  const clipFrames = Math.max(1, Math.round((sourceFrames / sourceFps) * fps));
  // Stretch a short clip over the scene (down to half speed) before looping it.
  const rate = speed ?? Math.max(0.5, Math.min(1, clipFrames / Math.max(1, sceneFrames)));
  const loopFrames = Math.max(1, Math.floor(clipFrames / rate) - 1);
  const video = (
    <OffthreadVideo
      src={src}
      muted={muted}
      playbackRate={rate}
      style={style}
      {...(trim ? { startFrom: Math.round(trim.startSeconds * fps) } : {})}
      {...(trim?.endSeconds !== undefined ? { endAt: Math.round(trim.endSeconds * fps) } : {})}
    />
  );
  return loop ? <Loop durationInFrames={loopFrames}>{video}</Loop> : video;
}

function panelAnimation(frame: number, anim: ForegroundItem['anim']): { opacity: number; transform: string } {
  const t = interpolate(frame, [6, 26], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const dx = anim === 'slide-in' ? (1 - t) * 80 : 0;
  const dy = anim === 'fade-in' ? (1 - t) * 24 : 0;
  const zoom = anim === 'zoom-in' ? 0.92 + t * 0.08 : 1;
  const kenBurns = anim === 'ken-burns' ? 1 + Math.min(1, frame / 240) * 0.06 : 1;
  const parallax = anim === 'parallax-in' ? (1 - t) * 40 : 0;
  return {
    opacity: anim === 'none' ? 1 : t,
    transform: `translate(calc(-50% + ${dx + parallax}px), calc(-50% + ${dy}px)) scale(${zoom * kenBurns})`,
  };
}

/** A framed raster/video panel positioned from the foreground item. */
export function MediaPanel({ asset, item, sceneFrames }: { asset: Asset; item: ForegroundItem; sceneFrames: number }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const w = (item.w ?? 0.4) * width;
  const h = item.h !== undefined ? item.h * height : (w * 9) / 16;
  const anim = panelAnimation(frame, item.anim);
  return (
    <div
      style={{
        position: 'absolute',
        left: `${(item.x ?? 0.5) * 100}%`,
        top: `${(item.y ?? 0.5) * 100}%`,
        width: w,
        height: h,
        opacity: anim.opacity,
        transform: anim.transform,
        borderRadius: 28,
        overflow: 'hidden',
        zIndex: item.z ?? 6,
        boxShadow: '0 30px 80px rgba(0,0,0,0.45), 0 0 0 2px rgba(255,255,255,0.08)',
      }}
    >
      <MediaFill asset={asset} sceneFrames={sceneFrames} />
    </div>
  );
}

/** Lower-third/kicker overlay for full-bleed and media-only scenes. */
export function LowerThird({ kicker, text, pkg }: { kicker?: string; text: string; pkg: PackageV1 }) {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [8, 28], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const colors = textColors(pkg);
  return (
    <div
      style={{
        position: 'absolute',
        left: 144,
        right: 144,
        top: 150,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        alignItems: 'center',
        fontFamily: fontFamily(),
        opacity: t,
        transform: `translateY(${(1 - t) * 24}px)`,
        zIndex: 8,
      }}
    >
      {kicker ? (
        <div style={{ color: colors.muted, fontSize: 26, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase' }}>{kicker}</div>
      ) : null}
      <div style={{ color: colors.primary, fontSize: 46, fontWeight: 800, padding: '14px 34px', borderRadius: 18, background: 'rgba(11,29,46,0.72)' }}>
        {text}
      </div>
    </div>
  );
}

/** Scrim drawn between a media background and the layout text. */
export function Scrim({ opacity }: { opacity: number }) {
  if (opacity <= 0) return null;
  return <AbsoluteFill style={{ background: `rgba(5,10,18,${opacity})`, zIndex: 2 }} />;
}
