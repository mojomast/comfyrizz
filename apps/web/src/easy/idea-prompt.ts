import type { EasyState } from './types.ts';

const MUSIC_BED = 'instrumental bed';

/** The idea serialised the way `briefToPrompt` orders its sentences. */
export function ideaPrompt(state: EasyState): string {
  const sentences: string[] = [];
  const text = String(state.idea.text ?? '').trim();
  if (text) sentences.push(text);

  sentences.push(`Length: about ${state.idea.lengthS} seconds.`);
  sentences.push(`Aspect: ${state.idea.aspect}.`);
  sentences.push(`Look: ${state.idea.look}.`);
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
