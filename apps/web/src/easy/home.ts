import { COPY } from './copy.ts';
import { escapeHtml } from './components.ts';
import { exampleHref, readRecent, videoHref, type RecentVideo } from './recent.ts';
import { renderProjectNavigation } from '../project-gallery-navigation.ts';

const EMPTY_HOME = 'No videos yet. Start your first one.';
const NEW_VIDEO = 'New video';
const MAKE_IT_SIMPLE = 'Make it simple';

export interface HomeVideo {
  id: string;
  title: string;
  durationS: number | null;
  aspect: string | null;
  updatedAt: string;
  thumbnail: string | null;
}

export function ideaHref(): string {
  return '?step=idea';
}

export function homeVideos(apiList: unknown, stored: readonly RecentVideo[] = readRecent()): HomeVideo[] {
  const fromApi = Array.isArray(apiList) ? apiList.map(normalizeApi).filter((item): item is HomeVideo => item !== null) : [];
  if (fromApi.length > 0) return fromApi;
  return stored.map((item) => ({
    id: item.packageId,
    title: item.title,
    durationS: null,
    aspect: null,
    updatedAt: item.updatedAt,
    thumbnail: null,
  }));
}

function normalizeApi(value: unknown): HomeVideo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { id?: unknown; title?: unknown; durationS?: unknown; aspect?: unknown; updatedAt?: unknown; thumbnail?: unknown };
  if (typeof record.id !== 'string' || !record.id) return null;
  return {
    id: record.id,
    title: typeof record.title === 'string' && record.title ? record.title : record.id,
    durationS: typeof record.durationS === 'number' && Number.isFinite(record.durationS) ? record.durationS : null,
    aspect: typeof record.aspect === 'string' && record.aspect ? record.aspect : null,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    thumbnail: typeof record.thumbnail === 'string' && record.thumbnail ? record.thumbnail : null,
  };
}

export async function loadHomeVideos(fetchImpl: (input: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>): Promise<HomeVideo[]> {
  try {
    const response = await fetchImpl('/api/packages');
    if (response.ok) return homeVideos(await response.json());
  } catch { /* use the stored list */ }
  return homeVideos([]);
}

function meta(video: HomeVideo): string {
  const parts = [video.title];
  if (video.durationS !== null) parts.push(`${Math.round(video.durationS)} s`);
  if (video.aspect) parts.push(video.aspect);
  return parts.join(' · ');
}

/** The screen a bare visit shows before Idea. */
export function renderHomeScreen(videos: readonly HomeVideo[]): string {
  const frame = `<div class="easy-shell easy-home-screen" data-easy-home-screen>
<header class="easy-header">
<a class="easy-logo" href="/"><span aria-hidden="true">◆</span> Comfyrizz</a>
${renderProjectNavigation()}
</header>
<main class="easy-main">`;
  return frame + renderHome(videos) + '</main></div>';
}

export function renderHome(videos: readonly HomeVideo[]): string {
  const start = `<a href="${escapeHtml(ideaHref())}" data-easy-new-video>${escapeHtml(NEW_VIDEO)}</a>`;
  const example = `<a href="${escapeHtml(exampleHref())}">${escapeHtml(COPY.recent.example)}</a>`;
  const makeItSimple = `<button type="button" class="btn btn-secondary easy-home-simple" data-easy-make-simple>${escapeHtml(MAKE_IT_SIMPLE)}</button>`;
  if (videos.length === 0) {
    return `<section data-easy-home>
${makeItSimple}
<p>${escapeHtml(EMPTY_HOME)}</p>
${start}
${example}
</section>`;
  }
  const cards = videos.map((video) => {
    const thumb = video.thumbnail
      ? `<img alt="" src="${escapeHtml(video.thumbnail)}" />`
      : '';
    return `<li><a href="${escapeHtml(videoHref(video.id))}">${thumb}<span>${escapeHtml(meta(video))}</span></a></li>`;
  }).join('');
  return `<section data-easy-home>
${makeItSimple}
${start}
<ul class="easy-home-grid">${cards}</ul>
${example}
</section>`;
}
