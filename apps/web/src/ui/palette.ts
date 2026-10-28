import {
  clearCommands,
  commandShortcut,
  commandTitle,
  defaultCommandRegistry,
  filterCommands,
  getCommands,
  registerCommand,
  resetCommands,
  runCommand,
  type PaletteCommand,
} from '../editor/commands.ts';

export type { PaletteCommand };

export interface PaletteOptions {
  host?: HTMLElement | null;
  document?: Document;
  window?: Window;
  registry?: { list(): PaletteCommand[]; filter(query: string): PaletteCommand[]; register?(command: PaletteCommand): unknown };
  commands?: PaletteCommand[];
  announce?: (message: string) => void;
  onCommand?: (command: PaletteCommand) => void | Promise<void>;
  id?: string;
}

export interface PaletteHandle {
  element: HTMLElement;
  dialog: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  shortcutSheet: HTMLElement;
  open(): void;
  close(returnFocus?: boolean): void;
  toggle(): void;
  isOpen(): boolean;
  openShortcutSheet(): void;
  closeShortcutSheet(returnFocus?: boolean): void;
  destroy(): void;
  getCommands(): PaletteCommand[];
  filter(query: string): PaletteCommand[];
  setCommands(commands: PaletteCommand[]): void;
}

let installedStyle = false;

function resolveDocument(options: PaletteOptions): Document {
  if (options.document) return options.document;
  return document;
}

function resolveWindow(options: PaletteOptions, doc: Document): Window | null {
  if (options.window) return options.window;
  try {
    return doc.defaultView ?? (globalThis as unknown as { window?: Window }).window ?? null;
  } catch {
    return null;
  }
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { isContentEditable?: boolean; closest?: (selector: string) => Element | null }) | null;
  if (!element) return false;
  const tag = element.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (element.isContentEditable) return true;
  try {
    return Boolean(element.closest?.('[contenteditable="true"]'));
  } catch {
    return false;
  }
}

export const isEditableTarget = isTypingTarget;
export const isFormField = isTypingTarget;

function ensureStyle(doc: Document): void {
  if (installedStyle) return;
  try {
    if (doc.querySelector('link[data-palette-style="true"]')) {
      installedStyle = true;
      return;
    }
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./palette.css', import.meta.url).href;
    link.dataset.paletteStyle = 'true';
    doc.head?.append(link);
    installedStyle = true;
  } catch {
    // Tests without a head still get an unstyled but functional palette.
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

function commandHaystack(command: PaletteCommand): string {
  return [
    command.id,
    commandTitle(command),
    command.description,
    command.hint,
    commandShortcut(command),
    ...(Array.isArray(command.keywords) ? command.keywords : []),
    command.group,
    command.category,
  ]
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

export function filterPaletteCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [...commands];
  return commands.filter(command => commandHaystack(command).includes(needle));
}

export function paletteCommandsForQuery(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  return filterPaletteCommands(commands, query);
}

export function renderPaletteOption(command: PaletteCommand, index: number, active: boolean): string {
  const shortcut = commandShortcut(command);
  return `<div class="palette-option" id="palette-option-${index}" role="option" tabindex="-1" aria-selected="${active ? 'true' : 'false'}" data-palette-command="${escapeHtml(command.id)}">
    <span class="palette-option-title">${escapeHtml(commandTitle(command))}</span>
    ${command.description ? `<span class="palette-option-description">${escapeHtml(command.description)}</span>` : ''}
    ${shortcut ? `<kbd class="palette-option-shortcut">${escapeHtml(shortcut)}</kbd>` : ''}
  </div>`;
}

export function renderPalette(commands: readonly PaletteCommand[], query = ''): string {
  const filtered = filterPaletteCommands(commands, query);
  const options = filtered
    .map((command, index) => renderPaletteOption(command, index, index === 0))
    .join('');
  return `<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" data-palette="true">
    <div class="palette-backdrop" aria-hidden="true"></div>
    <div class="palette-dialog">
      <input class="palette-input" type="search" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-label="Search commands" placeholder="Search commands…" value="${escapeHtml(query)}" />
      <div class="palette-list" id="palette-list" role="listbox" aria-label="Commands">${options || '<div class="palette-empty" role="presentation">No matching commands</div>'}</div>
    </div>
  </div>`;
}

export function renderCommandPalette(commands: readonly PaletteCommand[], query = ''): string {
  return renderPalette(commands, query);
}

export function renderShortcutSheet(commands: readonly PaletteCommand[] = getCommands()): string {
  const rows = commands
    .filter(command => commandShortcut(command))
    .map(command => `<tr><td>${escapeHtml(commandTitle(command))}</td><td><kbd>${escapeHtml(commandShortcut(command))}</kbd></td></tr>`)
    .join('');
  return `<div class="palette-shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-shortcut-sheet="true">
    <div class="palette-shortcuts-dialog">
      <h2>Keyboard shortcuts</h2>
      <table><tbody>${rows}</tbody></table>
    </div>
  </div>`;
}

export const PALETTE_SHORTCUT = 'Ctrl/Cmd+K';
export const SHORTCUT_PALETTE = PALETTE_SHORTCUT;

export function mountPalette(options: PaletteOptions = {}): PaletteHandle {
  const doc = resolveDocument(options);
  const win = resolveWindow(options, doc);
  ensureStyle(doc);

  try {
    if (!defaultCommandRegistry.list().length) resetCommands();
  } catch {
    // A caller may pass its own registry; keep going.
  }

  const host = options.host ?? doc.body;
  if (!host) {
    throw new Error('mountPalette requires a document body or host element.');
  }

  const id = options.id ?? 'command-palette';
  const existing = doc.getElementById(id);
  if (existing) {
    existing.remove();
  }

  const root = doc.createElement('div');
  root.id = id;
  root.className = 'palette';
  root.dataset.paletteRoot = 'true';
  root.hidden = true;

  const dialog = doc.createElement('div');
  dialog.className = 'palette-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Command palette');

  const input = doc.createElement('input');
  input.type = 'search';
  input.className = 'palette-input';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-label', 'Search commands');
  input.placeholder = 'Search commands…';

  const list = doc.createElement('div');
  list.id = `${id}-list`;
  list.className = 'palette-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Commands');
  input.setAttribute('aria-controls', list.id);

  const backdrop = doc.createElement('div');
  backdrop.className = 'palette-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.addEventListener('click', () => handle.close());

  dialog.append(input, list);
  root.append(backdrop, dialog);
  if (typeof host.append === 'function') host.append(root); else host.appendChild(root);

  const sheet = doc.createElement('div');
  sheet.className = 'palette-shortcuts';
  sheet.dataset.shortcutSheet = 'true';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Keyboard shortcuts');
  sheet.hidden = true;
  const sheetDialog = doc.createElement('div');
  sheetDialog.className = 'palette-shortcuts-dialog';
  sheet.append(sheetDialog);
  if (typeof host.append === 'function') host.append(sheet); else host.appendChild(sheet);

  let commands: PaletteCommand[] = options.commands
    ? [...options.commands]
    : (options.registry?.list?.() ?? getCommands());
  let filtered: PaletteCommand[] = [...commands];
  let activeIndex = 0;
  let isOpen = false;
  let lastFocus: HTMLElement | null = null;
  let registry = options.registry;

  function registryList(): PaletteCommand[] {
    return registry?.list?.() ?? getCommands();
  }

  function setCommands(next: PaletteCommand[]): void {
    commands = [...next];
    renderList(input.value);
  }

  function renderList(query: string): void {
    const source = registry ? registryList() : commands;
    filtered = registry?.filter ? registry.filter(query) : filterPaletteCommands(source, query);
    if (options.commands && !registry) filtered = filterPaletteCommands(commands, query);
    activeIndex = filtered.length ? 0 : -1;
    list.innerHTML = filtered.length
      ? filtered.map((command, index) => renderPaletteOption(command, index, index === activeIndex)).join('')
      : '<div class="palette-empty" role="presentation">No matching commands</div>';
    updateActiveDescendant();
  }

  function updateActiveDescendant(): void {
    if (activeIndex >= 0 && filtered[activeIndex]) {
      input.setAttribute('aria-activedescendant', `palette-option-${activeIndex}`);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
    Array.from(list.querySelectorAll<HTMLElement>('[role="option"]')).forEach((option, index) => {
      option.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
      option.tabIndex = index === activeIndex ? 0 : -1;
    });
  }

  async function execute(command: PaletteCommand): Promise<void> {
    root.hidden = true;
    sheet.hidden = true;
    isOpen = false;
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    try {
      if (options.onCommand) await options.onCommand(command);
      else await runCommand(command);
    } catch {
      // Command execution is the caller's responsibility; never throw from the UI.
    }
  }

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    lastFocus = (doc.activeElement as HTMLElement | null) ?? null;
    root.hidden = false;
    sheet.hidden = true;
    input.value = '';
    renderList('');
    const raf = (win as { requestAnimationFrame?: (cb: FrameRequestCallback) => number } | null)?.requestAnimationFrame
      ?? (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame;
    if (typeof raf === 'function') {
      raf(() => {
        try { input.focus(); } catch { /* ignore */ }
      });
    } else {
      try { input.focus(); } catch { /* ignore */ }
    }
  }

  function close(returnFocus = true): void {
    if (!isOpen && root.hidden) return;
    isOpen = false;
    root.hidden = true;
    if (returnFocus && lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function toggle(): void {
    if (isOpen) close();
    else open();
  }

  function isOpenFn(): boolean {
    return isOpen;
  }

  function openShortcutSheet(): void {
    close(false);
    sheet.hidden = false;
    const source = registry ? registryList() : commands;
    sheetDialog.innerHTML = `<h2>Keyboard shortcuts</h2>${renderShortcutSheet(source).replace(/^<div[^>]*>|<\/div>$/g, '')}`;
    const first = sheetDialog.querySelector<HTMLElement>('button, [tabindex], h2');
    try { first?.focus?.(); } catch { /* ignore */ }
  }

  function closeShortcutSheet(returnFocus = true): void {
    sheet.hidden = true;
    if (returnFocus && lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  const handle = {
    element: root,
    dialog,
    input,
    list,
    shortcutSheet: sheet,
    open,
    close,
    toggle,
    isOpen: isOpenFn,
    openShortcutSheet,
    closeShortcutSheet,
    destroy() {
      root.remove();
      sheet.remove();
      if (win) win.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('keydown', onKeyDown);
    },
    getCommands() {
      return (registry ? registryList() : commands).map(command => ({ ...command }));
    },
    filter(query: string) {
      const source = registry ? registryList() : commands;
      return (registry?.filter ? registry.filter(query) : filterPaletteCommands(source, query)).map(command => ({ ...command }));
    },
    setCommands,
  };

  function onKeyDown(event: KeyboardEvent): void {
    const typing = isTypingTarget(event.target);
    const key = typeof event.key === 'string' ? event.key : '';

    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'k') {
      event.preventDefault();
      event.stopPropagation();
      toggle();
      return;
    }

    if (isOpen) {
      if (key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (key === 'ArrowDown') {
        event.preventDefault();
        if (filtered.length) {
          activeIndex = (activeIndex + 1) % filtered.length;
          updateActiveDescendant();
        }
        return;
      }
      if (key === 'ArrowUp') {
        event.preventDefault();
        if (filtered.length) {
          activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
          updateActiveDescendant();
        }
        return;
      }
      if (key === 'Home') {
        event.preventDefault();
        if (filtered.length) {
          activeIndex = 0;
          updateActiveDescendant();
        }
        return;
      }
      if (key === 'End') {
        event.preventDefault();
        if (filtered.length) {
          activeIndex = filtered.length - 1;
          updateActiveDescendant();
        }
        return;
      }
      if (key === 'Enter') {
        event.preventDefault();
        const command = filtered[activeIndex];
        if (command) void execute(command);
        return;
      }
      return;
    }

    if (typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Single-key shortcuts stay inert in editable fields.
      return;
    }

    if (key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      openShortcutSheet();
      return;
    }

    if (key.toLowerCase() === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const review = (registry ? registryList() : commands).find(command => command.id === 'review.drawer');
      if (review) {
        event.preventDefault();
        void execute(review);
      }
    }
  }

  input.addEventListener('input', () => renderList(input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  list.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-palette-command]');
    const id = target?.dataset.paletteCommand;
    if (!id) return;
    const command = filtered.find(item => item.id === id) ?? (registry ? registryList() : commands).find(item => item.id === id);
    if (command) void execute(command);
  });
  list.addEventListener('mousemove', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-palette-command]');
    const id = target?.dataset.paletteCommand;
    const index = filtered.findIndex(item => item.id === id);
    if (index >= 0 && index !== activeIndex) {
      activeIndex = index;
      updateActiveDescendant();
    }
  });

  const keyTargets: EventTarget[] = [doc];
  if (win && win !== (doc as unknown as Window)) keyTargets.push(win as unknown as EventTarget);
  for (const target of keyTargets) target.addEventListener('keydown', onKeyDown as EventListener);

  // Ensure defaults exist for the first interactive use.
  try {
    if ((registry ? registryList() : getCommands()).length === 0) resetCommands();
  } catch {
    // ignore
  }
  renderList('');

  return handle;
}

export const createPalette = mountPalette;
export const initPalette = mountPalette;
export const mountCommandPalette = mountPalette;
export const createCommandPalette = mountPalette;

export function openPalette(handle?: PaletteHandle): void {
  handle?.open();
}

export function closePalette(handle?: PaletteHandle): void {
  handle?.close();
}

export function togglePalette(handle?: PaletteHandle): void {
  handle?.toggle();
}

export function handlePaletteKeyDown(event: KeyboardEvent, handle?: PaletteHandle): boolean {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    handle?.toggle();
    return true;
  }
  return false;
}

export function shouldHandleShortcut(event: KeyboardEvent): boolean {
  return !isTypingTarget(event.target);
}

export function shortcutSuppressed(event: KeyboardEvent): boolean {
  return isTypingTarget(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export default mountPalette;
