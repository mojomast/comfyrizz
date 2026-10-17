/**
 * GPU test 2 showcase composition. Reuses Pi's renderer (SceneView layouts, CaptionOverlay,
 * TransitionSeries timing from the compiled timeline) and adds what the renderer does not
 * draw yet: raster/video assets as full-frame backgrounds (with a scrim) and as framed panels.
 * The layouts get a copy of the package whose base colour is transparent, so the media layer
 * underneath shows through; the package itself keeps valid hex colours.
 */
import React from 'react';
import { AbsoluteFill, Audio, Loop, OffthreadVideo, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { SceneView } from '../../../apps/renderer/src/components';
import { CaptionOverlay } from '../../../apps/renderer/src/captions';
import { fontFamily } from '../../../apps/renderer/src/theme';

export type MediaSidecar = {
  scrim?: Record<string, number>;
  skipLayout?: string[];
  lowerThird?: Record<string, { kicker: string; text: string }>;
};
type Asset = { kind: string; file?: string; media?: { frames?: number; fps?: number } };
type AnyScene = {
  id: string; layout: string; durationInFrames: number; transitionOutFrames: number;
  background?: { asset?: string }; foreground?: Array<{ asset: string; x?: number; y?: number; w?: number; anim?: string }>;
};

function Media({ asset, sceneFrames, fit = 'cover' }: { asset: Asset; sceneFrames: number; fit?: 'cover' | 'contain' }) {
  const { fps } = useVideoConfig();
  const src = staticFile(asset.file ?? '');
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: fit };
  if (asset.kind === 'image') return <Img src={src} style={style} />;
  const clipFrames = Math.round(((asset.media?.frames ?? 97) / (asset.media?.fps ?? 24)) * fps);
  // Stretch a short clip over the scene (down to half speed) before looping it.
  const rate = Math.max(0.5, Math.min(1, clipFrames / sceneFrames));
  const loopFrames = Math.max(1, Math.floor(clipFrames / rate) - 1);
  return (
    <Loop durationInFrames={loopFrames}>
      <OffthreadVideo src={src} muted playbackRate={rate} style={style} />
    </Loop>
  );
}

function Panel({ asset, item, sceneFrames }: { asset: Asset; item: NonNullable<AnyScene['foreground']>[number]; sceneFrames: number }) {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const w = (item.w ?? 0.4) * width;
  const t = interpolate(frame, [6, 26], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const dx = item.anim === 'slide-in' ? (1 - t) * 80 : 0;
  return (
    <div style={{ position: 'absolute', left: `${(item.x ?? 0.5) * 100}%`, top: `${(item.y ?? 0.5) * 100}%`, width: w, height: (w * 9) / 16,
      transform: `translate(calc(-50% + ${dx}px), -50%)`, opacity: t, borderRadius: 28, overflow: 'hidden', zIndex: 6,
      boxShadow: '0 30px 80px rgba(0,0,0,0.45), 0 0 0 2px rgba(255,255,255,0.08)' }}>
      <Media asset={asset} sceneFrames={sceneFrames} />
    </div>
  );
}

function LowerThird({ kicker, text }: { kicker: string; text: string }) {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [8, 28], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', left: 144, right: 144, top: 150, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center',
      fontFamily: fontFamily(), opacity: t, transform: `translateY(${(1 - t) * 24}px)`, zIndex: 8 }}>
      <div style={{ color: '#ffd166', fontSize: 26, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase' }}>{kicker}</div>
      <div style={{ color: '#f1faee', fontSize: 46, fontWeight: 800, padding: '14px 34px', borderRadius: 18, background: 'rgba(11,29,46,0.72)' }}>{text}</div>
    </div>
  );
}

function ShowcaseScene({ scene, pkg, media }: { scene: AnyScene; pkg: any; media: MediaSidecar }) {
  const assets: Record<string, Asset> = pkg.assets ?? {};
  const bg = scene.background?.asset ? assets[scene.background.asset] : undefined;
  const layoutPkg = { ...pkg, theme: { ...pkg.theme, palette: ['transparent', ...pkg.theme.palette.slice(1)] } };
  const panels = (scene.foreground ?? []).filter(item => assets[item.asset] && assets[item.asset].kind !== 'svg');
  const layoutScene = { ...scene, foreground: (scene.foreground ?? []).filter(item => !panels.includes(item)) };
  const lower = media.lowerThird?.[scene.id];
  return (
    <AbsoluteFill style={{ background: pkg.theme.palette[0] }}>
      {bg ? <Media asset={bg} sceneFrames={scene.durationInFrames} /> : null}
      {bg && (media.scrim?.[scene.id] ?? 0) > 0 ? <AbsoluteFill style={{ background: `rgba(5,10,18,${media.scrim?.[scene.id]})` }} /> : null}
      {media.skipLayout?.includes(scene.id) ? null : <SceneView scene={layoutScene as never} pkg={(bg ? layoutPkg : pkg) as never} />}
      {panels.map((item, index) => <Panel key={index} asset={assets[item.asset]} item={item} sceneFrames={scene.durationInFrames} />)}
      {lower ? <LowerThird {...lower} /> : null}
    </AbsoluteFill>
  );
}

export function Showcase({ pkg, timeline, media }: { pkg: any; timeline: any; media: MediaSidecar }) {
  const scenes = timeline.scenes as AnyScene[];
  const children: React.ReactNode[] = [];
  scenes.forEach((scene, index) => {
    children.push(
      <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.durationInFrames}>
        <ShowcaseScene scene={scene} pkg={pkg} media={media} />
      </TransitionSeries.Sequence>,
    );
    if (index < scenes.length - 1 && scene.transitionOutFrames > 0) {
      children.push(<TransitionSeries.Transition key={`${scene.id}-t`} presentation={fade()} timing={linearTiming({ durationInFrames: scene.transitionOutFrames })} />);
    }
  });
  return (
    <>
      <Audio src={staticFile('narration.norm.wav')} />
      <TransitionSeries>{children}</TransitionSeries>
      <CaptionOverlay captions={timeline.captions} />
    </>
  );
}
