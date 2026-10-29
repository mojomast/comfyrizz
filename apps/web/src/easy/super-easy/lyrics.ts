import {
  LrcParseError,
  parseLrc,
  type LrcParseIssue,
} from '../../../../../packages/planner/dist/src/browser.js';

/** Keep submit-time feedback useful without letting a large paste flood the form. */
export const SUPER_EASY_LRC_ERROR_LIMIT = 6;

export type SuperEasyLrcValidation =
  | { ok: true }
  | { ok: false; errors: readonly LrcParseIssue[] };

/**
 * Canonical cues are deliberately discarded: the browser validates only and
 * the exact user-authored LRC is sent to the server.
 */
export function validateSuperEasyLrc(raw: string): SuperEasyLrcValidation {
  if (raw.trim() === '') return { ok: true };
  try {
    parseLrc(raw);
    return { ok: true };
  } catch (error) {
    if (error instanceof LrcParseError) return { ok: false, errors: error.errors };
    return {
      ok: false,
      errors: [{ line: 1, code: 'LRC_INVALID_INPUT', message: 'the pasted LRC could not be parsed' }],
    };
  }
}

export function formatSuperEasyLrcErrors(errors: readonly LrcParseIssue[]): string {
  const visible = errors.slice(0, SUPER_EASY_LRC_ERROR_LIMIT)
    .map(issue => `Line ${issue.line}: ${issue.message}`);
  const remaining = errors.length - visible.length;
  if (remaining > 0) visible.push(`… and ${remaining} more LRC ${remaining === 1 ? 'error' : 'errors'}.`);
  return visible.join('\n');
}
