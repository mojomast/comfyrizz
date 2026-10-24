import { COPY } from '../copy.ts';
import { escapeHtml, renderErrorState } from '../components.ts';
import { confirmDialog } from '../dialog.ts';
import { ideaPrompt } from '../idea-prompt.ts';
import { mountEasyReferences } from './references.ts';
import { bindQuestions, renderQuestions } from './questions.ts';
import type { EasyQuestion, EasyState, EasyStepContext, EasyStepModule, Look, StepFacts } from '../types.ts';

export const STYLE_PRESETS: readonly Look[] = [
  'clay',
  'glass',
  'editorial-flat',
  'isometric-tech',
  'paper-cut',
  'cinematic-dark',
];

const ASPECTS = ['16:9', '9:16', '1:1'] as const;
const LENGTHS = [15, 30, 60, 90] as const;
const MAX_QUESTIONS = 3;

interface RenderOptions {
  error?: 'tooShort' | null;
}

interface IdeaView {
  root: HTMLElement;
  textarea: HTMLTextAreaElement | null;
  error: HTMLElement | null;
  questions: HTMLElement | null;
  busy: boolean;
}

let activeView: IdeaView | null = null;

function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

function templateChips(): string {
  const chips = COPY.idea.templates
    .map((template) => `<label class="easy-chip easy-idea-template" data-easy-template="${escapeAttr(template.id)}"><input class="easy-segment-input" type="radio" name="easy-idea-template" value="${escapeAttr(template.id)}" /><span>${escapeHtml(template.label)}</span></label>`)
    .join('');
  return `<fieldset class="easy-idea-templates"><legend class="easy-idea-legend">${escapeHtml(COPY.idea.templatesLabel)}</legend><div class="easy-idea-chip-row">${chips}</div></fieldset>`;
}

export interface TemplateOption {
  id: string;
  text: string;
}

export interface TemplateChangePlan {
  needsConfirm: boolean;
  text: string;
  restoreId: string | null;
}

export function templateChangeNeedsConfirm(
  currentText: string,
  templates: readonly { text: string }[] = COPY.idea.templates,
): boolean {
  const text = currentText.trim();
  if (!text) return false;
  return !templates.some((template) => template.text.trim() === text);
}

export function templateChangePlan(
  currentText: string,
  targetId: string,
  appliedId: string | null,
  templates: readonly TemplateOption[] = COPY.idea.templates,
): TemplateChangePlan | null {
  const target = templates.find((template) => template.id === targetId);
  if (!target) return null;
  return {
    needsConfirm: templateChangeNeedsConfirm(currentText, templates),
    text: target.text,
    restoreId: appliedId,
  };
}

function lengthSegments(state: EasyState): string {
  const options = LENGTHS.map((seconds) => {
    const checked = state.idea.lengthS === seconds ? ' checked' : '';
    return `<label class="easy-segment"><input class="easy-segment-input" type="radio" name="easy-idea-length" value="${seconds}"${checked} /><span class="easy-segment-title">${escapeHtml(COPY.idea.lengths[seconds])}</span></label>`;
  }).join('');
  return `<fieldset class="easy-segmented easy-idea-length"><legend class="easy-segment-legend">${escapeHtml(COPY.idea.length)}</legend><div class="easy-segment-row">${options}</div></fieldset>`;
}

function shapeSegments(state: EasyState): string {
  const options = ASPECTS.map((aspect) => {
    const checked = state.idea.aspect === aspect ? ' checked' : '';
    return `<label class="easy-segment"><input class="easy-segment-input" type="radio" name="easy-idea-shape" value="${escapeAttr(aspect)}"${checked} /><span class="easy-segment-title">${escapeHtml(COPY.idea.shapes[aspect])}</span></label>`;
  }).join('');
  return `<fieldset class="easy-segmented easy-idea-shape"><legend class="easy-segment-legend">${escapeHtml(COPY.idea.shape)}</legend><div class="easy-segment-row">${options}</div></fieldset>`;
}

function lookCards(state: EasyState): string {
  const options = STYLE_PRESETS.map((look) => {
    const checked = state.idea.look === look ? ' checked' : '';
    return `<label class="easy-choice-card easy-look-card" data-easy-look="${escapeAttr(look)}"><input class="easy-choice-input" type="radio" name="easy-idea-look" value="${escapeAttr(look)}"${checked} /><span class="easy-look-thumb" data-easy-look-thumb="${escapeAttr(look)}"><span class="easy-look-thumb-empty" aria-hidden="true"></span></span><span class="easy-choice-title">${escapeHtml(COPY.idea.looks[look])}</span><span class="easy-look-check" aria-hidden="true">✓</span></label>`;
  }).join('');
  return `<fieldset class="easy-choice-cards easy-idea-looks"><legend class="easy-choice-legend">${escapeHtml(COPY.idea.look)}</legend><div class="easy-choice-grid easy-idea-look-grid">${options}</div></fieldset>`;
}

function moreOptions(state: EasyState): string {
  const checked = state.idea.sound ? ' checked' : '';
  return `<details class="easy-idea-more"><summary class="easy-idea-more-summary">${escapeHtml(COPY.idea.more)}</summary><div class="easy-idea-more-body"><label class="easy-idea-toggle" for="easy-idea-sound"><input type="checkbox" id="easy-idea-sound" name="easy-idea-sound"${checked} /><span>${escapeHtml(COPY.idea.sound)}</span></label><div class="easy-idea-references" data-easy-references></div></div></details>`;
}

function looksEnabled(value: unknown): value is Look {
  return typeof value === 'string' && (STYLE_PRESETS as readonly string[]).includes(value);
}

function aspectsEnabled(value: unknown): value is EasyState['idea']['aspect'] {
  return typeof value === 'string' && (ASPECTS as readonly string[]).includes(value);
}

function lengthEnabled(value: unknown): value is EasyState['idea']['lengthS'] {
  return typeof value === 'number' && (LENGTHS as readonly number[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeQuestions(result: unknown): EasyQuestion[] {
  const data = asRecord(result);
  const list = Array.isArray(data?.questions) ? data.questions : [];
  const questions: EasyQuestion[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;
    const id = typeof record.id === 'string' ? record.id : '';
    const prompt = typeof record.prompt === 'string' ? record.prompt : '';
    if (!id || !prompt) continue;
    const optionSource = Array.isArray(record.options) ? record.options : Array.isArray(record.chips) ? record.chips : [];
    questions.push({
      id,
      field: typeof record.field === 'string' && record.field ? record.field : id,
      prompt,
      options: optionSource.filter((option): option is string => typeof option === 'string'),
      decide: typeof record.decide === 'string' ? record.decide : 'none',
    });
    if (questions.length >= MAX_QUESTIONS) break;
  }
  return questions;
}

function patchIdea(ctx: EasyStepContext, patch: Partial<EasyState['idea']>): void {
  const state = ctx.store.get();
  const textChanged = typeof patch.text === 'string' && patch.text !== state.idea.text;
  const planned = state.planHash !== null || state.plan.status === 'ready' || state.plan.status === 'stale';
  ctx.store.patch({
    idea: { ...state.idea, ...patch },
    ...(textChanged && planned
      ? { plan: { ...state.plan, status: 'stale', wordsChanged: true } }
      : {}),
  });
}

function errorHost(view: IdeaView | null): HTMLElement | null {
  return view?.root.querySelector<HTMLElement>('[data-easy-idea-error]') ?? null;
}

function clearTooShort(view: IdeaView | null): void {
  if (view?.textarea) view.textarea.removeAttribute('aria-invalid');
  if (view?.error) view.error.textContent = '';
}

function showTooShort(view: IdeaView | null): void {
  if (view?.textarea) {
    view.textarea.setAttribute('aria-invalid', 'true');
    view.textarea.focus();
  }
  if (view?.error) view.error.textContent = COPY.idea.tooShort;
}

function showBriefError(view: IdeaView | null): void {
  const host = errorHost(view);
  if (!host) return;
  host.innerHTML = renderErrorState({
    what: COPY.errors.brief,
    action: {
      label: COPY.errors.tryAgain,
      kind: 'secondary',
      data: { easyIdeaRetry: '1' },
    },
  });
}

function clearBriefError(view: IdeaView | null): void {
  const host = errorHost(view);
  if (host) host.innerHTML = '';
}

async function submit(ctx: EasyStepContext): Promise<void> {
  const view = activeView;
  if (view?.busy) return;

  const current = ctx.store.get();
  const text = view?.textarea ? view.textarea.value : current.idea.text;
  if (text.trim().length < 10) {
    showTooShort(view);
    return;
  }

  clearTooShort(view);
  clearBriefError(view);
  if (text !== current.idea.text) patchIdea(ctx, { text });

  const state = ctx.store.get();
  if (state.questionsAsked) {
    ctx.go('characters');
    return;
  }

  if (view) view.busy = true;
  try {
    const result = await ctx.api.planBrief(ideaPrompt(state));
    const questions = normalizeQuestions(result);
    ctx.store.patch({ questions, questionsAsked: true });
    if (questions.length > 0) {
      ctx.rerender();
      return;
    }
    ctx.go('characters');
  } catch {
    showBriefError(activeView);
  } finally {
    if (view) view.busy = false;
  }
}

function applyPresetThumbnails(view: IdeaView, result: unknown): void {
  const data = asRecord(result);
  const presets = Array.isArray(data?.presets) ? data.presets : [];
  for (const item of presets) {
    const record = asRecord(item);
    if (!record || typeof record.id !== 'string' || !looksEnabled(record.id)) continue;
    if (typeof record.thumbnail !== 'string' || !record.thumbnail) continue;
    const tile = view.root.querySelector<HTMLElement>(`[data-easy-look-thumb="${record.id}"]`);
    if (tile) tile.innerHTML = record.thumbnail;
  }
}

async function loadPresets(ctx: EasyStepContext, view: IdeaView, cancelled: () => boolean): Promise<void> {
  try {
    const response = await ctx.host.apiFetch('/api/brief/presets');
    if (cancelled() || !response.ok) return;
    const result = await response.json();
    if (cancelled()) return;
    applyPresetThumbnails(view, result);
  } catch {
    // An empty tile is the intended loading and failure state.
  }
}

function bindEvents(view: IdeaView, ctx: EasyStepContext): () => void {
  const referenceHost = view.root.querySelector<HTMLElement>('[data-easy-references]');
  const referenceState: { chatId: string | null } = { chatId: ctx.store.get().chatId };
  let stopReferences: () => void = () => {};
  if (referenceHost) {
    stopReferences = mountEasyReferences(referenceHost, {
      api: {
        createConversation: async () => {
          const created = await ctx.api.createConversation();
          const chatId = typeof created?.chatId === 'string' ? created.chatId : null;
          if (chatId) {
            referenceState.chatId = chatId;
            ctx.store.patch({ chatId });
          }
          return created;
        },
      },
      apiFetch: ctx.host.apiFetch,
      state: referenceState,
    });
  }

  let appliedTemplateId: string | null = null;

  const templateRadios = (): HTMLInputElement[] => Array.from(
    view.root.querySelectorAll<HTMLInputElement>('input[name="easy-idea-template"]'),
  );

  const setTemplateChecked = (id: string | null): void => {
    for (const radio of templateRadios()) radio.checked = radio.value === id;
  };

  const applyTemplate = (text: string, id: string): void => {
    if (view.textarea) view.textarea.value = text;
    patchIdea(ctx, { text });
    clearTooShort(view);
    appliedTemplateId = id;
  };

  const onInput = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement && target.id === 'easy-idea') {
      patchIdea(ctx, { text: target.value });
      clearTooShort(view);
    }
  };

  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.name === 'easy-idea-length' && lengthEnabled(Number(target.value))) {
      patchIdea(ctx, { lengthS: Number(target.value) as EasyState['idea']['lengthS'] });
      return;
    }
    if (target.name === 'easy-idea-shape' && aspectsEnabled(target.value)) {
      patchIdea(ctx, { aspect: target.value });
      return;
    }
    if (target.name === 'easy-idea-look' && looksEnabled(target.value)) {
      patchIdea(ctx, { look: target.value });
      return;
    }
    if (target.name === 'easy-idea-template') {
      const currentText = view.textarea ? view.textarea.value : ctx.store.get().idea.text;
      const plan = templateChangePlan(currentText, target.value, appliedTemplateId);
      if (!plan) return;
      if (!plan.needsConfirm) {
        applyTemplate(plan.text, target.value);
        return;
      }
      void confirmDialog({
        title: COPY.idea.replaceTitle,
        text: COPY.idea.replaceText,
        confirmLabel: COPY.idea.replaceConfirm,
        cancelLabel: COPY.idea.keep,
        opener: target,
      }).then((replace) => {
        if (replace) {
          applyTemplate(plan.text, target.value);
        } else {
          setTemplateChecked(plan.restoreId);
        }
      });
      return;
    }
    if (target.id === 'easy-idea-sound') {
      patchIdea(ctx, { sound: target.checked });
    }
  };

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const retry = target.closest('[data-easy-idea-retry]');
    if (retry) {
      clearBriefError(view);
      void submit(ctx);
    }
  };

  view.root.addEventListener('input', onInput);
  view.root.addEventListener('change', onChange);
  view.root.addEventListener('click', onClick);

  let stopped = false;
  void loadPresets(ctx, view, () => stopped);

  return () => {
    stopped = true;
    view.root.removeEventListener('input', onInput);
    view.root.removeEventListener('change', onChange);
    view.root.removeEventListener('click', onClick);
    stopReferences();
  };
}

// UI2-11: Wide single-column layout on wide screens (>=1000px) handled via .easy-main in easy.css.
export const step: EasyStepModule = {
  id: 'idea',
  heading: COPY.idea.heading,
  intro: COPY.idea.intro,

  primaryLabel() {
    return COPY.idea.continue;
  },

  render(state: EasyState, _facts: StepFacts, options: RenderOptions | 'tooShort' = {}): string {
    const tooShort = options === 'tooShort' || options?.error === 'tooShort';
    const textareaValue = escapeHtml(state.idea.text);
    const errorText = tooShort ? escapeHtml(COPY.idea.tooShort) : '';
    const busy = state.questionsAsked && state.questions.length > 0 ? ' data-easy-idea-waiting="1"' : '';
    return `<div class="easy-idea"${busy}>
  <div class="easy-idea-field">
    <label class="easy-idea-label" for="easy-idea">${escapeHtml(COPY.idea.label)}</label>
    <textarea class="easy-idea-input" id="easy-idea" name="idea" rows="4" placeholder="${escapeAttr(COPY.idea.placeholder)}" aria-describedby="easy-idea-too-short">${textareaValue}</textarea>
    <p class="easy-idea-error" id="easy-idea-too-short" role="alert">${errorText}</p>
  </div>
  ${templateChips()}
  <div class="easy-idea-segments">
    ${lengthSegments(state)}
    ${shapeSegments(state)}
  </div>
  ${lookCards(state)}
  <div class="easy-idea-error-host" data-easy-idea-error></div>
  <div class="easy-idea-questions" data-easy-questions></div>
  ${moreOptions(state)}
</div>`;
  },

  bind(el: HTMLElement, ctx: EasyStepContext): () => void {
    const view: IdeaView = {
      root: el,
      textarea: el.querySelector<HTMLTextAreaElement>('#easy-idea'),
      error: el.querySelector<HTMLElement>('#easy-idea-too-short'),
      questions: el.querySelector<HTMLElement>('[data-easy-questions]'),
      busy: false,
    };
    activeView = view;
    const stop = bindEvents(view, ctx);
    let stopQuestions = (): void => {};
    const state = ctx.store.get();
    if (view.questions && state.questions.length > 0) {
      view.questions.innerHTML = renderQuestions(state.questions, state.answers);
      stopQuestions = bindQuestions(view.questions, {
        onChange: (answers) => ctx.store.patch({ answers }),
      });
    }
    return () => {
      stopQuestions();
      stop();
      if (activeView === view) activeView = null;
    };
  },

  async onPrimary(ctx: EasyStepContext): Promise<void> {
    await submit(ctx);
  },
};
