import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthesizeFinishingWav } from '../../../packages/agent/dist/src/finishing-audio.js';

/** Add a real deterministic PCM stem to the editable package; no GPU or model call. */
export function applyProceduralFinishingAudio(pkg, { plan, assetsDir, seed = 1, assetId = 'a_finishing_mix' }) {
  const text = String(plan ?? '').trim();
  if (!text) throw new Error('an audio direction is required');
  const fps = Number(pkg?.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  const seconds = (pkg.scenes ?? []).reduce((sum, scene) => sum + (Number(scene?.preferredFrames) || 0), 0) / fps;
  if (!(seconds > 0)) throw new Error('the project has no timeline to score');
  const stem = synthesizeFinishingWav(text, seconds, seed);
  if (!/^a_[A-Za-z0-9_-]+$/.test(assetId)) throw new Error('invalid finishing audio asset id');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, `${assetId}.wav`), stem.wav);
  const next = structuredClone(pkg);
  next.assets ??= {};
  next.assets[assetId] = {
    kind: 'audio', origin: 'generated', status: 'ready',
    file: `assets/${assetId}.wav`,
    sha256: createHash('sha256').update(stem.wav).digest('hex'), bytes: stem.wav.length,
    media: { durationSeconds: stem.durationSeconds },
    gen: { generator: 'procedural-audio', model: 'deterministic-pcm-v2', inputs: { plan: text, seed } },
    license: { id: 'CC0-1.0' }, redistributable: true,
    notes: `Original deterministic procedural finishing stem; not native model audio. Whole-film plan: ${text}`.slice(0, 512),
  };
  next.audio = {
    ...(next.audio ?? {}),
    music: { asset: assetId, gain_db: -14, fade_in_seconds: 0.5, fade_out_seconds: 1, loop: false },
  };
  return { package: next, assetId, durationSeconds: stem.durationSeconds };
}
