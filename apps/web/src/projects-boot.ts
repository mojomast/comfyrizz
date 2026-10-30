import { apiFetch } from './editor/api.ts';
import { isProjectsRoute, mountProjectsGallery } from './easy/projects-gallery.ts';
import './easy/easy.css';
import './easy/projects-gallery.css';

/**
 * Cold boot for `?view=projects`.
 *
 * The Projects page is a collection, not a project: it must never mount the
 * seeded/bundled Pip package behind the list. Links on the page are real URLs,
 * so choosing a project performs a normal boot of that exact package and no
 * editor state leaks between projects.
 */
export function mountProjectsPageIfRequested(): boolean {
  const search = globalThis.location?.search ?? '';
  if (!isProjectsRoute(search)) return false;
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
  const root = document.createElement('div');
  root.id = 'projects-root';
  document.body.append(root);
  mountProjectsGallery(root, { request: input => apiFetch(input), search });
  document.documentElement.removeAttribute('data-app-loading');
  return true;
}
