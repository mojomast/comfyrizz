// SE04: the presentational Super Easy home.
//
// The happy path is one prompt and one primary Generate. There is no level
// picker and no plan or shot editing here; those stay in the Easy studio
// behind the more-control link. Draft is chosen under the hood by the caller.

import { COPY } from './copy.ts';
import { COPY as EASY_COPY } from '../copy.ts';
import { superEasyBrandMarkup } from './brand.ts';
import { escapeHtml } from '../components.ts';
import { escapeToStudio } from './escape.ts';
import { renderProcedureToggle } from '../procedure/toggle.ts';
import type { SuperEasySetup } from './setup.ts';
import type { EasyIdea } from '../types.ts';

export const SUPER_EASY_MIN_PROMPT_CHARS = 10;
const LENGTHS = [15, 30, 60, 90] as const satisfies readonly EasyIdea['lengthS'][];

/** One-click starting prompts, keyed by `data-super-easy-idea`. */
export const SUPER_EASY_IDEAS: Readonly<Record<string, string>> = COPY.ideas;

export interface SuperEasyHomeOptions {
  /** Initial prompt text; escaped before it reaches the page. */
  prompt?: string;
  /** Current video id, kept by the more-control escape. */
  packageId?: string | null;
  /** Current address, so unrelated query parameters survive the escape. */
  search?: string;
  /** Show the "Record this run" checkbox under Generate. */
  capture?: { armed: boolean };
  /** Saved setup preference; no API keys or tokens enter this view model. */
  setup?: SuperEasySetup;
  /** Shared Easy idea duration; 30 seconds remains the credit-safe default. */
  lengthS?: EasyIdea['lengthS'];
}

function ideaChips(): string {
  return Object.entries(SUPER_EASY_IDEAS)
    .map(([id, text]) => `<li><button type="button" class="super-easy-home-idea" data-super-easy-idea="${escapeHtml(id)}">${escapeHtml(text)}</button></li>`)
    .join('\n');
}

function lengthSegments(lengthS: EasyIdea['lengthS']): string {
  const options = LENGTHS.map((seconds) => {
    const checked = lengthS === seconds ? ' checked' : '';
    return `<label class="easy-segment"><input class="easy-segment-input" type="radio" name="super-easy-length" value="${seconds}" data-super-easy-length${checked} /><span class="easy-segment-title">${escapeHtml(EASY_COPY.idea.lengths[seconds])}</span></label>`;
  }).join('');
  return `<fieldset class="easy-segmented super-easy-home-length"><legend class="easy-segment-legend">${escapeHtml(EASY_COPY.idea.length)}</legend><div class="easy-segment-row">${options}</div></fieldset>`;
}

/**
 * Render the Super Easy landing for a bare visit.
 *
 * The returned string is static markup: the prompt box, the one primary
 * Generate action, the optional example actions and the more-control link.
 * The empty-prompt message stays hidden until a too-short Generate.
 */
export function renderSuperEasyHome(options: SuperEasyHomeOptions = {}): string {
  const prompt = typeof options.prompt === 'string' ? options.prompt : '';
  const moreControlHref = escapeToStudio(options.search ?? '', options.packageId ?? null);
  const colab = options.setup?.compute === 'colab' && options.setup.confirmed;
  const hint = colab ? 'One sentence is enough. Your film is planned, generated, finished and ready to watch here.' : COPY.home.hint;
  const setupText = colab ? `Google Colab · up to ${options.setup?.spendCap} credits per video` : 'Connect your AI agent and Google Colab for generated films';
  const motionModel = options.setup?.motionModel ?? 'auto';
  const lengthS = options.lengthS ?? 30;
  return `<section class="super-easy-home" aria-labelledby="super-easy-title" data-super-easy-home>
${superEasyBrandMarkup()}
<h1 class="super-easy-home-title" id="super-easy-title">${escapeHtml(COPY.home.title)}</h1>
<form class="super-easy-home-form" data-super-easy-form novalidate>
<label class="super-easy-home-label" for="super-easy-prompt">${escapeHtml(COPY.home.promptLabel)}</label>
<textarea class="super-easy-home-prompt" id="super-easy-prompt" name="prompt" rows="4" minlength="${SUPER_EASY_MIN_PROMPT_CHARS}" required placeholder="${escapeHtml(COPY.home.promptPlaceholder)}" aria-describedby="super-easy-prompt-hint">${escapeHtml(prompt)}</textarea>
<p class="super-easy-home-hint" id="super-easy-prompt-hint">${escapeHtml(hint)}</p>
<p class="super-easy-home-error" id="super-easy-prompt-error" role="alert" data-super-easy-prompt-error hidden>${escapeHtml(COPY.home.emptyPrompt)}</p>
${lengthSegments(lengthS)}
<div class="super-easy-home-actions">
<button type="submit" class="btn btn-primary super-easy-home-generate" data-super-easy-generate>${escapeHtml(COPY.home.generate)}</button>
<button type="button" class="btn btn-secondary super-easy-home-example" data-super-easy-example>${escapeHtml(COPY.home.tryExample)}</button>
</div>
${options.capture ? renderProcedureToggle({ armed: options.capture.armed, id: 'super-easy-capture' }) : ''}
</form>
<div class="super-easy-home-setup"><span>${escapeHtml(setupText)}</span><button type="button" class="btn btn-secondary btn-sm" data-super-easy-setup>${colab ? 'Change setup' : 'Set up AI & Google Colab'}</button></div>
<label class="super-easy-home-motion-model">Motion model<select data-super-easy-motion-model aria-label="Motion model"><option value="auto"${motionModel === 'auto' ? ' selected' : ''}>Auto — H3 acting + LTX camera</option><option value="h3"${motionModel === 'h3' ? ' selected' : ''}>MiniMax H3 — characters + native sound</option><option value="ltx"${motionModel === 'ltx' ? ' selected' : ''}>LTX-2.5 — cinematic motion plates</option><option value="klein"${motionModel === 'klein' ? ' selected' : ''}>Klein only — stills + code motion</option></select></label>
<div class="super-easy-home-ideas">
<p class="super-easy-home-ideas-label" id="super-easy-ideas-label">${escapeHtml(COPY.home.ideasLabel)}</p>
<ul class="super-easy-home-idea-list" aria-labelledby="super-easy-ideas-label">
${ideaChips()}
</ul>
</div>
<p class="super-easy-home-more"><a class="super-easy-home-more-link" href="${escapeHtml(moreControlHref)}" data-super-easy-more-control>${escapeHtml(COPY.home.moreControl)}</a></p>
</section>`;
}
