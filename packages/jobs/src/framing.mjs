// judge-workflow v3: framing adherence at the prompt-planning stage.
//
// FLUX-family models decide the camera from the first part of the prompt, and "wide shot" alone is
// read as intent, not distance: the same model that renders a medium shot for "wide shot of Gus on a
// scooter" frames head to toe when the prompt LEADS with framing and anchors it physically (feet on
// the ground, space above the head and below the feet, camera at a moderate distance). See
// /workspace/judge-workflow-v3/RESEARCH.md (BFL / Runware FLUX 3 prompting guides, Tensor.Art guide).
// All wording is positive: Klein is distilled (cfg 1) and negatives tend to summon what they name.

const SIZES = [
  { size: 'extreme_wide', re: /\b(extreme(?:ly)?[- ]wide|establishing)\s+shot\b/i,
    lead: 'Extreme wide shot from a distance, the whole figure small within a large environment, head to toe visible.' },
  { size: 'wide', re: /\b(wide|long|full[- ]body|full[- ]length)\s+shot\b|\bfull[- ]body\b|\bhead to toe\b/i,
    lead: 'Wide shot, camera at a moderate distance, full body framed from head to toe with space above the head and below the feet, feet on the ground.' },
];

/** The planned shot size named in a prompt, or null. */
export function plannedShotSize(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  for (const entry of SIZES) if (entry.re.test(text)) return entry.size;
  return null;
}

/** The framing lead sentence for a prompt's planned shot size, or '' when no wide size is planned. */
export function framingLead(prompt) {
  const size = plannedShotSize(prompt);
  return size ? SIZES.find((entry) => entry.size === size).lead : '';
}

/**
 * Put the framing first. A prompt that plans a wide/full-body shot gets the lead sentence in front,
 * unless it already starts with it. Other prompts are returned unchanged (cache keys stay stable).
 */
export function leadWithFraming(prompt) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  const lead = framingLead(text);
  if (!lead || text.startsWith(lead)) return { prompt: text, applied: false };
  return { prompt: `${lead} ${text}`, applied: true, lead };
}
