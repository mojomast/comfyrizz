import { COPY } from '../copy.ts';
import { escapeHtml } from '../components.ts';
import type { EasyQuestion } from '../types.ts';

export const DECIDE_VALUE = '__decide__';

export type QuestionAnswers = Record<string, string>;
export type QuestionDecisions = Record<string, string>;

export interface BindQuestionsOptions {
  onChange?: (answers: QuestionAnswers) => void;
}

function optionLabel(value: string): string {
  if (value.toLowerCase() === 'none') return COPY.questions.none;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function checkedOption(question: EasyQuestion, answers: QuestionAnswers): string | null {
  const answer = answers[question.id];
  if (typeof answer !== 'string' || answer === '' || answer === DECIDE_VALUE) return null;
  return question.options.includes(answer) ? answer : null;
}

function renderQuestion(question: EasyQuestion, answers: QuestionAnswers): string {
  const id = escapeHtml(question.id);
  const name = `easy-q-${id}`;
  const selected = checkedOption(question, answers);
  const options = question.options.map((option, index) => {
    const checked = option === selected ? ' checked' : '';
    return `<label class="easy-question-option" for="${name}-${index}"><input type="radio" id="${name}-${index}" name="${name}" value="${escapeHtml(option)}"${checked} /><span>${escapeHtml(optionLabel(option))}</span></label>`;
  }).join('');
  const decideChecked = selected === null ? ' checked' : '';
  return `<fieldset class="easy-question" data-easy-question-id="${id}">
  <legend>${escapeHtml(question.prompt)}</legend>
  <div class="easy-question-options">
    ${options}
    <label class="easy-question-option" for="${name}-decide"><input type="radio" id="${name}-decide" name="${name}" value="${DECIDE_VALUE}" data-easy-decide="1"${decideChecked} /><span>${escapeHtml(COPY.questions.decide)}</span></label>
  </div>
</fieldset>`;
}

export function renderQuestions(questions: readonly EasyQuestion[], answers: QuestionAnswers = {}): string {
  const fields = questions.map((question) => renderQuestion(question, answers)).join('\n');
  return `<section class="easy-questions" aria-labelledby="easy-q-h">
  <h2 id="easy-q-h" tabindex="-1">${escapeHtml(COPY.questions.heading)}</h2>
  ${fields}
</section>`;
}

function questionId(input: HTMLInputElement): string | null {
  const fieldset = input.closest<HTMLElement>('[data-easy-question-id]');
  return fieldset?.getAttribute('data-easy-question-id') || null;
}

export function bindQuestions(el: HTMLElement, options: BindQuestionsOptions = {}): () => void {
  const heading = el.querySelector<HTMLElement>('#easy-q-h');
  if (heading && el.getAttribute('data-easy-questions-bound') !== '1') {
    el.setAttribute('data-easy-questions-bound', '1');
    heading.focus();
  }

  const answers: QuestionAnswers = {};
  for (const input of Array.from(el.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked'))) {
    const id = questionId(input);
    if (id) answers[id] = input.value;
  }

  const onChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'radio') return;
    const id = questionId(input);
    if (!id) return;
    answers[id] = input.value;
    options.onChange?.({ ...answers });
  };

  el.addEventListener('change', onChange);
  return () => el.removeEventListener('change', onChange);
}

export function answersToDecisions(questions: readonly EasyQuestion[], answers: QuestionAnswers = {}): QuestionDecisions {
  const decisions: QuestionDecisions = {};
  for (const question of questions) {
    const value = answers[question.id];
    if (typeof value !== 'string' || value === '' || value === DECIDE_VALUE) continue;
    decisions[question.field] = value;
  }
  return decisions;
}
