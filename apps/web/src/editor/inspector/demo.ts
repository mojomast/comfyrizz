/** Synthetic narration tone for the waveform when the open package has no decoded take. */

export const DEMO_SOURCE = 'demo-narration-tone';

export function demoSamples(): Float32Array {
  const samples = new Float32Array(8000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * 220 * index) / 8000) * (index < 4000 ? 0.4 : 0.15);
  }
  return samples;
}
