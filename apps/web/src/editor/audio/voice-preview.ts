/**
 * Voice preview. Plays an existing take, or a generated CPU fixture.
 * There is no model call. A CPU audition never replaces the selected voice.
 */
export interface VoicePreview {
  kind: 'take' | 'cpu-fixture';
  label: string;
  sampleRate: number;
  samples: Float32Array;
  replacesSelectedVoice: false;
}

const CPU_RATE = 8000;

/** A short 440 Hz tone. Fixture audio, not a synthesizer. */
export function cpuVoiceFixture(): Float32Array {
  const samples = new Float32Array(400);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * 440 * index) / CPU_RATE) * 0.2;
  }
  return samples;
}

export function resolveVoicePreview(options: {
  engine?: string;
  takeFresh: boolean;
  takeSamples?: Float32Array;
  takeSampleRate?: number;
  preferCpu?: boolean;
}): VoicePreview {
  const qwen = options.engine === 'qwen3-tts';
  if (!options.preferCpu && options.takeFresh && options.takeSamples && options.takeSampleRate) {
    return {
      kind: 'take',
      label: qwen ? 'Selected Qwen take. Preview plays the existing audio.' : 'Selected take.',
      sampleRate: options.takeSampleRate,
      samples: options.takeSamples,
      replacesSelectedVoice: false,
    };
  }
  const label = qwen
    ? 'CPU temporary audition (Kokoro fixture). This is not the selected Qwen voice and is not final-quality timing.'
    : 'CPU temporary audition (Kokoro fixture). This does not replace the selected voice.';
  return { kind: 'cpu-fixture', label, sampleRate: CPU_RATE, samples: cpuVoiceFixture(), replacesSelectedVoice: false };
}
