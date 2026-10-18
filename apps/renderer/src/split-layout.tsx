import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import type { Background, PackageV1, Scene } from '../../../packages/schema/types';
import { proceduralStyle } from './background-model.js';
import { HEADLINE_PX_AT_1080, SUPPORT_PX_AT_1080, frameSafePx, readablePx, textBand } from '../../../packages/schema/src/code-layout.mjs';
import { MediaFill, MissingMediaPlaceholder, isRenderableMedia } from './media';
import { fadeUp, staggerFrames } from './motion/primitives.js';
import { palette, textColors, useFontFamily } from './theme';

/**
 * LP2 split and compare: two plates. 16:9 and 1:1 sit side by side; 9:16 stacks.
 * Plates are fully visible at frame 0 (the frame is never empty). Labels enter
 * and then hold still. One focal point: the pair of plates. No second accent.
 */
export function SplitCompareLayout({ scene, pkg, frame }: { scene: Scene; pkg: PackageV1; frame: number }) {
  const family = useFontFamily();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const stacked = height > width * 1.2;
  const plates = (scene.media ?? []).slice(0, 2);
  const safe = frameSafePx(width);
  const band = textBand(width, height);
  const text = textColors(pkg);
  const headline = scene.copy?.headline;
  const headlinePx = readablePx(width, HEADLINE_PX_AT_1080);
  const labelPx = readablePx(width, SUPPORT_PX_AT_1080);
  const headlineEnter = fadeUp({ frame, fps, delay: 0, duration: Math.min(18, Math.round(0.5 * fps)), distance: 24 });
  return (
    <AbsoluteFill style={{ fontFamily: family, color: text.primary, background: '#1b2440' }}>
      <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', width: '100%', height: '100%' }}>
        {plates.map((plate, index) => {
          const label = fadeUp({
            frame,
            fps,
            delay: staggerFrames(index, 0.12, fps),
            duration: Math.min(16, Math.round(0.45 * fps)),
            distance: 16,
          });
          return (
            <div key={index} style={{ position: 'relative', flex: '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
              <PlateFill plate={plate} pkg={pkg} sceneFrames={durationInFrames} />
              {plate.label ? (
                <div
                  style={{
                    position: 'absolute',
                    left: safe.x,
                    right: safe.x,
                    ...(stacked && index === 1 ? { top: safe.y } : { bottom: safe.y }),
                    fontSize: labelPx,
                    fontWeight: 700,
                    lineHeight: 1.15,
                    textAlign: 'center',
                    color: '#f4f6fb',
                    textShadow: '0 2px 16px rgba(0,0,0,0.45)',
                    opacity: label.opacity,
                    transform: `translateY(${label.translateY}px)`,
                    zIndex: 3,
                  }}
                >
                  {plate.label}
                </div>
              ) : null}
              {index === 0 ? (
                <div
                  style={{
                    position: 'absolute',
                    background: 'rgba(255,255,255,0.55)',
                    zIndex: 4,
                    ...(stacked
                      ? { left: safe.x, right: safe.x, bottom: 0, height: 4 }
                      : { top: safe.y, bottom: safe.y, right: 0, width: 4 }),
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {headline ? (
        <div
          style={{
            position: 'absolute',
            left: safe.x,
            right: safe.x,
            top: Math.max(safe.y, band.top + safe.y * 0.25),
            fontSize: headlinePx,
            fontWeight: 800,
            letterSpacing: -1,
            lineHeight: 1.05,
            textAlign: 'center',
            color: '#f7f8fb',
            textShadow: '0 8px 28px rgba(0,0,0,0.45)',
            opacity: headlineEnter.opacity,
            transform: `translateY(${headlineEnter.translateY}px)`,
            zIndex: 5,
          }}
        >
          {headline}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

function PlateFill({ plate, pkg, sceneFrames }: { plate: Background; pkg: PackageV1; sceneFrames: number }) {
  if (plate.asset) {
    const asset = pkg.assets?.[plate.asset];
    if (asset && isRenderableMedia(asset)) {
      return (
        <MediaFill
          asset={asset}
          assetId={plate.asset}
          pkg={pkg}
          sceneFrames={sceneFrames}
          fit={plate.fit ?? 'cover'}
          loop={plate.loop ?? true}
          muted={plate.muted ?? true}
          {...(plate.speed !== undefined ? { speed: plate.speed } : {})}
          {...(plate.trim ? { trim: plate.trim } : {})}
        />
      );
    }
    return <MissingMediaPlaceholder assetId={plate.asset} asset={asset} pkg={pkg} />;
  }
  const colors = plate.procedural?.palette && plate.procedural.palette.length >= 2 ? plate.procedural.palette : palette(pkg);
  const pattern = plate.procedural?.pattern ?? 'gradient';
  return <AbsoluteFill style={proceduralStyle(pattern, colors)} />;
}
