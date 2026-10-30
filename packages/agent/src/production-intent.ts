export type ProductionIntentKind = 'motion-graphics' | 'generated-film';

export interface AudioIntent {
  /** Full silence prohibits music, effects and speech, including native audio. */
  silent: boolean;
  /** Wordless describes speech, never the presence of a native soundscape. */
  wordless: boolean;
  speechRequested: boolean;
  /** Explicitly requests finishing narration rather than native H3 dialogue. */
  narrationRequested: boolean;
  /** Explicitly requests a score/music bed; soundscape alone does not imply music. */
  musicRequested: boolean;
  musicProhibited: boolean;
}

export interface ProductionIntent extends AudioIntent {
  kind: ProductionIntentKind;
  generatedFilm: boolean;
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
  exactDuration: boolean;
  evidence: {
    generatedShots: boolean;
    recurringPhysicalCharacters: boolean;
    cinematicCameraOrAction: boolean;
    nativeSoundscape: boolean;
    proceduralConstraint: boolean;
  };
}

// Lists remain in the same clause ("avoid photos, people and live action"),
// while a separate directive starts fresh ("avoid cartoons and show people").
// Do not use a character/word window: disclaimers may qualify distant subjects.
function clausePrefix(text: string, index: number): string {
  return text.slice(0, index).split(/[.!?;\n]|\b(?:but|however|yet)\b|(?:,|\band\b)\s*(?=(?:(?:then|also|please|I|we)\s+)*(?:include|add|create|generate|use|show|feature|film|want|need)\b)/i).at(-1) ?? '';
}

const NEGATED_CLAUSE = /\b(?:no|not|without|never|avoid|exclude|instead\s+of|rather\s+than|don['’]t|doesn['’]t|isn['’]t)\b(?!\s+only\b)[^.!?;\n]*$/i;

function* positiveMatches(text: string, pattern: RegExp): Generator<{ match: RegExpMatchArray; prefix: string }> {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    const prefix = clausePrefix(text, match.index ?? 0);
    if (!NEGATED_CLAUSE.test(prefix)) yield { match, prefix };
  }
}

function positiveMatch(text: string, pattern: RegExp): boolean {
  return !positiveMatches(text, pattern).next().done;
}

// Quoted dialogue, titles and source copy are content, not production policy.
// Keep this classification view separate: the original brief must be serialized
// verbatim, including punctuation and every word of supplied dialogue.
function instructionText(brief: string): string {
  return String(brief ?? '').replace(/"(?:\\.|[^"\\])*"|“[^”]*”|(?<![\p{L}\p{N}])'(?:\\.|(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}])|[^'\\])*'(?![\p{L}\p{N}])|‘(?:(?<=[\p{L}\p{N}])’(?=[\p{L}\p{N}])|[^’])*’/gu, ' [supplied content] ');
}

/** Shared, subject-neutral visual look policy for UI serialization and planning. */
export function requestsLiveActionLook(text: string): boolean {
  text = instructionText(text);
  const nativeMedium = positiveMatch(text, /\b(?:native\s+(?:editable\s+)?(?:motion\s+graphics|typography|graphics|bar\s+chart)|(?:bar\s+)?charts?|graphs?)\b/i);
  const pattern = /\b(?:real\s+(?:humans?|people)|realistic\s+humans?|photoreal(?:istic)?(?:\s+humans?)?|live[\s-]*action)\b/i;
  for (const { match, prefix } of positiveMatches(text, pattern)) {
    // People can be the subject of a chart without defining its visual medium.
    const peopleRequested = /\b(?:show|use|include|feature|film|want|need)\s+(?:(?:some|actual|fictional|two|three|\d+)\s+)*$/i.test(prefix);
    if (nativeMedium && /^real\s+(?:humans?|people)$/i.test(match[0]) && !peopleRequested) continue;
    return true;
  }
  return false;
}

// Only bare, coordinated production elements share a prohibition. Do not
// extend "no loud music" to all music, or treat a story mentioning a negative
// list as an instruction. clausePrefix also resets at "but add" / "and use".
const SPEECH_ITEM = 'dialogue|narration|narrator|speech|speaking|spoken\\s+words?|voice[\\s-]?over|lyrics|singing|vocals?|(?:whispered\\s+)?voices|vocal\\s+samples';
const AUDIO_LIST_ITEM = `(?:(?:any|additional|extra)\\s+)?(?:on[\\s-]screen\\s+(?:copy|text|captions?)|copy|text|captions?|subtitles?|titles?|logos?|people|humans?|characters?|photos?|photographs?|images?|footage|claims|tray|plate|hands|cuts|transitions|opener|outro|${SPEECH_ITEM}|music|soundtrack|score|instrumental(?:\\s+bed)?|BGM|sound\\s+effects?|SFX)`;
const NEGATIVE_LIST_PREFIX = new RegExp(`^\\s*(?:please\\s+)?(?:(?:no|without|avoid|exclude)|(?:do\\s+not|don['’]t)\\s+(?:add|include|use))\\s+(?:${AUDIO_LIST_ITEM}(?:\\s*,\\s*(?:(?:and|or|nor)\\s+)?|\\s+(?:and|or|nor)\\s+))+(?:(?:any|additional|extra)\\s+)?$`, 'i');

function prohibitedInList(text: string, subjects: string): boolean {
  const pattern = new RegExp(`\\b(?:${subjects})\\b(?=\\s*(?:[,;.!?\\n]|$|\\b(?:and|or|nor)\\b))`, 'gi');
  for (const match of text.matchAll(pattern)) {
    if (NEGATIVE_LIST_PREFIX.test(clausePrefix(text, match.index ?? 0))) return true;
  }
  return false;
}

/** Browser-safe audio policy shared by brief serialization and scene planning. */
export function classifyAudioIntent(brief: string): AudioIntent {
  const text = instructionText(brief);
  // "The signal went silent" and "a silent room" describe the story. Silence
  // applies to the output only when requested as an audio/film directive.
  const silent = positiveMatch(text, /(?:^|[.!?;\n])\s*(?:please\s+)?silent\b(?=\s*(?:[,;.!?\n]|$))|\bsilent\s+(?:(?:generated|native)\s+)?(?:film|video|sequence|short|title|output)\b|\b(?:make|keep|render)\s+(?:it|(?:the|this)\s+(?:film|video|audio|output))\s+(?:completely\s+)?silent\b|\b(?:full|complete|total)\s+silence\b|\b(?:film|video|output)\s+in\s+silence\b/i)
    || /\b(?:no|without)\s+(?:any\s+)?(?:audio|sound)\b(?!\s+(?:effects?|design)\b)/i.test(text);
  const nativeSpeech = positiveMatch(text, /\b(?:dialogue|speech|speak(?:s|ing)?|talk(?:s|ing)?|conversations?)\b/i);
  // A character may speak while a separate narrator is explicitly forbidden.
  // Keep legacy "no narration" => wordless only when no native speech is asked for.
  const prohibitedSpeech = nativeSpeech ? 'dialogue|speech|speaking|spoken\\s+words?|lyrics|singing|vocals?|(?:whispered\\s+)?voices|vocal\\s+samples' : SPEECH_ITEM;
  const wordless = silent || positiveMatch(text, /\bwordless\b/i)
    || new RegExp(`\\b(?:no|without)\\s+(?:any\\s+)?(?:${prohibitedSpeech})\\b`, 'i').test(text)
    || prohibitedInList(text, prohibitedSpeech);
  const musicProhibited = silent || /\b(?:no|without)\s+(?:any\s+)?(?:music|soundtrack|score|instrumental(?:\s+bed)?|BGM)\b/i.test(text)
    || /\bno\s+(?:dialogue|narration|speech)(?:\s*,\s*(?:dialogue|narration|speech))*\s*(?:,|or|and)\s*music\b/i.test(text)
    || prohibitedInList(text, 'music|soundtrack|score|instrumental(?:\\s+bed)?|BGM');
  const kokoroNarration = [...positiveMatches(text, /\bKokoro\b/i)].some(({ match }) => {
    const clause = text.slice(0, match.index).split(/[.!?;\n]/).at(-1) + text.slice(match.index).split(/[.!?;\n]/)[0];
    return !/\b(?:conditioning|voice\s+reference|native\s+(?:speech|dialogue))\b/i.test(clause);
  });
  const narrationRequested = !wordless && (positiveMatch(text, /\b(?:narrat(?:e|es|ed|ing|ion|or)|voice[\s-]?over|spoken\s+(?:script|narration))\b/i) || kokoroNarration);
  const speechRequested = !wordless && (narrationRequested || positiveMatch(text, /\b(?:dialogue|speech|spoken|speak(?:s|ing)?|talk(?:s|ing)?|conversations?)\b/i));
  const musicRequested = !musicProhibited && positiveMatch(text, /\b(?:music|soundtrack|score|instrumental(?:\s+bed)?|theme\s+song|BGM)\b/i);
  return { silent, wordless, speechRequested, narrationRequested, musicRequested, musicProhibited };
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const DURATION_NUMBER = '(?:\\d{1,3}(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)';

function durationNumber(value: string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NUMBER_WORDS[value.toLowerCase()] ?? Number.NaN;
}

/** Prefer output-runtime instructions over durations quoted in source data. */
function requestedDuration(brief: string): { requestedSeconds: number | null; exactDuration: boolean } {
  const text = brief.replace(/\b(exactly|precisely|exact)(?=\d)/gi, '$1 ');
  const minutes = '(?:minutes?|mins?|m)';
  const seconds = '(?:seconds?|secs?|s)';
  const pattern = new RegExp(`\\b(${DURATION_NUMBER})[\\s-]*(?:(${minutes})(?:\\b|(?=\\d))(?:[\\s,-]*(?:and\\s+)?(${DURATION_NUMBER})[\\s-]*${seconds}\\b)?|(${seconds})\\b)`, 'gi');
  let chosen: { seconds: number; exact: boolean; score: number } | null = null;
  for (const match of text.matchAll(pattern)) {
    const prefix = text.slice(0, match.index).split(/[!?;\n]|\.(?!\d)/).at(-1) ?? '';
    const suffix = text.slice(match.index + match[0].length);
    const exact = /\b(?:exactly|precisely|exact)\s+(?:(?:at|of)\s+)?$/i.test(prefix);
    const outputPrefix = /\b(?:runtime|run\s*time|duration|length)\s*(?::|=|is|of|should\s+be|must\s+be)?\s*(?:(?:exactly|precisely|exact|about|around|approximately|at|of)\s+)*$/i.test(prefix)
      || /\b(?:make|create|produce|render|lasts?|lasting|runs?\s+for)\s+(?:(?:it|a|an|the|film|video|output|exactly|precisely|about|around)\s+)*$/i.test(prefix)
      || /\b(?:film|video|output)\s*(?::|=|is|of|should\s+be|must\s+be|will\s+be)\s*(?:(?:exactly|precisely|about|around)\s+)*$/i.test(prefix);
    const outputSuffix = /^(?:[\s-]+(?:of\s+)?(?:a\s+|an\s+)?(?:(?:landscape|portrait|native|animated|short|live[\s-]*action|generated|motion|data)\s+)*(?:film|video|story|graphics|explainer|teaser|bumper|short)\b|\s+(?:long|in\s+total)\b)/i.test(suffix);
    const score = (outputPrefix || outputSuffix ? 4 : 0) + (exact ? 2 : 0);
    const isMinutes = Boolean(match[2]);
    const value = durationNumber(match[1]) * (isMinutes ? 60 : 1) + (isMinutes && match[3] ? durationNumber(match[3]) : 0);
    if (!chosen || score > chosen.score) chosen = { seconds: isMinutes ? Math.round(value) : value, exact, score };
  }
  return { requestedSeconds: chosen?.seconds ?? null, exactDuration: chosen?.exact ?? false };
}

/**
 * Rule-first classification: explicit medium wording wins over a preset fallback.
 * With no fallback, the original brief-only inference remains unchanged.
 */
export function classifyProductionIntent(brief: string, fallbackKind?: ProductionIntentKind): ProductionIntent {
  const text = instructionText(brief);
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
  const audioIntent = classifyAudioIntent(text);
  const explicitRemotionCopy = positiveMatch(text, /\b(?:(?:Remotion|native)(?:\s+[\w-]+){0,3}\s+(?:titles?|title\s+cards?|end\s+cards?|headlines?|copy|captions?|credits?|overlays?|lower[\s-]+thirds?)|(?:titles?|title\s+cards?|end\s+cards?|headlines?|copy|captions?|credits?|overlays?|lower[\s-]+thirds?)\s+(?:in|with|using)\s+Remotion|required\s+copy)\b/i);
  // Subtitles, extra words and lettering baked into generated footage are
  // separate from authored native titles/credits. Only a blanket text ban
  // overrides explicit overlay instructions.
  const allTextBan = /\b(?:no|without)\s+(?:(?:any|all)\s+)?(?:on[\s-]+screen\s+)?(?:text|copy)\b(?!\s+(?:in|on|within)\s+(?:the\s+)?(?:generated|AI|imagery|footage)\b)/i.test(text);
  const editorialText = text.replace(/\b(?:generated|AI[\s-]+generated)\s+(?:footage|imagery|images?|shots?)\s+(?:(?:must|should)\s+be\s+|is\s+)?text[\s-]+free\b|\btext[\s-]+free\s+(?:generated|AI[\s-]+generated)\s+(?:footage|imagery|images?|shots?)\b/gi, '');
  const noCaptions = allTextBan || (!explicitRemotionCopy && (/\b(?:no|without)\s+(?:captions?|headlines?|titles?|title\s+cards?|end\s+cards?|lower[\s-]+thirds?)\b/i.test(text)
    || prohibitedInList(text, 'captions?|headlines?|titles?|copy|text')
    || /\btext[\s-]+free\b/i.test(editorialText)));
  const requiresNarrationCues = /\bcue_phrases\b|narration[\s-]+(?:linked|anchored)\s+(?:motion|animation|cues?)|timed\s+(?:to|with)\s+(?:the\s+)?narration/i.test(text);
  // A photographic medium does not imply a human subject (food, wildlife,
  // products and landscapes use it too). Keep human-specific enforcement only
  // when the brief also positively requests people.
  const liveActionLook = requestsLiveActionLook(text);
  const humanSubject = positiveMatch(text, /\b(?:humans?|people|persons?|men|women|man|woman|adults?|children|child|boys?|girls?|actors?|actresses|performers?|bakers?|chefs?|dancers?|cyclists?|skateboarders?)\b/i);
  const liveActionHumans = liveActionLook && humanSubject;
  const { requestedSeconds, exactDuration } = requestedDuration(text);
  const strongEvidence = [generatedShots, recurringPhysicalCharacters, cinematicCameraOrAction, nativeSoundscape]
    .filter(Boolean).length;
  // An explicit generated film may use Remotion overlays and motion graphics.
  // Procedural wording only wins when the brief is not explicitly a generated film.
  // A selected preset supplies a fallback, never permission to override explicit wording.
  const generatedFilm = explicitGeneratedFilm || (!proceduralConstraint && (
    fallbackKind === 'motion-graphics' ? false
      : generatedShots || strongEvidence >= 2 || fallbackKind === 'generated-film'
  ));
  const structuredVisual = noCaptions ? null
    : positiveMatch(text, /\b(?:mechanisms?|how\s+(?:a|an|the)\s+[\w\s-]+works?|sketch(?:book)?|draw[\s-]+on)\b/i) ? 'sketch'
      : positiveMatch(text, /\b(?:technical[\s-]+flow|workflows?|process(?:es)?|architecture|cause[\s-]+and[\s-]+effect|pipelines?)\b/i) ? 'technical-flow'
        : positiveMatch(text, /\b(?:before\s*(?:\/|and)\s*after|transformations?|compare|comparison|versus|vs\.?)\b/i) ? 'morph'
          : positiveMatch(text, /\b(?:evidence|screenshots?|product\s+demos?|source\s+claims?|focus\s+windows?)\b/i) ? 'focus'
            : null;
  return {
    kind: generatedFilm ? 'generated-film' : 'motion-graphics',
    generatedFilm,
    ...audioIntent,
    noCaptions,
    requiresNarrationCues,
    liveActionHumans,
    bookends: generatedFilm && !noCaptions,
    structuredVisual,
    requestedSeconds,
    exactDuration,
    evidence: { generatedShots, recurringPhysicalCharacters, cinematicCameraOrAction, nativeSoundscape, proceduralConstraint },
  };
}
