export { sanitizeSvg, SANITIZER_VERSION, DEFAULT_LIMITS } from './sanitize.js';
export type { SanitizeResult, SanitizeError } from './sanitize.js';
export { renderCheck } from './render-check.js';
export type { RenderCheckOptions, RenderCheckResult, RenderCheckError } from './render-check.js';
export { autoFix } from './auto-fix.js';
export type { AutoFixResult, AutoFixIssue, GenerateContext, SvgGenerator, SvgIntent, AttemptRecord } from './auto-fix.js';
export { createStubGenerator, stubGenerator } from './stub-generator.js';
export type { StubOptions } from './stub-generator.js';
