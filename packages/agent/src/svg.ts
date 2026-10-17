/**
 * Thin bridge to A5's autoFix. The agent supplies intent + palette; the caller
 * wires the real generator (LLM or stub) and the sanitizer/render-check loop.
 */
export interface SvgIntentLike {
  kind: 'icon' | 'diagram' | 'pattern' | 'vector-anim';
  prompt: string;
  palette?: string[];
  width?: number;
  height?: number;
  seed?: number;
}

export interface SvgFixResult {
  ok: boolean;
  svg: string;
  attempts: number;
  repairs: number;
  sanitizerVersion: string;
  errors: Array<{ source: string; code: string; message: string; detail?: string }>;
  history?: unknown[];
}

export type SvgGeneratorLike = (context: {
  intent: SvgIntentLike;
  attempt: number;
  errors: Array<{ source: string; code: string; message: string; detail?: string }>;
  previousSvg?: string;
}) => string | Promise<string>;

export type AutoFixLike = (
  generate: SvgGeneratorLike,
  intent: SvgIntentLike,
  maxRepairs?: number,
) => Promise<SvgFixResult>;

/** Run A5's sanitize → render-check → repair loop and refuse a failed result. */
export async function svgPipeline(autoFix: AutoFixLike, generate: SvgGeneratorLike, intent: SvgIntentLike, maxRepairs = 2): Promise<SvgFixResult> {
  const result = await autoFix(generate, intent, maxRepairs);
  if (!result.ok) {
    const detail = result.errors.map(error => `${error.source}/${error.code}: ${error.message}`).join('; ');
    throw Object.assign(new Error(`SVG failed after ${result.attempts} attempt(s): ${detail}`), { result });
  }
  return result;
}
