/**
 * Deterministic stub generator for the A5 auto-fix tests and CPU examples.
 * It stands in for the LLM (`gen.generator: "llm-svg"`); the production generator
 * lives in the agent tool layer (C3). No randomness: same intent → same markup.
 */

import type { GenerateContext, SvgIntent } from './auto-fix.js';

export interface StubOptions {
  /** Return deliberately unsafe markup on attempt 1 so the repair loop is exercised. */
  brokenFirstAttempt?: boolean;
}

function palette(intent: SvgIntent, index: number): string {
  return intent.palette?.[index % intent.palette.length] ?? ['#0d0f14', '#6d8cff', '#e6e8ee'][index % 3];
}

function icon(intent: SvgIntent): string {
  const stroke = palette(intent, 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke="${stroke}" stroke-width="6"/><path d="M20 34l9 9 16-20" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function diagram(intent: SvgIntent): string {
  const one = palette(intent, 1);
  const two = palette(intent, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect x="12" y="60" width="90" height="60" rx="10" fill="${one}"/><rect x="218" y="60" width="90" height="60" rx="10" fill="${two}"/><path d="M102 90h116" stroke="${one}" stroke-width="6" stroke-linecap="round"/><path d="M206 78l14 12-14 12" fill="none" stroke="${one}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function pattern(intent: SvgIntent): string {
  const base = palette(intent, 0);
  const dot = palette(intent, 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><defs><pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="20" cy="20" r="6" fill="${dot}"/></pattern></defs><rect width="160" height="160" fill="${base}"/><rect width="160" height="160" fill="url(#dots)" opacity="0.35"/></svg>`;
}

function vectorAnim(intent: SvgIntent): string {
  const bar = palette(intent, 1);
  const base = palette(intent, 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" rx="16" fill="${base}"/><rect x="24" y="30" width="24" height="60" rx="8" fill="${bar}"/><rect x="64" y="46" width="24" height="44" rx="8" fill="${bar}"/><rect x="104" y="20" width="24" height="70" rx="8" fill="${bar}"/><rect x="144" y="54" width="24" height="36" rx="8" fill="${bar}"/></svg>`;
}

export function createStubGenerator(options: StubOptions = {}) {
  return async function stubGenerator(context: GenerateContext): Promise<string> {
    if (options.brokenFirstAttempt && context.attempt === 1) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>alert(1)</script></svg>`;
    }
    switch (context.intent.kind) {
      case 'diagram':
        return diagram(context.intent);
      case 'pattern':
        return pattern(context.intent);
      case 'vector-anim':
        return vectorAnim(context.intent);
      default:
        return icon(context.intent);
    }
  };
}

export const stubGenerator = createStubGenerator();
