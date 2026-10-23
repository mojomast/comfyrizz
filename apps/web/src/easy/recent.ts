import { COPY, fill } from './copy.ts';
import { escapeHtml } from './components.ts';
import { DEFAULT_PACKAGE_ID } from '../default-project.ts';

const RECENT_KEY = 'comfyrizz.recent';
const RECENT_CAP = 8;
const QUERY_NAME = 'package';

export interface RecentVideo {
  packageId: string;
  title: string;
  updatedAt: string;
}

export function exampleHref(): string {
  return `?${QUERY_NAME}=${DEFAULT_PACKAGE_ID}&step=review`;
}

export function videoHref(packageId: string): string {
  return `?${QUERY_NAME}=${encodeURIComponent(packageId)}`;
}

export function timeAgo(ms: number): string {
  const elapsed = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function storageOf(storage?: Storage): Storage | null {
  if (storage) return storage;
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  return candidate ?? null;
}

export function readRecent(storage?: Storage): RecentVideo[] {
  const store = storageOf(storage);
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const videos: RecentVideo[] = [];
    for (const item of parsed) {
      if (!item || typeof item.packageId !== 'string' || !item.packageId || seen.has(item.packageId)) continue;
      seen.add(item.packageId);
      videos.push({
        packageId: item.packageId,
        title: typeof item.title === 'string' && item.title ? item.title : item.packageId,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
      });
      if (videos.length === RECENT_CAP) break;
    }
    return videos;
  } catch {
    return [];
  }
}

export function rememberVideo(
  pkg: { id?: string; title?: string } | null | undefined,
  storage?: Storage,
  now = Date.now(),
): RecentVideo[] {
  const packageId = typeof pkg?.id === 'string' ? pkg.id : '';
  if (!packageId) return readRecent(storage);
  const title = typeof pkg?.title === 'string' && pkg.title ? pkg.title : packageId;
  const next: RecentVideo = { packageId, title, updatedAt: new Date(now).toISOString() };
  const videos = [next, ...readRecent(storage).filter((item) => item.packageId !== packageId)].slice(0, RECENT_CAP);
  const store = storageOf(storage);
  try { store?.setItem(RECENT_KEY, JSON.stringify(videos)); } catch { /* ignore quota */ }
  return videos;
}

export function renderRecent(list: readonly RecentVideo[], now = Date.now()): string {
  const items = list.map((item) => {
    const when = Date.parse(item.updatedAt);
    const ago = timeAgo(Number.isFinite(when) ? now - when : 0);
    const label = fill(COPY.recent.item, { title: item.title, ago });
    return `<li><a href="${escapeHtml(videoHref(item.packageId))}">${escapeHtml(label)}</a></li>`;
  }).join('');
  return `<section data-easy-recent>
<h2>${escapeHtml(COPY.recent.heading)}</h2>
<ul>${items}</ul>
<a href="${escapeHtml(exampleHref())}">${escapeHtml(COPY.recent.example)}</a>
</section>`;
}
