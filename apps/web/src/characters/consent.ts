export const KIND_FICTIONAL = 'fictional' as const;
export const KIND_REAL_AUTHORIZED = 'real_authorized' as const;

export type ConsentKind = typeof KIND_FICTIONAL | typeof KIND_REAL_AUTHORIZED;

export const CONSENT_KINDS: readonly ConsentKind[] = Object.freeze([
  KIND_FICTIONAL,
  KIND_REAL_AUTHORIZED,
]);

export const KIND_LABELS: Readonly<Record<ConsentKind, string>> = Object.freeze({
  [KIND_FICTIONAL]: 'Fictional character',
  [KIND_REAL_AUTHORIZED]: 'Real person',
});

export const KIND_CHOICES: readonly { id: ConsentKind; label: string; hint: string }[] = Object.freeze([
  {
    id: KIND_FICTIONAL,
    label: KIND_LABELS[KIND_FICTIONAL],
    hint: 'A made-up character, mascot or creature.',
  },
  {
    id: KIND_REAL_AUTHORIZED,
    label: KIND_LABELS[KIND_REAL_AUTHORIZED],
    hint: 'A likeness of a real person. Written permission is required.',
  },
]);

export const LIKENESS_WARNING =
  'You are adding a likeness of a real person. Only continue if you have that person\'s written permission to use their face, name and likeness in this video. Do not upload photos of someone else, a public figure or a minor without the permission of their parent or guardian.';

export const CONSENT_CHECKBOX_LABEL =
  'I have written permission from this person to use their likeness in this character and the videos made with it. I understand I am responsible for that permission.';

export const CONSENT_REQUIRED_MESSAGE =
  'Confirm that you have permission to use this person\'s likeness before saving.';

export const CONSENT_INVALID_MESSAGE =
  'The consent record is incomplete. Add who gave permission and try again.';

export const CONSENT_SAVED_MESSAGE = 'Consent recorded. Save is enabled.';

export const CONSENT_REQUIRED_CODE = 'CHAR_CONSENT_REQUIRED';
export const CONSENT_INVALID_CODE = 'CHAR_CONSENT_INVALID';
export const KIND_UNSUPPORTED_CODE = 'CHAR_KIND_UNSUPPORTED';

export const DEFAULT_ASSERTED_BY = 'self';
export const DEFAULT_SCOPE = 'character_likeness';
export const MAX_ASSERTED_BY_CHARS = 200;
export const MAX_SCOPE_CHARS = 200;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export type LikenessConsent = Readonly<{
  assertedBy: string;
  assertedAt: string;
  scope: string;
  likenessWarningShown: true;
}>;

export type ConsentState = {
  kind: ConsentKind;
  consentRequired: boolean;
  warningVisible: boolean;
  checked: boolean;
  assertedBy: string;
  assertedAt: string;
  scope: string;
  message: string;
  messageError: boolean;
};

export type ConsentValidation = {
  ok: boolean;
  code: string;
  message: string;
  consent: LikenessConsent | null;
};

export type ConsentClock = () => string | number | Date;

export type ConsentOptions = {
  kind?: string;
  consent?: unknown;
  assertedBy?: string;
  scope?: string;
  clock?: ConsentClock;
  onChange?: (state: ConsentState) => void;
};

export type ConsentFields = {
  kind: ConsentKind;
  consent?: LikenessConsent;
};

export class ConsentError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConsentError';
    this.code = code;
  }
}

type Listener = (state: ConsentState) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isoFrom(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('clock must return a valid date');
  return date.toISOString();
}

function defaultNow(): string {
  return new Date().toISOString();
}

function readClock(clock: ConsentClock | undefined): string {
  return isoFrom(clock ? clock() : defaultNow());
}

export function isConsentKind(value: unknown): value is ConsentKind {
  return value === KIND_FICTIONAL || value === KIND_REAL_AUTHORIZED;
}

export function normalizeConsentKind(value: unknown): ConsentKind {
  const kind = typeof value === 'string' ? value.trim() : '';
  if (!isConsentKind(kind)) {
    throw new ConsentError(KIND_UNSUPPORTED_CODE, `${KIND_UNSUPPORTED_CODE}: kind must be 'fictional' or 'real_authorized'`);
  }
  return kind;
}

export function consentRequiredFor(kind: unknown): boolean {
  return kind === KIND_REAL_AUTHORIZED;
}

export function consentMessageFor(kind: unknown): string {
  return consentRequiredFor(kind) ? CONSENT_REQUIRED_MESSAGE : '';
}

export function emptyConsentState(kind: unknown = KIND_FICTIONAL): ConsentState {
  const normalized = normalizeConsentKind(kind);
  const required = normalized === KIND_REAL_AUTHORIZED;
  return {
    kind: normalized,
    consentRequired: required,
    warningVisible: required,
    checked: false,
    assertedBy: DEFAULT_ASSERTED_BY,
    assertedAt: '',
    scope: DEFAULT_SCOPE,
    message: required ? CONSENT_REQUIRED_MESSAGE : '',
    messageError: required,
  };
}

function textField(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max || CONTROL_CHARS_RE.test(text)) return '';
  return text;
}

export function validateConsentRecord(value: unknown): ConsentValidation {
  if (value === undefined || value === null) {
    return {
      ok: false,
      code: CONSENT_REQUIRED_CODE,
      message: CONSENT_REQUIRED_MESSAGE,
      consent: null,
    };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      code: CONSENT_INVALID_CODE,
      message: CONSENT_INVALID_MESSAGE,
      consent: null,
    };
  }
  const assertedBy = textField(value.assertedBy, MAX_ASSERTED_BY_CHARS);
  const scope = textField(value.scope, MAX_SCOPE_CHARS);
  const assertedAt = typeof value.assertedAt === 'string' ? value.assertedAt.trim() : '';
  const assertedTime = assertedAt ? new Date(assertedAt).getTime() : Number.NaN;
  if (!assertedBy || !scope || Number.isNaN(assertedTime) || value.likenessWarningShown !== true) {
    return {
      ok: false,
      code: CONSENT_INVALID_CODE,
      message: CONSENT_INVALID_MESSAGE,
      consent: null,
    };
  }
  return {
    ok: true,
    code: '',
    message: '',
    consent: Object.freeze({
      assertedBy,
      assertedAt: new Date(assertedTime).toISOString(),
      scope,
      likenessWarningShown: true as const,
    }),
  };
}

export function validateConsent(kind: unknown, consent: unknown): ConsentValidation {
  if (!isConsentKind(kind)) {
    return {
      ok: false,
      code: KIND_UNSUPPORTED_CODE,
      message: `${KIND_UNSUPPORTED_CODE}: kind must be 'fictional' or 'real_authorized'`,
      consent: null,
    };
  }
  if (kind === KIND_FICTIONAL) {
    return { ok: true, code: '', message: '', consent: null };
  }
  return validateConsentRecord(consent);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function consentRecordFor(state: ConsentState, clock?: ConsentClock): LikenessConsent | null {
  if (state.kind === KIND_FICTIONAL || !state.checked) return null;
  const assertedBy = textField(state.assertedBy, MAX_ASSERTED_BY_CHARS) || DEFAULT_ASSERTED_BY;
  const scope = textField(state.scope, MAX_SCOPE_CHARS) || DEFAULT_SCOPE;
  const assertedAt = state.assertedAt || readClock(clock);
  const result = validateConsentRecord({
    assertedBy,
    assertedAt,
    scope,
    likenessWarningShown: state.warningVisible === true,
  });
  return result.ok ? result.consent : null;
}

export function consentForState(state: ConsentState, clock?: ConsentClock): ConsentValidation {
  if (state.kind === KIND_FICTIONAL) {
    return { ok: true, code: '', message: '', consent: null };
  }
  if (!state.checked) {
    return {
      ok: false,
      code: CONSENT_REQUIRED_CODE,
      message: CONSENT_REQUIRED_MESSAGE,
      consent: null,
    };
  }
  const consent = consentRecordFor(state, clock);
  if (!consent) {
    return {
      ok: false,
      code: CONSENT_INVALID_CODE,
      message: CONSENT_INVALID_MESSAGE,
      consent: null,
    };
  }
  return { ok: true, code: '', message: '', consent };
}

export class CharacterConsentController {
  state: ConsentState;
  clock?: ConsentClock;
  listeners: Set<Listener>;
  onChange?: (state: ConsentState) => void;
  destroyed: boolean;

  constructor(options: ConsentOptions = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('CharacterConsentController requires an options object');
    }
    this.clock = options.clock;
    this.listeners = new Set();
    this.onChange = options.onChange;
    this.destroyed = false;

    const inferredKind = options.consent !== undefined && options.consent !== null
      ? KIND_REAL_AUTHORIZED
      : undefined;
    const kind = normalizeConsentKind(options.kind ?? inferredKind ?? KIND_FICTIONAL);
    this.state = emptyConsentState(kind);
    if (typeof options.assertedBy === 'string' && options.assertedBy.trim()) {
      this.state.assertedBy = options.assertedBy.trim().slice(0, MAX_ASSERTED_BY_CHARS);
    }
    if (typeof options.scope === 'string' && options.scope.trim()) {
      this.state.scope = options.scope.trim().slice(0, MAX_SCOPE_CHARS);
    }

    if (kind === KIND_REAL_AUTHORIZED && options.consent !== undefined && options.consent !== null) {
      const existing = validateConsentRecord(options.consent);
      if (existing.ok && existing.consent) {
        this.state.checked = true;
        this.state.assertedBy = existing.consent.assertedBy;
        this.state.assertedAt = existing.consent.assertedAt;
        this.state.scope = existing.consent.scope;
        this.state.message = CONSENT_SAVED_MESSAGE;
        this.state.messageError = false;
      } else {
        this.state.message = existing.message;
        this.state.messageError = true;
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): ConsentState {
    return clone(this.state);
  }

  getState(): ConsentState {
    return this.snapshot();
  }

  notify(): void {
    if (this.destroyed) return;
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { }
    }
    try { this.onChange?.(snapshot); } catch { }
  }

  setKind(kind: unknown): boolean {
    const next = normalizeConsentKind(kind);
    if (next === this.state.kind) return false;
    const wasFictional = this.state.kind === KIND_FICTIONAL;
    this.state.kind = next;
    this.state.consentRequired = next === KIND_REAL_AUTHORIZED;
    this.state.warningVisible = next === KIND_REAL_AUTHORIZED;
    this.state.checked = false;
    this.state.assertedAt = '';
    if (next === KIND_REAL_AUTHORIZED) {
      this.state.message = CONSENT_REQUIRED_MESSAGE;
      this.state.messageError = true;
    } else {
      this.state.message = '';
      this.state.messageError = false;
      if (wasFictional) this.state.assertedBy = DEFAULT_ASSERTED_BY;
    }
    this.notify();
    return true;
  }

  chooseRealPerson(): boolean {
    return this.setKind(KIND_REAL_AUTHORIZED);
  }

  chooseFictional(): boolean {
    return this.setKind(KIND_FICTIONAL);
  }

  setRealPerson(value: boolean): boolean {
    return this.setKind(value ? KIND_REAL_AUTHORIZED : KIND_FICTIONAL);
  }

  setChecked(value: boolean): boolean {
    if (this.state.kind === KIND_FICTIONAL) return false;
    const checked = value === true;
    if (checked === this.state.checked) return false;
    this.state.checked = checked;
    if (checked) {
      this.state.assertedAt = readClock(this.clock);
      this.state.message = CONSENT_SAVED_MESSAGE;
      this.state.messageError = false;
    } else {
      this.state.assertedAt = '';
      this.state.message = CONSENT_REQUIRED_MESSAGE;
      this.state.messageError = true;
    }
    this.notify();
    return true;
  }

  setConsentChecked(value: boolean): boolean {
    return this.setChecked(value);
  }

  acknowledgeConsent(value = true): boolean {
    return this.setChecked(value);
  }

  setAssertedBy(value: unknown): boolean {
    const text = typeof value === 'string' ? value.slice(0, MAX_ASSERTED_BY_CHARS) : '';
    if (text === this.state.assertedBy) return false;
    this.state.assertedBy = text;
    this.notify();
    return true;
  }

  setScope(value: unknown): boolean {
    const text = typeof value === 'string' ? value.slice(0, MAX_SCOPE_CHARS) : '';
    if (text === this.state.scope) return false;
    this.state.scope = text;
    this.notify();
    return true;
  }

  applyConsent(kind: unknown, consent: unknown): boolean {
    const next = normalizeConsentKind(kind);
    this.state.kind = next;
    this.state.consentRequired = next === KIND_REAL_AUTHORIZED;
    this.state.warningVisible = next === KIND_REAL_AUTHORIZED;
    this.state.checked = false;
    this.state.assertedAt = '';
    this.state.message = next === KIND_REAL_AUTHORIZED ? CONSENT_REQUIRED_MESSAGE : '';
    this.state.messageError = next === KIND_REAL_AUTHORIZED;
    if (next === KIND_REAL_AUTHORIZED && consent !== undefined && consent !== null) {
      const result = validateConsentRecord(consent);
      if (result.ok && result.consent) {
        this.state.checked = true;
        this.state.assertedBy = result.consent.assertedBy;
        this.state.assertedAt = result.consent.assertedAt;
        this.state.scope = result.consent.scope;
        this.state.message = CONSENT_SAVED_MESSAGE;
        this.state.messageError = false;
      } else {
        this.state.message = result.message;
        this.state.messageError = true;
      }
    }
    this.notify();
    return this.canSave();
  }

  clearConsent(): boolean {
    return this.setChecked(false);
  }

  validate(): ConsentValidation {
    return consentForState(this.state, this.clock);
  }

  canSave(): boolean {
    return this.validate().ok;
  }

  isSaveBlocked(): boolean {
    return !this.canSave();
  }

  saveBlockedReason(): string {
    const result = this.validate();
    return result.ok ? '' : result.message;
  }

  consentRecord(): LikenessConsent | null {
    return this.validate().consent;
  }

  assertCanSave(): void {
    const result = this.validate();
    if (!result.ok) throw new ConsentError(result.code, result.message);
  }

  fields(): ConsentFields {
    const result = this.validate();
    if (this.state.kind === KIND_FICTIONAL) return { kind: KIND_FICTIONAL };
    if (!result.ok || !result.consent) {
      throw new ConsentError(result.code, result.message);
    }
    return { kind: KIND_REAL_AUTHORIZED, consent: result.consent };
  }

  toCharacterFields(): ConsentFields {
    return this.fields();
  }

  render(): string {
    return renderConsentSection(this.getState());
  }

  toHTML(): string {
    return this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
}

export const ConsentController = CharacterConsentController;
export const CharacterConsent = CharacterConsentController;

export function createConsentController(options: ConsentOptions = {}): CharacterConsentController {
  return new CharacterConsentController(options);
}

export const createConsent = createConsentController;

export type ConsentRenderOptions = {
  idPrefix?: string;
  showKindChoice?: boolean;
  fictionalNotice?: string;
};

export function renderConsentSection(
  state: ConsentState,
  options: ConsentRenderOptions = {},
): string {
  const value = state && typeof state === 'object' && isConsentKind(state.kind)
    ? state
    : emptyConsentState();
  const idPrefix = options.idPrefix ?? 'chr-consent';
  const warningId = `${idPrefix}-warning`;
  const statusId = `${idPrefix}-status`;
  const showKindChoice = options.showKindChoice !== false;

  const chooser = showKindChoice
    ? `<fieldset class="chr-consent-kind" data-consent-kind-choice>
        <legend>Character type</legend>
        ${KIND_CHOICES.map(choice => `<label class="chr-check">
          <input type="radio" name="${escapeHtml(idPrefix)}-kind" value="${escapeHtml(choice.id)}" data-consent-kind${choice.id === value.kind ? ' checked' : ''}>
          <span><strong>${escapeHtml(choice.label)}.</strong> ${escapeHtml(choice.hint)}</span>
        </label>`).join('')}
      </fieldset>`
    : '';

  if (value.kind === KIND_FICTIONAL) {
    const notice = options.fictionalNotice
      ? `<p class="chr-hint" data-consent-fictional-notice>${escapeHtml(options.fictionalNotice)}</p>`
      : '';
    return `<div class="chr-consent" data-consent-section data-kind="${KIND_FICTIONAL}">${chooser}${notice}</div>`;
  }

  const status = value.checked
    ? CONSENT_SAVED_MESSAGE
    : value.message || CONSENT_REQUIRED_MESSAGE;
  const statusClass = value.checked ? 'chr-hint' : 'chr-hint chr-hint-error';

  return `<div class="chr-consent" data-consent-section data-kind="${KIND_REAL_AUTHORIZED}">
    ${chooser}
    <div class="chr-likeness-warning" data-likeness-warning id="${escapeHtml(warningId)}" role="alert">
      <strong>Likeness warning.</strong> ${escapeHtml(LIKENESS_WARNING)}
    </div>
    <div class="chr-field-grid">
      <label class="chr-field">Asserted by<input data-consent-asserted-by maxlength="${MAX_ASSERTED_BY_CHARS}" autocomplete="off" value="${escapeHtml(value.assertedBy)}"></label>
      <label class="chr-field">Scope<input data-consent-scope maxlength="${MAX_SCOPE_CHARS}" autocomplete="off" value="${escapeHtml(value.scope)}"></label>
    </div>
    <label class="chr-check chr-consent-check">
      <input type="checkbox" data-consent-checkbox name="${escapeHtml(idPrefix)}-consent" required aria-required="true" aria-describedby="${escapeHtml(warningId)} ${escapeHtml(statusId)}"${value.checked ? ' checked' : ''}>
      <span>${escapeHtml(CONSENT_CHECKBOX_LABEL)}</span>
    </label>
    <p class="${statusClass}" id="${escapeHtml(statusId)}" data-consent-status role="status">${escapeHtml(status)}</p>
  </div>`;
}

export const renderConsent = renderConsentSection;
export const renderLikenessConsent = renderConsentSection;
export const renderConsentField = renderConsentSection;

export type ConsentMountOptions = ConsentOptions & {
  controller?: CharacterConsentController;
  idPrefix?: string;
  showKindChoice?: boolean;
  fictionalNotice?: string;
};

export type ConsentMountHandle = {
  controller: CharacterConsentController;
  render: () => void;
  destroy: () => void;
};

export function mountConsentSection(
  element: HTMLElement,
  options: ConsentMountOptions = {},
): ConsentMountHandle {
  if (!element || typeof element.addEventListener !== 'function') {
    throw new TypeError('mountConsentSection requires a DOM element');
  }
  const controller = options.controller ?? new CharacterConsentController(options);
  const root = element;

  const render = () => {
    root.innerHTML = renderConsentSection(controller.getState(), {
      idPrefix: options.idPrefix,
      showKindChoice: options.showKindChoice,
      fictionalNotice: options.fictionalNotice,
    });
  };

  const onChange = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target || !target.dataset) return;
    if (target.dataset.consentKind !== undefined) {
      controller.setKind(target.value);
      return;
    }
    if (target.dataset.consentCheckbox !== undefined) {
      controller.setChecked(target.checked);
    }
  };

  const onInput = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target || !target.dataset) return;
    if (target.dataset.consentAssertedBy !== undefined) controller.setAssertedBy(target.value);
    else if (target.dataset.consentScope !== undefined) controller.setScope(target.value);
  };

  const unsubscribe = controller.subscribe(render);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  render();

  return {
    controller,
    render,
    destroy: () => {
      root.removeEventListener('change', onChange);
      root.removeEventListener('input', onInput);
      unsubscribe();
      controller.destroy();
      root.innerHTML = '';
    },
  };
}

export const mountConsent = mountConsentSection;
export default CharacterConsentController;
