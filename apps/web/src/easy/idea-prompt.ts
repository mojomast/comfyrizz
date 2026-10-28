import type { EasyState } from './types.ts';

const MUSIC_BED = 'instrumental bed';
const NO_SPEECH_REQUEST = /\bwordless\b|\b(?:no|without)[\s-]+(?:dialogue|narration|speech|voice[\s-]*over)\b/i;
const SPEECH_INTENT = /\b(?:dialogue|narrat(?:e|es|ed|ing|ion|or)|speech|spoken|voice[\s-]*over|speak(?:s|ing)?|talk(?:s|ing)?|conversations?)\b/i;

/** The idea serialised the way `briefToPrompt` orders its sentences. */
export function ideaPrompt(state: EasyState): string {
  const sentences: string[] = [];
  const text = String(state.idea.text ?? '').trim();
  if (text) sentences.push(text);

  const hasExplicitDuration = /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]+(?:seconds?|minutes?|mins?)\b/i.test(text);
  if (!hasExplicitDuration) sentences.push(`Length: about ${state.idea.lengthS} seconds.`);
  sentences.push(`Aspect: ${state.idea.aspect}.`);
  const liveActionLook = /\b(?:real\s+(?:humans?|people)|realistic\s+humans?|photoreal(?:istic)?(?:\s+humans?)?|live[\s-]*action)\b/i.test(text);
  sentences.push(`Look: ${liveActionLook ? 'photorealistic live-action humans, natural skin and real-world materials' : state.idea.look}.`);
  sentences.push(state.idea.sound ? `Music: ${MUSIC_BED}.` : 'No music.');
  if (!NO_SPEECH_REQUEST.test(text)) {
    if (state.narration.on) {
      sentences.push('Finishing narration: meaningful scene-specific Kokoro voiceover that preserves the native soundscape.');
    } else if (!SPEECH_INTENT.test(text)) {
      sentences.push('No narration.');
    }
  }

  for (const question of state.questions) {
    const answer = state.answers[question.id];
    if (!answer || answer === '__decide__') continue;
    const prompt = String(question.prompt ?? '').trim();
    if (!prompt) continue;
    sentences.push(`${prompt} ${answer}`);
  }

  return sentences.join(' ');
}
