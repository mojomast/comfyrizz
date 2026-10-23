import type { StepId } from './types.ts';
import { COPY, fill } from './copy.ts';
import { STEPS, stepIndex } from './steps.ts';
import { escapeHtml } from './components.ts';
import { openDialog } from './dialog.ts';

export const PRIMARY_REASON_ID = 'easy-primary-reason';

const LOGO_LABEL = 'Comfyrizz';
const HELP_CLOSE_LABEL = 'Close';

export interface ShellModel {
  videoName: string;
  saveStatus: string;
}

export interface PrimaryModel {
  label: string;
  disabled?: boolean;
  reason?: string | null;
}

export interface StepView {
  id: StepId;
  heading: string;
  intro?: string;
  bodyHtml: string;
}

export interface ShellDeps {
  onBack(): void;
  onPrimary(): void;
  onHelp?(): void;
  onSettings?(): void;
  onOpenEditor?(): void;
  onNext?(): void;
}

export interface ShellController {
  setStep(step: StepView): void;
  setPrimary(primary: PrimaryModel): void;
  setBack(visible: boolean): void;
  setStatus(text: string): void;
  alert(text: string): void;
  setBanner(html: string): void;
  setVideoName(name: string): void;
  setSaveStatus(text: string): void;
  setNext(handler: (() => void) | null): void;
  destroy(): void;
}

export function renderPrimary({ label, disabled = false, reason }: PrimaryModel): string {
  const hasReason = reason !== null && reason !== undefined && String(reason).length > 0;
  const describedBy = hasReason ? ` aria-describedby="${PRIMARY_REASON_ID}"` : '';
  const disabledAttribute = disabled ? ' disabled' : '';
  return `<button type="button" class="btn btn-primary easy-primary" data-easy-primary${disabledAttribute}${describedBy}>${escapeHtml(label)}</button>`;
}

export function stepAnnouncement(id: StepId): string {
  return fill(COPY.shell.stepAnnounce, {
    n: stepIndex(id) + 1,
    total: STEPS.length,
    name: COPY.steps[id],
  });
}

export function renderShell({ videoName, saveStatus }: ShellModel): string {
  const name = String(videoName ?? '').trim() || COPY.shell.untitled;
  const status = String(saveStatus ?? '').trim() || COPY.shell.saved;
  return `<div class="easy-shell" data-easy-shell>
<header class="easy-header">
<a class="easy-logo" href="/"><span aria-hidden="true">◆</span> ${escapeHtml(LOGO_LABEL)}</a>
<span class="easy-name" data-easy-name>${escapeHtml(name)}</span>
<span class="easy-save" data-easy-save aria-live="polite" aria-atomic="true">${escapeHtml(status)}</span>
<div class="easy-header-actions">
<button type="button" class="btn btn-secondary easy-header-button" data-easy-help>${escapeHtml(COPY.shell.help)}</button>
<button type="button" class="btn btn-secondary easy-header-button" data-easy-settings>${escapeHtml(COPY.shell.settings)}</button>
<button type="button" class="btn btn-secondary easy-header-button" data-easy-open-editor>${escapeHtml(COPY.shell.openEditor)}</button>
</div>
</header>
<div class="easy-stepper-host" data-easy-stepper></div>
<div class="easy-banner-host" data-easy-banner></div>
<main id="easy-main" class="easy-main" tabindex="-1">
<div class="easy-step" data-easy-step>
<h1 class="easy-step-heading" data-easy-heading tabindex="-1"></h1>
<p class="easy-step-intro" data-easy-intro></p>
<div class="easy-step-body" data-easy-body></div>
</div>
</main>
<footer class="easy-actions" data-easy-actions>
<button type="button" class="btn btn-secondary easy-back" data-easy-back hidden>${escapeHtml(COPY.shell.back)}</button>
<p class="easy-status" data-easy-status aria-live="polite" aria-atomic="true"></p>
<p class="easy-reason" data-easy-reason id="${PRIMARY_REASON_ID}"></p>
<button type="button" class="btn btn-primary easy-primary" data-easy-primary hidden disabled></button>
</footer>
<div class="sr-only easy-visually-hidden" data-easy-alert aria-live="assertive" aria-atomic="true"></div>
</div>`;
}

function helpBodyHtml(): string {
  const lines = COPY.help.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  return `<ul class="easy-help-list">${lines}</ul>`;
}

export function mountShell(root: HTMLElement, deps: ShellDeps): ShellController {
  const doc = root.ownerDocument;
  const nameElement = root.querySelector<HTMLElement>('[data-easy-name]');
  const saveElement = root.querySelector<HTMLElement>('[data-easy-save]');
  const headingElement = root.querySelector<HTMLElement>('[data-easy-heading]');
  const introElement = root.querySelector<HTMLElement>('[data-easy-intro]');
  const bodyElement = root.querySelector<HTMLElement>('[data-easy-body]');
  const statusElement = root.querySelector<HTMLElement>('[data-easy-status]');
  const reasonElement = root.querySelector<HTMLElement>('[data-easy-reason]');
  const alertElement = root.querySelector<HTMLElement>('[data-easy-alert]');
  const bannerElement = root.querySelector<HTMLElement>('[data-easy-banner]');
  const backButton = root.querySelector<HTMLButtonElement>('[data-easy-back]');
  const primaryButton = root.querySelector<HTMLButtonElement>('[data-easy-primary]');
  const helpButton = root.querySelector<HTMLButtonElement>('[data-easy-help]');
  const settingsButton = root.querySelector<HTMLButtonElement>('[data-easy-settings]');
  const editorButton = root.querySelector<HTMLButtonElement>('[data-easy-open-editor]');

  let videoName = nameElement?.textContent?.trim() || COPY.shell.untitled;
  let currentStep: StepId | null = null;
  let backVisible = false;
  let primaryEnabled = false;
  let nextHandler = deps.onNext ?? null;

  function setStatus(text: string): void {
    if (statusElement) statusElement.textContent = String(text ?? '');
  }

  function alert(text: string): void {
    if (!alertElement) return;
    alertElement.textContent = '';
    alertElement.textContent = String(text ?? '');
  }

  function setVideoName(name: string): void {
    const next = String(name ?? '').trim() || COPY.shell.untitled;
    videoName = next;
    if (nameElement) nameElement.textContent = next;
    if (currentStep && doc) doc.title = `${COPY.steps[currentStep]} · ${videoName} · Comfyrizz`;
  }

  function setSaveStatus(text: string): void {
    if (saveElement) saveElement.textContent = String(text ?? '');
  }

  function setStep({ id, heading, intro, bodyHtml }: StepView): void {
    currentStep = id;
    if (headingElement) {
      headingElement.setAttribute('tabindex', '-1');
      headingElement.textContent = String(heading ?? '');
    }
    if (introElement) introElement.textContent = String(intro ?? '');
    if (bodyElement) bodyElement.innerHTML = String(bodyHtml ?? '');
    if (doc) doc.title = `${COPY.steps[id]} · ${videoName} · Comfyrizz`;
    setStatus(stepAnnouncement(id));
    if (headingElement) headingElement.focus();
  }

  function setPrimary({ label, disabled = false, reason = null }: PrimaryModel): void {
    if (!primaryButton) {
      primaryEnabled = !disabled;
      return;
    }
    primaryButton.textContent = String(label ?? '');
    primaryButton.disabled = Boolean(disabled);
    primaryButton.hidden = false;
    primaryEnabled = !disabled;
    const hasReason = Boolean(disabled) && reason !== null && reason !== undefined && String(reason).length > 0;
    if (reasonElement) reasonElement.textContent = hasReason ? String(reason) : '';
    if (hasReason) primaryButton.setAttribute('aria-describedby', PRIMARY_REASON_ID);
    else primaryButton.removeAttribute('aria-describedby');
  }

  function setBack(visible: boolean): void {
    backVisible = Boolean(visible);
    if (backButton) backButton.hidden = !backVisible;
  }

  function setBanner(html: string): void {
    if (bannerElement) bannerElement.innerHTML = String(html ?? '');
  }

  function setNext(handler: (() => void) | null): void {
    nextHandler = handler;
  }

  function onHelpClick(): void {
    if (deps.onHelp) {
      deps.onHelp();
      return;
    }
    void openDialog({
      title: COPY.help.title,
      bodyHtml: helpBodyHtml(),
      actions: [{ label: HELP_CLOSE_LABEL, value: 'close', kind: 'secondary' }],
      opener: helpButton ?? root,
    });
  }

  function onSettingsClick(): void {
    deps.onSettings?.();
  }

  function onOpenEditorClick(): void {
    deps.onOpenEditor?.();
  }

  function onPrimaryClick(): void {
    if (!primaryEnabled) return;
    deps.onPrimary();
  }

  function onBackClick(): void {
    if (!backVisible) return;
    deps.onBack();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      if (!primaryEnabled) return;
      event.preventDefault();
      deps.onPrimary();
      return;
    }
    if (!event.altKey) return;
    if (event.key === 'ArrowLeft') {
      if (!backVisible) return;
      event.preventDefault();
      deps.onBack();
      return;
    }
    if (event.key === 'ArrowRight') {
      if (!nextHandler) return;
      event.preventDefault();
      nextHandler();
    }
  }

  helpButton?.addEventListener('click', onHelpClick);
  settingsButton?.addEventListener('click', onSettingsClick);
  editorButton?.addEventListener('click', onOpenEditorClick);
  backButton?.addEventListener('click', onBackClick);
  primaryButton?.addEventListener('click', onPrimaryClick);
  root.addEventListener('keydown', onKeyDown);

  return {
    setStep,
    setPrimary,
    setBack,
    setStatus,
    alert,
    setBanner,
    setVideoName,
    setSaveStatus,
    setNext,
    destroy(): void {
      helpButton?.removeEventListener('click', onHelpClick);
      settingsButton?.removeEventListener('click', onSettingsClick);
      editorButton?.removeEventListener('click', onOpenEditorClick);
      backButton?.removeEventListener('click', onBackClick);
      primaryButton?.removeEventListener('click', onPrimaryClick);
      root.removeEventListener('keydown', onKeyDown);
    },
  };
}
