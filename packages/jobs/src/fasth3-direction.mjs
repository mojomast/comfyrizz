// Full-reference prompt contract, based on MiniMax's official ref-mode guide.
// This supports the shipped two-image / one-audio graph and a single shot/voice.
// It is prompt conditioning, not a guarantee of composition or exact speech.
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`FastH3 direction.${name} must be nonempty text`);
  if (/[<>]/.test(value)) throw new Error(`FastH3 direction.${name} must contain plain text, not reference/dialogue tags`);
  return value.trim();
};
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const normalized = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim();

/** Build one native-AV shot. Metadata is planner-only, never a Comfy node input. */
export function buildFastH3Prompt(direction, { slotSeconds, sourceSeconds, conditioningSeconds } = {}) {
  if (!direction || typeof direction !== 'object' || Array.isArray(direction)) throw new Error('FastH3 direction must be an object');
  const subject = text(direction.subject, 'subject');
  const composition = text(direction.composition, 'composition');
  const action = text(direction.action, 'action');
  const camera = text(direction.camera, 'camera');
  const soundscape = text(direction.soundscape, 'soundscape');
  const count = direction.characterCount;
  if (!Number.isInteger(count) || count < 0) throw new Error('FastH3 direction.characterCount must be a nonnegative integer');
  const reaction = direction.reactionSeconds ?? .2;
  if (typeof reaction !== 'number' || !Number.isFinite(reaction) || reaction < 0) throw new Error('FastH3 direction.reactionSeconds must be nonnegative');
  if (!positive(slotSeconds) || slotSeconds <= .2 || !positive(sourceSeconds) || slotSeconds > sourceSeconds + 1 / 24) {
    throw new Error('FastH3 direction needs a positive editorial slot that fits the generated source');
  }
  let voiceDefinition = '<Audio 1> is a silent conditioning signal.';
  let retention = '<Audio 1>: reference - silence provides no vocal content.';
  let speech = 'The shot contains only the physical sounds described below.';
  if (direction.dialogue !== undefined) {
    const d = direction.dialogue;
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('FastH3 direction.dialogue must be an object');
    const line = text(d.text, 'dialogue.text');
    const language = text(d.language, 'dialogue.language');
    const voice = text(d.voice, 'dialogue.voice');
    const delivery = text(d.delivery, 'dialogue.delivery');
    if (d.offscreen !== undefined && typeof d.offscreen !== 'boolean') throw new Error('FastH3 dialogue.offscreen must be boolean');
    if (count === 0 && d.offscreen !== true) throw new Error('FastH3 an unoccupied shot needs an offscreen speaker');
    if (count > 1 && !d.offscreen) throw new Error('FastH3 this direction helper supports one visible speaker; use separate coverage for multi-character dialogue');
    if (normalized(text(d.conditioningText, 'dialogue.conditioningText')) !== normalized(line)) {
      throw new Error('FastH3 conditioning text must contain only this shot\'s exact dialogue; prepare a shot-specific reference');
    }
    if (!positive(conditioningSeconds) || conditioningSeconds + reaction > slotSeconds + 1 / 24) {
      throw new Error('FastH3 measured conditioning audio plus reaction time must fit the editorial slot at natural speed; revise the line or timing');
    }
    const speaker = d.offscreen ? `${voice} (S1), off-screen` : '<Subject 1> (S1)';
    voiceDefinition = `<Audio 1> is the voice-timbre and delivery reference for ${d.offscreen ? `${voice} (S1)` : '<Subject 1> (S1)'}.`;
    retention = '<Audio 1>: reference - guide timbre and delivery while generating a new synchronized performance.';
    speech = `${speaker} says once, ${delivery}, <d>[${language}] ${line}</d> The line begins with the action and finishes within ${(slotSeconds - reaction).toFixed(2)} seconds, leaving ${reaction.toFixed(2)} seconds for the response to land. ${d.offscreen ? 'The composition remains unoccupied by the speaker.' : '<Subject 1> closes their mouth afterward.'}`;
  }
  return `subject_definitions:
<Subject 1> is ${subject} from <Picture 1>.
<Picture 2> is the composition reference: ${composition}
${voiceDefinition}

summary:
[reference generation${direction.dialogue ? ' + audio reference' : ''}] One continuous shot of <Subject 1> using <Picture 2> for framing and spatial relationships.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - retain the defined appearance and physical features.
<Picture 2> ([Shot 1] composition): fully_preserved - retain the described subject placement and contact points.
${retention}

detailed_description:
The visual style and lighting follow the supplied references.
[Shot 1] ${composition} ${count === 0 ? 'The setting is unoccupied throughout.' : `Exactly ${count} visible character${count === 1 ? '' : 's'} occupy the shot.`} ${camera} ${action} ${speech} Hold the resulting state through the remaining source duration of ${sourceSeconds.toFixed(3)} seconds.

overall_soundscape:
${soundscape}

non_diegetic_music:
N/A`;
}

/** Check every scene use, not just the first occurrence of a reused asset. */
export function fastH3SlotSeconds(pkg, assetId, requested) {
  const uses = (pkg.scenes ?? []).filter(scene => scene.background?.asset === assetId);
  const slots = uses.map(scene => {
    if (scene.background?.speed !== undefined && scene.background.speed !== 1) {
      throw new Error(`FastH3 ${assetId}: directed native speech/motion needs natural-speed playback`);
    }
    if (scene.background?.trim?.startSeconds || scene.background?.trim?.endSeconds !== undefined) {
      throw new Error(`FastH3 ${assetId}: apply source trims after reviewing the generated performance`);
    }
    return scene.preferredFrames / pkg.format?.fps;
  });
  if (slots.some(slot => !positive(slot))) throw new Error(`FastH3 ${assetId}: set explicit scene frames/fps before directing a shot`);
  if (requested !== undefined) {
    if (!positive(requested)) throw new Error(`FastH3 ${assetId}: direction.slotSeconds must be positive`);
    slots.push(requested);
  }
  return slots.length ? Math.min(...slots) : undefined;
}
