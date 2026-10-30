/** Shared builder/tool/repair guidance. Evidence and scope: docs/research/COMFY_PROMPT_QUALITY.md. */
export const KLEIN_CAPTION_GUIDANCE = 'Write one concrete, self-contained scene caption of 100 to 350 words. Put medium and style first, then the scene and setting, then lighting, then each subject with its colours, materials and position stated relative to the frame (frame-left, frame-right, foreground, background, upper third). Quote any visible text verbatim in double quotes. Describe only what is visible; avoid mood-only or abstract sentences, and use only detail that serves the approved brief: do not pad with new characters, props, story beats, factual claims or invented source observations. The local tool appends constraints; it does not run a semantic prompt upsampler. Preserve exact supplied copy, original language and line breaks; quote requested in-image lettering with placement and typography. Otherwise keep copy in native overlays and generated surfaces plain.';

export const KLEIN_EDIT_GUIDANCE = 'An edit prompt describes the finished image, beginning with the words The final frame shows, with the change folded into that description and an explicit keep-list: pose, background, lighting and composition stay as in the reference unless the change requires otherwise. Name each reference role with <ref_image_0>-style tokens. For references, describe concrete finished appearance and reference roles. A newly composed shot needs a full result caption; a bounded edit may use an instruction stating the exact end state and what stays unchanged (BFL suggests 50–150 words). Preserve identity, source materials and exact labels unless explicitly changed; never infer unseen reference details. Use only returned asset IDs for refs. Local Klein workflows support at most two connected references total, including implicit cast references; requests for more fail before generation. Klein tokens are zero-based connected conditioning order: <ref_image_0> is the first connected image, <ref_image_1> the second, not H3 Picture numbering. Upload/provenance order alone does not prove conditioning: the local single-reference graph wires only image0, and the two-reference graph wires image0 and image1. Do not invent higher-token correspondence from reference_N names or an unwired cast reference; verify the selected graph and resolved references first.';

export const MODEL_NEGATIVE_GUIDANCE = 'Prefer concrete positive visual descriptions. Distilled Klein at CFG 1 has no effective separate negative-prompt guidance; do not write negative-prompt lists into its caption or claim a negative field will enforce exclusions. This is model-specific: retain the LTX workflow negative conditioning and keep FastH3 prompt/conditioning rules separate.';

export const LTX_SHOT_GUIDANCE = 'For this single-shot LTX image-to-video path, use a focused flowing paragraph in present tense: shot scale and one camera move (or static camera), the start-frame subject and setting, one observable action with its end state, and consistent light/material continuity. Roughly 4–8 useful sentences can suffice; do not add actions to meet a count. Keep one continuous take sized to the shot, without internal cuts, competing camera moves, extra characters or a sequence of unrelated events. Keep soundscape and finishing_sound concrete and separate from picture direction: this local route emits picture only, so sound is a post-production plan, not evidence of native generated audio. Preserve exact dialogue/copy and model selection; never move H3 dialogue into LTX to bypass a failure.';

export const MODEL_QUALITY_GUIDANCE = [
  KLEIN_CAPTION_GUIDANCE,
  KLEIN_EDIT_GUIDANCE,
  MODEL_NEGATIVE_GUIDANCE,
  LTX_SHOT_GUIDANCE,
].join('\n');

export interface KleinPromptLintOptions {
  edit?: boolean;
}

/** Lightweight prompt checks for the Klein caption or edit stages. */
export function kleinPromptLint(text: string, { edit = false }: KleinPromptLintOptions = {}): string[] {
  const problems: string[] = [];
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 100 || wordCount > 350) {
    problems.push(`word count ${wordCount} is outside 100 to 350 words`);
  }
  const matches = text.match(/\b(?:no|not|without|avoid|never)\b/gi) ?? [];
  const negatives = [...new Set(matches.map((word) => word.toLowerCase()))];
  if (negatives.length > 0) {
    problems.push(`negative wording: ${negatives.map((word) => `"${word}"`).join(', ')}`);
  }
  if (edit && !text.trim().startsWith('The final frame shows')) {
    problems.push('edit prompt must start with "The final frame shows"');
  }
  return problems;
}
