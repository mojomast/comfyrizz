import type { CompileOptions, NarrationChunk } from './package-types.js';

/** audio/durations.json shape written by the narration tools. */
export interface DurationsReport {
  engine?: string;
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
    narration[sceneId] = (scene?.chunks ?? []).map(chunk => {
      const words = chunk.words?.length ? chunk.words : undefined;
      // Every compile path (editor, server, export) must retain the provenance
      // of word positions, including legacy Kokoro reports without metadata.
      const timing = chunk.timing === 'aligner' || chunk.timing === 'syllable-fallback'
        ? chunk.timing
        : words && typeof report.engine === 'string' && report.engine.startsWith('kokoro') ? 'syllable-fallback' : undefined;
      return { text: chunk.text, seconds: chunk.seconds, ...(words ? { words } : {}), ...(timing ? { timing } : {}) };
    });
  }
  return {
    narration,
    narrationGapSeconds: report.gapSeconds,
    narrationPaddingSeconds: report.paddingSeconds,
  };
}
