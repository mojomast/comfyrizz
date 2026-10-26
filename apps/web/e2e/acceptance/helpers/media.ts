/**
 * Decode labelled fixture media inside the browser and return the identity the
 * ENGINE actually decoded (audio samples, canvas pixels), so a spec can assert
 * "this is take B" rather than "something played".
 */
import type { Page } from '@playwright/test';
import { decodeAudioLabel, decodeImageLabelFrom, labelId } from '../../../../../qa/lib/media-fixtures.mjs';
import type { AcceptanceEnv } from '../fixtures.ts';

export { labelId };

/** Null when this engine/host has no audio decoder (Linux WebKit without the GStreamer plugin packages). */
export async function decodedAudioId(page: Page, url: string, offsetSeconds = 0): Promise<number | null> {
  const decoded = await page.evaluate(async (target: string) => {
    if (!new Audio().canPlayType('audio/wav')) return null;
    const bytes = await (await fetch(target)).arrayBuffer();
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(bytes);
      return { sampleRate: buffer.sampleRate, samples: Array.from(buffer.getChannelData(0)) };
    } finally { void context.close(); }
  }, url);
  if (!decoded) return null;
  return decodeAudioLabel(Float32Array.from(decoded.samples), decoded.sampleRate, { offsetSeconds }).id;
}

export async function decodedImageId(page: Page, url: string): Promise<number> {
  const pixels = await page.evaluate(async (target: string) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = target;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return { width: canvas.width, height: canvas.height, data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  }, url);
  return decodeImageLabelFrom({
    width: pixels.width, height: pixels.height,
    luminanceAt: (x: number, y: number) => {
      const at = (Math.min(pixels.height - 1, Math.max(0, y)) * pixels.width + Math.min(pixels.width - 1, Math.max(0, x))) * 4;
      return (pixels.data[at] + pixels.data[at + 1] + pixels.data[at + 2]) / 3;
    },
  }).id;
}

/** Seek a <video> to `seconds`, draw the frame the engine decoded and read its label. Null when the engine cannot play H.264 or exposes no decoded pixels to canvas. */
export async function decodedVideoFrameId(page: Page, url: string, seconds: number): Promise<number | null> {
  const frame = await page.evaluate(async ({ target, at }: { target: string; at: number }) => {
    const video = document.createElement('video');
    if (!video.canPlayType('video/mp4; codecs="avc1.42E01E"')) return null;
    video.crossOrigin = 'anonymous'; video.muted = true; video.preload = 'auto'; video.src = target;
    await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error('video failed to load')); });
    video.currentTime = at;
    await new Promise<void>(resolve => { video.onseeked = () => resolve(); });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0);
    return { width: canvas.width, height: canvas.height, data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  }, { target: url, at: seconds });
  if (!frame) return null;
  // Some engines (Playwright's Linux WebKit) play the video but hand canvas an empty frame; that is "not observable", not a wrong identity.
  let anyPixel = false;
  for (let index = 3; index < frame.data.length; index += 4) if (frame.data[index] !== 0) { anyPixel = true; break; }
  if (!anyPixel) return null;
  return decodeImageLabelFrom({
    width: frame.width, height: frame.height,
    luminanceAt: (x: number, y: number) => {
      const at = (Math.min(frame.height - 1, Math.max(0, y)) * frame.width + Math.min(frame.width - 1, Math.max(0, x))) * 4;
      return (frame.data[at] + frame.data[at + 1] + frame.data[at + 2]) / 3;
    },
  }).id;
}

export function mediaUrl(env: AcceptanceEnv, label: string, kind: 'png' | 'wav' | 'mp4'): string {
  const entry = env.media[label];
  const file = entry?.[kind];
  if (!entry || !file) throw new Error(`no ${kind} fixture for "${label}"`);
  return `${env.mediaBase}/${file}`;
}
