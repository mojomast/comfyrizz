export type ProductionIntentKind = 'motion-graphics' | 'generated-film';

export interface ProductionIntent {
  kind: ProductionIntentKind;
  generatedFilm: boolean;
  /** Wordless describes speech, never the presence of a native soundscape. */
  wordless: boolean;
  noCaptions: boolean;
  /** Explicitly requires narration-anchored motion.cue_phrases on every scene. */
  requiresNarrationCues: boolean;
  /** Live-action fictional humans, not a substituted stylized medium. */
  liveActionHumans: boolean;
  /** Add editable Remotion opening/closing treatment to existing AI-footage shots. */
  bookends: boolean;
  /** Purpose-matched structured editorial treatment for the middle shots. */
  structuredVisual: 'technical-flow' | 'sketch' | 'morph' | 'focus' | null;
  requestedSeconds: number | null;
  evidence: {
    generatedShots: boolean;
    recurringPhysicalCharacters: boolean;
    cinematicCameraOrAction: boolean;
    nativeSoundscape: boolean;
    proceduralConstraint: boolean;
  };
}

const NEGATED_PREFIX = /\b(?:no|not|without|never|avoid|exclude|instead\s+of)\s+(?:[\w-]+\s+){0,2}$/i;
const NEGATED_LIST_PREFIX = /\b(?:no|not|without|never|avoid|exclude)\b[^.!?;]{0,40}(?:,|\bor\b|\band\b)\s*$/i;

function positiveMatch(text: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 36), match.index);
    if (!NEGATED_PREFIX.test(prefix) && !NEGATED_LIST_PREFIX.test(prefix)) return true;
  }
  return false;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const DURATION_NUMBER = '(?:\\d{1,3}(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)';

function durationNumber(value: string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NUMBER_WORDS[value.toLowerCase()] ?? Number.NaN;
}

/** Rule-first classification: an explicit procedural deliverable wins over film language. */
export function classifyProductionIntent(brief: string): ProductionIntent {
  const text = String(brief ?? '');
  const proceduralConstraint = positiveMatch(
    text,
    /\b(?:motion[\s-]+graphics?|SVG|charts?|graphs?|vector(?:\s+|\s*-)*(?:animation|graphics?|art)|procedural(?:\s+|\s*-)*(?:animation|graphics?|video)|animated\s+(?:charts?|graphs?|diagrams?|infographics?)|data[\s-]+driven\s+(?:animation|video)|kinetic\s+typography)\b/i,
  );
  const explicitGeneratedFilm = positiveMatch(
    text,
    /\b(?:AI[\s-]+generated\s+(?:film|video|shots?)|generated\s+(?:film|shots?)|(?:live[\s-]*action(?:\s+(?:film|video|footage|shots?))?|(?:realistic\s+humans?|photoreal(?:istic)?(?:\s+humans?)?)))\b/i,
  );
  const generatedShots = positiveMatch(
    text,
    /\b(?:AI[\s-]+generated\s+(?:film|video|shots?)|generated\s+(?:film|shots?)|(?:live[\s-]*action(?:\s+(?:film|video|footage|shots?))?|(?:realistic\s+humans?|photoreal(?:istic)?(?:\s+humans?)?))|(?:film|movie|explainer\s+video|video\s+(?:explaining|about))|short\s+film|cinematic\s+(?:short|film|sequence)|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]+shots?\b|film\s+in\s+(?:\d+|one|two|three|four|five|six)[\s-]+shots?)\b/i,
  );
  const recurringPhysicalCharacters = positiveMatch(
    text,
    /\b(?:recurring\s+(?:[\w-]+\s+){0,3}(?:characters?|mascots?)|same\s+(?:character|mascot|protagonist)|(?:felt|wooden|clay|tactile|plush|puppet|miniature)\s+(?:[\w-]+\s+){0,2}(?:jerboa|bird|fox|bear|robot|character|mascot|protagonist)|(?:jerboa|protagonist|puppet|mascot)\b)/i,
  );
  const cinematicCameraOrAction = positiveMatch(
    text,
    /\b(?:cinematic|camera\s+(?:moves?|push|dolly|pan|tilt|tracking|orbit)|close[\s-]+up|wide\s+shot|tracking\s+shot|physical\s+action|restore[sd]?|repair[sd]?|haul[sd]?|lift[sd]?|carr(?:y|ies|ied)|brac(?:e|es|ed)|walks?|runs?|climbs?|opens?|closes?|approaches?)\b/i,
  );
  const nativeSoundscape = positiveMatch(
    text,
    /\b(?:native\s+(?:audio|sound|soundscape)|soundscape|sound\s+design|foley|ambient\s+sound|coastal\s+sound|gentle\s+[\w-]+\s+sound)\b/i,
  );
  const wordless = /\bwordless\b/i.test(text)
    || /\bno\b[^.!?\n]{0,70}\b(?:dialogue|narration|speech|voice[\s-]?over)\b/i.test(text)
    || /\bwithout\s+(?:dialogue|narration|speech|voice[\s-]?over)\b/i.test(text);
  const noCaptions = /\bno\b[^.!?\n]{0,90}\b(?:captions?|subtitles?|on[\s-]+screen\s+text|headlines?|titles?|title\s+cards?|end\s+cards?|lower\s+thirds?|copy)\b/i.test(text)
    || /\bwithout\s+(?:captions?|subtitles?|on[\s-]+screen\s+text|headlines?|titles?|title\s+cards?|end\s+cards?|lower\s+thirds?)\b/i.test(text)
    || /\btext[\s-]+free\b/i.test(text);
  const requiresNarrationCues = /\bcue_phrases\b|narration[\s-]+(?:linked|anchored)\s+(?:motion|animation|cues?)|timed\s+(?:to|with)\s+(?:the\s+)?narration/i.test(text);
  const liveActionHumans = positiveMatch(text, /\b(?:real\s+(?:humans?|people)|(?:realistic\s+humans?|photoreal(?:istic)?(?:\s+humans?)?)|photoreal(?:istic)?(?:\s+humans?)?|live[\s-]*action)\b/i);
  const requestedMinutesMatch = new RegExp(`\\b(${DURATION_NUMBER})[\\s-]+(?:minutes?|mins?)\\b`, 'i').exec(text);
  const requestedSecondsMatch = new RegExp(`\\b(${DURATION_NUMBER})[\\s-]+seconds?\\b`, 'i').exec(text);
  const adjacentSeconds = requestedMinutesMatch && requestedSecondsMatch
    && requestedSecondsMatch.index > requestedMinutesMatch.index
    && /^\s*(?:and\s+)?$/i.test(text.slice(requestedMinutesMatch.index + requestedMinutesMatch[0].length, requestedSecondsMatch.index))
    ? durationNumber(requestedSecondsMatch[1])
    : 0;
  const requestedSeconds = requestedMinutesMatch
    ? Math.round(durationNumber(requestedMinutesMatch[1]) * 60 + adjacentSeconds)
    : requestedSecondsMatch ? durationNumber(requestedSecondsMatch[1]) : null;
  const strongEvidence = [generatedShots, recurringPhysicalCharacters, cinematicCameraOrAction, nativeSoundscape]
    .filter(Boolean).length;
  // An explicit generated film may use Remotion overlays and motion graphics.
  // Procedural wording only wins when the brief is not explicitly a generated film.
  const generatedFilm = explicitGeneratedFilm || (!proceduralConstraint && (generatedShots || strongEvidence >= 2));
  const structuredVisual = noCaptions ? null
    : positiveMatch(text, /\b(?:mechanisms?|how\s+(?:a|an|the)\s+[\w\s-]+works?|sketch(?:book)?|draw[\s-]+on)\b/i) ? 'sketch'
      : positiveMatch(text, /\b(?:technical[\s-]+flow|workflows?|process(?:es)?|architecture|cause[\s-]+and[\s-]+effect|pipelines?)\b/i) ? 'technical-flow'
        : positiveMatch(text, /\b(?:before\s*(?:\/|and)\s*after|transformations?|compare|comparison|versus|vs\.?)\b/i) ? 'morph'
          : positiveMatch(text, /\b(?:evidence|screenshots?|product\s+demos?|source\s+claims?|focus\s+windows?)\b/i) ? 'focus'
            : null;
  return {
    kind: generatedFilm ? 'generated-film' : 'motion-graphics',
    generatedFilm,
    wordless,
    noCaptions,
    requiresNarrationCues,
    liveActionHumans,
    bookends: generatedFilm && !noCaptions,
    structuredVisual,
    requestedSeconds,
    evidence: { generatedShots, recurringPhysicalCharacters, cinematicCameraOrAction, nativeSoundscape, proceduralConstraint },
  };
}
