// SE04: the presentational Super Easy home.
//
// The happy path is one prompt and one primary Generate. There is no level
// picker and no plan or shot editing here; those stay in the Easy studio
// behind the more-control link. Draft is chosen under the hood by the caller.

import { COPY } from './copy.ts';
import { escapeHtml } from '../components.ts';
import { escapeToStudio } from './escape.ts';
import { renderProcedureToggle } from '../procedure/toggle.ts';
import type { SuperEasySetup } from './setup.ts';

export const SUPER_EASY_MIN_PROMPT_CHARS = 10;

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
}

function ideaChips(): string {
  return Object.entries(SUPER_EASY_IDEAS)
    .map(([id, text]) => `<li><button type="button" class="super-easy-home-idea" data-super-easy-idea="${escapeHtml(id)}">${escapeHtml(text)}</button></li>`)
    .join('\n');
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
  return `<section class="super-easy-home" aria-labelledby="super-easy-title" data-super-easy-home>
<h1 class="super-easy-home-title" id="super-easy-title">${escapeHtml(COPY.home.title)}</h1>
<form class="super-easy-home-form" data-super-easy-form novalidate>
<label class="super-easy-home-label" for="super-easy-prompt">${escapeHtml(COPY.home.promptLabel)}</label>
<textarea class="super-easy-home-prompt" id="super-easy-prompt" name="prompt" rows="4" minlength="${SUPER_EASY_MIN_PROMPT_CHARS}" required placeholder="${escapeHtml(COPY.home.promptPlaceholder)}" aria-describedby="super-easy-prompt-hint">${escapeHtml(prompt)}</textarea>
<p class="super-easy-home-hint" id="super-easy-prompt-hint">${escapeHtml(hint)}</p>
<p class="super-easy-home-error" id="super-easy-prompt-error" role="alert" data-super-easy-prompt-error hidden>${escapeHtml(COPY.home.emptyPrompt)}</p>
<div class="super-easy-home-actions">
<button type="submit" class="btn btn-primary super-easy-home-generate" data-super-easy-generate>${escapeHtml(COPY.home.generate)}</button>
<button type="button" class="btn btn-secondary super-easy-home-example" data-super-easy-example>${escapeHtml(COPY.home.tryExample)}</button>
</div>
${options.capture ? renderProcedureToggle({ armed: options.capture.armed, id: 'super-easy-capture' }) : ''}
</form>
<div class="super-easy-home-setup"><span>${escapeHtml(setupText)}</span><button type="button" class="btn btn-secondary btn-sm" data-super-easy-setup>${colab ? 'Change setup' : 'Set up AI & Google Colab'}</button></div>
<div class="super-easy-home-ideas">
<p class="super-easy-home-ideas-label" id="super-easy-ideas-label">${escapeHtml(COPY.home.ideasLabel)}</p>
<ul class="super-easy-home-idea-list" aria-labelledby="super-easy-ideas-label">
${ideaChips()}
</ul>
</div>
<p class="super-easy-home-more"><a class="super-easy-home-more-link" href="${escapeHtml(moreControlHref)}" data-super-easy-more-control>${escapeHtml(COPY.home.moreControl)}</a></p>
</section>`;
}
