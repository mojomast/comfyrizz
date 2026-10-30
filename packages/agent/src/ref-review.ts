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
  return [
    refReviewSkill().body,
    '',
    'Review one generated reference still before it feeds the LTX video stage.',
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
    '- identity: Does each character match their identity lock and stated wardrobe?',
    '- anatomy: Are hands, fingers, limbs, and eyes correctly formed and naturally attached?',
    '- framing: Does the composition match the plan and the shot prompt? Shot sizes are bands with tolerance, not exact crops: a close-up shows the head and maybe the shoulders; a medium shot is anything from chest-up to waist-up or hip-up; a medium close-up sits between them; a wide or full shot shows the whole body with surroundings; an extreme wide shows the subject small in a large scene. Neighbouring sizes count as a match. Fail framing only when the shot size is clearly different (for example a close-up or macro when a wide or full-body shot was asked for, or a full-body wide when a close-up was asked for), when the planned subject is missing or cut off, or when the composition clearly contradicts the plan. Mark small crop, headroom or lens-feel differences as pass, or as a soft note at most.',
    '- prompt: For each deduction, name the category entity|appearance|activity|counting|composition and quote the prompt detail that is missing or wrong.',
    '- text_artifact: Is unintended text, lettering, logo, watermark, or garbled writing visible?',
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
