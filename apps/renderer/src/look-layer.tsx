import React, { useEffect, useId, useMemo } from 'react';
import { continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { buildLookRender, hasLook, lookFontEntries } from './look-model.js';

export type LookFinishEffect = {
  id: string;
  params?: Record<string, number>;
  cpuFallback?: boolean;
};

export type LookSidecar = {
  schema: string;
  recipeId: string;
  seed?: number;
  fonts?: Array<{ family: string; assetId: string }>;
  finish?: LookFinishEffect[];
  transitions?: Array<Record<string, unknown>>;
  camera?: { move: string; amount: number };
};

type LayerStyle = Record<string, string | number | undefined>;

type RenderLayer = {
  kind: string;
  effectId: string;
  order: number;
  opacity?: number;
  style: LayerStyle;
  svg?: {
    type: 'fractalNoise' | 'turbulence';
    baseFrequency: number;
    numOctaves: number;
    seed: number;
    stitchTiles: 'stitch' | 'noStitch';
  };
  specks?: Array<{ x: number; y: number; r: number; opacity: number }>;
  scratches?: Array<{ x: number; y: number; length: number; width: number; opacity: number }>;
};

type RenderModel = {
  sceneFilter: string | null;
  sceneTransform: string | null;
  chroma?: { dx: number; dy: number } | null;
  layers: RenderLayer[];
  fonts: Array<{ family: string; file: string; path: string }>;
};

const loadedLookFonts = new Set<string>();

function loadLookFonts(look: LookSidecar): Promise<void> {
  const entries = lookFontEntries(look) as RenderModel['fonts'];
  return Promise.all(
    entries.map(async entry => {
      const weight = entry.family === 'Inter' || entry.file.includes('[wght]') ? '100 900' : '400';
      const key = `${entry.family}:${entry.file}:${weight}`;
      if (loadedLookFonts.has(key)) return;
      loadedLookFonts.add(key);
      try {
        const face = new FontFace(entry.family, `url(${JSON.stringify(staticFile(entry.path))})`, {
          weight,
          style: 'normal',
          display: 'block',
        });
        await face.load();
        document.fonts.add(face);
      } catch {
        loadedLookFonts.delete(key);
      }
    }),
  ).then(() => undefined);
}

function useLookFonts(look: LookSidecar): void {
  useEffect(() => {
    const entries = lookFontEntries(look) as RenderModel['fonts'];
    if (entries.length === 0) return undefined;
    const handle = delayRender('Loading recipe look fonts');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      continueRender(handle);
    };
    const timer = setTimeout(finish, 5000);
    void loadLookFonts(look).finally(() => {
      clearTimeout(timer);
      finish();
    });
    return () => {
      clearTimeout(timer);
      finish();
    };
  }, [look]);
}

function GrainSvg({ layer, filterId, width, height }: { layer: RenderLayer; filterId: string; width: number; height: number }) {
  const svg = layer.svg;
  if (!svg) return null;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    >
      <defs>
        <filter id={filterId} x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
          <feTurbulence
            type={svg.type}
            baseFrequency={svg.baseFrequency}
            numOctaves={svg.numOctaves}
            seed={svg.seed}
            stitchTiles={svg.stitchTiles}
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <rect width="100%" height="100%" filter={`url(#${filterId})`} />
    </svg>
  );
}

function DustSvg({ layer, width, height }: { layer: RenderLayer; width: number; height: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    >
      {layer.scratches?.map((scratch, index) => (
        <line
          key={`scratch-${index}`}
          x1={scratch.x}
          y1={scratch.y}
          x2={scratch.x + scratch.width}
          y2={scratch.y + scratch.length}
          stroke="#ffffff"
          strokeWidth={scratch.width}
          opacity={scratch.opacity}
        />
      ))}
      {layer.specks?.map((speck, index) => (
        <circle
          key={`speck-${index}`}
          cx={speck.x}
          cy={speck.y}
          r={speck.r}
          fill="#ffffff"
          opacity={speck.opacity}
        />
      ))}
    </svg>
  );
}

function EffectLayer({ layer, index, uid, width, height }: { layer: RenderLayer; index: number; uid: string; width: number; height: number }) {
  const style = layer.style as unknown as React.CSSProperties;
  if (layer.kind === 'grain' || layer.kind === 'boil') {
    const filterId = `comfyrizz-look-${uid}-${index}`;
    return (
      <div style={style}>
        <GrainSvg layer={layer} filterId={filterId} width={width} height={height} />
      </div>
    );
  }
  if (layer.kind === 'dust') {
    return (
      <div style={style}>
        <DustSvg layer={layer} width={width} height={height} />
      </div>
    );
  }
  return <div style={style} />;
}

function LookLayerActive({
  look,
  palette,
  children,
}: {
  look: LookSidecar;
  palette?: string[];
  children?: React.ReactNode;
}) {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  useLookFonts(look);
  const model = useMemo(
    () => buildLookRender(look, { frame, width, height, durationInFrames, palette }) as unknown as RenderModel,
    [look, frame, width, height, durationInFrames, palette],
  );
  if (!model) return <>{children ?? null}</>;
  const chromaId = `comfyrizz-chroma-${uid}`;
  const sceneFilter = [model.sceneFilter, model.chroma ? `url(#${chromaId})` : null].filter(Boolean).join(' ');
  const sceneStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'auto',
    ...(sceneFilter ? { filter: sceneFilter } : {}),
    ...(model.sceneTransform ? { transform: model.sceneTransform, transformOrigin: '50% 50%' } : {}),
  };
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', isolation: 'isolate' }}>
      {model.chroma ? (
        <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute' }}>
          <defs>
            <filter id={chromaId} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
              <feOffset in="SourceGraphic" dx={model.chroma.dx} dy={model.chroma.dy} result="shiftRed" />
              <feColorMatrix
                in="shiftRed"
                type="matrix"
                values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
                result="red"
              />
              <feOffset in="SourceGraphic" dx={-model.chroma.dx} dy={-model.chroma.dy} result="shiftCyan" />
              <feColorMatrix
                in="shiftCyan"
                type="matrix"
                values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0"
                result="cyan"
              />
              <feBlend in="red" in2="cyan" mode="screen" />
            </filter>
          </defs>
        </svg>
      ) : null}
      <div style={sceneStyle}>{children}</div>
      {model.layers.map((layer, index) => (
        <EffectLayer key={`${layer.effectId}-${index}`} layer={layer} index={index} uid={uid} width={width} height={height} />
      ))}
    </div>
  );
}

export function LookLayer({
  look,
  palette,
  children,
}: {
  look?: LookSidecar | null;
  palette?: string[];
  children?: React.ReactNode;
}) {
  if (!hasLook(look)) return <>{children ?? null}</>;
  return (
    <LookLayerActive look={look as LookSidecar} palette={palette}>
      {children}
    </LookLayerActive>
  );
}

export default LookLayer;
