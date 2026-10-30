import { escapeHtml } from './components.ts';
import { homeVideos, type HomeVideo } from './home.ts';
import { projectNavigationTarget } from '../project-gallery-navigation.ts';

export type ProjectOpenMode = 'super-easy' | 'easy' | 'editor' | 'chat';
export interface ProjectSelection { packageId: string; mode: ProjectOpenMode }
export type ProjectsGalleryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; projects: readonly HomeVideo[] };

export interface ProjectsGalleryOptions {
  request(input: string): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
  search?: string;
  /** Optional SPA handoff. The selected package, never the previous chat, is authoritative. */
  onOpen?(selection: ProjectSelection): void;
}

/**
 * Boot hook for the routing owner: check this before opening the seeded/bundled
 * project so a collection visit never mounts Pip or any saved document first.
 */
export function isProjectsRoute(search: string): boolean {
  try {
    return new URLSearchParams(search).get('view') === 'projects';
  } catch {
    return false;
  }
}

export function projectOpenHref(packageId: string, mode: ProjectOpenMode): string {
  const params = new URLSearchParams({ package: packageId });
  // Easy derives the right step for this saved project; forcing `step=idea`
  // would reopen every finished project at its first question.
  if (mode !== 'easy') params.set('view', mode === 'chat' ? 'editor' : mode);
  // The editor already exposes project chat; this focuses the composer so the
  // "chat about changes" entry lands on the conversation, not the timeline.
  if (mode === 'chat') params.set('focus', 'chat');
  return `?${params}`;
}

export async function loadProjectsGallery(options: Pick<ProjectsGalleryOptions, 'request' | 'search'>): Promise<HomeVideo[]> {
  // Never send an owner API request from an invite route, even if mounted by mistake.
  if (new URLSearchParams(options.search ?? globalThis.location?.search ?? '').get('demo') === '1') {
    throw new Error('Open Gallery to view shared films and edit your private copies.');
  }
  const response = await options.request('/api/packages');
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Connect your owner session, then retry to see your saved projects.');
    throw new Error('Saved projects could not be loaded. Check your server connection and retry.');
  }
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error('The server returned an invalid project list. Retry to load your saved projects.');
  // An empty server list is authoritative; never substitute browser recents or a sample.
  return homeVideos(body, []);
}

function projectCard(project: HomeVideo): string {
  const details: string[] = ['Saved project'];
  if (project.durationS !== null && project.durationS >= 0) details.push(`${Math.round(project.durationS)} s`);
  if (project.aspect) details.push(project.aspect);
  const updated = Date.parse(project.updatedAt);
  if (Number.isFinite(updated)) details.push(`Updated ${new Date(updated).toLocaleDateString()}`);
  const actions: Array<[ProjectOpenMode, string]> = [
    ['super-easy', 'Super Easy'], ['easy', 'Easy'], ['editor', 'Editor'], ['chat', 'Chat with agent'],
  ];
  const title = project.title.trim() || project.id;
  return `<li class="projects-gallery-card" data-project-id="${escapeHtml(project.id)}">
<h2>${escapeHtml(title)}</h2>
<p class="hint">${escapeHtml(details.join(' · '))}</p>
<p class="projects-gallery-id">${escapeHtml(project.id)}</p>
<nav class="projects-gallery-actions" aria-label="Open ${escapeHtml(title)}">${actions.map(([mode, label]) => `<a class="btn ${mode === 'super-easy' ? 'btn-primary' : 'btn-secondary'}" href="${escapeHtml(projectOpenHref(project.id, mode))}" data-project-open="${escapeHtml(project.id)}" data-project-mode="${mode}">${label}</a>`).join('\n')}</nav>
</li>`;
}

export function renderProjectsGallery(state: ProjectsGalleryState): string {
  const loading = state.status === 'loading';
  const content = loading
    ? '<p role="status">Loading your saved projects…</p>'
    : state.status === 'error'
      ? `<div role="alert"><h2>Projects unavailable</h2><p>${escapeHtml(state.message)}</p><button type="button" class="btn btn-secondary" data-projects-retry>Retry</button></div>`
      : state.projects.length === 0
        ? '<div class="projects-gallery-empty"><h2>No saved projects yet</h2><p>Start a video in Super Easy. Once a project is saved, you can reopen it here in any mode or continue its chat.</p><a class="btn btn-primary" href="?view=super-easy">Create your first video</a></div>'
        : `<p role="status">${state.projects.length} saved project${state.projects.length === 1 ? '' : 's'} · newest first</p><ul class="projects-gallery-grid">${state.projects.map(projectCard).join('\n')}</ul>`;
  return `<section class="easy-shell projects-gallery" data-projects-gallery aria-labelledby="projects-gallery-title" aria-busy="${loading}">
<header class="easy-header"><a class="easy-logo" href="?view=super-easy">Comfyrizz</a><a class="btn btn-primary" href="?view=super-easy">New video</a><button type="button" class="btn btn-secondary" data-projects-retry${loading ? ' disabled' : ''}>Refresh projects</button></header>
<main class="easy-main"><h1 id="projects-gallery-title" tabindex="-1">Projects</h1><p>Your saved work, including drafts and videos in progress. Open the same project in any mode, or continue with its agent.</p>${content}</main>
</section>`;
}

/** Routing contract: mount for view=projects; dispose before changing route. */
export function mountProjectsGallery(root: HTMLElement, options: ProjectsGalleryOptions): () => void {
  let disposed = false;
  let generation = 0;
  const search = options.search ?? root.ownerDocument.defaultView?.location.search ?? '';
  if (new URLSearchParams(search).get('demo') === '1') {
    const target = projectNavigationTarget({ search, baseURI: root.ownerDocument.baseURI });
    root.innerHTML = `<section class="easy-main"><h1>Gallery</h1><p>Explore shared films and open a private copy to edit with the agent.</p><a class="btn btn-primary" href="${escapeHtml(target.href)}">Open Gallery</a></section>`;
    root.ownerDocument.title = 'Gallery · Comfyrizz';
    return () => { root.innerHTML = ''; };
  }
  root.ownerDocument.title = 'Projects · Comfyrizz';
  async function refresh(): Promise<void> {
    const current = ++generation;
    root.innerHTML = renderProjectsGallery({ status: 'loading' });
    try {
      const projects = await loadProjectsGallery({ ...options, search });
      if (!disposed && current === generation) root.innerHTML = renderProjectsGallery({ status: 'ready', projects });
    } catch (error) {
      if (!disposed && current === generation) root.innerHTML = renderProjectsGallery({ status: 'error', message: error instanceof Error ? error.message : 'Saved projects could not be loaded. Please retry.' });
    }
  }
  function onClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (target?.closest('[data-projects-retry]')) { void refresh(); return; }
    if (!options.onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = target?.closest<HTMLAnchorElement>('[data-project-open]');
    const packageId = link?.dataset.projectOpen;
    const mode = link?.dataset.projectMode;
    if (!packageId || !['super-easy', 'easy', 'editor', 'chat'].includes(mode ?? '')) return;
    event.preventDefault();
    options.onOpen({ packageId, mode: mode as ProjectOpenMode });
  }
  root.addEventListener('click', onClick);
  void refresh();
  return () => {
    disposed = true;
    generation += 1;
    root.removeEventListener('click', onClick);
    root.innerHTML = '';
  };
}
