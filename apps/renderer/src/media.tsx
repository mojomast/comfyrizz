import React, { createContext, useContext, useState } from 'react';
import { AbsoluteFill, Img, Loop, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Asset, ForegroundItem, PackageV1 } from '../../../packages/schema/types';
import { fontFamily, palette, textColors } from './theme';
import { isMissingMedia } from './media-model.js';

export type { MediaSidecar, LowerThirdContent, ResolvedSceneMedia } from './media-model.js';
export { isRenderableMedia, resolveSceneMedia } from './media-model.js';

/**
 * Files the current render knows are absent (P-fix4). A clean clone of the GPU
 * examples has no assets/*.mp4|png or audio/*.wav, so renderPackage passes the
 * missing list down and every media node draws a placeholder instead of asking
 * Remotion for a file that is not in this clone.
 */
const MissingMediaContext = createContext<Set<string>>(new Set());

export function MissingMediaProvider({ files, children }: { files?: string[]; children: React.ReactNode }) {
  const value = new Set(files ?? []);
  return <MissingMediaContext.Provider value={value}>{children}</MissingMediaContext.Provider>;
}

export function useMissingMedia(): Set<string> {
  return useContext(MissingMediaContext);
}

/** Labelled stand-in drawn when a declared media file is not in this clone. */
export function MissingMediaPlaceholder({ assetId, asset, pkg, style }: { assetId?: string; asset?: Asset; pkg: PackageV1; style?: React.CSSProperties }) {
  const colors = palette(pkg);
  const text = textColors(pkg);
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 28,
        textAlign: 'center',
        fontFamily: fontFamily(),
        color: text.primary,
        background: `linear-gradient(135deg, ${colors[1]}, ${colors[0]})`,
        boxShadow: 'inset 0 0 0 3px rgba(255,255,255,0.16)',
        ...style,
      }}
    >
      <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase' }}>media not in this clone</div>
      <div style={{ fontSize: 22, opacity: 0.75 }}>
        {assetId ?? asset?.kind ?? 'asset'}
        {asset?.file ? ` · ${asset.file}` : ''}
      </div>
      {asset?.gen?.generator ? (
        <div style={{ fontSize: 17, opacity: 0.55 }}>
          {asset.gen.generator}
          {asset.gen.workflow ? ` · ${asset.gen.workflow}` : ''}
        </div>
      ) : null}
    </div>
  );
}

/** A raster/video asset stretched over the frame, looped to fill the scene. */
export function MediaFill({
  asset,
  assetId,
  pkg,
  sceneFrames,
  fit = 'cover',
  loop = true,
  muted = true,
  speed,
  trim,
}: {
  asset: Asset;
  assetId?: string;
  pkg: PackageV1;
  sceneFrames: number;
  fit?: 'cover' | 'contain';
  loop?: boolean;
  muted?: boolean;
  speed?: number;
  trim?: { startSeconds: number; endSeconds?: number };
}) {
  const { fps } = useVideoConfig();
  const missing = useMissingMedia();
  const [failed, setFailed] = useState(false);
  if (failed || isMissingMedia(asset, missing)) {
    return <MissingMediaPlaceholder assetId={assetId} asset={asset} pkg={pkg} />;
  }
  const src = staticFile(asset.file ?? '');
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: fit };
  if (asset.kind === 'image') return <Img src={src} style={style} onError={() => setFailed(true)} />;
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
      onError={() => setFailed(true)}
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
export function MediaPanel({ asset, assetId, item, pkg, sceneFrames }: { asset: Asset; assetId?: string; item: ForegroundItem; pkg: PackageV1; sceneFrames: number }) {
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
      <MediaFill asset={asset} assetId={assetId} pkg={pkg} sceneFrames={sceneFrames} />
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
