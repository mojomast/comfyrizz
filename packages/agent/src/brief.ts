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
import {
  FIELD_PROVENANCE,
  isStatisticClaim,
  type FieldProvenance,
} from './evidence.js';

export { FIELD_PROVENANCE };
export type { FieldProvenance };

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
    /** True when the user asked for an on-screen-only brief. */
    silent: z.boolean().optional(),
  }),
  music: z.object({ mood: z.string().max(120).optional(), enabled: z.boolean() }),
  must_include: z.array(z.string()),
  avoid: z.array(z.string()),
  facts: z.array(z.object({
    claim: z.string().min(1),
    source: z.string().min(1),
    excerpt: z.string().min(1).optional(),
    date: z.string().min(1).optional(),
    qualification: z.string().min(1).optional(),
  })),
  mode: z.enum(BRIEF_MODES),
  /** Question ids answered in the chip flow; `field_provenance` says who chose. */
  decided_by_agent: z.array(z.string()),
  /** Who chose each field: the user, an inference, a default, or unresolved. */
  field_provenance: z.record(z.enum(FIELD_PROVENANCE)).optional(),
  /** The original prompt, kept so scaffolds can stay on topic. */
  source_prompt: z.string().optional(),
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
export interface VoiceDraft { engine?: Brief['voice']['engine']; persona?: string; lang?: (typeof BRIEF_LANGUAGES)[number]; silent?: boolean }
export interface MusicDraft { mood?: string; enabled?: boolean }
export type BriefFieldProvenance = Partial<Record<string, FieldProvenance>>;

/** What the extractor produced; missing fields are simply absent. */
export interface BriefFact {
  claim: string;
  source: string;
  excerpt?: string;
  date?: string;
  qualification?: string;
}

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
  facts?: BriefFact[];
  mode?: Brief['mode'];
  decided_by_agent?: string[];
  source_prompt?: string;
  field_provenance?: BriefFieldProvenance;
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
  const declared = /\bAspect\s*:\s*(16:9|9:16|1:1)(?!\d)/i.exec(text);
  if (declared) return declared[1] as Brief['aspect'];
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

const STYLE_PATTERNS: [StylePreset, RegExp][] = [
  ['paper-cut', /\bpaper[- ]?cut\b/i],
  ['editorial-flat', /\beditorial(?:[- ]flat)?\b/i],
  ['isometric-tech', /\bisometric(?:[- ]tech)?\b/i],
  ['cinematic-dark', /\bcinematic(?:[- ]dark)?\b|\bdark\s+cinematic\b/i],
  ['glass', /\bglass(?:morphism)?\b/i],
  ['clay', /\bclay(?:mation)?\b/i],
];

function detectStylePreset(text: string): StylePreset | undefined {
  for (const [preset, pattern] of STYLE_PATTERNS) if (pattern.test(text)) return preset;
  return undefined;
}

interface VoiceChoice { persona?: string; silent: boolean; explicit: boolean }

function detectVoiceChoice(text: string): VoiceChoice {
  const silent = /\b(?:no|without|skip)\s+(?:narration|voice ?over|voice|speech|audio)\b|\bsilent\b|\btext[- ]only\b|\bcaptions?[- ]only\b|\bon[- ]screen text only\b/i.test(text);
  if (silent) return { silent: true, explicit: true };
  if (/\b(authoritative|authority|documentary|newsreader|gravitas)\b/i.test(text)) {
    return { persona: 'authoritative narrator, measured pace', silent: false, explicit: true };
  }
  if (/\b(energetic|upbeat|high[- ]energy)\b/i.test(text)) {
    return { persona: 'energetic narrator', silent: false, explicit: true };
  }
  if (/\b(warm|friendly|conversational)\b/i.test(text)) {
    return { persona: 'warm narrator, measured pace', silent: false, explicit: true };
  }
  if (/\b(calm|measured|soothing)\s+(?:narrator|voice)\b/i.test(text)) {
    return { persona: 'calm narrator, measured pace', silent: false, explicit: true };
  }
  return { silent: false, explicit: false };
}

interface LanguageChoice { language: (typeof BRIEF_LANGUAGES)[number]; explicit: boolean }

function detectLanguage(text: string): LanguageChoice {
  if (/\b(fran[çc]ais|french|en fran[çc]ais)\b/i.test(text)) return { language: 'fr', explicit: true };
  if (/\b(english|en anglais)\b/i.test(text)) return { language: 'en', explicit: true };
  return { language: 'en', explicit: false };
}

function setProvenance(map: BriefFieldProvenance, field: string, provenance: FieldProvenance): void {
  map[field] = provenance;
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
  const draft: BriefDraft = {
    mode: options.mode ?? 'plan',
    decided_by_agent: [...(options.decidedByAgent ?? [])],
    source_prompt: options.sourcePrompt ?? prompt,
    field_provenance: {},
  };
  const decided = draft.decided_by_agent as string[];
  const provenance = draft.field_provenance as BriefFieldProvenance;

  const goal = detectGoal(text);
  if (goal) {
    draft.goal = goal;
    setProvenance(provenance, 'goal', 'inferred');
  } else {
    draft.goal = 'launch';
    decided.push('goal');
    setProvenance(provenance, 'goal', 'defaulted');
  }

  const message = firstSentence(prompt);
  if (message) {
    draft.key_message = message;
    setProvenance(provenance, 'key_message', 'explicit');
  } else {
    setProvenance(provenance, 'key_message', 'unresolved');
  }

  const who = detectAudience(prompt);
  if (who) {
    draft.audience = { who };
    setProvenance(provenance, 'audience.who', 'inferred');
  } else {
    setProvenance(provenance, 'audience.who', 'unresolved');
  }

  const length = detectLengthSeconds(prompt);
  if (length !== undefined) {
    draft.length_s = length;
    setProvenance(provenance, 'length_s', 'explicit');
  } else {
    setProvenance(provenance, 'length_s', 'unresolved');
  }

  const aspect = detectAspect(prompt);
  if (aspect) {
    draft.aspect = aspect;
    setProvenance(provenance, 'aspect', 'explicit');
  } else {
    draft.aspect = '16:9';
    decided.push('aspect');
    setProvenance(provenance, 'aspect', 'defaulted');
  }

  // C-pres: the presenter is opt-in; detect an explicit ask and otherwise leave it off.
  const presenter = detectPresenter(text);
  draft.presenter = presenter ?? 'none';
  setProvenance(provenance, 'presenter', presenter ? 'explicit' : 'defaulted');
  if (!presenter) decided.push('presenter');

  const detectedTone = detectTone(prompt);
  const tone = [...detectedTone];
  const toneDefaults = ['clear', 'confident', 'calm'];
  for (const word of toneDefaults) {
    if (tone.length >= 3) break;
    if (!tone.includes(word)) tone.push(word);
  }
  draft.tone = tone.slice(0, 3);
  setProvenance(provenance, 'tone', detectedTone.length >= draft.tone.length ? 'explicit' : 'inferred');
  if (draft.tone.some(word => !detectedTone.includes(word))) decided.push('tone');

  const style = detectStylePreset(text);
  if (style) {
    draft.style = { preset: style };
    setProvenance(provenance, 'style.preset', 'explicit');
  } else {
    setProvenance(provenance, 'style.preset', 'unresolved');
  }

  const languageChoice = detectLanguage(text);
  const language = languageChoice.language;
  draft.audience = { ...(draft.audience ?? {}), language };
  setProvenance(provenance, 'audience.language', languageChoice.explicit ? 'explicit' : 'defaulted');
  if (draft.audience.who === undefined) delete draft.audience.who;

  const mustInclude = detectList(text, 'must[- ]include');
  const avoid = detectList(text, 'avoid');
  if (mustInclude.length) {
    draft.must_include = mustInclude;
    setProvenance(provenance, 'must_include', 'explicit');
  }
  if (avoid.length) {
    draft.avoid = avoid;
    setProvenance(provenance, 'avoid', 'explicit');
  }

  const cta = /\b(star[- _]the[- _]repo|star us|book a demo|sign up|join the (?:beta|waitlist)|subscribe)\b/i.exec(text);
  if (cta) {
    draft.cta = cta[1].replace(/[-_]+/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    setProvenance(provenance, 'cta', 'explicit');
  } else {
    setProvenance(provenance, 'cta', 'unresolved');
  }

  const voice = detectVoiceChoice(text);
  draft.voice = { engine: 'kokoro', lang: language };
  decided.push('voice');
  if (voice.silent) {
    draft.voice.silent = true;
    setProvenance(provenance, 'voice.silent', 'explicit');
    setProvenance(provenance, 'voice.persona', 'explicit');
  } else if (voice.persona) {
    draft.voice.persona = voice.persona;
    setProvenance(provenance, 'voice.persona', 'explicit');
  } else {
    draft.voice.persona = 'warm narrator, measured pace';
    setProvenance(provenance, 'voice.persona', 'defaulted');
  }

  const music = /\b(music|soundtrack|score|music bed)\b/i.test(text);
  draft.music = { enabled: music };
  setProvenance(provenance, 'music.enabled', music ? 'explicit' : 'defaulted');
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
  next.field_provenance = { ...(next.field_provenance ?? {}) };
  const provenance = next.field_provenance;
  for (const question of QUESTION_BANK) {
    if (!(question.id in decisions)) continue;
    const raw = decisions[question.id];
    const explicit = raw !== undefined && raw !== '';
    const value = explicit ? raw : question.decide;
    switch (question.id) {
      case 'key_message':
        next.key_message = String(value).slice(0, 200);
        setProvenance(provenance, 'key_message', explicit ? 'explicit' : 'defaulted');
        break;
      case 'audience':
        next.audience = { ...(next.audience ?? {}), who: String(value).toLowerCase(), language: next.audience?.language ?? 'en' };
        setProvenance(provenance, 'audience.who', explicit ? 'explicit' : 'defaulted');
        break;
      case 'length':
        next.length_s = parseLength(value, question.decide);
        setProvenance(provenance, 'length_s', explicit ? 'explicit' : 'defaulted');
        break;
      case 'look': {
        const preset = (STYLE_PRESETS as readonly string[]).includes(String(value)) ? (value as StylePreset) : 'cinematic-dark';
        next.style = { ...(next.style ?? {}), preset };
        setProvenance(provenance, 'style.preset', explicit ? 'explicit' : 'defaulted');
        break;
      }
      case 'voice': {
        const none = /^none$/i.test(String(value));
        next.voice = { ...(next.voice ?? { engine: 'kokoro', lang: 'en' }), persona: none ? undefined : String(value) };
        if (none) {
          delete next.voice.persona;
          next.voice.silent = true;
        } else {
          delete next.voice.silent;
        }
        setProvenance(provenance, 'voice.persona', explicit ? 'explicit' : 'defaulted');
        setProvenance(provenance, 'voice.silent', explicit ? 'explicit' : 'defaulted');
        break;
      }
      case 'data':
        next.facts = next.facts ?? [];
        setProvenance(provenance, 'facts', explicit ? 'explicit' : 'defaulted');
        break;
      case 'cta':
        if (/^none$/i.test(String(value))) delete next.cta;
        else next.cta = String(value);
        setProvenance(provenance, 'cta', explicit ? 'explicit' : 'defaulted');
        break;
      case 'presenter': {
        const text = String(value).toLowerCase();
        next.presenter = text.includes('all') ? 'all' : text.includes('intro') || text.includes('outro') || text.includes('bookend') ? 'bookends' : 'none';
        setProvenance(provenance, 'presenter', explicit ? 'explicit' : 'defaulted');
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
  const provenance: BriefFieldProvenance = { ...(draft.field_provenance ?? {}) };
  const ensure = (field: string, value: FieldProvenance): void => {
    if (!provenance[field] || provenance[field] === 'unresolved') provenance[field] = value;
  };
  ensure('goal', draft.goal ? 'inferred' : 'defaulted');
  ensure('key_message', draft.key_message ? 'explicit' : 'defaulted');
  ensure('audience.who', draft.audience?.who ? 'inferred' : 'defaulted');
  ensure('audience.language', draft.audience?.language ? 'explicit' : 'defaulted');
  ensure('aspect', draft.aspect ? 'explicit' : 'defaulted');
  ensure('presenter', draft.presenter ? 'explicit' : 'defaulted');
  ensure('tone', draft.tone && draft.tone.length >= 3 ? 'explicit' : 'defaulted');
  ensure('style.preset', draft.style?.preset ? 'explicit' : style?.preset ? 'explicit' : 'defaulted');
  ensure('voice.persona', draft.voice?.persona ? 'explicit' : 'defaulted');
  ensure('music.enabled', draft.music?.enabled !== undefined ? 'explicit' : 'defaulted');

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
    voice: {
      engine: draft.voice?.engine ?? 'kokoro',
      ...(draft.voice?.persona ? { persona: draft.voice.persona } : {}),
      ...(draft.voice?.silent ? { silent: true } : {}),
      lang: draft.voice?.lang ?? language,
    },
    music: { ...(draft.music?.mood ? { mood: draft.music.mood } : {}), enabled: draft.music?.enabled ?? false },
    must_include: draft.must_include ?? [],
    avoid: draft.avoid ?? [],
    facts: draft.facts ?? [],
    mode: draft.mode ?? 'plan',
    decided_by_agent: draft.decided_by_agent ?? [],
    field_provenance: provenance,
    ...(draft.source_prompt ? { source_prompt: draft.source_prompt } : {}),
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

const FRENCH_OPENERS: Record<Brief['goal'], string> = {
  launch: 'Voici ce qui est nouveau.',
  explain: 'Voici comment ça marche.',
  teach: 'Voici comment faire.',
  pitch: 'Voici l’idée.',
  recap: 'Voici le récapitulatif.',
};

interface ScaffoldCopy {
  openers: Record<Brief['goal'], string>;
  madeFor: string;
  fictionFrame: string;
  pointWith: string;
  pointIdea: string;
  proofLead: string;
  proofPlaceholder: string;
  proofHeadline: string;
  fictionHeadline: string;
  fictionNarration: string;
  ctaLead: string;
  ctaClose: string;
  thanks: string;
  silentNote: string;
  fictionNote: string;
  noFactsNote: string;
  noCtaNote: string;
  lookNote: (preset: string, palette: string, font: string) => string;
  voiceNote: (persona: string, lang: string) => string;
  scaffoldNarrated: string;
  scaffoldSilent: string;
}

function scaffoldCopy(language: Brief['audience']['language']): ScaffoldCopy {
  if (language === 'fr') {
    return {
      openers: FRENCH_OPENERS,
      madeFor: 'Conçu pour',
      fictionFrame: 'C’est une histoire fictive.',
      pointWith: 'Nous couvrons',
      pointIdea: 'Tout se résume à une idée :',
      proofLead: 'Et la preuve :',
      proofPlaceholder: 'La preuve reste visuelle jusqu’à ce que le brief ait une source.',
      proofHeadline: 'Ajoutez une source ou gardez cette preuve visuelle',
      fictionHeadline: 'Histoire fictive',
      fictionNarration: 'C’est une histoire fictive : il n’y a pas de fait réel à prouver.',
      ctaLead: 'Si cela vous intéresse,',
      ctaClose: 'C’est toute l’idée.',
      thanks: 'Merci d’avoir regardé',
      silentNote: 'Aucune narration dans le brief ; les plans sont du texte à l’écran.',
      fictionNote: 'Fiction : ce canevas traite le sujet comme fictif ; aucune statistique réelle n’est sous-entendue.',
      noFactsNote: 'Aucune source ; la preuve affiche un emplacement visible.',
      noCtaNote: 'Aucun appel à l’action ; la fin ferme simplement.',
      lookNote: (preset, palette, font) => `Look: ${preset} (${palette}${font ? ` on ${font}` : ''}).`,
      voiceNote: (persona, lang) => `Voice: ${persona} (${lang}).`,
      scaffoldNarrated: 'Canevas : structure déterministe à modifier avant la construction.',
      scaffoldSilent: 'Canevas : plans à l’écran, aucune narration générée.',
    };
  }
  return {
    openers: GOAL_OPENERS,
    madeFor: 'Made for',
    fictionFrame: 'This is a fictional story.',
    pointWith: 'Along the way we cover',
    pointIdea: 'It comes down to one thing:',
    proofLead: 'And the proof:',
    proofPlaceholder: 'The proof stays visual until the brief has a source.',
    proofHeadline: 'Add a source or keep this beat visual',
    fictionHeadline: 'Fiction, not data',
    fictionNarration: 'This is a fictional story, so there is no real-world claim to prove.',
    ctaLead: 'If that sounds useful,',
    ctaClose: 'That is the whole idea.',
    thanks: 'Thanks for watching',
    silentNote: 'No narration in the brief; the beats are on-screen text only.',
    fictionNote: 'Fiction: this scaffold treats the topic as fictional; no real-world statistic is implied.',
    noFactsNote: 'No source facts; the proof beat shows a visible placeholder.',
    noCtaNote: 'No CTA in the brief; the outro just closes.',
    lookNote: (preset, palette, font) => `Look: ${preset} (${palette}${font ? ` on ${font}` : ''}).`,
    voiceNote: (persona, lang) => `Voice: ${persona} (${lang}).`,
    scaffoldNarrated: 'Scaffold: deterministic beats; edit them before building.',
    scaffoldSilent: 'Scaffold: silent on-screen beats; no narration is generated.',
  };
}

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

export interface OutlineScaffold {
  kind: 'narrated' | 'silent';
  fiction: boolean;
  proof: 'sourced' | 'placeholder' | 'fiction';
  label: string;
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
  scaffold: OutlineScaffold;
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

function briefText(brief: Brief): string {
  return [brief.source_prompt, brief.key_message, brief.must_include.join(' '), brief.avoid.join(' ')]
    .filter(Boolean)
    .join(' ');
}

/** Fiction is signalled by the user's topic, never inferred from a missing fact. */
function isFictionBrief(brief: Brief): boolean {
  return /\b(ficti(?:on|ve|onal)|story|stories|tale|myth|fable|fantasy|imaginary|made[- ]up|novel)\b/i.test(briefText(brief));
}

function isSilentBrief(brief: Brief): boolean {
  return brief.voice.silent === true || !brief.voice.persona?.trim();
}

function hasRelevantNumbers(text: string): boolean {
  const withoutDurations = text.replace(/\b\d+(?:\.\d+)?\s*-?\s*(?:s|sec|secs|second|seconds|min|mins|minute|minutes)\b/gi, '');
  return isStatisticClaim(withoutDurations);
}

function hasNumericContext(brief: Brief): boolean {
  if (brief.facts.length > 0) return true;
  if (hasRelevantNumbers(brief.key_message)) return true;
  return brief.source_prompt ? hasRelevantNumbers(brief.source_prompt) : false;
}

/**
 * Turn a completed brief into a script-first outline with estimated seconds. The
 * scaffold follows the chosen language, look and voice; a silent brief emits no
 * narration, and a fictional or non-numeric brief never gains a spoken statistic.
 */
export function buildOutline(brief: Brief, options: OutlineOptions = {}): Outline {
  const language = brief.audience.language;
  const copy = scaffoldCopy(language);
  const gapSeconds = options.gapSeconds ?? 0.4;
  const maxBeats = Math.max(3, options.maxBeats ?? 4);
  const who = brief.audience.who;
  const keyMessage = brief.key_message.replace(/\s+/g, ' ').trim();
  const silent = isSilentBrief(brief);
  const fiction = isFictionBrief(brief);
  const beats: OutlineBeat[] = [];

  const hook = `${copy.openers[brief.goal]} ${keyMessage}${fiction ? ` ${copy.fictionFrame}` : ''} ${copy.madeFor} ${who}.`;
  beats.push({
    id: 's_title',
    role: 'hook',
    layout: 'title',
    headline: trimHeadline(keyMessage),
    narration: silent ? '' : hook,
    seconds: silent ? 0 : estimateNarrationSeconds(hook, language),
    placeholder: false,
  });

  const points = brief.must_include.length > 0 ? `${copy.pointWith} ${brief.must_include.join(', ')}.` : `${copy.pointIdea} ${keyMessage}`;
  beats.push({
    id: 's_point',
    role: 'point',
    layout: brief.must_include.length > 0 ? 'list' : 'hero',
    headline: trimHeadline(brief.must_include[0] ?? keyMessage),
    narration: silent ? '' : points,
    seconds: silent ? 0 : estimateNarrationSeconds(points, language),
    placeholder: false,
  });

  const fact = brief.facts[0];
  let proofMode: OutlineScaffold['proof'] = fact ? 'sourced' : 'placeholder';
  if (fiction) {
    proofMode = 'fiction';
    beats.push({
      id: 's_fiction',
      role: 'point',
      layout: 'hero',
      headline: trimHeadline(copy.fictionHeadline),
      narration: silent ? '' : copy.fictionNarration,
      seconds: silent ? 0 : estimateNarrationSeconds(copy.fictionNarration, language),
      placeholder: false,
    });
  } else {
    const proof = fact ? `${copy.proofLead} ${fact.claim} (${fact.source}).` : copy.proofPlaceholder;
    beats.push({
      id: 's_proof',
      role: 'proof',
      layout: fact || hasNumericContext(brief) ? 'stat' : 'hero',
      headline: trimHeadline(fact ? fact.claim : copy.proofHeadline),
      narration: silent ? '' : proof,
      seconds: silent ? 0 : estimateNarrationSeconds(proof, language),
      placeholder: !fact,
    });
  }

  if (maxBeats >= 4) {
    const ctaLine = brief.cta ? `${copy.ctaLead} ${brief.cta}.` : copy.ctaClose;
    beats.push({
      id: 's_outro',
      role: 'cta',
      layout: 'title',
      headline: trimHeadline(brief.cta ?? copy.thanks),
      narration: silent ? '' : ctaLine,
      seconds: silent ? 0 : estimateNarrationSeconds(ctaLine, language),
      placeholder: false,
    });
  }

  const narrationSeconds = Number(beats.reduce((sum, beat) => sum + beat.seconds, 0).toFixed(2));
  const estimatedSeconds = Number((narrationSeconds + gapSeconds * beats.length).toFixed(2));
  const targetSeconds = brief.length_s ?? estimatedSeconds;
  const lower = targetSeconds * 0.85;
  const upper = targetSeconds * 1.15;
  const fit: Outline['fit'] = estimatedSeconds < lower ? 'short' : estimatedSeconds > upper ? 'long' : 'on-target';
  const scaffold: OutlineScaffold = {
    kind: silent ? 'silent' : 'narrated',
    fiction,
    proof: proofMode,
    label: silent ? copy.scaffoldSilent : copy.scaffoldNarrated,
  };

  const notes = [
    copy.lookNote(brief.style.preset, (brief.style.palette ?? []).join(' '), brief.style.font ?? ''),
  ];
  if (silent) notes.push(copy.silentNote);
  else if (brief.voice.persona) notes.push(copy.voiceNote(brief.voice.persona, brief.voice.lang));
  if (!brief.cta) notes.push(copy.noCtaNote);
  if (brief.avoid.length > 0) notes.push(`Avoid: ${brief.avoid.join(', ')}.`);
  if (fiction) notes.push(copy.fictionNote);
  else if (!brief.facts.length) notes.push(copy.noFactsNote);
  if (brief.presenter !== 'none') notes.push(`Presenter: ${brief.presenter === 'all' ? 'every scene' : 'intro and outro'} (opt-in; clips are planned, not run).`);
  if (fit === 'short') notes.push(`About ${(targetSeconds - estimatedSeconds).toFixed(1)} s of headroom left; add a beat or slow the pace.`);
  if (fit === 'long') notes.push(`About ${(estimatedSeconds - targetSeconds).toFixed(1)} s over; trim the point or drop the proof.`);
  notes.push(scaffold.label);

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
    scaffold,
  };
}
