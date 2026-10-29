import type { EasyState } from './types.ts';
import { EASY_DURATION_PRESETS } from './duration.ts';
import { classifyAudioIntent, requestsLiveActionLook } from '../../../../packages/agent/src/production-intent.ts';

const MUSIC_BED = 'instrumental bed';

/** The idea serialised the way `briefToPrompt` orders its sentences. */
export function ideaPrompt(state: EasyState): string {
  const sentences: string[] = [];
  const text = String(state.idea.text ?? '').trim();
  if (text) sentences.push(text);

  const hasExplicitDuration = /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]+(?:seconds?|minutes?|mins?)\b/i.test(text);
  if (!hasExplicitDuration) {
    const preset = (EASY_DURATION_PRESETS as readonly number[]).includes(state.idea.lengthS);
    sentences.push(preset ? `Length: about ${state.idea.lengthS} seconds.` : `Length: exactly ${state.idea.lengthS} seconds; account for transition overlaps in the compiled timeline.`);
  }
  sentences.push(`Aspect: ${state.idea.aspect}.`);
  const liveActionLook = requestsLiveActionLook(text);
  sentences.push(`Look: ${liveActionLook ? 'photorealistic live-action, natural light and real-world materials' : state.idea.look}.`);
  if (String(state.videoType) === 'music-video') {
    sentences.push('For this Music Video, the supplied song is the only song master. Do not add a narrator, narration, or any composed music substitute.');
    if (state.lyricsStyle === 'caption') sentences.push('The separately supplied LRC uses bottom-safe caption presentation.');
    if (state.lyricsStyle === 'reel') sentences.push('The separately supplied LRC uses large-overlay reel presentation.');
    sentences.push('When an editorial performer image is present, the performance is an experimental reviewed audition.');
  } else {
    const audio = classifyAudioIntent(text);
    const titleReveal = state.videoType === 'title-reveal' || /\b(?:title|logo)[\s-]+reveal\b/i.test(text);
    const finishingNarration = state.narration.on && (!titleReveal || audio.speechRequested);
    if (audio.silent) sentences.push('Full silence: no audio, music, sound effects or speech.');
    else if (!state.idea.sound || audio.musicProhibited) sentences.push('No music.');
    // A wordless brief may direct native SFX or music, but does not request a bed.
    else if (!audio.wordless) sentences.push(`Music: ${MUSIC_BED}.`);
    if (!audio.wordless) {
      if (finishingNarration) {
        sentences.push('Finishing narration: meaningful scene-specific Kokoro voiceover that preserves the native soundscape.'); // banned-ok: internal model instruction, not display copy
      } else if (!audio.speechRequested) {
        sentences.push('No narration.');
      }
      if (finishingNarration || audio.speechRequested) {
        sentences.push('Narration timing is provisional: plan roughly 1.8 spoken words per second of usable speech time, allowing about 0.5 seconds padding per narrated scene and accounting for transition overlaps. Budget each scene separately as well as the whole film; leave room for natural pauses and visual reading. Shorten secondary wording rather than speeding up speech or extending the requested length. Measure the actual voice before final delivery.');
      }
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
