import { COPY } from './copy.ts';

export type BannerTone = 'info' | 'warn' | 'danger' | 'success';
export type ButtonKind = 'primary' | 'secondary' | 'link' | 'danger';

export type DataAttributes = Record<string, string | number | boolean | null | undefined>;

export interface EasyAction {
  label: string;
  value?: string;
  kind?: ButtonKind;
  data?: DataAttributes;
}

export interface BannerModel {
  tone: BannerTone;
  text: string;
  actions?: EasyAction[];
}

export interface EmptyStateModel {
  text: string;
  actions: EasyAction[];
}

export interface ErrorStateModel {
  what: string;
  why?: string;
  action: EasyAction;
}

export interface ChoiceOption {
  value: string;
  title: string;
  body?: string;
  disabled?: boolean;
  extra?: string;
}

export interface ChoiceCardsModel {
  name: string;
  legend: string;
  options: ChoiceOption[];
  value: string;
}

export interface SegmentedModel {
  name: string;
  legend: string;
  options: ChoiceOption[];
  value: string;
}

export interface ChipModel {
  label: string;
  pressed?: boolean;
  data: DataAttributes;
}

export interface ProgressBarModel {
  label: string;
  value: number;
}

export interface ButtonModel {
  label: string;
  kind: ButtonKind;
  data: DataAttributes;
  disabled?: boolean;
  reasonId?: string;
}

const BUTTON_CLASSES: Record<ButtonKind, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  link: 'btn btn-ghost easy-button-link',
  danger: 'btn btn-danger',
};

export function buttonClassName(kind: ButtonKind): string {
  return BUTTON_CLASSES[safeKind(kind)];
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] as string);
}

function safeTone(tone: BannerTone): BannerTone {
  return tone === 'warn' || tone === 'danger' || tone === 'success' ? tone : 'info';
}

function safeKind(kind: ButtonKind): ButtonKind {
  return kind === 'primary' || kind === 'link' || kind === 'danger' ? kind : 'secondary';
}

function attributeName(key: string): string {
  const base = key.startsWith('data-') ? key.slice(5) : key;
  return `data-${base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .toLowerCase()}`;
}

function dataAttributes(data: DataAttributes | undefined): string {
  if (!data) return '';
  return Object.entries(data)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ` ${attributeName(key)}="${escapeHtml(value)}"`)
    .join('');
}

function renderAction(action: EasyAction, fallbackKind: ButtonKind = 'secondary'): string {
  return renderButton({
    label: action.label,
    kind: action.kind ?? fallbackKind,
    data: action.data ?? {},
  });
}

function renderOptions(
  options: ChoiceOption[],
  name: string,
  value: string,
  cardClass: string,
  inputClass: string,
  titleClass: string,
  bodyClass: string,
  extraClass: string,
): string {
  return options.map((option) => {
    const checked = option.value === value ? ' checked' : '';
    const disabled = option.disabled ? ' disabled' : '';
    const body = option.body ? `<span class="${bodyClass}">${escapeHtml(option.body)}</span>` : '';
    const extra = option.extra ? `<span class="${extraClass}">${escapeHtml(option.extra)}</span>` : '';
    return `<label class="${cardClass}${option.disabled ? ' easy-is-disabled' : ''}"><input class="${inputClass}" type="radio" name="${escapeHtml(name)}" value="${escapeHtml(option.value)}"${checked}${disabled} /><span class="${titleClass}">${escapeHtml(option.title)}</span>${body}${extra}</label>`;
  }).join('');
}

export function renderBanner({ tone, text, actions = [] }: BannerModel): string {
  const toneName = safeTone(tone);
  const role = toneName === 'danger' ? 'alert' : 'status';
  const actionHtml = actions.length
    ? `<div class="easy-banner-actions">${actions.map((action) => renderAction(action)).join('')}</div>`
    : '';
  return `<div class="easy-banner easy-banner-${toneName}" role="${role}" data-easy-banner-tone="${toneName}"><p class="easy-banner-text">${escapeHtml(text)}</p>${actionHtml}</div>`;
}

export function renderEmptyState({ text, actions = [] }: EmptyStateModel): string {
  const actionHtml = actions.length
    ? `<div class="easy-empty-actions">${actions.map((action) => renderAction(action)).join('')}</div>`
    : '';
  return `<div class="easy-empty"><p class="easy-empty-text">${escapeHtml(text)}</p>${actionHtml}</div>`;
}

export function renderErrorState({ what, why, action }: ErrorStateModel): string {
  const details = why
    ? `<details class="easy-error-why"><summary>${COPY.errors.details}</summary><p>${escapeHtml(why)}</p></details>`
    : '';
  const actionHtml = action ? `<div class="easy-error-action">${renderAction(action)}</div>` : '';
  return `<div class="easy-error" role="alert"><p class="easy-error-what">${escapeHtml(what)}</p>${details}${actionHtml}</div>`;
}

export function renderSkeleton(rows: number, loadingText: string): string {
  const rowCount = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
  const rowHtml = '<div class="easy-skeleton-row" aria-hidden="true"></div>'.repeat(rowCount);
  return `<div class="easy-skeleton" aria-busy="true" aria-label="${escapeHtml(loadingText)}">${rowHtml}</div>`;
}

export function renderChoiceCards({ name, legend, options, value }: ChoiceCardsModel): string {
  return `<fieldset class="easy-choice-cards"><legend class="easy-choice-legend">${escapeHtml(legend)}</legend><div class="easy-choice-grid">${renderOptions(
    options,
    name,
    value,
    'easy-choice-card',
    'easy-choice-input',
    'easy-choice-title',
    'easy-choice-body',
    'easy-choice-extra',
  )}</div></fieldset>`;
}

export function renderSegmented({ name, legend, options, value }: SegmentedModel): string {
  return `<fieldset class="easy-segmented"><legend class="easy-segment-legend">${escapeHtml(legend)}</legend><div class="easy-segment-row">${renderOptions(
    options,
    name,
    value,
    'easy-segment',
    'easy-segment-input',
    'easy-segment-title',
    'easy-segment-body',
    'easy-segment-extra',
  )}</div></fieldset>`;
}

export function renderChip({ label, pressed, data }: ChipModel): string {
  const pressedAttribute = typeof pressed === 'boolean' ? ` aria-pressed="${pressed ? 'true' : 'false'}"` : '';
  return `<button type="button" class="easy-chip"${dataAttributes(data)}${pressedAttribute}>${escapeHtml(label)}</button>`;
}

export function renderProgressBar({ label, value }: ProgressBarModel): string {
  const numeric = Number(value);
  const now = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
  return `<div class="easy-progress" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${now}"><div class="easy-progress-fill" style="width: ${now}%"></div></div>`;
}

export function renderButton({ label, kind, data, disabled = false, reasonId }: ButtonModel): string {
  const disabledAttribute = disabled ? ' disabled' : '';
  const describedBy = disabled && reasonId ? ` aria-describedby="${escapeHtml(reasonId)}"` : '';
  return `<button type="button" class="${buttonClassName(kind)}"${dataAttributes(data)}${disabledAttribute}${describedBy}>${escapeHtml(label)}</button>`;
}
