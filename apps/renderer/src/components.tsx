import React, { createContext, useContext, useState } from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import { GENERATED_ASSETS } from './generated-assets';

/** SVG markup resolved at render time for agent-built packages (C5). */
export interface InlineAsset {
  kind: string;
  svg: string;
  width?: number;
  height?: number;
  sanitizerVersion?: string;
}

const GeneratedAssetsContext = createContext<Record<string, InlineAsset>>(GENERATED_ASSETS as unknown as Record<string, InlineAsset>);

export function GeneratedAssetsProvider({ assets, children }: { assets: Record<string, InlineAsset>; children: React.ReactNode }) {
  return <GeneratedAssetsContext.Provider value={assets}>{children}</GeneratedAssetsContext.Provider>;
}
import { COPY_LIMITS, SAFE_AREA, TYPE_SCALE, color, palette, textColors, useFontFamily } from './theme';
import { proceduralStyle } from './background-model.js';
import { statLines } from './stat-model.js';
import { chartSeries } from './chart-model.js';
import { LowerThird, MediaFill, MediaPanel, Scrim, isRenderableMedia, resolveSceneMedia, type MediaSidecar } from './media';
import { STAGGER_SECONDS, countUp, fadeUp, maskRise, pop, prog, staggerFrames } from './motion/primitives.js';
import { energyProfile } from './motion/index.js';
import { highlightSweep, canDrawOn, drawOnSvg, splitHighlight, waterfallEntry, waterfallPlan } from './motion/kinetic.js';

/* ------------------------------------------------------------------ *
 * Motion: the eased entry tokens live in ./motion (MS1). Every layout uses
 * them so an entrance is a curve, never a linear ramp, and nothing starts at
 * partial opacity. Deterministic functions of the local frame only.
 * ------------------------------------------------------------------ */

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
  const mid = color(colors, 1);
  const accent = color(colors, 2);
  const soft = color(colors, 3);
  const style = proceduralStyle(pattern, colors);

  if (pattern === 'grain') {
    return (
      <AbsoluteFill style={style}>
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

  if (pattern === 'mesh') {
    const blobs = random.slice(0, 5).map((value, index) => ({
      x: 10 + value * 80,
      y: 15 + random[index + 5] * 70,
      size: 34 + random[(index + 3) % 12] * 28,
      tone: [accent, mid, soft][index % 3],
    }));
    return (
      <AbsoluteFill style={style}>
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

  return <AbsoluteFill style={style} />;
}

function Background({ scene, pkg, media }: { scene: Scene; pkg: PackageV1; media?: MediaSidecar }) {
  const colors = palette(pkg);
  const { durationInFrames } = useVideoConfig();
  const background = scene.background;
  if (background?.procedural) {
    const pattern = background.procedural.pattern ?? 'gradient';
    const local = background.procedural.palette && background.procedural.palette.length >= 2 ? background.procedural.palette : colors;
    return <ProceduralBackground pattern={pattern} seed={background.procedural.seed ?? 1} colors={local} />;
  }
  const resolved = resolveSceneMedia(scene, pkg, media);
  const backgroundAsset = resolved.background;
  if (backgroundAsset && isRenderableMedia(backgroundAsset)) {
    return (
      <>
        <MediaFill
          asset={backgroundAsset}
          assetId={resolved.backgroundId}
          pkg={pkg}
          sceneFrames={durationInFrames}
          fit={background?.fit ?? 'cover'}
          loop={background?.loop ?? true}
          muted={background?.muted ?? true}
          {...(background?.speed !== undefined ? { speed: background.speed } : {})}
          {...(background?.trim ? { trim: background.trim } : {})}
        />
        <Scrim opacity={resolved.scrim} />
      </>
    );
  }
  return <AbsoluteFill style={{ background: colors[0] }} />;
}

/* ------------------------------------------------------------------ *
 * VectorAsset: inline, pre-sanitized SVG. The Remotion frame drives any
 * motion (spec A5: no SMIL wall clock).
 * ------------------------------------------------------------------ */

function VectorAsset({ assetId, frame, entry }: { assetId: string; frame: number; entry?: string }) {
  const assets = useContext(GeneratedAssetsContext);
  const { fps } = useVideoConfig();
  const asset = assets[assetId];
  if (!asset) return null;
  const drawOn = entry === 'drawOn' && canDrawOn(asset.svg);
  const local = drawOn ? { opacity: 1, translateY: 0 } : fadeUp({ frame, fps, delay: 4, duration: 20 });
  const scale = !drawOn && entry === 'zoom-in' ? pop({ frame, fps, delay: 6, preset: 'pop' }).scale : 1;
  const drift = !drawOn && entry === 'parallax-in' ? (1 - Math.min(1, frame / 40)) * 30 : 0;
  const isAnim = asset.kind === 'vector-anim';
  let svg = asset.svg;
  if (drawOn) {
    // VectorAsset's caller already checked canDrawOn; drawOnSvg is a no-op when it is unsafe.
    svg = drawOnSvg(asset.svg, { frame, fps, delay: 4, duration: 30 });
  }
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        opacity: local.opacity,
        transform: `translateY(${local.translateY + drift}px) scale(${scale * (isAnim ? 0.9 + Math.min(1, frame / 30) * 0.1 : 1)})`,
      }}
      // The markup passed sanitizeSvg + renderCheck at build time (see generated-assets.ts). Draw-on
      // only adds pathLength/dash attributes to safe <path> elements; the A5 check runs on the source.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function Foreground({ scene, pkg, frame }: { scene: Scene; pkg: PackageV1; frame: number }) {
  const { durationInFrames } = useVideoConfig();
  return (
    <>
      {(scene.foreground ?? []).map((item, index) => {
        const asset = pkg.assets?.[item.asset];
        if (asset && asset.kind !== 'svg' && asset.kind !== 'vector-anim') {
          if (!isRenderableMedia(asset)) return null;
          return <MediaPanel key={`${item.asset}-${index}`} asset={asset} assetId={item.asset} item={item} pkg={pkg} sceneFrames={durationInFrames} />;
        }
        return (
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
            <VectorAsset assetId={item.asset} frame={frame - index * 3} entry={item.anim ?? scene.motion?.entry} />
          </div>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Copy guard: overflow is a visible fail state, never silent clipping.
 * ------------------------------------------------------------------ */

function CopyGuard({ scene, children }: { scene: Scene; children: React.ReactNode }) {
  const family = useFontFamily();
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
          fontFamily: family,
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
  media?: MediaSidecar;
}

function Kicker({ text }: { text?: string }) {
  const family = useFontFamily();
  if (!text) return null;
  return (
    <div style={{ color: '#6d8cff', fontFamily: family, fontSize: TYPE_SCALE.kicker, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase' }}>
      {text}
    </div>
  );
}

/**
 * MS3 emphasis: exactly one highlight sweep per scene, behind the `motion.highlight` phrase.
 * A scene with no emphasis (or a phrase that is not in the copy) renders its children unchanged.
 */
function HighlightBand({ scene, pkg, frame, fps, children }: { scene: Scene; pkg: PackageV1; frame: number; fps: number; children: React.ReactNode }) {
  const colors = palette(pkg);
  const emphasis = scene.motion?.emphasis;
  if (!emphasis || emphasis === 'none') return <>{children}</>;
  const sweep = highlightSweep({ frame, fps, at: 12 });
  return (
    <span style={{ position: 'relative', display: 'inline-block', zIndex: 0 }}>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: '-0.1em',
          right: '-0.1em',
          top: '0.06em',
          bottom: '0.12em',
          background: colors[2],
          borderRadius: 6,
          transform: `scaleX(${sweep.progress})`,
          transformOrigin: 'left center',
          opacity: sweep.opacity,
          zIndex: -1,
        }}
      />
      {children}
    </span>
  );
}

/**
 * The scene's headline entry (MS3). Waterfall splits copy into staggered words; maskRise, pop
 * and the default fadeUp come straight from the MS1 primitives. `motion.entry` absent keeps the
 * layout's historical default exactly.
 */
function AnimatedHeadline({
  scene, pkg, frame, text, style, delay = 2, duration = 22, distance = 42,
}: { scene: Scene; pkg: PackageV1; frame: number; text?: string; style?: React.CSSProperties; delay?: number; duration?: number; distance?: number }) {
  const { fps } = useVideoConfig();
  const entry = scene.motion?.entry;
  const energy = energyProfile(scene.motion?.energy ?? pkg.motion?.energy);
  const dist = distance * energy.distanceScale;
  const highlight = scene.motion?.emphasis && scene.motion.emphasis !== 'none' ? scene.motion.highlight : undefined;
  const content = typeof text === 'string' ? text : '';

  if (entry === 'waterfall') {
    const plan = waterfallPlan(content, highlight);
    return (
      <div style={{ ...style, display: 'flex', flexWrap: 'wrap', gap: '0 0.28em', alignItems: 'baseline' }}>
        {plan.map((word, index) => {
          const anim = waterfallEntry({ frame, fps, index, anchor: word.anchor, delay, distance: dist });
          const inner = word.highlight
            ? <HighlightBand scene={scene} pkg={pkg} frame={frame} fps={fps}>{word.word}</HighlightBand>
            : word.word;
          return (
            <span key={`${word.word}-${index}`} style={{ display: 'inline-block', opacity: anim.opacity, transform: `translateY(${anim.translateY}px) rotate(${anim.rotate}deg)` }}>
              {inner}
            </span>
          );
        })}
      </div>
    );
  }

  let anim: React.CSSProperties;
  if (entry === 'maskRise') {
    const rise = maskRise({ frame, fps, delay, duration: duration + 4 });
    anim = { opacity: rise.opacity, transform: `translateY(${rise.translateYPercent}%) rotate(${rise.rotate}deg)` };
  } else if (entry === 'pop') {
    const springy = pop({ frame, fps, delay, duration: duration + 4, preset: scene.motion?.spring ?? 'pop' });
    anim = { opacity: springy.opacity, transform: `scale(${springy.scale})`, transformOrigin: 'left center' };
  } else {
    const settle = fadeUp({ frame, fps, delay, duration, distance: dist });
    anim = { opacity: settle.opacity, transform: `translateY(${settle.translateY}px)` };
  }

  const split = splitHighlight(content, highlight);
  const body = split.found
    ? <>{split.before}<HighlightBand scene={scene} pkg={pkg} frame={frame} fps={fps}>{split.match}</HighlightBand>{split.after}</>
    : content;

  if (entry === 'maskRise') {
    return (
      <div style={{ overflow: 'hidden', ...style }}>
        <div style={anim}>{body}</div>
      </div>
    );
  }
  return <div style={{ ...style, ...anim }}>{body}</div>;
}

/** A stat value that counts up when `motion.entry` is `countUp`, else springs in as before. */
function StatNumber({ scene, frame, fps, value, style }: { scene: Scene; frame: number; fps: number; value: string; style: React.CSSProperties }) {
  if (scene.motion?.entry === 'countUp') {
    const match = String(value).match(/^(\D*)([\d][\d,]*)(.*)$/);
    const target = match ? Number(match[2].replace(/,/g, '')) : NaN;
    if (match && Number.isFinite(target)) {
      const { value: current } = countUp({ frame, fps, delay: 4, duration: 30, to: target });
      const formatted = match[2].includes(',') ? current.toLocaleString('en-US') : String(current);
      return <div style={style}>{match[1]}{formatted}{match[3]}</div>;
    }
  }
  const springy = pop({ frame, fps, delay: 4, duration: 30, preset: 'pop' });
  return <div style={{ ...style, transform: `scale(${springy.scale})`, transformOrigin: 'left center' }}>{value}</div>;
}

/**
 * B1: the owner's uploaded logo, placed on title/outro scenes. `theme.logo_asset`
 * is a validated asset reference (upload origin); a missing or broken file hides
 * the mark instead of failing the render.
 */
function BrandLogo({ pkg }: { pkg: PackageV1 }) {
  const [failed, setFailed] = useState(false);
  const logoId = pkg.theme?.logo_asset;
  const asset = logoId ? pkg.assets?.[logoId] : undefined;
  if (failed || !asset?.file) return null;
  return (
    <Img
      src={staticFile(asset.file)}
      onError={() => setFailed(true)}
      style={{ position: 'absolute', top: SAFE_AREA.y - 16, left: SAFE_AREA.x, height: 72, width: 'auto', maxWidth: 360, objectFit: 'contain', zIndex: 8 }}
    />
  );
}

function TitleLayout({ scene, pkg, frame, media }: LayoutProps) {
  const family = useFontFamily();
  const { fps } = useVideoConfig();
  const colors = palette(pkg);
  const text = textColors(pkg);
  const copy = (scene.copy ?? {}) as Record<string, string | undefined>;
  const sub = fadeUp({ frame, fps, delay: 10, duration: 22 });
  const cta = pop({ frame, fps, delay: 22, duration: 24, preset: 'pop' });
  const outro = scene.variant === 'outro';
  return (
    <AbsoluteFill style={{ fontFamily: family, color: text.primary, justifyContent: 'center', alignItems: 'center', padding: SAFE_AREA.y, textAlign: 'center' }}>
      <Background scene={scene} pkg={pkg} media={media} />
      <BrandLogo pkg={pkg} />
      <div style={{ position: 'relative', zIndex: 7, display: 'flex', flexDirection: 'column', gap: 26, alignItems: 'center' }}>
        <Kicker text={copy.kicker} />
        <AnimatedHeadline scene={scene} pkg={pkg} frame={frame} text={copy.headline} delay={2} duration={22} style={{ fontSize: outro ? TYPE_SCALE.headlineLg : TYPE_SCALE.headlineXl, fontWeight: 800, letterSpacing: -2 }} />
        {copy.sub ? (
          <div style={{ fontSize: TYPE_SCALE.sub, color: text.muted, maxWidth: 1100, opacity: sub.opacity, transform: `translateY(${sub.translateY}px)` }}>{copy.sub}</div>
        ) : null}
        {copy.cta ? (
          <div
            style={{
              marginTop: 10,
              padding: '16px 30px',
              borderRadius: 999,
              background: colors[2],
              color: text.onAccent,
              fontSize: TYPE_SCALE.body,
              fontWeight: 700,
              opacity: cta.opacity,
              transform: `scale(${cta.scale})`,
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

function HeroLayout({ scene, pkg, frame, media }: LayoutProps) {
  const family = useFontFamily();
  const text = textColors(pkg);
  const { width: frameWidth, height: frameHeight, fps } = useVideoConfig();
  // L1 re-layout: a split hero stacks (copy on top, media below) in portrait
  // instead of cropping, matching textZones('9:16', 'hero-split').
  const portrait = frameHeight > frameWidth;
  const copy = (scene.copy ?? {}) as Record<string, string | undefined>;
  const split = scene.variant !== 'full-bleed';
  const stacked = split && portrait;
  const body = fadeUp({ frame, fps, delay: 12, duration: 22 });
  return (
    <AbsoluteFill style={{ fontFamily: family, color: text.primary }}>
      <Background scene={scene} pkg={pkg} media={media} />
      <div
        style={{
          position: 'relative',
          zIndex: 7,
          display: 'flex',
          flexDirection: stacked ? 'column' : 'row',
          width: '100%',
          height: '100%',
          alignItems: stacked ? 'flex-start' : 'center',
          gap: stacked ? 28 : 60,
          padding: stacked ? `${SAFE_AREA.y}px ${SAFE_AREA.x}px` : `0 ${SAFE_AREA.x}px`,
          justifyContent: split ? 'flex-start' : 'center',
        }}
      >
        <div style={{ flex: split ? (stacked ? '0 0 auto' : '0 0 52%') : '1 1 auto', maxWidth: split ? (stacked ? '100%' : 900) : 1400, display: 'flex', flexDirection: 'column', gap: 24, textAlign: split ? 'left' : 'center' }}>
          <Kicker text={copy.kicker} />
          <AnimatedHeadline scene={scene} pkg={pkg} frame={frame} text={copy.headline} delay={2} duration={22} style={{ fontSize: TYPE_SCALE.headlineLg, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1.05 }} />
          {copy.sub ? <div style={{ fontSize: 30, color: text.muted }}>{copy.sub}</div> : null}
          {copy.body ? (
            <div style={{ fontSize: TYPE_SCALE.body, color: text.primary, opacity: 0.86 * body.opacity, transform: `translateY(${body.translateY}px)` }}>{copy.body}</div>
          ) : null}
        </div>
      </div>
      <Foreground scene={scene} pkg={pkg} frame={frame} />
    </AbsoluteFill>
  );
}

function StatLayout({ scene, pkg, frame, media }: LayoutProps) {
  const family = useFontFamily();
  const { fps } = useVideoConfig();
  const colors = palette(pkg);
  const text = textColors(pkg);
  const copy = (scene.copy ?? {}) as Record<string, string | undefined>;
  const datasetId = scene.data?.dataset;
  const dataset = datasetId ? pkg.datasets?.[datasetId] : undefined;
  const first = dataset?.values?.[0];
  const value = copy.body ?? (first ? `${first.value}${dataset?.unit ? ` ${dataset.unit}` : ''}` : '—');
  // N12: kicker falls back to the headline; only an example dataset is tagged
  // "example data", and the scene footnote (source line) is kept.
  const lines = statLines(copy, dataset);
  return (
    <AbsoluteFill style={{ fontFamily: family, color: text.primary }}>
      <Background scene={scene} pkg={pkg} media={media} />
      <div style={{ position: 'relative', zIndex: 7, display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%', padding: `0 ${SAFE_AREA.x}px`, gap: 18 }}>
        <Kicker text={lines.kicker} />
        <StatNumber scene={scene} frame={frame} fps={fps} value={value} style={{ fontSize: TYPE_SCALE.stat, fontWeight: 800, letterSpacing: -6, lineHeight: 1, color: colors[2] }} />
        {copy.sub ? <div style={{ fontSize: TYPE_SCALE.sub, color: text.primary, opacity: 0.85 }}>{copy.sub}</div> : null}
        {lines.sourceLine ? <div style={{ fontSize: TYPE_SCALE.footnote, color: text.primary, opacity: 0.6 }}>{lines.sourceLine}</div> : null}
        {lines.footnote ? <div style={{ fontSize: TYPE_SCALE.footnote, color: text.primary, opacity: 0.6 }}>{lines.footnote}</div> : null}
      </div>
      <Foreground scene={scene} pkg={pkg} frame={frame} />
    </AbsoluteFill>
  );
}

function ChartLayout({ scene, pkg, frame, media }: LayoutProps) {
  const family = useFontFamily();
  const { width: frameWidth, fps } = useVideoConfig();
  const colors = palette(pkg);
  const text = textColors(pkg);
  const copy = (scene.copy ?? {}) as Record<string, string | undefined>;
  const datasetId = scene.data?.dataset;
  const dataset = datasetId ? pkg.datasets?.[datasetId] : undefined;
  const values = chartSeries(dataset);
  // L1 re-layout: the bar chart shrinks to the safe area instead of overflowing
  // a 1080-wide portrait/square frame. Landscape keeps the authored 1180 px.
  const width = Math.min(1180, Math.max(320, frameWidth - 2 * SAFE_AREA.x));
  const height = 420;
  const max = Math.max(1, ...values.map(item => item.value));
  const gap = 42;
  const barWidth = values.length > 0 ? (width - gap * (values.length - 1)) / values.length : width;
  return (
    <AbsoluteFill style={{ fontFamily: family, color: text.primary }}>
      <Background scene={scene} pkg={pkg} media={media} />
      <div style={{ position: 'relative', zIndex: 7, display: 'flex', flexDirection: 'column', height: '100%', padding: `${SAFE_AREA.y}px ${SAFE_AREA.x}px`, gap: 22 }}>
        <AnimatedHeadline scene={scene} pkg={pkg} frame={frame} text={copy.headline} delay={2} duration={22} style={{ fontSize: TYPE_SCALE.headlineMd, fontWeight: 800 }} />
        {copy.sub ? <div style={{ fontSize: TYPE_SCALE.sub, color: text.muted }}>{copy.sub}</div> : null}
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ marginTop: 12 }}>
          {values.map((item, index) => {
            const grow = prog(frame, 10 + staggerFrames(index, 0.08, fps, 0.4), 26, 'enter');
            const barHeight = (item.value / max) * (height - 70);
            const x = index * (barWidth + gap);
            return (
              <g key={item.label}>
                <rect x={x} y={height - 40 - barHeight * grow} width={barWidth} height={barHeight * grow} rx={10} fill={index === values.length - 1 ? colors[3] : colors[2]} />
                <text x={x + barWidth / 2} y={height - 14} fill={text.primary} fontSize={24} textAnchor="middle" fontFamily={family}>
                  {item.label}
                </text>
                <text x={x + barWidth / 2} y={height - 52 - barHeight * grow} fill={text.primary} fontSize={26} fontWeight={700} textAnchor="middle" fontFamily={family}>
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

function ListLayout({ scene, pkg, frame, media }: LayoutProps) {
  const family = useFontFamily();
  const { fps } = useVideoConfig();
  const colors = palette(pkg);
  const text = textColors(pkg);
  const copy = (scene.copy ?? {}) as Record<string, string | undefined | string[]>;
  const quote = scene.variant === 'quote';
  const items = Array.isArray(copy.items) ? (copy.items as string[]) : [];
  return (
    <AbsoluteFill style={{ fontFamily: family, color: text.primary }}>
      <Background scene={scene} pkg={pkg} media={media} />
      <div style={{ position: 'relative', zIndex: 7, width: '100%', height: '100%', padding: `${SAFE_AREA.y}px ${SAFE_AREA.x}px`, display: 'flex', flexDirection: 'column', gap: 30 }}>
        <AnimatedHeadline scene={scene} pkg={pkg} frame={frame} text={typeof copy.headline === 'string' ? copy.headline : undefined} delay={2} duration={22} style={{ fontSize: TYPE_SCALE.headlineMd, fontWeight: 800, maxWidth: 1100 }} />
        {quote ? (
          <div style={{ fontSize: 52, lineHeight: 1.25, maxWidth: 1300 }}>
            “{copy.quote}”
            {copy.attribution ? <div style={{ fontSize: TYPE_SCALE.sub, color: text.muted, marginTop: 18 }}>— {copy.attribution}</div> : null}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 1180 }}>
            {items.map((item, index) => {
              const row = fadeUp({ frame, fps, delay: 8 + staggerFrames(index, STAGGER_SECONDS.listItem, fps), duration: 18 });
              return (
                <div key={item} style={{ display: 'flex', gap: 20, alignItems: 'center', opacity: row.opacity, transform: `translateY(${row.translateY}px)` }}>
                  <div style={{ width: 44, height: 44, borderRadius: 999, background: colors[2], color: text.onAccent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 24 }}>
                    {index + 1}
                  </div>
                  <div style={{ fontSize: 34 }}>{item}</div>
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

export function SceneView({ scene, pkg, media }: { scene: Scene; pkg: PackageV1; media?: MediaSidecar }) {
  const frame = useCurrentFrame();
  const resolved = resolveSceneMedia(scene, pkg, media);
  const props: LayoutProps = { scene, pkg, frame, media };
  if (resolved.mediaOnly) {
    return (
      <AbsoluteFill>
        <Background scene={scene} pkg={pkg} media={media} />
        <Foreground scene={scene} pkg={pkg} frame={frame} />
        {resolved.lowerThird ? <LowerThird {...resolved.lowerThird} pkg={pkg} /> : null}
      </AbsoluteFill>
    );
  }
  return (
    <CopyGuard scene={scene}>
      {scene.layout === 'title' ? <TitleLayout {...props} /> : null}
      {scene.layout === 'hero' ? <HeroLayout {...props} /> : null}
      {scene.layout === 'stat' ? <StatLayout {...props} /> : null}
      {scene.layout === 'chart' ? <ChartLayout {...props} /> : null}
      {scene.layout === 'list' ? <ListLayout {...props} /> : null}
      {resolved.lowerThird ? <LowerThird {...resolved.lowerThird} pkg={pkg} /> : null}
    </CopyGuard>
  );
}
