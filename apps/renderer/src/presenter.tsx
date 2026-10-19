import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { PackageV1 } from '../../../packages/schema/types';
import type { TimelinePresenter } from '../../../packages/planner/dist/src/index.js';
import { MediaFill, MissingMediaPlaceholder } from './media';
import { useGeneratedAssets } from './generated-assets-context';
import { palette, useFontFamily } from './theme';
import { isOverlayPlacement, presenterBox, presenterLabelStyle, presenterOpacity } from './presenter-model.js';

/**
 * P-pres: the persistent AI presenter overlay (research 2.2). It is one layer
 * above the scene stack and below the captions (z 100), so a push/fade between
 * scenes never drags the presenter with it: each clip cross-dissolves into the
 * next at the seam, hiding the pose jump. The clip's own audio is never mixed;
 * narration stays the only voice. `scene.presenter: 'split'` scenes are drawn by
 * their own layout, not here.
 */
export function PresenterOverlay({ presenters, pkg }: { presenters?: TimelinePresenter[]; pkg: PackageV1 }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const colors = palette(pkg);
  const list = (presenters ?? []).filter(entry => isOverlayPlacement(entry.placement));
  if (list.length === 0) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 45 }}>
      {list.map(entry => {
        const local = frame - entry.from;
        if (local < 0 || local >= entry.durationInFrames) return null;
        const opacity = presenterOpacity(local, entry.durationInFrames, entry.dissolveInFrames, entry.dissolveOutFrames);
        if (opacity <= 0) return null;
        const box = presenterBox({ placement: entry.placement, shape: entry.shape, size: entry.size, width, height });
        return (
          <Sequence key={entry.sceneId} from={entry.from} durationInFrames={entry.durationInFrames} layout="none">
          <div
            style={{
              position: 'absolute',
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              opacity,
              borderRadius: box.radius,
              overflow: 'hidden',
              // 2-4 px brand ring + soft shadow (research 2.2).
              boxShadow: `0 0 0 3px ${colors[2]}, 0 24px 60px rgba(0,0,0,0.45)`,
            }}
          >
            <PresenterClip assetId={entry.assetId} label={entry.label} pkg={pkg} frames={entry.durationInFrames} fontSize={Math.max(16, Math.round(box.height * 0.075))} shape={entry.shape} />
          </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

/**
 * The presenter clip plus its disclosure chip. Shared by the overlay and the
 * split-left card so both read the same. The clip's audio is never mixed.
 */
export function PresenterClip({ assetId, label, pkg, frames, fontSize, shape }: { assetId: string; label?: string | null; pkg: PackageV1; frames: number; fontSize?: number; shape?: 'circle' | 'rounded-rect' }) {
  const family = useFontFamily();
  const inline = useGeneratedAssets();
  const labelStyle = presenterLabelStyle(shape, fontSize ?? 24);
  const asset = pkg.assets?.[assetId];
  const svg = inline[assetId]?.svg;
  return (
    <>
      {svg ? (
        // A flat-cartoon or paper-cut presenter is an inline, pre-sanitized SVG (same A5 check as
        // VectorAsset), so the CPU demo can show a presenter with no GPU and no raster asset.
        <div style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : asset ? (
        <MediaFill asset={asset} assetId={assetId} pkg={pkg} sceneFrames={frames} fit="cover" loop={false} speed={1} muted />
      ) : (
        <MissingMediaPlaceholder assetId={assetId} pkg={pkg} />
      )}
      {label ? (
        <div
          style={{
            position: 'absolute',
            textAlign: 'center',
            background: 'rgba(4, 6, 12, 0.68)',
            color: '#f4f6fb',
            fontFamily: family,
            fontWeight: 700,
            textTransform: 'uppercase',
            ...labelStyle,
          }}
        >
          {label}
        </div>
      ) : null}
    </>
  );
}
