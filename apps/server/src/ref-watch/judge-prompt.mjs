import { TEXT_GUARD } from '../../../../packages/jobs/src/defaults.mjs';

/**
 * The shot prompt as the judge should read it. The planner appends the text guard
 * (TEXT_GUARD: "... plain untextured backgrounds ...") and plates open with the LTX
 * instruction "Use the provided start image as the first frame." Neither describes content:
 * on the goat live check (2026-11-02) the judge failed the prompt check on clips that clearly
 * showed the hay-bale jump and the pond crash because the sunflower field was "not a plain
 * untextured background". Text is still checked by the text_artifact dimension.
 */
const START_FRAME = /^\s*use the provided start image as the first frame\.\s*/i;

export function judgePrompt(prompt) {
  let text = String(prompt ?? '');
  text = text.replace(START_FRAME, '');
  const at = text.indexOf(TEXT_GUARD);
  if (at >= 0) text = text.slice(0, at) + text.slice(at + TEXT_GUARD.length);
  return text.replace(/\s*,\s*(,\s*)+/g, ', ').replace(/[\s,]+$/, '').replace(/\s+\./g, '.').trim();
}

/** Six sampled frames cannot show pacing or camera wording; the clip prompt check judges subjects and action. */
export const CLIP_PROMPT_NOTE = 'Prompt check for a clip: judge whether the named subjects, setting and action are visibly shown across the frames. Camera and pacing wording (slow motion, tracking, low angle, static, push in, no cuts) cannot be judged from six frames; do not fail on it. Still fail the prompt check when the main action or a named subject is missing or clearly different. ';
