/**
 * Willem's birthday video. Same approach as scripts/gpu2/explainer/Showcase.tsx: Pi's SceneView for
 * the title card over a full-bleed GPU clip (transparent base colour + scrim), then full-bleed
 * LTX clips with playful French lower thirds, and a big animated title over the cake scene.
 */
import React from 'react';
import { AbsoluteFill, Audio, Freeze, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { SceneView } from '../../../apps/renderer/src/components';
import { fontFamily } from '../../../apps/renderer/src/theme';

export type MediaSidecar = {
  scrim?: Record<string, number>;
  skipLayout?: string[];
  lowerThird?: Record<string, { kicker: string; text: string }>;
  bigTitle?: Record<string, { text: string; sub?: string; kicker?: string; position?: 'top' | 'bottom'; confetti?: boolean }>;
  music?: { file: string; fromScene: string; volume: number };
};
type Asset = { kind: string; file?: string; media?: { frames?: number; fps?: number } };
type AnyScene = { id: string; layout: string; from: number; durationInFrames: number; transitionOutFrames: number; background?: { asset?: string } };

const CORAL = '#ff7a59';
const CREAM = '#fff8f0';
const PLUM = 'rgba(43,22,64,0.78)';

function Media({ asset, sceneFrames }: { asset: Asset; sceneFrames: number }) {
  const { fps } = useVideoConfig();
  const clipFrames = Math.round(((asset.media?.frames ?? 97) / (asset.media?.fps ?? 24)) * fps);
  // Stretch the clip over the scene (down to 0.6x), then hold its last frame (no loop jump).
  const rate = Math.max(0.6, Math.min(1, clipFrames / sceneFrames));
  const playFrames = Math.max(1, Math.floor(clipFrames / rate) - 2);
  const video = <OffthreadVideo src={staticFile(asset.file ?? '')} muted playbackRate={rate} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
  return (
    <>
      <Sequence durationInFrames={playFrames}>{video}</Sequence>
      {sceneFrames > playFrames ? <Sequence from={playFrames}><Freeze frame={playFrames - 1}>{video}</Freeze></Sequence> : null}
    </>
  );
}

function LowerThird({ kicker, text }: { kicker: string; text: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - 8, fps, config: { damping: 11, stiffness: 120 } });
  return (
    <div style={{ position: 'absolute', left: 110, bottom: 96, fontFamily: fontFamily(), transform: `scale(${0.6 + 0.4 * s}) rotate(${(1 - s) * -6}deg)`,
      transformOrigin: 'left bottom', opacity: Math.min(1, s * 1.4), display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
      <div style={{ color: CREAM, fontSize: 40, fontWeight: 700, padding: '6px 22px', borderRadius: 999, background: CORAL }}>{kicker}</div>
      <div style={{ color: CREAM, fontSize: 78, fontWeight: 900, padding: '12px 34px', borderRadius: 28, background: PLUM, boxShadow: '0 18px 50px rgba(0,0,0,0.35)' }}>{text}</div>
    </div>
  );
}

function BigTitle({ text, sub, kicker, position = 'top' }: { text: string; sub?: string; kicker?: string; position?: 'top' | 'bottom' }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - 10, fps, config: { damping: 10, stiffness: 90 } });
  const s2 = spring({ frame: frame - 40, fps, config: { damping: 14 } });
  return (
    <div style={{ position: 'absolute', left: 80, right: 80, ...(position === 'top' ? { top: 70 } : { bottom: 80 }), display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, fontFamily: fontFamily() }}>
      {kicker ? <div style={{ color: CREAM, fontSize: 40, fontWeight: 800, padding: '6px 24px', borderRadius: 999, background: CORAL, opacity: Math.min(1, s * 1.5) }}>{kicker}</div> : null}
      <div style={{ color: CREAM, fontSize: 96, fontWeight: 900, textAlign: 'center', padding: '16px 44px', borderRadius: 36, background: PLUM,
        transform: `scale(${0.4 + 0.6 * s})`, opacity: Math.min(1, s * 1.5), textShadow: `0 4px 0 ${CORAL}` }}>{text}</div>
      {sub ? <div style={{ color: '#2b1640', fontSize: 44, fontWeight: 800, padding: '8px 28px', borderRadius: 999, background: '#ffd166', opacity: s2, transform: `translateY(${(1 - s2) * 30}px)` }}>{sub}</div> : null}
    </div>
  );
}

function Confetti() {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const colors = [CORAL, '#ffd166', '#6ee7b7', '#93c5fd', '#f9a8d4', CREAM];
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: 70 }, (_, i) => {
        const seed = (i * 9301 + 49297) % 233280;
        const x = (seed / 233280) * width;
        const speed = 3 + (i % 5);
        const y = ((frame * speed + (i * 137) % height) % (height + 60)) - 40;
        const rot = frame * (4 + (i % 7)) + i * 33;
        return <div key={i} style={{ position: 'absolute', left: x + Math.sin((frame + i * 10) / 15) * 30, top: y, width: 14, height: 22, background: colors[i % colors.length], borderRadius: 3, transform: `rotate(${rot}deg)`, opacity: 0.9 }} />;
      })}
    </AbsoluteFill>
  );
}

function BirthdayScene({ scene, pkg, media }: { scene: AnyScene; pkg: any; media: MediaSidecar }) {
  const assets: Record<string, Asset> = pkg.assets ?? {};
  const bg = scene.background?.asset ? assets[scene.background.asset] : undefined;
  const layoutPkg = { ...pkg, theme: { ...pkg.theme, palette: ['transparent', ...pkg.theme.palette.slice(1)] } };
  const scrim = media.scrim?.[scene.id] ?? 0;
  const lower = media.lowerThird?.[scene.id];
  const big = media.bigTitle?.[scene.id];
  return (
    <AbsoluteFill style={{ background: pkg.theme.palette[0] }}>
      {bg ? <Media asset={bg} sceneFrames={scene.durationInFrames} /> : null}
      {scrim > 0 ? <AbsoluteFill style={{ background: `rgba(30,12,40,${scrim})` }} /> : null}
      {media.skipLayout?.includes(scene.id) ? null : <SceneView scene={{ ...scene, foreground: [] } as never} pkg={layoutPkg as never} />}
      {lower ? <LowerThird {...lower} /> : null}
      {big ? <>{big.confetti !== false ? <Confetti /> : null}<BigTitle {...big} /></> : null}
    </AbsoluteFill>
  );
}

export function Birthday({ pkg, timeline, media }: { pkg: any; timeline: any; media: MediaSidecar }) {
  const scenes = timeline.scenes as AnyScene[];
  const children: React.ReactNode[] = [];
  scenes.forEach((scene, index) => {
    children.push(
      <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.durationInFrames}>
        <BirthdayScene scene={scene} pkg={pkg} media={media} />
      </TransitionSeries.Sequence>,
    );
    if (index < scenes.length - 1 && scene.transitionOutFrames > 0) {
      children.push(<TransitionSeries.Transition key={`${scene.id}-t`} presentation={fade()} timing={linearTiming({ durationInFrames: scene.transitionOutFrames })} />);
    }
  });
  const musicFrom = media.music ? scenes.find(s => s.id === media.music?.fromScene)?.from ?? 0 : 0;
  return (
    <>
      <Audio src={staticFile('narration.norm.wav')} />
      {media.music ? <Sequence from={musicFrom}><Audio src={staticFile(media.music.file)} volume={f => media.music!.volume * Math.min(1, f / 10)} /></Sequence> : null}
      <TransitionSeries>{children}</TransitionSeries>
    </>
  );
}
