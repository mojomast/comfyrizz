const SAMPLE_RATE = 24000;

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Original deterministic PCM finishing stem, not a stock or native-model track. */
export function synthesizeFinishingWav(plan: string, seconds: number, seed = 1): { wav: Uint8Array; durationSeconds: number } {
  const duration = Math.max(1, Math.min(120, Math.round(seconds)));
  const count = duration * SAMPLE_RATE;
  const samples = new Float32Array(count);
  const rng = random(seed);
  const text = plan.toLowerCase();
  const percussive = /woodblock|pulse|rhythm|percussion|drum|piano|footstep/.test(text);
  const drone = /cello|string|drone|ambient|hush|wind|room tone/.test(text);
  const textured = /paper|rain|water|salt|wind|coastal|eraser|scrape|crackle/.test(text);
  const root = /playful|warm|resolve|major/.test(text) ? 110 : 103.83;
  let noise = 0;
  for (let index = 0; index < count; index += 1) {
    const t = index / SAMPLE_RATE;
    if (drone) {
      const vibrato = 1 + 0.003 * Math.sin(2 * Math.PI * 4.2 * t);
      samples[index] += 0.075 * Math.sin(2 * Math.PI * root * vibrato * t);
      samples[index] += 0.025 * Math.sin(2 * Math.PI * root * 1.5 * t);
    }
    if (textured) {
      noise = noise * 0.985 + (rng() * 2 - 1) * 0.015;
      samples[index] += noise * 0.22;
    }
    if (percussive) {
      const interval = /playful|piano|rhythm/.test(text) ? 0.45 : 0.68;
      const phase = t % interval;
      const note = Math.floor(t / interval);
      const frequency = /piano/.test(text) ? [220, 261.63, 329.63, 293.66][note % 4] : 235;
      const envelope = Math.exp(-phase * 28);
      samples[index] += (Math.sin(2 * Math.PI * frequency * phase) + 0.25 * Math.sin(2 * Math.PI * frequency * 2.7 * phase)) * envelope * 0.16;
    }
    const fade = Math.min(1, t / 0.5, (duration - t) / 1);
    samples[index] *= Math.max(0, fade);
  }
  const wav = new Uint8Array(44 + count * 2);
  const view = new DataView(wav.buffer);
  const write = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, count * 2, true);
  for (let index = 0; index < count; index += 1) view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), true);
  return { wav, durationSeconds: duration };
}
