import type { EasyState } from './types.ts';

const MUSIC_BED = 'instrumental bed';

/** The idea serialised the way `briefToPrompt` orders its sentences. */
export function ideaPrompt(state: EasyState): string {
  const sentences: string[] = [];
  const text = String(state.idea.text ?? '').trim();
  if (text) sentences.push(text);

  const hasExplicitDuration = /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]+(?:seconds?|minutes?|mins?)\b/i.test(text);
  if (!hasExplicitDuration) sentences.push(`Length: about ${state.idea.lengthS} seconds.`);
  sentences.push(`Aspect: ${state.idea.aspect}.`);
  const liveActionLook = /\b(?:real\s+(?:humans?|people)|realistic\s+humans?|photoreal(?:istic)?(?:\s+humans?)?|live[\s-]*action)\b/i.test(text);
  sentences.push(`Look: ${liveActionLook ? 'photorealistic live-action fictional human adults, natural skin and real-world materials' : state.idea.look}.`);
  sentences.push(state.idea.sound ? `Music: ${MUSIC_BED}.` : 'No music.');

  for (const question of state.questions) {
    const answer = state.answers[question.id];
    if (!answer || answer === '__decide__') continue;
    const prompt = String(question.prompt ?? '').trim();
    if (!prompt) continue;
    sentences.push(`${prompt} ${answer}`);
  }

  return sentences.join(' ');
}
