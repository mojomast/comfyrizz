import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const RATE = 24000;

function wav(samples) {
  const result = Buffer.alloc(44 + samples.length * 2);
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(RATE, 24); result.writeUInt32LE(RATE * 2, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36);
  result.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) result.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return result;
}

function noise(seed) {
  let state = seed >>> 0 || 1;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2147483648 - 1; };
}

// A quiet, original synthesized mallet/keyboard ostinato. This is deliberately
// identified as synthesis, not a recording of a piano or a music model output.
function score(seconds, bpm) {
  const samples = new Float32Array(Math.ceil(seconds * RATE));
  const beat = 60 / bpm;
  const notes = [220, 261.626, 329.628, 392, 196, 246.942, 293.665, 329.628];
  for (let n = 0; n * beat < seconds; n++) {
    const start = Math.round(n * beat * RATE);
    const frequency = notes[n % notes.length];
    const length = Math.min(samples.length - start, Math.round(beat * 1.8 * RATE));
    for (let i = 0; i < length; i++) {
      const t = i / RATE;
      const envelope = Math.min(1, t / 0.008) * Math.exp(-t * 3.2);
      samples[start + i] += 0.20 * envelope * (Math.sin(2 * Math.PI * frequency * t) + 0.22 * Math.sin(2 * Math.PI * frequency * 2.01 * t) + 0.08 * Math.sin(2 * Math.PI * frequency * 3.98 * t));
    }
  }
  return wav(samples);
}

// Synthesize filtered, modulated noise only while visible paths are being
// drawn/erased. Multiple simultaneous strokes share a bounded envelope.
function strokes(scene, frames, fps, seed) {
  const count = Math.ceil(frames / fps * RATE);
  const samples = new Float32Array(count);
  const envelopes = new Float32Array(count);
  const erasures = new Float32Array(count);
  let paths = 0;
  for (const element of scene.drawing?.elements ?? []) {
    if (element.type !== 'path' || !Number.isFinite(element.start) || !Number.isFinite(element.end) || element.end - element.start < 2) continue;
    const start = Math.max(0, Math.round(element.start / fps * RATE));
    const end = Math.min(count, Math.round(element.end / fps * RATE));
    if (end <= start) continue;
    paths++;
    const target = element.erase ? erasures : envelopes;
    for (let i = start; i < end; i++) {
      const t = (i - start) / RATE;
      const edge = Math.min(1, t / 0.035, (end - i) / RATE / 0.055);
      const gesture = 0.65 + 0.35 * Math.sin(2 * Math.PI * (element.erase ? 5.2 : 8.1) * t) ** 2;
      target[i] = Math.max(target[i], edge * gesture);
    }
  }
  if (!paths) return null;
  const random = noise(seed);
  let low = 0, previous = 0;
  for (let i = 0; i < count; i++) {
    const white = random();
    low += 0.19 * (white - low);
    const scratch = white - low;
    const rub = low - previous * 0.35;
    previous = low;
    samples[i] = scratch * envelopes[i] * 0.10 + rub * erasures[i] * 0.22;
  }
  return wav(samples);
}

function prohibited(brief, terms) {
  return new RegExp(`\\b(?:no|without|avoid|exclude|never)\\s+(?:any\\s+)?(?:(?:[\\w-]+\\s*(?:,|\\band\\b|\\bor\\b)\\s*){0,6})(?:${terms})\\b|\\b(?:silent|silence|mute|muted|soundless)\\b`, 'i').test(brief);
}

/** Add only supported Sketch Build audio, leaving existing editorial audio alone. */
export function finalizeSketchAudio(pkg, { brief = '', assetsDir } = {}) {
  // Legacy packages without an audio block may use an unreferenced ready audio
  // asset as narration. Adding a mix would disable that fallback.
  if (pkg.audio || Object.values(pkg.assets ?? {}).some(asset => asset?.kind === 'audio') || !assetsDir) return { package: pkg, added: false };
  const noMusic = prohibited(brief, 'music|score|soundtrack|piano|instrumental(?:s)?');
  const noEffects = prohibited(brief, 'audio|sound|sounds|sound effects|sfx|foley|effects');
  const allSilent = prohibited(brief, 'audio|sounds|sound(?!\\s+effects?)');
  const timeline = compileTimeline(pkg);
  const fps = timeline.fps;
  // Bound CPU and memory for unexpectedly long or malformed plans. The normal
  // Super Easy durations are at most 90 seconds; longer projects remain silent
  // rather than allocating unbounded PCM buffers during proposal generation.
  if (!(fps > 0) || !(timeline.durationInFrames > 0) || timeline.durationInFrames / fps > 180) return { package: pkg, added: false };
  const scenes = new Map((pkg.scenes ?? []).map(scene => [scene.id, scene]));
  const cues = [];
  if (!noEffects && !allSilent) {
    for (const timed of timeline.scenes ?? []) {
      const scene = scenes.get(timed.id);
      if (!scene?.drawing || cues.length >= 64) continue;
      const bytes = strokes(scene, timed.durationInFrames, fps, cues.length + 1);
      if (bytes) cues.push({ timed, bytes });
    }
  }
  // A drawing-free plan does not justify a generic replacement soundtrack.
  const hasDrawing = (pkg.scenes ?? []).some(scene => (scene.drawing?.elements ?? []).some(element => element.type === 'path' && element.end - element.start >= 2));
  const music = hasDrawing && !noMusic && !allSilent && timeline.durationInFrames > 0;
  if (!music && !cues.length) return { package: pkg, added: false };
  const out = structuredClone(pkg);
  out.assets ??= {};
  out.audio = {};
  mkdirSync(assetsDir, { recursive: true });
  function save(bytes, label) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const id = `a_sketch_${hash.slice(0, 20)}`;
    writeFileSync(join(assetsDir, `${id}.wav`), bytes);
    out.assets[id] = { kind: 'audio', origin: 'generated', status: 'ready', file: `assets/${id}.wav`, sha256: hash, bytes: bytes.length,
      media: { durationSeconds: (bytes.length - 44) / 2 / RATE },
      gen: { generator: 'procedural-audio', model: 'sketch-pcm-v1', inputs: { plan: label } },
      license: { id: 'CC0-1.0' }, redistributable: true, notes: label };
    return id;
  }
  if (music) {
    const match = /\b(\d{2,3})\s*bpm\b/i.exec(`${brief} ${pkg.proposal?.soundtrack ?? ''}`);
    const bpm = match ? Math.max(40, Math.min(140, Number(match[1]))) : 72;
    const id = save(score(timeline.durationInFrames / fps, bpm), `Original synthesized keyboard ostinato at ${bpm} BPM; not a recorded piano.`);
    out.audio.music = { asset: id, gain_db: -12, fade_in_seconds: 0.5, fade_out_seconds: 1, loop: false };
  }
  if (cues.length) out.audio.sfx = cues.map(({ timed, bytes }) => ({ asset: save(bytes, 'Synthesized drawing textures timed to visible paths, with softer rubs for erasures.'), scene: timed.id, at: 'scene-start', gain_db: -10 }));
  if (out.proposal) out.proposal.soundtrack = music && cues.length
    ? 'Synthesized keyboard ostinato with drawing textures.'
    : music ? 'Synthesized keyboard ostinato.' : 'Synthesized drawing textures; no music.';
  return { package: out, added: true };
}
