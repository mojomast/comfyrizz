// SE04: the presentational Super Easy home.
//
// The happy path is one prompt and one primary Generate. There is no level
// picker and no plan or shot editing here; those stay in the Easy studio
// behind the more-control link. Draft is chosen under the hood by the caller.

import { COPY } from './copy.ts';
import { escapeHtml } from '../components.ts';
import { escapeToStudio } from './escape.ts';

export const SUPER_EASY_MIN_PROMPT_CHARS = 10;

export interface SuperEasyHomeOptions {
  /** Initial prompt text; escaped before it reaches the page. */
  prompt?: string;
  /** Current video id, kept by the more-control escape. */
  packageId?: string | null;
  /** Current address, so unrelated query parameters survive the escape. */
  search?: string;
}

/**
 * Render the Super Easy landing for a bare visit.
 *
 * The returned string is static markup: the prompt box, the one primary
 * Generate action, the optional example action and the more-control link.
 */
export function renderSuperEasyHome(options: SuperEasyHomeOptions = {}): string {
  const prompt = typeof options.prompt === 'string' ? options.prompt : '';
  const moreControlHref = escapeToStudio(options.search ?? '', options.packageId ?? null);
  return `<section class="super-easy-home" aria-labelledby="super-easy-title" data-super-easy-home>
<h1 class="super-easy-home-title" id="super-easy-title">${escapeHtml(COPY.home.title)}</h1>
<form class="super-easy-home-form" data-super-easy-form>
<label class="super-easy-home-label" for="super-easy-prompt">${escapeHtml(COPY.home.promptLabel)}</label>
<textarea class="super-easy-home-prompt" id="super-easy-prompt" name="prompt" rows="4" minlength="${SUPER_EASY_MIN_PROMPT_CHARS}" required placeholder="${escapeHtml(COPY.home.promptPlaceholder)}" aria-describedby="super-easy-prompt-hint">${escapeHtml(prompt)}</textarea>
<p class="super-easy-home-hint" id="super-easy-prompt-hint">${escapeHtml(COPY.home.emptyPrompt)}</p>
<div class="super-easy-home-actions">
<button type="submit" class="btn btn-primary super-easy-home-generate" data-super-easy-generate>${escapeHtml(COPY.home.generate)}</button>
<button type="button" class="btn btn-secondary super-easy-home-example" data-super-easy-example>${escapeHtml(COPY.home.tryExample)}</button>
</div>
</form>
<p class="super-easy-home-more"><a class="super-easy-home-more-link" href="${escapeHtml(moreControlHref)}" data-super-easy-more-control>${escapeHtml(COPY.home.moreControl)}</a></p>
</section>`;
}
