import { COPY } from './copy.ts';
import { escapeHtml } from './components.ts';
import { createProjectChat } from '../project-chat.ts';
import type { EasyHost, EasyState } from './types.ts';

const ASK_OPEN_ERROR = 'We couldn’t open Ask for changes. Close and try again.';

export interface AskDrawerView {
  hasProvider: boolean;
  projectChatHtml?: string;
  error?: string | null;
}

export interface AskDrawerOptions {
  root: HTMLElement;
  state: Pick<EasyState, 'chatId' | 'packageId'>;
  host: EasyHost;
  log?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export interface AskDrawerController {
  openAsk(prefill?: string): Promise<void>;
  close(): void;
}

type ProjectChat = ReturnType<typeof createProjectChat>;
type AiSelection = Awaited<ReturnType<EasyHost['aiSelection']>>;

export function renderAskDrawer({
  hasProvider,
  projectChatHtml = '',
  error = null,
}: AskDrawerView): string {
  const body = error
    ? `<p class="easy-ask-error" role="alert">${escapeHtml(error)}</p>`
    : hasProvider
      ? `<div class="easy-ask-chat" data-easy-ask-chat>${projectChatHtml}</div>`
      : `<div class="easy-ask-no-provider"><p>${escapeHtml(COPY.ask.noProvider)}</p><button type="button" class="btn btn-secondary" data-easy-ask-connect>${escapeHtml(COPY.ask.connect)}</button></div>`;
  return `<aside class="easy-ask-drawer" data-easy-ask-drawer aria-labelledby="easy-ask-title"><header class="easy-ask-header"><h2 class="easy-ask-title" id="easy-ask-title">${escapeHtml(COPY.ask.title)}</h2><button type="button" class="btn btn-ghost easy-ask-close" data-easy-ask-close>${escapeHtml(COPY.ask.close)}</button></header><div class="easy-ask-body">${body}</div></aside>`;
}

function connectedProvider(selection: AiSelection): { provider: string; model: string } | null {
  if (!selection || typeof selection.provider !== 'string') return null;
  const provider = selection.provider.trim();
  if (!provider || provider === 'none') return null;
  const model = typeof selection.model === 'string' ? selection.model.trim() : '';
  return { provider, model };
}

export function createAskDrawer(options: AskDrawerOptions): AskDrawerController {
  const document = options.root.ownerDocument;
  let aside: HTMLElement | null = null;
  let chat: ProjectChat | null = null;
  let opener: HTMLElement | null = null;
  let operation = 0;

  function requiredElement<T extends HTMLElement>(selector: string): T {
    const element = aside?.querySelector<T>(selector);
    if (!element) throw new Error(ASK_OPEN_ERROR);
    return element;
  }

  function onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !aside) return;
    const build = target.closest('#project-plan-build');
    if (build && aside.contains(build)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const closeButton = target.closest('[data-easy-ask-close]');
    if (closeButton && aside.contains(closeButton)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    const connect = target.closest('[data-easy-ask-connect]');
    if (connect && aside.contains(connect)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        options.host.openAgentSettings();
      } catch (error) {
        showError(error);
      }
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function removeDrawer(restoreFocus: boolean): void {
    const hadDrawer = aside !== null;
    const previousOpener = opener;
    chat?.destroy();
    chat = null;
    if (aside) {
      aside.removeEventListener('click', onClick, true);
      aside.removeEventListener('keydown', onKeyDown);
      aside.remove();
      aside = null;
    }
    opener = null;
    if (restoreFocus && hadDrawer) previousOpener?.focus();
  }

  function close(): void {
    operation += 1;
    removeDrawer(true);
  }

  function paint(view: AskDrawerView): void {
    const previous = aside;
    chat?.destroy();
    chat = null;
    if (previous) {
      previous.removeEventListener('click', onClick, true);
      previous.removeEventListener('keydown', onKeyDown);
    }
    const template = document.createElement('template');
    template.innerHTML = renderAskDrawer(view);
    const next = template.content.firstElementChild;
    if (!(next instanceof HTMLElement) || next.tagName !== 'ASIDE') throw new Error(ASK_OPEN_ERROR);
    aside = next;
    aside.addEventListener('click', onClick, true);
    aside.addEventListener('keydown', onKeyDown);
    if (previous) previous.replaceWith(aside);
    else options.root.append(aside);
  }

  function showError(error: unknown): void {
    paint({ hasProvider: false, error: ASK_OPEN_ERROR });
    requiredElement<HTMLButtonElement>('[data-easy-ask-close]').focus();
    options.log?.(ASK_OPEN_ERROR);
    options.onError?.(error);
  }

  async function providerForChat(): Promise<{ provider: string; model: string }> {
    const selection = connectedProvider(await options.host.aiSelection());
    if (!selection) throw new Error(COPY.ask.noProvider);
    return selection;
  }

  function focusComposer(prefill: string): void {
    if (!chat) throw new Error(ASK_OPEN_ERROR);
    if (prefill) {
      chat.prefill(prefill);
      return;
    }
    requiredElement<HTMLTextAreaElement>('[data-project-chat-input]').focus();
  }

  async function openAsk(prefill = ''): Promise<void> {
    if (aside && chat) {
      focusComposer(prefill);
      return;
    }
    if (aside) removeDrawer(false);
    const active = document.activeElement;
    opener = active instanceof HTMLElement ? active : null;
    const current = ++operation;
    let selection: { provider: string; model: string } | null;
    try {
      selection = connectedProvider(await options.host.aiSelection());
    } catch (error) {
      if (current === operation) showError(error);
      return;
    }
    if (current !== operation) return;
    try {
      paint({ hasProvider: selection !== null });
      if (!selection) {
        requiredElement<HTMLButtonElement>('[data-easy-ask-connect]').focus();
        return;
      }
      const chatHost = requiredElement<HTMLElement>('[data-easy-ask-chat]');
      chat = createProjectChat(chatHost, {
        apiFetch: (input, init) => options.host.apiFetch(input, init),
        applyProject: (project) => options.host.adoptBuiltPackage(project),
        provider: providerForChat,
        log: (message) => options.log?.(message),
        restoreSaved: false,
        ...(options.state.chatId ? { initialConversationId: options.state.chatId } : {}),
        ...(options.state.packageId ? { expectedPackageId: options.state.packageId } : {}),
      });
      focusComposer(prefill);
    } catch (error) {
      if (current === operation) showError(error);
    }
  }

  return { openAsk, close };
}
