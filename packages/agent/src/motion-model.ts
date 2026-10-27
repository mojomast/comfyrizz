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

/** Deterministic editorial routing; never a fallback after another model failed. */
export function autoMotionModel(direction: ShotMotionDirection): AutoResolvedMotionModel {
  const subjectAndAction = `${direction.subject} ${direction.action}`;
  const sound = direction.soundscape;
  if (direction.dialogue !== undefined || /\b(?:native\s+(?:audio|sound)|dialogue|spoken|speech|synchroni[sz]ed\s+(?:audio|sound)|footsteps?|vocali[sz]ations?)\b/i.test(sound)) {
    return 'h3';
  }
  const character = /\b(?:jerboa|bird|fox|bear|robot|mascot|protagonist|puppet|person|woman|man|girl|boy|child|character|felt|wooden|clay|plush|percussionist|drummer|musician|locksmith|operator|cartographer|worker|archivist|dancer)\b/i.test(subjectAndAction);
  const acting = /\b(?:act(?:ing|s|ed)?|react(?:ing|s|ed)?|gestur(?:e|es|ing)|speak(?:s|ing)?|restore[sd]?|repair[sd]?|haul[sd]?|lift[sd]?|carr(?:y|ies|ied)|brac(?:e|es|ed)|holds?|pulls?|pushes?|places?|picks?\s+up|opens?|closes?|climbs?|walks?|runs?|jumps?|dances?|waves?|turns?|rows?|guides?|feels?|listens?|plays?)\b/i.test(direction.action);
  if (character && acting) return 'h3';

  const scenery = /\b(?:establishing|scenery|landscape|seascape|cityscape|b[\s-]?roll|aerial|insert|wide\s+shot|camera[\s-]+driven|drifts?|pans?|tilts?|dollies|orbits?|tracking\s+shot|push[\s-]+in|pull[\s-]+out)\b/i;
  if (scenery.test(`${direction.composition} ${direction.action} ${direction.camera}`)) return 'ltx';
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
