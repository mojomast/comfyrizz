import { escapeHtml } from './easy/components.ts';

export interface ProjectNavigationOptions {
  /** The current app query; demo=1 selects the invite-scoped Gallery. */
  search?: string;
  /** App document URL, including any deployment prefix. */
  baseURI?: string;
}

export function projectNavigationTarget(options: ProjectNavigationOptions = {}): { label: string; href: string } {
  const params = new URLSearchParams(options.search ?? globalThis.location?.search ?? '');
  if (params.get('demo') === '1') {
    const base = options.baseURI ?? globalThis.document?.baseURI ?? 'http://localhost/';
    return { label: 'Gallery', href: new URL('./gallery/', base).pathname };
  }
  // A collection visit must not retain the previous project's chat/production.
  for (const key of ['package', 'chat', 'production', 'step', 'edit']) params.delete(key);
  params.set('view', 'projects');
  return { label: 'Projects', href: `?${params}` };
}

/** Real links work with a cold reload; routers may intercept data-project-navigation. */
export function renderProjectNavigation(options: ProjectNavigationOptions = {}): string {
  const target = projectNavigationTarget(options);
  const guest = target.label === 'Gallery' ? ' data-guest-gallery' : '';
  return `<a class="btn btn-secondary project-navigation" href="${escapeHtml(target.href)}" data-project-navigation${guest}>${target.label}</a>`;
}

/**
 * Editor/topbar integration; returns cleanup without touching the host's other
 * controls. Re-mounting updates the existing link instead of adding a second
 * Projects/Gallery entry.
 */
export function mountProjectNavigation(host: HTMLElement, options: ProjectNavigationOptions = {}): () => void {
  const target = projectNavigationTarget(options);
  const existing = host.querySelector<HTMLAnchorElement>('[data-project-navigation]');
  const link = existing ?? host.ownerDocument.createElement('a');
  link.className = 'btn btn-secondary project-navigation';
  link.href = target.href;
  link.textContent = target.label;
  link.dataset.projectNavigation = '';
  if (target.label === 'Gallery') link.dataset.guestGallery = '';
  else delete link.dataset.guestGallery;
  if (!existing) host.append(link);
  return () => link.remove();
}
