/**
 * R2 (research §2.3–2.4): the brief schema, the question bank and a deterministic
 * extractor.
 *
 * Plan mode fills as much of the brief as the prompt allows, then asks at most
 * three questions (each with tappable chips and a "Decide for me" option) before
 * anything is built. The extractor never calls a model: it is pure text work so
 * the chip flow is testable and costs nothing.
 *
 * The three shapes are separate on purpose:
 *   - `BriefDraft`  — what the extractor knows; every field may be absent.
 *   - `Question`    — one missing field, with chips and a default.
 *   - `Brief`       — a completed, schema-validated brief (what gets built).
 */
import { z } from 'zod';

export const BRIEF_GOALS = ['launch', 'explain', 'teach', 'pitch', 'recap'] as const;
export const BRIEF_MODES = ['plan', 'express'] as const;
export const BRIEF_LANGUAGES = ['en', 'fr'] as const;
export const BRIEF_ASPECTS = ['16:9', '9:16', '1:1'] as const;
/** C-pres: presenter coverage is a brief-level choice, off by default (Kyle, Oct 18). */
export const BRIEF_PRESENTERS = ['none', 'bookends', 'all'] as const;

/** The six bundled looks (research §2.2 step 4). Thumbnails land later (CPU/SVG). */
export const STYLE_PRESETS = ['clay', 'glass', 'editorial-flat', 'isometric-tech', 'paper-cut', 'cinematic-dark'] as const;
export type StylePreset = (typeof STYLE_PRESETS)[number];

/** Default palette/font per look until the brand kit (B1) overrides them. */
export const STYLE_PRESET_DEFAULTS: Record<StylePreset, { palette: string[]; font: string; attributes: string }> = {
  clay: { palette: ['#f4e9dd', '#c98a6b', '#6d4b3a', '#2b2320'], font: 'Inter', attributes: 'rounded matte forms, soft studio light' },
  glass: { palette: ['#0b1020', '#4f6bff', '#9fe8ff', '#eef3ff'], font: 'Inter', attributes: 'frosted glass panels, cool rim light' },
  'editorial-flat': { palette: ['#f7f5f0', '#1a1a1a', '#e6482f', '#5b6cff'], font: 'Inter', attributes: 'flat editorial colour blocks, generous margins' },
  'isometric-tech': { palette: ['#0d1117', '#2d6cff', '#31d0aa', '#e6edf3'], font: 'Inter', attributes: 'isometric geometry, thin technical strokes' },
  'paper-cut': { palette: ['#fdf6e3', '#e0b13c', '#3f7d5a', '#2d2a26'], font: 'Inter', attributes: 'layered paper-cut shapes, crisp drop shadows' },
  'cinematic-dark': { palette: ['#05070d', '#1b2440', '#6d8cff', '#f4f6fb'], font: 'Inter', attributes: 'cinematic dark grade, soft volumetric light' },
};

export const TONE_WORDS = [
  'calm', 'confident', 'playful', 'bold', 'warm', 'energetic', 'authoritative', 'clear',
  'friendly', 'serious', 'inspiring', 'minimal', 'premium', 'human', 'direct', 'optimistic',
] as const;

export const briefSchema = z.object({
  goal: z.enum(BRIEF_GOALS),
  key_message: z.string().min(1).max(200),
  audience: z.object({
    who: z.string().min(1).max(120),
    knows: z.string().max(200).optional(),
    language: z.enum(BRIEF_LANGUAGES),
  }),
  cta: z.string().min(1).max(200).optional(),
  length_s: z.number().positive().max(600).optional(),
  aspect: z.enum(BRIEF_ASPECTS),
  /** The AI presenter: none (default), bookends (intro + outro), or all scenes. */
  presenter: z.enum(BRIEF_PRESENTERS).default('none'),
  tone: z.array(z.string().min(1)).length(3),
  style: z.object({
    preset: z.enum(STYLE_PRESETS),
    palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
    font: z.string().optional(),
    references: z.array(z.string()).optional(),
    attributes: z.string().optional(),
  }),
  voice: z.object({
    engine: z.enum(['kokoro', 'qwen3-tts', 'voxcpm2', 'chatterbox']),
    persona: z.string().max(200).optional(),
    lang: z.enum(BRIEF_LANGUAGES),
  }),
  music: z.object({ mood: z.string().max(120).optional(), enabled: z.boolean() }),
  must_include: z.array(z.string()),
  avoid: z.array(z.string()),
  facts: z.array(z.object({ claim: z.string().min(1), source: z.string().min(1) })),
  mode: z.enum(BRIEF_MODES),
  /** Question ids the agent answered itself ("Decide for me" or a skipped ask). */
  decided_by_agent: z.array(z.string()),
});
export type Brief = z.infer<typeof briefSchema>;

export interface AudienceDraft { who?: string; knows?: string; language?: (typeof BRIEF_LANGUAGES)[number] }
export interface StyleDraft {
  preset?: StylePreset;
  palette?: string[];
  font?: string;
  references?: string[];
  attributes?: string;
}
export interface VoiceDraft { engine?: Brief['voice']['engine']; persona?: string; lang?: (typeof BRIEF_LANGUAGES)[number] }
export interface MusicDraft { mood?: string; enabled?: boolean }

/** What the extractor produced; missing fields are simply absent. */
export interface BriefDraft {
  goal?: Brief['goal'];
  key_message?: string;
  audience?: AudienceDraft;
  cta?: string;
  length_s?: number;
  aspect?: Brief['aspect'];
  presenter?: Brief['presenter'];
  tone?: string[];
  style?: StyleDraft;
  voice?: VoiceDraft;
  music?: MusicDraft;
  must_include?: string[];
  avoid?: string[];
  facts?: { claim: string; source: string }[];
  mode?: Brief['mode'];
  decided_by_agent?: string[];
  source_prompt?: string;
}

export interface Question {
  /** Stable id; also the `decided_by_agent` entry when answered by the agent. */
  id: string;
  field: string;
  prompt: string;
  chips: string[];
  /** What the agent picks when the user taps "Decide for me". */
  decide: string;
}

/**
 * Question bank (research §2.4). The ordering *is* the priority: only the first
 * three unanswered questions are ever asked.
 */
export const QUESTION_BANK: Question[] = [
  {
    id: 'key_message',
    field: 'key_message',
    prompt: 'In one sentence, what should viewers remember?',
    chips: [],
    decide: 'One clear idea the viewer can repeat after one watch.',
  },
  {
    id: 'audience',
    field: 'audience.who',
    prompt: 'Who is this for?',
    chips: ['customers', 'developers', 'investors', 'students', 'internal team'],
    decide: 'developers',
  },
  {
    id: 'length',
    field: 'length_s',
    prompt: 'How long, and where will it play?',
    chips: ['30 s social', '45-60 s landing page', '90 s talk opener'],
    decide: '45-60 s landing page',
  },
  {
    id: 'look',
    field: 'style.preset',
    prompt: 'Pick a look.',
    chips: [...STYLE_PRESETS],
    decide: 'cinematic-dark',
  },
  {
    id: 'voice',
    field: 'voice.persona',
    prompt: 'Narration?',
    chips: ['warm narrator', 'energetic narrator', 'authoritative narrator', 'none'],
    decide: 'warm narrator',
  },
  {
    id: 'data',
    field: 'facts',
    prompt: 'Do you have the real numbers?',
    chips: ['paste or upload CSV', 'use visible placeholders'],
    decide: 'use visible placeholders',
  },
  {
    id: 'cta',
    field: 'cta',
    prompt: 'What should they do at the end?',
    chips: ['visit the website', 'sign up', 'get in touch', 'none'],
    decide: 'none',
  },
  {
    id: 'presenter',
    field: 'presenter',
    prompt: 'Should an AI presenter host it?',
    chips: ['none', 'intro + outro', 'all scenes'],
    decide: 'none',
  },
];

/** Example prompts offered in the composer (research §2.2 step 1). */
export const BRIEF_EXAMPLE_PROMPTS = [
  'A 45 second launch video for Comfyrizz, for developers, calm and confident, ending with a star-the-repo CTA.',
  'Explain how our CPU render pipeline works to customers in 60 seconds, bold and clear.',
  'A 30 second pitch for investors with three stats and our logo at the end.',
];

const GOAL_PATTERNS: [Brief['goal'], RegExp][] = [
  ['launch', /\b(launch|ship|announce|release|demo|lancement|lancer)\b/i],
  ['explain', /\b(explain|explique|expliquer|how .* works|walk ?through|overview)\b/i],
  ['teach', /\b(teach|tutorial|tutoriel|learn|apprendre|course|lesson|onboard)\b/i],
  ['pitch', /\b(pitch|investor|raise|funding|seed round)\b/i],
  ['recap', /\b(recap|summary|r[eé]cap|wrap ?up|retro|quarter)\b/i],
];

const AUDIENCE_WORDS = ['developers', 'customers', 'investors', 'students', 'internal team', 'designers', 'founders'];

function firstSentence(text: string): string | undefined {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  const match = /^(.*?[.!?])(\s|$)/.exec(trimmed);
  return (match ? match[1] : trimmed).trim().slice(0, 200);
}

function detectGoal(text: string): Brief['goal'] | undefined {
  for (const [goal, pattern] of GOAL_PATTERNS) if (pattern.test(text)) return goal;
  return undefined;
}

function detectAudience(text: string): string | undefined {
  const forMatch = /\bfor ([a-z][a-z0-9 +\-]{2,40}?)(?:[,.;]|\bin \d|\bwith\b|\bending\b|\bthat\b|\b$)/i.exec(text);
  if (forMatch) return forMatch[1].trim().toLowerCase();
  const lower = text.toLowerCase();
  return AUDIENCE_WORDS.find(word => lower.includes(word));
}

function detectLengthSeconds(text: string): number | undefined {
  const seconds = /\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i.exec(text);
  if (seconds) return Number(seconds[1]);
  const minutes = /\b(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes)\b/i.exec(text);
  if (minutes) return Number(minutes[1]) * 60;
  return undefined;
}

function detectAspect(text: string): Brief['aspect'] | undefined {
  if (/\b(vertical|9:16|tiktok|reel|shorts|portrait)\b/i.test(text)) return '9:16';
  if (/\b(square|1:1)\b/i.test(text)) return '1:1';
  if (/\b(16:9|landscape|widescreen|youtube)\b/i.test(text)) return '16:9';
  return undefined;
}

/** C-pres: an explicit presenter ask. No mention means off (the default). */
function detectPresenter(text: string): Brief['presenter'] | undefined {
  if (/\b(no|without|skip)\s+(?:an?\s+)?(?:ai\s+)?(?:presenter|talking head|avatar|host|face to camera)\b/i.test(text)) return 'none';
  const wants = /\b(presenter|talking head|avatar|face to camera|on camera|host(?:ed)?\s+by|intro and outro presenter)\b/i.test(text);
  if (!wants) return undefined;
  if (/\b(every|all|whole|entire)\s+(?:scene|video|clip)/i.test(text)) return 'all';
  return 'bookends';
}

function detectTone(text: string): string[] {
  const lower = text.toLowerCase();
  const found = TONE_WORDS.filter(word => new RegExp(`\\b${word}\\b`, 'i').test(lower));
  return [...found];
}

function detectList(text: string, keyword: string): string[] {
  const match = new RegExp(`\\b${keyword}\\s*:?\\s*([^.;]+)`, 'i').exec(text);
  if (!match) return [];
  return match[1].split(',').map(part => part.trim()).filter(Boolean);
}

export interface ExtractBriefOptions {
  mode?: Brief['mode'];
  /** Extra attachment text (notes, PDF/MD text, a pasted CSV header) appended for detection only. */
  attachments?: string;
  decidedByAgent?: string[];
  sourcePrompt?: string;
}

/**
 * Deterministic extraction: goal, key message, audience, length, aspect, tone,
 * CTA and must-include/avoid. Never invents facts; anything absent stays absent
 * so `missingQuestions` can ask for it.
 */
export function extractBrief(prompt: string, options: ExtractBriefOptions = {}): BriefDraft {
  const text = `${prompt}\n${options.attachments ?? ''}`.trim();
  const draft: BriefDraft = { mode: options.mode ?? 'plan', decided_by_agent: [...(options.decidedByAgent ?? [])], source_prompt: options.sourcePrompt ?? prompt };
  const decided = draft.decided_by_agent as string[];

  const goal = detectGoal(text);
  if (goal) draft.goal = goal;
  else { draft.goal = 'launch'; decided.push('goal'); }

  const message = firstSentence(prompt);
  if (message) draft.key_message = message;

  const who = detectAudience(prompt);
  if (who) draft.audience = { who };

  const length = detectLengthSeconds(prompt);
  if (length !== undefined) draft.length_s = length;

  const aspect = detectAspect(prompt);
  if (aspect) draft.aspect = aspect;
  else { draft.aspect = '16:9'; decided.push('aspect'); }

  // C-pres: the presenter is opt-in; detect an explicit ask and otherwise leave it off.
  const presenter = detectPresenter(text);
  draft.presenter = presenter ?? 'none';
  if (!presenter) decided.push('presenter');

  const tone = detectTone(prompt);
  const toneDefaults = ['clear', 'confident', 'calm'];
  for (const word of toneDefaults) {
    if (tone.length >= 3) break;
    if (!tone.includes(word)) tone.push(word);
  }
  draft.tone = tone.slice(0, 3);
  if (draft.tone.some(word => !detectTone(prompt).includes(word))) decided.push('tone');

  const language = /\b(fran[çc]ais|french|en fran[çc]ais)\b/i.test(text) ? 'fr' : 'en';
  draft.audience = { ...(draft.audience ?? {}), language };
  if (draft.audience.who === undefined) delete draft.audience.who;

  const mustInclude = detectList(text, 'must[- ]include');
  const avoid = detectList(text, 'avoid');
  if (mustInclude.length) draft.must_include = mustInclude;
  if (avoid.length) draft.avoid = avoid;

  const cta = /\b(star[- _]the[- _]repo|star us|book a demo|sign up|join the (?:beta|waitlist)|subscribe)\b/i.exec(text);
  if (cta) draft.cta = cta[1].replace(/[-_]+/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();

  const wantsNarration = !/\b(no|without)\s+(?:narration|voice ?over|vo)\b/i.test(text);
  draft.voice = { engine: 'kokoro', lang: language };
  decided.push('voice');
  if (wantsNarration) draft.voice.persona = 'warm narrator, measured pace';
  draft.music = { enabled: /\b(music|soundtrack|score|music bed)\b/i.test(text) };
  if (draft.music.enabled === false) decided.push('music');

  return draft;
}

/** The three drafted key-message options shown as chips (research §2.4 item 1). */
export function draftKeyMessages(prompt: string, count = 3): string[] {
  const sentences = prompt
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 8 && sentence.length <= 140)
    .slice(0, count);
  return sentences;
}

/** Unanswered questions, in priority order, capped at `max` (default 3). */
export function missingQuestions(draft: BriefDraft, max = 3, keyMessageOptions: string[] = []): Question[] {
  const answered = new Set(draft.decided_by_agent ?? []);
  const missing = QUESTION_BANK.filter(question => {
    if (answered.has(question.id)) return false;
    switch (question.id) {
      case 'key_message': return !draft.key_message;
      case 'audience': return !draft.audience?.who;
      case 'length': return draft.length_s === undefined;
      case 'look': return !draft.style?.preset;
      case 'voice': return !draft.voice?.persona;
      case 'data': return draft.facts === undefined && mentionsNumbers(draft);
      case 'cta': return !draft.cta;
      case 'presenter': return draft.presenter === undefined;
      default: return false;
    }
  });
  return missing.slice(0, max).map(question =>
    question.id === 'key_message' && keyMessageOptions.length > 0
      ? { ...question, chips: keyMessageOptions }
      : question,
  );
}

/** True when the draft's key message or original prompt mentions numbers/data. */
export function mentionsNumbers(draft: BriefDraft): boolean {
  const parts = [draft.key_message, draft.source_prompt].filter(Boolean).join(' ');
  const stripped = parts.replace(/\b\d+(?:\.\d+)?\s*-?\s*(?:s|sec|secs|second|seconds|min|mins|minute|minutes)\b/gi, '');
  return /\d|\b(numbers?|data|chart|graph|stats?|statistics|percent|metrics?|growth|revenue)\b|%/i.test(stripped);
}

export interface BriefDecisions {
  /** Question id -> the chosen chip / typed answer. `undefined` means "Decide for me". */
  [questionId: string]: string | number | undefined;
}

function parseLength(value: string | number | undefined, fallback: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? fallback);
  const range = /(\d+)\s*[-–]\s*(\d+)/.exec(text);
  if (range) return Number(range[2]);
  const number = /(\d+(?:\.\d+)?)/.exec(text);
  if (!number) return 45;
  return text.trim().startsWith(String(number[1])) && /min/i.test(text) ? Number(number[1]) * 60 : Number(number[1]);
}

/**
 * Apply the user's answers (or "Decide for me" defaults) to a draft. Returns a
 * new draft; unknown ids are ignored.
 */
export function applyDecisions(draft: BriefDraft, decisions: BriefDecisions): BriefDraft {
  const next: BriefDraft = structuredClone(draft);
  next.decided_by_agent = [...(next.decided_by_agent ?? [])];
  for (const question of QUESTION_BANK) {
    if (!(question.id in decisions)) continue;
    const raw = decisions[question.id];
    const value = raw === undefined || raw === '' ? question.decide : raw;
    switch (question.id) {
      case 'key_message':
        next.key_message = String(value).slice(0, 200);
        break;
      case 'audience':
        next.audience = { ...(next.audience ?? {}), who: String(value).toLowerCase(), language: next.audience?.language ?? 'en' };
        break;
      case 'length':
        next.length_s = parseLength(value, question.decide);
        break;
      case 'look': {
        const preset = (STYLE_PRESETS as readonly string[]).includes(String(value)) ? (value as StylePreset) : 'cinematic-dark';
        next.style = { ...(next.style ?? {}), preset };
        break;
      }
      case 'voice': {
        const none = /^none$/i.test(String(value));
        next.voice = { ...(next.voice ?? { engine: 'kokoro', lang: 'en' }), persona: none ? undefined : String(value) };
        if (none) delete next.voice.persona;
        break;
      }
      case 'data':
        next.facts = next.facts ?? [];
        break;
      case 'cta':
        if (/^none$/i.test(String(value))) delete next.cta;
        else next.cta = String(value);
        break;
      case 'presenter': {
        const text = String(value).toLowerCase();
        next.presenter = text.includes('all') ? 'all' : text.includes('intro') || text.includes('outro') || text.includes('bookend') ? 'bookends' : 'none';
        break;
      }
      default:
        break;
    }
    if (!next.decided_by_agent.includes(question.id)) next.decided_by_agent.push(question.id);
  }
  return next;
}

/** Fill the remaining defaults and validate; throws a `z.ZodError` when invalid. */
export function completeBrief(draft: BriefDraft, style?: Partial<StyleDraft>): Brief {
  const mergedStyle: StyleDraft = { ...draft.style, ...style };
  const preset: StylePreset = mergedStyle.preset ?? 'cinematic-dark';
  const presetDefaults = STYLE_PRESET_DEFAULTS[preset];
  const language = draft.audience?.language ?? 'en';
  const tone = (draft.tone && draft.tone.length >= 3 ? draft.tone.slice(0, 3) : [...(draft.tone ?? []), 'clear', 'confident', 'calm']).slice(0, 3);
  return briefSchema.parse({
    goal: draft.goal ?? 'launch',
    key_message: draft.key_message ?? 'One clear idea the viewer can repeat after one watch.',
    audience: { who: draft.audience?.who ?? 'developers', ...(draft.audience?.knows ? { knows: draft.audience.knows } : {}), language },
    ...(draft.cta ? { cta: draft.cta } : {}),
    ...(draft.length_s !== undefined ? { length_s: draft.length_s } : {}),
    aspect: draft.aspect ?? '16:9',
    presenter: draft.presenter ?? 'none',
    tone,
    style: {
      preset,
      palette: mergedStyle.palette ?? presetDefaults.palette,
      font: mergedStyle.font ?? presetDefaults.font,
      ...(mergedStyle.references ? { references: mergedStyle.references } : {}),
      attributes: mergedStyle.attributes ?? presetDefaults.attributes,
    },
    voice: { engine: draft.voice?.engine ?? 'kokoro', ...(draft.voice?.persona ? { persona: draft.voice.persona } : {}), lang: draft.voice?.lang ?? language },
    music: { ...(draft.music?.mood ? { mood: draft.music.mood } : {}), enabled: draft.music?.enabled ?? false },
    must_include: draft.must_include ?? [],
    avoid: draft.avoid ?? [],
    facts: draft.facts ?? [],
    mode: draft.mode ?? 'plan',
    decided_by_agent: draft.decided_by_agent ?? [],
  });
}

/** English ≈ 2.5 words/s; French is a little slower per the report. */
export function secondsPerWord(language: (typeof BRIEF_LANGUAGES)[number] = 'en'): number {
  return language === 'fr' ? 2.1 : 2.5;
}

/** Estimated spoken seconds for a narration line (research §2.2 step 5). */
export function estimateNarrationSeconds(text: string, language: (typeof BRIEF_LANGUAGES)[number] = 'en'): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Number((words / secondsPerWord(language)).toFixed(2));
}

/** A goal's opener line; keeps the hook in the brief's own tone without a model. */
const GOAL_OPENERS: Record<Brief['goal'], string> = {
  launch: "Here's what's new.",
  explain: "Here's how it works.",
  teach: "Here's how to do it.",
  pitch: "Here's the idea.",
  recap: "Here's the recap.",
};

/** One script beat; `id` matches the package scene the build will reuse. */
export interface OutlineBeat {
  id: string;
  role: 'hook' | 'point' | 'proof' | 'cta';
  layout: 'title' | 'hero' | 'stat' | 'list';
  headline: string;
  narration: string;
  /** Estimated spoken seconds for `narration`. */
  seconds: number;
  /** True when the beat shows a visible placeholder because a fact is missing. */
  placeholder: boolean;
}

/** The script-first outline shown in the editable Brief card (research §2.2 step 5). */
export interface Outline {
  beats: OutlineBeat[];
  /** Sum of the per-beat narration estimates. */
  narrationSeconds: number;
  /** Seconds the brief asked for, or the estimate when it did not say. */
  targetSeconds: number;
  /** On-screen estimate: narration plus one gap per beat. */
  estimatedSeconds: number;
  fit: 'short' | 'on-target' | 'long';
  notes: string[];
  style: Brief['style'];
  voice: Brief['voice'];
  music: Brief['music'];
  language: Brief['audience']['language'];
}

export interface OutlineOptions {
  /** Extra seconds per beat for the transition gap (default 0.4 s). */
  gapSeconds?: number;
  /** Maximum beats to emit (default 4: hook, point, proof, cta). */
  maxBeats?: number;
}

function trimHeadline(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > 24 ? cut.slice(0, space) : cut).trim()}…`;
}

/**
 * Turn a completed brief into a script-first outline with estimated seconds. Pure
 * and deterministic: it never invents facts, and a missing CTA or dataset becomes
 * an honest note plus a visible placeholder instead of made-up copy.
 */
export function buildOutline(brief: Brief, options: OutlineOptions = {}): Outline {
  const language = brief.audience.language;
  const gapSeconds = options.gapSeconds ?? 0.4;
  const maxBeats = Math.max(3, options.maxBeats ?? 4);
  const who = brief.audience.who;
  const keyMessage = brief.key_message.replace(/\s+/g, ' ').trim();
  const beats: OutlineBeat[] = [];

  const hook = `${GOAL_OPENERS[brief.goal]} ${keyMessage} Made for ${who}.`;
  beats.push({
    id: 's_title',
    role: 'hook',
    layout: 'title',
    headline: trimHeadline(keyMessage),
    narration: hook,
    seconds: estimateNarrationSeconds(hook, language),
    placeholder: false,
  });

  const points = brief.must_include.length > 0 ? `Along the way we cover ${brief.must_include.join(', ')}.` : `It comes down to one thing: ${keyMessage}`;
  beats.push({
    id: 's_point',
    role: 'point',
    layout: brief.must_include.length > 0 ? 'list' : 'hero',
    headline: trimHeadline(brief.must_include[0] ?? keyMessage),
    narration: points,
    seconds: estimateNarrationSeconds(points, language),
    placeholder: false,
  });

  const fact = brief.facts[0];
  const proof = fact ? `And the proof: ${fact.claim} (${fact.source}).` : 'The numbers go here once the brief has a source.';
  beats.push({
    id: 's_proof',
    role: 'proof',
    layout: 'stat',
    headline: trimHeadline(fact ? fact.claim : 'Add a source for the numbers'),
    narration: proof,
    seconds: estimateNarrationSeconds(proof, language),
    placeholder: !fact,
  });

  if (maxBeats >= 4) {
    const ctaLine = brief.cta ? `If that sounds useful, ${brief.cta}.` : 'That is the whole idea.';
    beats.push({
      id: 's_outro',
      role: 'cta',
      layout: 'title',
      headline: trimHeadline(brief.cta ?? 'Thanks for watching'),
      narration: ctaLine,
      seconds: estimateNarrationSeconds(ctaLine, language),
      placeholder: false,
    });
  }

  const narrationSeconds = Number(beats.reduce((sum, beat) => sum + beat.seconds, 0).toFixed(2));
  const estimatedSeconds = Number((narrationSeconds + gapSeconds * beats.length).toFixed(2));
  const targetSeconds = brief.length_s ?? estimatedSeconds;
  const lower = targetSeconds * 0.85;
  const upper = targetSeconds * 1.15;
  const fit: Outline['fit'] = estimatedSeconds < lower ? 'short' : estimatedSeconds > upper ? 'long' : 'on-target';

  const notes = [`Look: ${brief.style.preset} (${(brief.style.palette ?? []).join(' ')}${brief.style.font ? ` on ${brief.style.font}` : ''}).`];
  if (brief.voice.persona) notes.push(`Voice: ${brief.voice.persona} (${brief.voice.lang}).`);
  else notes.push('No narration in the brief; the beats are on-screen text only.');
  if (!brief.cta) notes.push('No CTA in the brief; the outro just closes.');
  if (brief.avoid.length > 0) notes.push(`Avoid: ${brief.avoid.join(', ')}.`);
  if (!brief.facts.length) notes.push('No source facts; the proof beat shows a visible placeholder.');
  if (brief.presenter !== 'none') notes.push(`Presenter: ${brief.presenter === 'all' ? 'every scene' : 'intro and outro'} (opt-in; clips are planned, not run).`);
  if (fit === 'short') notes.push(`About ${(targetSeconds - estimatedSeconds).toFixed(1)} s of headroom left; add a beat or slow the pace.`);
  if (fit === 'long') notes.push(`About ${(estimatedSeconds - targetSeconds).toFixed(1)} s over; trim the point or drop the proof.`);

  return {
    beats,
    narrationSeconds,
    targetSeconds,
    estimatedSeconds,
    fit,
    notes,
    style: brief.style,
    voice: brief.voice,
    music: brief.music,
    language,
  };
}
