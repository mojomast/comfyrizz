import type { CompileOptions, NarrationChunk } from './package-types.js';

/** audio/durations.json shape written by the narration tools. */
export interface DurationsReport {
  gapSeconds?: number;
  paddingSeconds?: number;
  scenes?: Record<string, { chunks?: NarrationChunk[] }>;
}

/**
 * Map a durations sidecar into compiler options. Same fields the renderer
 * used to build inline, so every compile path shares one conversion.
 */
export function measuredFromReport(report: DurationsReport | null | undefined): CompileOptions {
  if (!report || typeof report !== 'object') return {};
  const narration: Record<string, NarrationChunk[]> = {};
  for (const [sceneId, scene] of Object.entries(report.scenes ?? {})) {
    narration[sceneId] = (scene?.chunks ?? []).map(chunk => (
      chunk.words && chunk.words.length > 0
        ? { text: chunk.text, seconds: chunk.seconds, words: chunk.words }
        : { text: chunk.text, seconds: chunk.seconds }
    ));
  }
  return {
    narration,
    narrationGapSeconds: report.gapSeconds,
    narrationPaddingSeconds: report.paddingSeconds,
  };
}
