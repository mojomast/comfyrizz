/**
 * R2 (research §2.3–2.4): server-side plan-mode brief flow.
 *
 * Wraps the deterministic extractor in `@comfyrizz/agent` so the web UI can ask
 * for a brief + at most three chip questions, then apply the answers. Step 4 adds
 * the script-first outline (`buildOutline`) so the Brief card can show and edit
 * the narration beats and their estimated seconds. No model, no network, no GPU:
 * this is pure text work.
 */
import {
  applyDecisions,
  buildOutline,
  completeBrief,
  draftKeyMessages,
  extractBrief,
  missingQuestions,
} from '../../../packages/agent/dist/src/index.js';

export const MAX_QUESTIONS = 3;

function normalizeMode(mode) {
  return mode === 'express' ? 'express' : 'plan';
}

/** Complete a draft and attach its outline. */
function finished(mode, draft) {
  const brief = completeBrief(draft);
  return { mode, complete: true, questions: [], brief, outline: buildOutline(brief) };
}

/**
 * @param {{
 *   prompt?: string,
 *   mode?: 'plan'|'express',
 *   attachments?: string,
 *   decisions?: Record<string, string|number|undefined>,
 *   askMore?: boolean,
 * }} input
 */
export function planBrief(input = {}) {
  const mode = normalizeMode(input.mode);
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const draft = extractBrief(prompt, { mode, attachments: input.attachments });
  const options = draftKeyMessages(prompt);

  if (input.decisions && typeof input.decisions === 'object') {
    const answered = applyDecisions(draft, input.decisions);
    const remaining = missingQuestions(answered, MAX_QUESTIONS, options);
    // One round of at most three questions (research §2.4): once the user has
    // answered them, the agent decides anything still open.
    if (input.askMore !== true || remaining.length === 0 || mode === 'express') {
      return finished(mode, answered);
    }
    return { mode, complete: false, questions: remaining, brief: answered };
  }

  if (mode === 'express') {
    return finished(mode, draft);
  }

  const questions = missingQuestions(draft, MAX_QUESTIONS, options);
  if (questions.length === 0) {
    return finished(mode, draft);
  }
  return { mode, complete: false, questions, brief: draft };
}

/**
 * Refresh an edited brief: complete it (filling any cleared field with its
 * default) and return the new outline. Step 4's Brief card posts every edit here.
 *
 * @param {{ brief?: object }} input
 */
export function refreshBrief(input = {}) {
  const draft = input.brief && typeof input.brief === 'object' ? input.brief : {};
  const mode = normalizeMode(draft.mode);
  const brief = completeBrief({ ...draft, mode });
  return { mode, complete: true, questions: [], brief, outline: buildOutline(brief) };
}
