import { REF_DIMENSIONS, REF_SEVERITIES, REF_VERDICT_SCHEMA, validateRefVerdict } from '@comfyrizz/schema/ref-review';
import type { RefVerdict } from '@comfyrizz/schema/ref-review';
import { refReviewSkill } from './skills/index.js';
import type { ChatMessage, ImagePart } from './types.js';

interface ReviewRequest {
  jobId: string;
  keyframeSha256: string;
  prompt: string;
  width: number;
  height: number;
  plannedWidth: number;
  plannedHeight: number;
  characters: Array<{ characterId: string; identityLock: string; wardrobeState?: string }>;
  /** judge-loop v2: the review subject. 'clip' is a 3x2 grid of frames sampled in order from one LTX clip. */
  kind?: 'still' | 'keyframe' | 'clip';
  /** judge-loop v2 fix verification: the hard failures of the previous attempt of this still. */
  priorFailures?: Array<{ dimension: string; evidence: string }>;
  attempt?: number;
}

export interface ReviewStillOptions {
  request: ReviewRequest;
  image: ImagePart;
  model: (messages: ChatMessage[]) => string | Promise<string>;
  signal?: AbortSignal;
}

interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function verdictCheck(value: unknown): ValidationResult {
  return validateRefVerdict(value) as ValidationResult;
}

function buildPrompt(request: ReviewRequest): string {
  const locks = request.characters.length
    ? request.characters.map(character => {
        const wardrobe = character.wardrobeState ? `\n  Wardrobe: ${character.wardrobeState}` : '';
        return `- ${character.characterId}: ${character.identityLock}${wardrobe}`;
      }).join('\n')
    : '- none';
  const clip = request.kind === 'clip';
  const prior = Array.isArray(request.priorFailures) && request.priorFailures.length
    ? [
        '',
        `Fix verification: this is attempt ${request.attempt ?? 1}. The previous version of this still failed these hard checks:`,
        ...request.priorFailures.map(failure => `- ${failure.dimension}: ${String(failure.evidence).slice(0, 300)}`),
        'For each of those dimensions, say in its evidence whether the failure is now resolved, quoting what you see. Fail it again (hard) if it is not resolved. Then check every other dimension as usual: a fix that breaks something else is a new failure.',
      ]
    : [];
  return [
    refReviewSkill().body,
    '',
    clip
      ? 'Review one generated video clip, shown as six frames sampled in order (left to right, top row then bottom row). Judge the motion as a whole: the same character must stay the same person in every frame.'
      : 'Review one generated reference still before it feeds the LTX video stage.',
    ...(clip ? [
      'For a clip: identity fails (hard) if a character visibly changes into a different person, animal or outfit between frames; anatomy fails (hard) if a body morphs, melts, gains or loses limbs, or a face distorts in any frame; technical fails (hard) if frames tear, flash, smear into noise or the subject dissolves; framing fails only if the subject leaves frame for most of the clip. Small, natural motion blur and camera moves are fine. The text_artifact and prompt checks use the same rules as for a still.',
    ] : []),
    ...prior,
    '',
    'Shot prompt:',
    request.prompt,
    '',
    'Story bible locks:',
    locks,
    '',
    `Planned frame: ${request.plannedWidth}x${request.plannedHeight}. Rendered still: ${request.width}x${request.height}.`,
    '',
    'Answer each question from what is visibly present in the image:',
    '- technical: Is the image technically clean: in focus where it matters, no heavy blur, noise, banding, smearing, broken or doubled regions, and not washed out? Fail hard only when the defect is obvious at a glance.',
    '- identity: Does each character match their identity lock and stated wardrobe?',
    '- anatomy: Are hands, fingers, limbs, and eyes correctly formed and naturally attached?',
    '- framing: Does the composition match the plan and the shot prompt? Shot sizes are bands with tolerance, not exact crops: a close-up shows the head and maybe the shoulders; a medium shot is anything from chest-up to waist-up or hip-up; a medium close-up sits between them; a wide or full shot shows the whole body with surroundings; an extreme wide shows the subject small in a large scene. Neighbouring sizes count as a match. Fail framing only when the shot size is clearly different (for example a close-up or macro when a wide or full-body shot was asked for, or a full-body wide when a close-up was asked for), when the planned subject is missing or cut off, or when the composition clearly contradicts the plan. Mark small crop, headroom or lens-feel differences as pass, or as a soft note at most.',
    '- prompt: For each deduction, name the category entity|appearance|activity|counting|composition and quote the prompt detail that is missing or wrong.',
    '- text_artifact: Is unintended text, lettering, logo, watermark, or garbled writing visible? Severity is hard only when the text is prominent: on a character or their clothing, in the foreground, readable as words at a glance anywhere in the frame (a large or lit sign counts, even behind the subject), or a watermark or logo. Only small, distant, blurred or illegible lettering on incidental props (a plaque, label or poster you cannot read at a glance) is severity soft, because the video stage can carry it.',
    '- Severity in general: hard means the still would visibly break the shot or the story (wrong person, broken anatomy, missing subject, prominent garbled text). Minor accessory or prop differences that the identity lock does not name are soft. When you are unsure whether a defect is visible, say so in the evidence and use severity soft.',
    '',
    `Use dimension values ${REF_DIMENSIONS.join('|')} and severity values ${REF_SEVERITIES.join('|')}.`,
    'Keep every evidence string at most 400 characters.',
    'Write every fixHint as a positive end-state phrase describing the corrected still, never a negative or a prohibition. Example: "five fingers clearly visible".',
    `Return ONLY one JSON object that validates as ${REF_VERDICT_SCHEMA}:`,
    `{"schema":"${REF_VERDICT_SCHEMA}","jobId":"${request.jobId}","keyframeSha256":"${request.keyframeSha256}","reviewer":"pi","overall":"pass|fail|error","checks":[{"dimension":"identity","pass":true,"severity":"hard","evidence":"visible evidence"}],"fixHints":[]}`,
    'Do not wrap the JSON in prose or code fences.',
  ].join('\n');
}

function buildRepair(errors: string[]): string {
  return [
    'Your previous reply was not a valid RefVerdict. Correct exactly these validation errors:',
    ...errors.map(error => `- ${error}`),
    '',
    'Return ONLY the corrected RefVerdict JSON object, with no prose and no code fences.',
  ].join('\n');
}

function parseVerdict(reply: unknown): unknown {
  if (typeof reply !== 'string') return undefined;
  let text = reply.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return undefined;
}

function errorVerdict(request: ReviewRequest): RefVerdict {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: request.jobId,
    keyframeSha256: request.keyframeSha256,
    reviewer: 'pi',
    overall: 'error',
    checks: [],
    fixHints: [],
  };
}

async function ask(model: ReviewStillOptions['model'], messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const reply = await model(messages);
  signal?.throwIfAborted();
  return reply;
}

export async function reviewStill({ request, image, model, signal }: ReviewStillOptions): Promise<RefVerdict> {
  signal?.throwIfAborted();
  const messages: ChatMessage[] = [{ role: 'user', content: buildPrompt(request), images: [image] }];

  let reply: string;
  try {
    reply = await ask(model, messages, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return errorVerdict(request);
  }

  const first = parseVerdict(reply);
  const firstCheck = verdictCheck(first);
  if (firstCheck.ok) return first as RefVerdict;

  const repairMessages: ChatMessage[] = [
    ...messages,
    { role: 'user', content: buildRepair(firstCheck.errors) },
  ];
  try {
    reply = await ask(model, repairMessages, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return errorVerdict(request);
  }

  const second = parseVerdict(reply);
  const secondCheck = verdictCheck(second);
  if (secondCheck.ok) return second as RefVerdict;
  return errorVerdict(request);
}


/** judge-loop v2: scene consistency. One call with anchor stills plus one candidate still. */
export interface SceneReviewOptions {
  candidate: { jobId: string; image: ImagePart; prompt: string };
  anchors: Array<{ jobId: string; image: ImagePart }>;
  characters: Array<{ characterId: string; identityLock: string; wardrobeState?: string }>;
  model: (messages: ChatMessage[]) => string | Promise<string>;
  signal?: AbortSignal;
}

export interface SceneVerdict {
  consistent: boolean;
  checks: Array<{ dimension: 'identity' | 'wardrobe' | 'style'; pass: boolean; severity: 'hard' | 'soft'; evidence: string }>;
  fixHints: string[];
}

const SCENE_DIMENSIONS = ['identity', 'wardrobe', 'style'];

function buildScenePrompt(options: SceneReviewOptions): string {
  const locks = options.characters.length
    ? options.characters.map(c => `- ${c.characterId}: ${c.identityLock}${c.wardrobeState ? ` (wardrobe: ${c.wardrobeState})` : ''}`).join('\n')
    : '- none given: compare the recurring characters between the images';
  return [
    'You check continuity across shots of one short film.',
    `The first ${options.anchors.length} image(s) are accepted anchor shots. The LAST image is the candidate shot.`,
    'Candidate shot prompt:',
    options.candidate.prompt,
    '',
    'Character locks:',
    locks,
    '',
    'Compare only characters that appear in both the candidate and an anchor. Camera angle, pose, expression and framing may differ; that is fine.',
    '- identity: is each recurring character recognisably the same individual (face, species, build, colouring, distinguishing marks)? Hard fail only if a viewer would think it is a different character.',
    '- wardrobe: same outfit and key props as the anchors unless the prompt says they changed? Hard fail only for an obvious change (different coat colour, missing signature item).',
    '- style: same rendering style (photoreal vs cartoon, colour grade family)? Hard fail only if the candidate looks like it is from a different film.',
    'When a character is not in the candidate, pass that dimension. When unsure, use soft.',
    'Return ONLY JSON: {"consistent":true|false,"checks":[{"dimension":"identity|wardrobe|style","pass":true,"severity":"hard|soft","evidence":"<=300 chars"}],"fixHints":["positive end-state phrase"]}',
    '"consistent" is false only when a check fails with severity hard.',
  ].join('\n');
}

export function validateSceneVerdict(value: unknown): value is SceneVerdict {
  if (!value || typeof value !== 'object') return false;
  const v = value as SceneVerdict;
  if (typeof v.consistent !== 'boolean' || !Array.isArray(v.checks) || !Array.isArray(v.fixHints ?? [])) return false;
  return v.checks.every(c => c && SCENE_DIMENSIONS.includes(c.dimension) && typeof c.pass === 'boolean'
    && (c.severity === 'hard' || c.severity === 'soft') && typeof c.evidence === 'string');
}

/** Returns null when the reply cannot be read; callers treat null as "no opinion", never as a hold. */
export async function reviewScene(options: SceneReviewOptions): Promise<SceneVerdict | null> {
  options.signal?.throwIfAborted();
  const images = [...options.anchors.map(a => a.image), options.candidate.image];
  const messages: ChatMessage[] = [{ role: 'user', content: buildScenePrompt(options), images }];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply: string;
    try { reply = await ask(options.model, messages, options.signal); } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      continue;
    }
    const parsed = parseVerdict(reply);
    if (validateSceneVerdict(parsed)) {
      const hard = parsed.checks.some(c => !c.pass && c.severity === 'hard');
      return { ...parsed, consistent: !hard, fixHints: parsed.fixHints ?? [] };
    }
  }
  return null;
}
