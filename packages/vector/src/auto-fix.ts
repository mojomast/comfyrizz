/**
 * Auto-fix loop (spec A5 / PLAN "Generated-first assets"):
 * sanitize → render-check on CPU → feed structured errors back to the generator.
 * The generator is an LLM in production and a deterministic stub in tests.
 */

import { sanitizeSvg, SANITIZER_VERSION, type SanitizeError } from './sanitize.js';
import { renderCheck, type RenderCheckError, type RenderCheckOptions } from './render-check.js';

export interface SvgIntent {
  kind: 'icon' | 'diagram' | 'pattern' | 'vector-anim';
  prompt: string;
  /** Palette the asset must stay inside (usually the package theme). */
  palette?: string[];
  width?: number;
  height?: number;
  seed?: number;
}

export interface AutoFixIssue {
  source: 'sanitize' | 'render' | 'generator';
  code: string;
  message: string;
  detail?: string;
}

export interface GenerateContext {
  intent: SvgIntent;
  /** 1 for the first try, 2 for the first repair, and so on. */
  attempt: number;
  /** Errors from the previous attempt, empty on the first try. */
  errors: AutoFixIssue[];
  previousSvg?: string;
}

export type SvgGenerator = (context: GenerateContext) => string | Promise<string>;

export interface AttemptRecord {
  attempt: number;
  sanitized: boolean;
  rendered: boolean;
  errors: AutoFixIssue[];
}

export interface AutoFixResult {
  ok: boolean;
  svg: string;
  attempts: number;
  repairs: number;
  sanitizerVersion: string;
  errors: AutoFixIssue[];
  history: AttemptRecord[];
}

function fromSanitize(errors: SanitizeError[]): AutoFixIssue[] {
  return errors.map(error => ({ source: 'sanitize' as const, code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) }));
}

function fromRender(errors: RenderCheckError[]): AutoFixIssue[] {
  return errors.map(error => ({ source: 'render' as const, code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) }));
}

export async function autoFix(
  generate: SvgGenerator,
  intent: SvgIntent,
  maxRepairs = 2,
  renderOptions: RenderCheckOptions = {},
): Promise<AutoFixResult> {
  const history: AttemptRecord[] = [];
  let errors: AutoFixIssue[] = [];
  let previousSvg: string | undefined;
  const maxAttempts = Math.max(1, maxRepairs + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw: string;
    try {
      raw = await generate({ intent, attempt, errors, ...(previousSvg ? { previousSvg } : {}) });
    } catch (error) {
      errors = [{ source: 'generator', code: 'generator-threw', message: 'The SVG generator threw before returning markup.', detail: error instanceof Error ? error.message : String(error) }];
      history.push({ attempt, sanitized: false, rendered: false, errors });
      continue;
    }
    const sanitized = sanitizeSvg(raw);
    if (!sanitized.ok) {
      errors = fromSanitize(sanitized.errors);
      history.push({ attempt, sanitized: false, rendered: false, errors });
      previousSvg = raw;
      continue;
    }
    const check = renderCheck(sanitized.svg, { palette: intent.palette, width: intent.width ?? renderOptions.width, ...renderOptions });
    if (!check.ok) {
      errors = fromRender(check.errors);
      history.push({ attempt, sanitized: true, rendered: false, errors });
      previousSvg = sanitized.svg;
      continue;
    }
    history.push({ attempt, sanitized: true, rendered: true, errors: [] });
    return {
      ok: true,
      svg: sanitized.svg,
      attempts: attempt,
      repairs: attempt - 1,
      sanitizerVersion: SANITIZER_VERSION,
      errors: [],
      history,
    };
  }

  return { ok: false, svg: previousSvg ?? '', attempts: maxAttempts, repairs: maxAttempts - 1, sanitizerVersion: SANITIZER_VERSION, errors, history };
}
