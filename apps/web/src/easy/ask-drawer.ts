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

/** The live project conversation a drawer instance is allowed to talk to. */
export type AskScope = Pick<EasyState, 'chatId' | 'packageId'> & {
  productionId?: string | null;
};

export type AskStateSource = AskScope | (() => AskScope);

export interface AskDrawerOptions {
  root: HTMLElement;
  state: AskStateSource;
  host: EasyHost;
  /** Opens the visible AI settings surface; falls back to the host trigger. */
  openSettings?: () => void | Promise<void>;
  /** Store subscription used to tear the chat down when the project changes. */
  subscribe?: (listener: () => void) => () => void;
  createChat?: typeof createProjectChat;
  log?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export interface AskDrawerController {
  openAsk(prefill?: string): Promise<void>;
  close(): void;
  refreshScope(): void;
  destroy(): void;
}

type ProjectChat = ReturnType<typeof createProjectChat>;
type AiSelection = Awaited<ReturnType<EasyHost['aiSelection']>>;

/**
 * A chat is canonical only for the conversation and package it was opened
 * against. Any id change makes the previous chat stale, including a change
 * from project A to an unbound new video.
 */
export function askScopeKey(scope: AskScope): string {
  return JSON.stringify([scope.chatId ?? null, scope.packageId ?? null, scope.productionId ?? null]);
}

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

export function connectedProvider(selection: AiSelection): { provider: string; model: string } | null {
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
  let openScope: string | null = null;

  function readScope(): AskScope {
    const value = typeof options.state === 'function' ? options.state() : options.state;
    return {
      chatId: value?.chatId ?? null,
      packageId: value?.packageId ?? null,
      productionId: value?.productionId ?? null,
    };
  }

  function requiredElement<T extends HTMLElement>(selector: string): T {
    const element = aside?.querySelector<T>(selector);
    if (!element) throw new Error(ASK_OPEN_ERROR);
    return element;
  }

  async function openSettings(): Promise<void> {
    try {
      const opened = options.openSettings ? options.openSettings() : options.host.openAgentSettings();
      if (opened && typeof (opened as Promise<void>).then === 'function') {
        await opened;
        // Settings may have connected a provider; ask again for the same project.
        if (aside && !chat) await openAsk();
      }
    } catch (error) {
      showError(error);
    }
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
      void openSettings();
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
    openScope = null;
    if (restoreFocus && hadDrawer && previousOpener && (previousOpener as { isConnected?: boolean }).isConnected !== false) {
      previousOpener.focus();
    }
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
    const holder = document.createElement('div');
    holder.innerHTML = renderAskDrawer(view);
    const next = holder.firstElementChild;
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
    const scope = readScope();
    const scopeKey = askScopeKey(scope);

    if (aside && chat) {
      if (openScope === scopeKey) {
        focusComposer(prefill);
        return;
      }
      removeDrawer(false);
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
    // A project switch while the provider lookup was in flight must not paint
    // or open a conversation for the project that is no longer current.
    if (current !== operation || askScopeKey(readScope()) !== scopeKey) return;
    try {
      paint({ hasProvider: selection !== null });
      openScope = scopeKey;
      if (!selection) {
        requiredElement<HTMLButtonElement>('[data-easy-ask-connect]').focus();
        return;
      }
      const chatHost = requiredElement<HTMLElement>('[data-easy-ask-chat]');
      const createChat = options.createChat ?? createProjectChat;
      chat = createChat(chatHost, {
        apiFetch: (input, init) => options.host.apiFetch(input, init),
        applyProject: (project) => {
          // A late reply from the previous project must never replace the
          // project the user switched to while the turn was in flight.
          if (askScopeKey(readScope()) !== scopeKey) return;
          options.host.adoptBuiltPackage(project);
        },
        provider: providerForChat,
        log: (message) => options.log?.(message),
        restoreSaved: false,
        ...(scope.chatId ? { initialConversationId: scope.chatId } : {}),
        ...(scope.packageId ? { expectedPackageId: scope.packageId } : {}),
      });
      focusComposer(prefill);
    } catch (error) {
      if (current === operation) showError(error);
    }
  }

  function refreshScope(): void {
    if (!aside || openScope === null) return;
    if (openScope === askScopeKey(readScope())) return;
    operation += 1;
    removeDrawer(true);
  }

  const stopScope = options.subscribe?.(() => refreshScope()) ?? null;

  return {
    openAsk,
    close,
    refreshScope,
    destroy(): void {
      operation += 1;
      stopScope?.();
      removeDrawer(false);
    },
  };
}
