import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import { GENERATED_ASSETS } from './generated-assets';
import { COPY_LIMITS, SAFE_AREA, TYPE_SCALE, color, fontFamily, palette } from './theme';

/* ------------------------------------------------------------------ *
 * Animation vocabulary: reveal, stagger, emphasis, exit. Deterministic
 * functions of the local frame only (no CSS time animation).
 * ------------------------------------------------------------------ */

function reveal(frame: number, delay = 0, duration = 18): { opacity: number; translateY: number } {
  const progress = interpolate(frame, [delay, delay + duration], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return { opacity: 0.18 + progress * 0.82, translateY: (1 - progress) * 42 };
}

function emphasis(frame: number, delay = 0): number {
  const progress = interpolate(frame, [delay, delay + 24], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return 0.92 + progress * 0.08;
}

/* ------------------------------------------------------------------ *
 * Procedural backgrounds (spec 6.3: fallback when no plate exists).
 * ------------------------------------------------------------------ */

function seeded(seed: number): number[] {
  // Tiny deterministic LCG so a seed always paints the same background.
  let state = (seed || 1) >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  return Array.from({ length: 12 }, next);
}

function ProceduralBackground({ pattern, seed, colors }: { pattern: string; seed: number; colors: string[] }) {
  const random = seeded(seed);
  const base = color(colors, 0);
  const mid = color(colors, 1);
  const accent = color(colors, 2);
  const soft = color(colors, 3);

  if (pattern === 'grain') {
    return (
      <AbsoluteFill style={{ background: base }}>
        <svg width="100%" height="100%" viewBox="0 0 1920 1080" preserveAspectRatio="none">
          <filter id="comfyrizz-grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={seed} stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="1920" height="1080" filter="url(#comfyrizz-grain)" opacity={0.16} />
        </svg>
      </AbsoluteFill>
    );
  }

  if (pattern === 'dots') {
    return (
      <AbsoluteFill
        style={{
          background: `${base} radial-gradient(${accent} 2.5px, transparent 2.6px) 0 0 / 46px 46px, radial-gradient(${soft} 1.5px, transparent 1.6px) 23px 23px / 46px 46px`,
        }}
      />
    );
  }

  if (pattern === 'grid') {
    return (
      <AbsoluteFill
        style={{
          background: `${base} linear-gradient(${mid} 1.5px, transparent 1.5px) 0 0 / 96px 96px, linear-gradient(90deg, ${mid} 1.5px, transparent 1.5px) 0 0 / 96px 96px`,
        }}
      />
    );
  }

  if (pattern === 'mesh') {
    const blobs = random.slice(0, 5).map((value, index) => ({
      x: 10 + value * 80,
      y: 15 + random[index + 5] * 70,
      size: 34 + random[(index + 3) % 12] * 28,
      tone: [accent, mid, soft][index % 3],
    }));
    return (
      <AbsoluteFill style={{ background: base }}>
        {blobs.map((blob, index) => (
          <div
            key={index}
            style={{
              position: 'absolute',
              left: `${blob.x}%`,
              top: `${blob.y}%`,
              width: `${blob.size}%`,
              height: `${blob.size}%`,
              transform: 'translate(-50%, -50%)',
              borderRadius: '50%',
              background: `radial-gradient(closest-side, ${blob.tone}66, transparent)`,
            }}
          />
        ))}
      </AbsoluteFill>
    );
  }

  return <AbsoluteFill style={{ background: `linear-gradient(140deg, ${base} 0%, ${mid} 58%, ${accent} 130%)` }} />;
}

function Background({ scene, pkg }: { scene: Scene; pkg: PackageV1 }) {
  const colors = palette(pkg);
  const background = scene.background;
  if (background?.procedural) {
    const pattern = background.procedural.pattern ?? 'gradient';
    const local = background.procedural.palette && background.procedural.palette.length >= 2 ? background.procedural.palette : colors;
    return <ProceduralBackground pattern={pattern} seed={background.procedural.seed ?? 1} colors={local} />;
  }
  // Asset backgrounds are rendered by the foreground list when present; keep a base tone.
  return <AbsoluteFill style={{ background: colors[0] }} />;
}

/* ------------------------------------------------------------------ *
 * VectorAsset: inline, pre-sanitized SVG. The Remotion frame drives any
 * motion (spec A5: no SMIL wall clock).
 * ------------------------------------------------------------------ */

function VectorAsset({ assetId, frame, animation }: { assetId: string; frame: number; animation?: string }) {
  const asset = GENERATED_ASSETS[assetId];
  if (!asset) return null;
  const local = reveal(frame, 4, 20);
  const scale = animation === 'zoom-in' ? emphasis(frame, 6) : 1;
  const drift = animation === 'parallax-in' ? (1 - Math.min(1, frame / 40)) * 30 : 0;
  const isAnim = asset.kind === 'vector-anim';
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        opacity: local.opacity,
        transform: `translateY(${local.translateY + drift}px) scale(${scale * (isAnim ? 0.9 + Math.min(1, frame / 30) * 0.1 : 1)})`,
      }}
      // The markup passed sanitizeSvg + renderCheck at build time (see generated-assets.ts).
      dangerouslySetInnerHTML={{ __html: asset.svg }}
    />
  );
}

function Foreground({ scene, pkg, frame }: { scene: Scene; pkg: PackageV1; frame: number }) {
  const colors = palette(pkg);
  void colors;
  return (
    <>
      {(scene.foreground ?? []).map((item, index) => (
        <div
          key={`${item.asset}-${index}`}
          style={{
            position: 'absolute',
            left: `${(item.x ?? 0.5) * 100}%`,
            top: `${(item.y ?? 0.5) * 100}%`,
            width: `${(item.w ?? 0.4) * 100}%`,
            transform: 'translate(-50%, -50%)',
            zIndex: item.z ?? 5,
          }}
        >
          <VectorAsset assetId={item.asset} frame={frame - index * 3} animation={item.anim} />
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Copy guard: overflow is a visible fail state, never silent clipping.
 * ------------------------------------------------------------------ */

function CopyGuard({ scene, children }: { scene: Scene; children: React.ReactNode }) {
  const limits = COPY_LIMITS[scene.layout] ?? {};
  const copy = (scene.copy ?? {}) as Record<string, unknown>;
  const violations: string[] = [];
  for (const [key, max] of Object.entries(limits)) {
    const value = copy[key];
    if (typeof value === 'string' && typeof max === 'number' && value.length > max) {
      violations.push(`${key} ${value.length}/${max}`);
    }
  }
  if (scene.layout === 'list') {
    const items = copy.items;
    if (Array.isArray(items) && (items.length < 2 || items.length > 6)) violations.push(`items ${items.length} (need 2-6)`);
  }
  if (violations.length === 0) return <>{children}</>;
  return (
    <>
      {children}
      <div
        style={{
          position: 'absolute',
          left: SAFE_AREA.x,
          right: SAFE_AREA.x,
          bottom: 40,
          padding: '18px 24px',
          borderRadius: 14,
          background: '#b00020',
          color: '#ffffff',
          fontFamily: fontFamily(),
          fontSize: 26,
          fontWeight: 700,
          zIndex: 50,
        }}
      >
        RENDER FAIL — copy does not fit scene {scene.id}: {violations.join(', ')}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Layouts
 * ------------------------------------------------------------------ */

interface LayoutProps {
  scene: Scene;
  pkg: PackageV1;
  frame: number;
}

function Kicker({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div style={{ color: '#6d8cff', fontFamily: fontFamily(), fontSize: TYPE_SCALE.kicker, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase' }}>
      {text}
    </div>
  );
}

function TitleLayout({ scene, pkg, frame }: LayoutProps) {
  const colors = palette(pkg);
  const copy = (scene.copy ?? {}) as Record<string, string | undefined>;
  const headline = reveal(frame, 2, 22);
  const sub = reveal(frame, 10, 22);
  const outro = scene.variant === 'outro';
  return (
    <AbsoluteFill style={{ fontFamily: fontFamily(), color: colors[3], justifyContent: 'center', alignItems: 'center', padding: SAFE_AREA.y, textAlign: 'center' }}>
      <Background scene={scene} pkg={pkg} />
      <div style={{ position: 'relative', zIndex: 3, display: 'flex', flexDirection: 'column', gap: 26, alignItems: 'center' }}>
        <Kicker text={copy.kicker} />
        <div style={{ fontSize: outro ? TYPE_SCALE.headlineLg : TYPE_SCALE.headlineXl, fontWeight: 800, letterSpacing: -2, opacity: headline.opacity, transform: `translateY(${headline.translateY}px)` }}>
          {copy.headline}
        </div>
        {copy.sub ? (
          <div style={{ fontSize: TYPE_SCALE.sub, color: colors[2], maxWidth: 1100, opacity: sub.opacity, transform: `translateY(${sub.translateY}px)` }}>{copy.sub}</div>
        ) : null}
        {copy.cta ? (
          <div
            style={{
              marginTop: 10,
              padding: '16px 30px',
              borderRadius: 999,
              background: colors[2],
              color: colors[0],
              fontSize: TYPE_SCALE.body,
              fontWeight: 700,
              opacity: emphasis(frame, 22),
            }}
          >
            {copy.cta}
          </div>
        ) : null}
      </div>
      <Foreground scene={scene} pkg={pkg} frame={frame} />
    </AbsoluteFill>
  );
}

function HeroLayout({ scene, pkg, frame }: LayoutProps) {
  const colors = palette(pkg);
  const copy = (scene.copy ?? {}) as Record<string, string | undefined>;
  const split = scene.variant !== 'full-bleed';
  const head = reveal(frame, 2, 22);
  const body = reveal(frame, 12, 22);
  return (
    <AbsoluteFill style={{ fontFamily: fontFamily(), color: colors[3] }}>
      <Background scene={scene} pkg={pkg} />
      <div
        style={{
          position: 'relative',
          zIndex: 3,
          display: 'flex',
          width: '100%',
          height: '100%',
          alignItems: 'center',
          gap: 60,
          padding: `0 ${SAFE_AREA.x}px`,
          justifyContent: split ? 'flex-start' : 'center',
        }}
      >
        <div style={{ flex: split ? '0 0 52%' : '1 1 auto', maxWidth: split ? 900 : 1400, display: 'flex', flexDirection: 'column', gap: 24, textAlign: split ? 'left' : 'center' }}>
          <Kicker text={copy.kicker} />
          <div style={{ fontSize: TYPE_SCALE.headlineLg, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1.05, opacity: head.opacity, transform: `translateY(${head.translateY}px)` }}>
            {copy.headline}
          </div>
          {copy.sub ? <div style={{ fontSize: TYPE_SCALE.sub, color: colors[2], fontSize: 30 }}>{copy.sub}</div> : null}
          {copy.body ? (
            <div style={{ fontSize: TYPE_SCALE.body, color: colors[3], opacity: 0.86 * body.opacity, transform: `translateY(${body.translateY}px)` }}>{copy.body}</div>
          ) : null}
        </div>
      </div>
      <Foreground scene={scene} pkg={pkg} frame={frame} />
    </AbsoluteFill>
  );
}

function StatLayout({ scene, pkg, frame }: LayoutProps) {
  const colors = palette(pkg);
  const copy = (scene.copy ?? {}) as Record<string, string | undefined>;
  const datasetId = scene.data?.dataset;
  const dataset = datasetId ? pkg.datasets?.[datasetId] : undefined;
  const first = dataset?.values?.[0];
  const value = copy.body ?? (first ? `${first.value}${dataset?.unit ? ` ${dataset.unit}` : ''}` : '—');
  const number = emphasis(frame, 4);
  return (
    <AbsoluteFill style={{ fontFamily: fontFamily(), color: colors[3] }}>
      <Background scene={scene} pkg={pkg} />
      <div style={{ position: 'relative', zIndex: 3, display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%', padding: `0 ${SAFE_AREA.x}px`, gap: 18 }}>
        <Kicker text={copy.headline} />
        <div style={{ fontSize: TYPE_SCALE.stat, fontWeight: 800, letterSpacing: -6, lineHeight: 1, color: colors[2], transform: `scale(${number})`, transformOrigin: 'left center' }}>
          {value}
        </div>
        {copy.sub ? <div style={{ fontSize: TYPE_SCALE.sub, color: colors[3], opacity: 0.85 }}>{copy.sub}</div> : null}
        {dataset?.label ? <div style={{ fontSize: TYPE_SCALE.footnote, color: colors[3], opacity: 0.6 }}>{dataset.label} · example data</div> : null}
      </div>
      <Foreground scene={scene} pkg={pkg} frame={frame} />
    </AbsoluteFill>
  );
}

function ChartLayout({ scene, pkg, frame }: LayoutProps) {
  const colors = palette(pkg);
  const copy = (scene.copy ?? {}) as Record<string, string | undefined>;
  const datasetId = scene.data?.dataset;
  const dataset = datasetId ? pkg.datasets?.[datasetId] : undefined;
  const values = dataset?.values ?? [];
  const width = 1180;
  const height = 420;
  const max = Math.max(1, ...values.map(item => item.value));
  const gap = 42;
  const barWidth = values.length > 0 ? (width - gap * (values.length - 1)) / values.length : width;
  return (
    <AbsoluteFill style={{ fontFamily: fontFamily(), color: colors[3] }}>
      <Background scene={scene} pkg={pkg} />
      <div style={{ position: 'relative', zIndex: 3, display: 'flex', flexDirection: 'column', height: '100%', padding: `${SAFE_AREA.y}px ${SAFE_AREA.x}px`, gap: 22 }}>
        <div style={{ fontSize: TYPE_SCALE.headlineMd, fontWeight: 800 }}>{copy.headline}</div>
        {copy.sub ? <div style={{ fontSize: TYPE_SCALE.sub, color: colors[2] }}>{copy.sub}</div> : null}
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ marginTop: 12 }}>
          {values.map((item, index) => {
            const grow = interpolate(frame, [10 + index * 5, 40 + index * 5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const barHeight = (item.value / max) * (height - 70);
            const x = index * (barWidth + gap);
            return (
              <g key={item.label}>
                <rect x={x} y={height - 40 - barHeight * grow} width={barWidth} height={barHeight * grow} rx={10} fill={index === values.length - 1 ? colors[3] : colors[2]} />
                <text x={x + barWidth / 2} y={height - 14} fill={colors[3]} fontSize={24} textAnchor="middle" fontFamily={fontFamily()}>
                  {item.label}
                </text>
                <text x={x + barWidth / 2} y={height - 52 - barHeight * grow} fill={colors[3]} fontSize={26} fontWeight={700} textAnchor="middle" fontFamily={fontFamily()}>
                  {item.value}
                </text>
              </g>
            );
          })}
          <line x1={0} y1={height - 40} x2={width} y2={height - 40} stroke={colors[2]} strokeWidth={3} opacity={0.6} />
        </svg>
        {copy.footnote ? <div style={{ fontSize: TYPE_SCALE.footnote, opacity: 0.6 }}>{copy.footnote}</div> : null}
      </div>
    </AbsoluteFill>
  );
}

function ListLayout({ scene, pkg, frame }: LayoutProps) {
  const colors = palette(pkg);
  const copy = (scene.copy ?? {}) as Record<string, string | undefined | string[]>;
  const quote = scene.variant === 'quote';
  const items = Array.isArray(copy.items) ? (copy.items as string[]) : [];
  return (
    <AbsoluteFill style={{ fontFamily: fontFamily(), color: colors[3] }}>
      <Background scene={scene} pkg={pkg} />
      <div style={{ position: 'relative', zIndex: 3, width: '100%', height: '100%', padding: `${SAFE_AREA.y}px ${SAFE_AREA.x}px`, display: 'flex', flexDirection: 'column', gap: 30 }}>
        <div style={{ fontSize: TYPE_SCALE.headlineMd, fontWeight: 800, maxWidth: 1100 }}>{copy.headline}</div>
        {quote ? (
          <div style={{ fontSize: 52, lineHeight: 1.25, maxWidth: 1300 }}>
            “{copy.quote}”
            {copy.attribution ? <div style={{ fontSize: TYPE_SCALE.sub, color: colors[2], marginTop: 18 }}>— {copy.attribution}</div> : null}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 1180 }}>
            {items.map((item, index) => {
              const row = reveal(frame, 8 + index * 6, 18);
              return (
                <div key={item} style={{ display: 'flex', gap: 20, alignItems: 'center', opacity: row.opacity, transform: `translateY(${row.translateY}px)` }}>
                  <div style={{ width: 44, height: 44, borderRadius: 999, background: colors[2], color: colors[0], display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 24 }}>
                    {index + 1}
                  </div>
                  <div style={{ fontSize: TYPE_SCALE.body, fontSize: 34 }}>{item}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <Foreground scene={scene} pkg={pkg} frame={frame} />
    </AbsoluteFill>
  );
}

export function SceneView({ scene, pkg }: { scene: Scene; pkg: PackageV1 }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  void durationInFrames;
  const props: LayoutProps = { scene, pkg, frame };
  return (
    <CopyGuard scene={scene}>
      {scene.layout === 'title' ? <TitleLayout {...props} /> : null}
      {scene.layout === 'hero' ? <HeroLayout {...props} /> : null}
      {scene.layout === 'stat' ? <StatLayout {...props} /> : null}
      {scene.layout === 'chart' ? <ChartLayout {...props} /> : null}
      {scene.layout === 'list' ? <ListLayout {...props} /> : null}
    </CopyGuard>
  );
}
