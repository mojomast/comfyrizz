const SAMPLE_RATE = 24000;

type FinishingTheme = 'paper' | 'storm' | 'percussion' | 'noir' | 'ambient';

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function finishingTheme(text: string): FinishingTheme {
  if (/cartographer|woodcut|eraser|paper|ink|map room/.test(text)) return 'paper';
  if (/salt|brine|storm|squall|rake|thunder/.test(text)) return 'storm';
  if (/prepared.piano|player piano|percussion|floor thump|stomp|call.and.response/.test(text)) return 'percussion';
  if (/locksmith|brass key|shadow key|noir|metal awning/.test(text)) return 'noir';
  return 'ambient';
}

/**
 * Original deterministic PCM finishing stem, not a stock or native-model track.
 * Themes deliberately use different gestures and textures rather than filtering
 * one shared drone: paper/rasp, wind/rake/thunder, floor/piano and rain/key foley.
 */
export function synthesizeFinishingWav(plan: string, seconds: number, seed = 1): { wav: Uint8Array; durationSeconds: number } {
  const duration = Math.max(1, Math.min(120, Math.round(seconds)));
  const count = duration * SAMPLE_RATE;
  const samples = new Float32Array(count);
  const text = plan.toLowerCase();
  let planSeed = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) planSeed = Math.imul(planSeed ^ text.charCodeAt(index), 16777619);
  const rng = random(planSeed);
  const theme = finishingTheme(text);
  const segments = plan.split('|').map(part => part.trim().toLowerCase()).filter(Boolean);
  let noise = 0;

  for (let index = 0; index < count; index += 1) {
    const t = index / SAMPLE_RATE;
    const segmentIndex = Math.min(Math.max(0, segments.length - 1), Math.floor(t / duration * segments.length));
    const localText = segments[segmentIndex] ?? text;
    const white = rng() * 2 - 1;
    noise = noise * 0.985 + white * 0.015;
    let sample = 0;

    if (theme === 'paper') {
      // Dry eraser/paper gestures alternate with uneven woodblock ticks. The
      // erased middle is intentionally sparse instead of resting on a drone.
      const raspCycle = t % 3.75;
      const raspProgress = (raspCycle - 0.35) / 0.85;
      const rasp = raspProgress >= 0 && raspProgress <= 1 ? Math.sin(Math.PI * raspProgress) ** 2 : 0;
      sample += white * rasp * 0.085 + noise * 0.28;
      const tickPhase = t % 0.75;
      const tick = Math.floor(t / 0.75);
      if ((tick + segmentIndex) % 4 !== 3) {
        const frequency = tick % 2 === 0 ? 720 : 510;
        sample += Math.sin(2 * Math.PI * frequency * tickPhase) * Math.exp(-tickPhase * 52) * 0.065;
      }
      sample += Math.sin(2 * Math.PI * 55 * t) * 0.008;
      const resolveAt = duration * 0.78;
      if (/bridge|redraw|returns?|line back|resolve/.test(localText) && t >= resolveAt) {
        const local = t - resolveAt;
        sample += (Math.sin(2 * Math.PI * 220 * local) + 0.35 * Math.sin(2 * Math.PI * 330 * local)) * Math.exp(-local * 1.5) * 0.055;
      }
    } else if (theme === 'storm') {
      // Wind grows over the film; close brine/rake scrapes and discrete thunder
      // supply the structure. Rain enters only in the back half.
      const gust = (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.065 * t))) * (0.65 + 0.35 * t / duration);
      sample += noise * gust * 1.8 + white * gust * 0.018;
      const rakePhase = (t + 0.2) % 4;
      if (rakePhase < 1.05) {
        const rakeEnvelope = Math.sin(Math.PI * rakePhase / 1.05) ** 2;
        sample += white * rakeEnvelope * 0.055 + Math.sin(2 * Math.PI * 145 * rakePhase) * rakeEnvelope * 0.012;
      }
      for (const hit of [duration * 0.32, duration * 0.7]) {
        const local = t - hit;
        if (local >= 0 && local < 4) {
          const envelope = Math.exp(-local * 1.25);
          sample += (Math.sin(2 * Math.PI * 43 * local) + 0.45 * Math.sin(2 * Math.PI * 61 * local) + noise * 4) * envelope * 0.12;
        }
      }
      const timedRain = Math.max(0, Math.min(1, (t / duration - 0.52) * 5));
      const rain = /after|post-storm/.test(localText) ? timedRain * 0.15 : /rain|raindrop/.test(localText) ? Math.max(0.35, timedRain) : timedRain;
      const dropPhase = t % 0.23;
      sample += white * rain * 0.025;
      sample += Math.sin(2 * Math.PI * 1750 * dropPhase) * Math.exp(-dropPhase * 95) * rain * 0.035;
    } else if (theme === 'percussion') {
      // A syncopated floor pattern and metallic prepared-piano answers create
      // audible call-and-response instead of an undifferentiated pulse.
      const stompPhase = t % 0.6;
      const stompStep = Math.floor(t / 0.6) % 8;
      if ([0, 1, 3, 4, 6].includes(stompStep)) {
        sample += Math.sin(2 * Math.PI * 72 * stompPhase) * Math.exp(-stompPhase * 20) * 0.22;
        sample += white * Math.exp(-stompPhase * 55) * 0.045;
      }
      const notePhase = t % 0.3;
      const noteStep = Math.floor(t / 0.3) % 16;
      if ([0, 3, 6, 8, 11, 14].includes(noteStep)) {
        const frequency = [220, 246.94, 329.63, 293.66, 261.63, 392][(Math.floor(noteStep / 3) + segmentIndex) % 6];
        const envelope = Math.exp(-notePhase * 17);
        sample += (Math.sin(2 * Math.PI * frequency * notePhase) + 0.32 * Math.sin(2 * Math.PI * frequency * 2.61 * notePhase) + 0.16 * Math.sin(2 * Math.PI * frequency * 4.07 * notePhase)) * envelope * 0.13;
        if (notePhase > 0.12) {
          const echo = notePhase - 0.12;
          sample += Math.sin(2 * Math.PI * frequency * echo) * Math.exp(-echo * 19) * 0.025;
        }
      }
      sample += noise * 0.22;
    } else if (theme === 'noir') {
      // Rain, a loose electrical hum and isolated brass/key transients leave
      // space for native performance sound. No continuous string bed.
      sample += white * 0.018 + noise * 0.42;
      sample += Math.sin(2 * Math.PI * 50 * t) * 0.015 + Math.sin(2 * Math.PI * 100 * t) * 0.005;
      const keyPhase = t % 2.75;
      sample += (Math.sin(2 * Math.PI * 2230 * keyPhase) + 0.45 * Math.sin(2 * Math.PI * 3710 * keyPhase)) * Math.exp(-keyPhase * 48) * 0.065;
      const drawer = t - duration * 0.74;
      if (drawer >= 0 && drawer < 1.4) sample += noise * Math.sin(Math.PI * drawer / 1.4) * 2.2;
      const finalNote = t - duration * 0.84;
      if (finalNote >= 0) sample += Math.sin(2 * Math.PI * 82.41 * finalNote) * Math.exp(-finalNote * 1.8) * 0.065;
    } else {
      const phase = t % 1.6;
      const root = /warm|major|playful/.test(localText) ? 110 : 103.83;
      sample += Math.sin(2 * Math.PI * root * phase) * Math.exp(-phase * 2.8) * 0.07;
      sample += noise * 0.3;
    }

    const fade = Math.min(1, t / 0.35, (duration - t) / 0.8);
    samples[index] = Math.tanh(sample * 1.15) * Math.max(0, fade) * 0.9;
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
