import { COPY } from './copy.ts';
import { escapeHtml } from './components.ts';
import type { EasyHost } from './types.ts';

export const MAX_NAME_LENGTH = 80;
const VIDEO_NAME_LABEL = 'Video name';

export interface ProjectNameHost {
  apiFetch: EasyHost['apiFetch'];
  getPackage(): any;
  editorStore?: EasyHost['editorStore'];
}

export interface ProjectNameController {
  getName(): string;
  setName(name: string | null | undefined): void;
  destroy(): void;
}

export interface ProjectNameOptions {
  host: ProjectNameHost;
  /** Called after a successful save so the shell title and document title agree. */
  onRename?: (name: string) => void;
}

export function normalizeName(value: unknown): string | null {
  const text = String(value ?? '').trim().slice(0, MAX_NAME_LENGTH);
  return text.length > 0 ? text : null;
}

export function displayName(value: unknown): string {
  return normalizeName(value) ?? COPY.shell.untitled;
}

export function renderProjectName(value: unknown): string {
  const name = displayName(value);
  const label = escapeHtml(COPY.shell.renameLabel);
  return `<button type="button" class="easy-name-button" data-easy-project-name aria-label="${label}" title="${label}">${escapeHtml(name)}</button>`;
}

type TitleSaver = (title: string) => unknown;

function titleSaver(host: ProjectNameHost): TitleSaver | null {
  const store = host.editorStore as any;
  if (!store) return null;
  if (typeof store.setTitle === 'function') return (title: string) => store.setTitle(title);
  if (typeof store.rename === 'function') return (title: string) => store.rename(title);
  if (store.commands && typeof store.commands.setTitle === 'function') {
    return (title: string) => store.dispatch(store.commands.setTitle(title));
  }
  if (typeof store.titleCommand === 'function') {
    return (title: string) => {
      const command = store.titleCommand(title);
      return command ? store.dispatch(command) : undefined;
    };
  }
  return null;
}

async function saveTitle(host: ProjectNameHost, title: string): Promise<void> {
  const save = titleSaver(host);
  if (save) {
    const result: any = await save(title);
    if (!result || result.ok !== false) {
      const current = host.getPackage();
      if (current && typeof current === 'object') current.title = title;
      return;
    }
  }

  const pkg = host.getPackage();
  if (!pkg || typeof pkg.id !== 'string' || pkg.id.length === 0) throw new Error('MISSING_VIDEO');
  const next = { ...pkg, title };
  const response = await host.apiFetch(`/api/package/${encodeURIComponent(pkg.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: pkg.revision, package: next }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? body?.code ?? `HTTP ${response.status}`);
  const saved = body?.package && typeof body.package === 'object' ? body.package : next;
  pkg.title = typeof saved.title === 'string' ? saved.title : title;
  const revision = Number.isFinite(body?.revision) ? body.revision : saved?.revision;
  if (Number.isFinite(revision)) pkg.revision = revision;
}

export function mountProjectName(el: HTMLElement, options: ProjectNameOptions): ProjectNameController {
  const { host } = options;
  let current = displayName(host.getPackage()?.title);
  let editing = false;
  let busy = false;
  let destroyed = false;
  let button: HTMLButtonElement | null = null;

  function paint(focus = false): void {
    if (destroyed) return;
    el.innerHTML = renderProjectName(current);
    button = el.querySelector<HTMLButtonElement>('button');
    button?.addEventListener('click', beginEdit);
    if (focus) button?.focus();
  }

  function beginEdit(): void {
    if (destroyed || editing || busy) return;
    editing = true;
    const previous = current;
    el.innerHTML = `<input type="text" class="easy-name-input" data-easy-project-name-input aria-label="${escapeHtml(VIDEO_NAME_LABEL)}" maxlength="${MAX_NAME_LENGTH}" autocomplete="off" value="${escapeHtml(current)}">`;
    const input = el.querySelector<HTMLInputElement>('input');
    if (!input) {
      editing = false;
      paint(true);
      return;
    }
    input.focus();
    input.select();

    let settled = false;
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      editing = false;
      paint(true);
    };
    const commit = async (): Promise<void> => {
      if (settled) return;
      const next = normalizeName(input.value);
      if (next === null || next === previous) {
        cancel();
        return;
      }
      settled = true;
      busy = true;
      input.disabled = true;
      try {
        await saveTitle(host, next);
        current = displayName(host.getPackage()?.title ?? next);
        if (current !== previous) options.onRename?.(current);
      } catch {
        current = previous;
      } finally {
        busy = false;
        editing = false;
        paint(true);
      }
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => { void commit(); });
  }

  paint();

  return {
    getName: () => current,
    setName(name) {
      current = displayName(name);
      if (!editing) paint();
    },
    destroy() {
      destroyed = true;
      el.innerHTML = '';
      button = null;
    },
  };
}
