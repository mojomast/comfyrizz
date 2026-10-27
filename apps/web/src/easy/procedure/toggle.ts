import { escapeHtml } from '../components.ts';
import { PROCEDURE_COPY } from './copy.ts';

export interface ProcedureToggleOptions {
  armed: boolean;
  /** Unique element id on the page. */
  id: string;
}

/** The "Record this run" checkbox shown next to Generate. */
export function renderProcedureToggle(options: ProcedureToggleOptions): string {
  const id = escapeHtml(options.id);
  return `<div class="procedure-capture-toggle" data-procedure-capture-toggle-row>
<label class="procedure-capture-toggle-label" for="${id}"><input type="checkbox" id="${id}" data-procedure-capture-toggle aria-describedby="${id}-hint"${options.armed ? ' checked' : ''}> ${escapeHtml(PROCEDURE_COPY.toggle)}</label>
<p class="procedure-capture-toggle-hint" id="${id}-hint">${escapeHtml(PROCEDURE_COPY.toggleHint)}</p>
</div>`;
}
