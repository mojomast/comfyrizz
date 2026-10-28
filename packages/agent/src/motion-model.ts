export const MOTION_MODELS = ['auto', 'h3', 'ltx', 'klein'] as const;
export type MotionModel = (typeof MOTION_MODELS)[number];
export type ResolvedMotionModel = Exclude<MotionModel, 'auto'>;
export type AutoResolvedMotionModel = 'h3' | 'ltx';

export interface ShotMotionDirection {
  subject: string;
  composition: string;
  action: string;
  camera: string;
  soundscape: string;
  characterCount: number;
  dialogue?: unknown;
}

export function parseMotionModel(value: unknown, fallback: MotionModel = 'auto'): MotionModel {
  const selected = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof selected !== 'string' || !(MOTION_MODELS as readonly string[]).includes(selected)) {
    throw new Error(`motionModel must be one of ${MOTION_MODELS.join(', ')}`);
  }
  return selected as MotionModel;
}

/**
 * Character evidence is a person or role noun, or a he/she/they pronoun, in the
 * subject or the action. A mention in composition or camera text is not evidence.
 */
const CHARACTER_SUBJECT = /\b(?:jerboa|bird|fox|bear|robot|mascot|protagonist|puppet|person|people|woman|women|man|men|girl|girls|boy|boys|child|children|character|hero|heroine|keeper|keepers|shopkeeper|shopkeepers|fisherman|fishermen|fisher|angler|diver|divers|sailor|sailors|captain|captains|pilot|pilots|rower|rowers|swimmer|swimmers|dancer|dancers|percussionist|percussionists|drummer|drummers|musician|musicians|locksmith|locksmiths|operator|operators|cartographer|cartographers|worker|workers|archivist|archivists|actor|actors|actress|actresses|performer|performers|painter|painters|sculptor|sculptors|potter|potters|weaver|weavers|blacksmith|blacksmiths|carpenter|carpenters|chef|chefs|cook|cooks|baker|bakers|farmer|farmers|gardener|gardeners|scientist|scientists|engineer|engineers|teacher|teachers|doctor|doctors|nurse|nurses|guard|guards|traveler|travelers|traveller|travellers|explorer|explorers|climber|climbers|hiker|hikers|walker|walkers|runner|runners|rider|riders|cyclist|cyclists|surfer|surfers|he|she|they)\b/i;

/**
 * Short agentive actions. Deliberately no light, weather, water or camera verbs
 * (no move, turn, set, drift, pan, stand, look or fall), so scenery stays LTX.
 */
const ACTED_ACTION = /\b(?:act(?:s|ed|ing)?|react(?:s|ed|ing)?|gestur(?:e|es|ed|ing)|speak(?:s|ing)?|spoke|spoken|restor(?:e|es|ed|ing)|repair(?:s|ed|ing)?|haul(?:s|ed|ing)?|lift(?:s|ed|ing)?|carr(?:y|ies|ied|ying)|brac(?:e|es|ed|ing)|hold(?:s|ing)?|held|pull(?:s|ed|ing)?|push(?:es|ed|ing)?|plac(?:e|es|ed|ing)|pick(?:s|ed|ing)?\s+up|open(?:s|ed|ing)?|clos(?:e|es|ed|ing)|climb(?:s|ed|ing)?|walk(?:s|ed|ing)?|run(?:s|ning)?|ran|danc(?:e|es|ed|ing)|row(?:s|ed|ing)?|play(?:s|ed|ing)?|guid(?:e|es|ed|ing)|reach(?:es|ed|ing)?|kneel(?:s|ing)?|knelt|ti(?:e|es|ed)|tying|hand(?:s|ed|ing)?)\b/i;

const ACTED_ACTION_ALL = new RegExp(ACTED_ACTION.source, 'gi');

const CLAUSE_BREAK = /[.!?;:]|\b(?:as|while|when|then)\b/gi;

/**
 * True when a character noun or pronoun appears before an acted verb. The order
 * matters: "the camera opens on the woman" is a camera move, not a character
 * acting. Action text is read clause by clause, so a bystander before "as" or
 * "while" cannot lend the camera clause a character.
 */
function characterActs(text: string, clauseScoped: boolean): boolean {
  for (const acted of text.matchAll(ACTED_ACTION_ALL)) {
    const index = acted.index ?? 0;
    let start = 0;
    if (clauseScoped) {
      for (const boundary of text.slice(0, index).matchAll(CLAUSE_BREAK)) {
        start = (boundary.index ?? 0) + boundary[0].length;
      }
    }
    if (CHARACTER_SUBJECT.test(text.slice(start, index))) return true;
  }
  return false;
}

/** Deterministic editorial routing; never a fallback after another model failed. */
export function autoMotionModel(direction: ShotMotionDirection): AutoResolvedMotionModel {
  const sound = direction.soundscape;
  if (direction.dialogue !== undefined || /\b(?:native\s+(?:audio|sound)|dialogue|spoken|speech|synchroni[sz]ed\s+(?:audio|sound)|footsteps?|vocali[sz]ations?)\b/i.test(sound)) {
    return 'h3';
  }
  if (direction.characterCount >= 1) {
    const subjectCharacter = CHARACTER_SUBJECT.test(direction.subject);
    // Character in the subject and an acted verb in the action (the original rule).
    if (subjectCharacter && ACTED_ACTION.test(direction.action)) return 'h3';
    // A subject that carries both the character and the acted verb
    // ("the same woman guiding the boat over the reef").
    if (characterActs(direction.subject, false)) return 'h3';
    // A scenery subject with the acting character in the action
    // ("she guides the boat over the reef while reef scenery drifts").
    if (characterActs(direction.action, true)) return 'h3';
  }
  return 'ltx';
}

/** Resolve one shot while treating non-auto package/tool selections as constraints. */
export function resolveShotMotionModel(
  configured: unknown,
  requested: unknown,
  direction: ShotMotionDirection,
): ResolvedMotionModel {
  const packageChoice = parseMotionModel(configured, 'auto');
  const toolChoice = parseMotionModel(requested, packageChoice);
  if (packageChoice !== 'auto' && toolChoice !== 'auto' && packageChoice !== toolChoice) {
    throw new Error(`motion_model ${toolChoice} conflicts with configured motionModel ${packageChoice}; select the same model or use auto`);
  }
  const selected = packageChoice === 'auto' ? toolChoice : packageChoice;
  return selected === 'auto' ? autoMotionModel(direction) : selected;
}
