import React, { useLayoutEffect, useMemo, useState } from 'react';
import { AudioBufferSink, ALL_FORMATS, Input, MATROSKA, UrlSource, WEBM, type InputAudioTrack } from 'mediabunny';
import { createSmoothSvgPath, type MediaUtilsAudioData } from '@remotion/media-utils';
import { continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  MUSIC_ANALYSIS_WINDOW_SECONDS,
  musicAmplitudeRange,
  musicSourceTime,
  reduceMusicAmplitudes,
  requiredMusicAnalysisWindows,
  scaleMusicAmplitudes,
} from './music-reactive-model.js';

export type MusicReactive = { style: 'waveform' | 'bars'; intensity: number };
export type MusicTrim = { startSeconds: number; endSeconds: number };

type Decoder = {
  input: Input;
  track: InputAudioTrack;
  sampleRate: number;
  durationInSeconds: number;
};

type WindowMap = Record<number, Float32Array>;

const DECODER_PREROLL_SECONDS = 1.5;

/** Bounded counterpart of media-utils' window decoder, with a static failure state. */
async function decodeWindow(decoder: Decoder, index: number, signal: AbortSignal): Promise<Float32Array> {
  const fromSeconds = index * MUSIC_ANALYSIS_WINDOW_SECONDS;
  const toSeconds = Math.min(decoder.durationInSeconds, fromSeconds + MUSIC_ANALYSIS_WINDOW_SECONDS);
  const actualFromSeconds = Math.max(0, fromSeconds - DECODER_PREROLL_SECONDS);
  const chunks: Float32Array[] = [];
  const sink = new AudioBufferSink(decoder.track);
  const iterator = sink.buffers(actualFromSeconds, toSeconds);
  for await (const { buffer, timestamp, duration } of iterator) {
    if (signal.aborted) throw new Error('Audio analysis was superseded');
    const channel = buffer.getChannelData(0);
    const overlapStart = Math.max(timestamp, fromSeconds);
    const overlapEnd = Math.min(timestamp + duration, toSeconds);
    if (overlapStart >= overlapEnd) continue;
    const startSample = Math.floor((overlapStart - timestamp) * buffer.sampleRate);
    const endSample = Math.ceil((overlapEnd - timestamp) * buffer.sampleRate);
    chunks.push(channel.slice(startSample, endSample));
  }
  await iterator.return();
  const result = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  if (result.length === 0) throw new Error(`No PCM samples decoded for source window ${index}`);
  return result;
}

function combineAudioData(src: string, required: number[], windows: WindowMap, decoder: Decoder): MediaUtilsAudioData {
  const arrays = required.map(index => windows[index]);
  const combined = new Float32Array(arrays.reduce((sum, samples) => sum + samples.length, 0));
  let offset = 0;
  for (const samples of arrays) {
    combined.set(samples, offset);
    offset += samples.length;
  }
  return {
    channelWaveforms: [combined],
    sampleRate: decoder.sampleRate,
    durationInSeconds: decoder.durationInSeconds,
    numberOfChannels: 1,
    resultId: `${src}:pcm:${required.join('-')}`,
    isRemote: /^https?:\/\//.test(src),
  };
}

function useMusicAmplitudes(src: string, frame: number, fps: number, trim: MusicTrim | null): number[] | 'loading' | 'unavailable' {
  const [decoder, setDecoder] = useState<Decoder | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [windows, setWindows] = useState<WindowMap>({});
  const sourceTime = musicSourceTime(frame, fps, trim);
  const range = musicAmplitudeRange(sourceTime, trim);
  const required = requiredMusicAnalysisWindows(range);
  const requiredKey = required.join('-');
  const ready = required.length > 0 && required.every(index => Boolean(windows[index]));

  useLayoutEffect(() => {
    let active = true;
    let finished = false;
    const handle = delayRender(`Loading master-song audio metadata: ${src}`);
    const finish = () => {
      if (finished) return;
      finished = true;
      continueRender(handle);
    };
    const input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(src, {
        // A failed analysis must become the explicit static state, not retry forever.
        getRetryDelay: () => null,
        maxCacheSize: 8 * 1024 * 1024,
        parallelism: 1,
        handleUnhandledError: () => {},
      }),
    });
    const load = async () => {
      try {
        const [durationInSeconds, track, format] = await Promise.all([
          input.computeDuration(),
          input.getPrimaryAudioTrack(),
          input.getFormat(),
        ]);
        if (!track) throw new Error('The selected song has no audio track');
        if (format === MATROSKA || format === WEBM) {
          // Mediabunny must decode Matroska from zero for every seek. Refuse that
          // unbounded work rather than pretending a whole-song decode is windowed.
          throw new Error('Windowed amplitude analysis is unavailable for Matroska/WebM audio');
        }
        if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) throw new Error('The selected song has no finite duration');
        if (!(await track.canDecode())) throw new Error('The selected song codec cannot be decoded');
        const sampleRate = await track.getSampleRate();
        if (active) setDecoder({ input, track, sampleRate, durationInSeconds });
      } catch (error) {
        input.dispose();
        if (active) setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        finish();
      }
    };
    void load();
    return () => {
      active = false;
      input.dispose();
      finish();
    };
  }, [src]);

  useLayoutEffect(() => {
    if (!decoder || failure || ready || required.length === 0) return undefined;
    let active = true;
    let finished = false;
    const controller = new AbortController();
    const handle = delayRender(`Decoding master-song PCM window: ${requiredKey}`);
    const finish = () => {
      if (finished) return;
      finished = true;
      continueRender(handle);
    };
    const missing = required.filter(index => !windows[index]);
    Promise.all(missing.map(async index => [index, await decodeWindow(decoder, index, controller.signal)] as const))
      .then(decoded => {
        if (!active) return;
        setWindows(previous => {
          const center = Math.floor(sourceTime / MUSIC_ANALYSIS_WINDOW_SECONDS);
          const keep = new Set([center - 1, center, center + 1, ...required]);
          const next = Object.fromEntries(Object.entries(previous).filter(([index]) => keep.has(Number(index))));
          for (const [index, samples] of decoded) next[index] = samples;
          return next;
        });
      })
      .catch(error => {
        if (active && !controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
      })
      .finally(finish);
    return () => {
      active = false;
      controller.abort();
      finish();
    };
    // requiredKey changes only at a two-second source-window boundary, not per frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoder, failure, ready, requiredKey]);

  const audioData = useMemo(() => {
    if (!decoder || !ready) return null;
    try {
      return combineAudioData(src, required, windows, decoder);
    } catch {
      return null;
    }
    // requiredKey represents the source arrays; the array itself is rebuilt per frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, decoder, ready, requiredKey, windows]);

  if (failure) return 'unavailable';
  if (!decoder || !ready) return 'loading';
  if (!audioData) return 'unavailable';
  try {
    const amplitudes = reduceMusicAmplitudes({
      audioData,
      dataOffsetInSeconds: required[0] * MUSIC_ANALYSIS_WINDOW_SECONDS,
      sourceTime,
      trim,
      numberOfSamples: 56,
    });
    return amplitudes ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function Unavailable({ color }: { color: string }) {
  return (
    <div
      data-reactive-state="unavailable"
      role="status"
      style={{
        alignSelf: 'center',
        padding: '8px 14px',
        border: `1px solid ${color}55`,
        borderRadius: 999,
        color: '#f4f6fb',
        background: 'rgba(5,10,18,0.72)',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 15,
        fontWeight: 600,
        letterSpacing: 0.2,
      }}
    >
      Audio-reactive visual unavailable
    </div>
  );
}

function AmplitudeSvg({ amplitudes, reactive, color }: { amplitudes: number[]; reactive: MusicReactive; color: string }) {
  const values = scaleMusicAmplitudes(amplitudes, reactive.intensity);
  const width = 480;
  const height = 72;
  const middle = height / 2;
  if (reactive.style === 'bars') {
    const step = width / values.length;
    return (
      <svg data-reactive-state="ready" data-reactive-style="bars" aria-label="Master song amplitude" viewBox={`0 0 ${width} ${height}`} width="100%" height="100%">
        <line x1={0} x2={width} y1={middle} y2={middle} stroke={color} strokeOpacity={0.24} strokeWidth={1} />
        {values.map((value, index) => {
          const barHeight = value * (height - 8);
          return (
            <rect
              key={index}
              x={index * step + step * 0.22}
              y={middle - barHeight / 2}
              width={Math.max(1, step * 0.56)}
              height={barHeight}
              rx={Math.max(0.5, step * 0.28)}
              fill={color}
              opacity={0.9}
            />
          );
        })}
      </svg>
    );
  }
  const points = values.map((value, index) => ({
    x: index * (width / Math.max(1, values.length - 1)),
    y: middle - value * (height / 2 - 4),
  }));
  const reflected = values.map((value, index) => ({
    x: index * (width / Math.max(1, values.length - 1)),
    y: middle + value * (height / 2 - 4),
  }));
  return (
    <svg data-reactive-state="ready" data-reactive-style="waveform" aria-label="Master song amplitude" viewBox={`0 0 ${width} ${height}`} width="100%" height="100%">
      <line x1={0} x2={width} y1={middle} y2={middle} stroke={color} strokeOpacity={0.24} strokeWidth={1} />
      <path d={createSmoothSvgPath({ points })} fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      <path d={createSmoothSvgPath({ points: reflected })} fill="none" stroke={color} strokeOpacity={0.58} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReactiveAnalysis({ src, trim, reactive, color }: { src: string; trim: MusicTrim | null; reactive: MusicReactive; color: string }) {
  const { fps } = useVideoConfig();
  // Composition frame, never HTMLMediaElement.currentTime: Player, stills and
  // MP4 workers therefore reduce the identical source span.
  const frame = useCurrentFrame();
  const result = useMusicAmplitudes(src, frame, fps, trim);
  if (result === 'loading') return null;
  if (result === 'unavailable') return <Unavailable color={color} />;
  return <AmplitudeSvg amplitudes={result} reactive={reactive} color={color} />;
}

/** Small low-z overlay: editorial copy (z 5+) and captions (z 100) stay above it. */
export function MusicReactiveOverlay({ src, missing = false, trim = null, reactive, color }: { src: string; missing?: boolean; trim?: MusicTrim | null; reactive: MusicReactive; color: string }) {
  const { width, height } = useVideoConfig();
  const cardWidth = Math.round(width * (width < 700 ? 0.72 : 0.38));
  const cardHeight = Math.max(58, Math.min(88, Math.round(height * 0.08)));
  return (
    <div
      aria-live="off"
      style={{
        position: 'absolute',
        right: Math.max(22, Math.round(width * 0.055)),
        bottom: Math.max(22, Math.round(height * 0.04)),
        width: cardWidth,
        height: cardHeight,
        zIndex: 3,
        pointerEvents: 'none',
        display: 'flex',
        justifyContent: 'center',
        padding: '6px 14px',
        boxSizing: 'border-box',
        borderRadius: 18,
        background: 'linear-gradient(90deg, rgba(5,10,18,0.08), rgba(5,10,18,0.58), rgba(5,10,18,0.08))',
        overflow: 'hidden',
      }}
    >
      {missing ? <Unavailable color={color} /> : <ReactiveAnalysis key={src} src={src} trim={trim} reactive={reactive} color={color} />}
    </div>
  );
}
