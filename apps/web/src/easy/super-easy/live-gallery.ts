import { activeReviewTake, type ClipsResponse, type TakesApi, type TakesResponse } from '../../takes/api.ts';
import type { GalleryItem, GalleryModel } from './gallery-model.ts';

interface LiveGalleryOptions {
  api: Pick<TakesApi, 'listClips' | 'getTakes' | 'takeTicket'>;
  onUpdate(items: GalleryItem[]): void;
  onError?(error: Error): void;
  pollMs?: number;
  setTimer?: typeof setInterval;
  clearTimer?: typeof clearInterval;
}

export interface LiveGalleryController {
  start(packageId: string): void;
  stop(): void;
  refresh(): Promise<void>;
}

function readyState(state: string): boolean {
  return state === 'review' || state === 'approved';
}

function labelFor(sceneId: string, index: number): string {
  const number = /^s(?:cene)?[_-]?(\d+)$/iu.exec(sceneId)?.[1];
  return number ? `Shot ${Number(number)}` : `Shot ${index + 1}`;
}

/** Merge live take media without replacing characters, voice or the final film. */
export function mergeLiveGallery(base: GalleryModel, live: readonly GalleryItem[]): GalleryModel {
  const liveShots = new Map(live.filter(item => item.kind === 'shot').map(item => [item.id, item]));
  const used = new Set<string>();
  const items = base.items.map((item, index) => {
    const replacement = item.kind === 'shot' ? liveShots.get(item.id) : undefined;
    if (!replacement) return { ...item, index };
    used.add(item.id);
    if (replacement.state !== 'ready' && item.state === 'ready') return { ...item, index };
    return { ...replacement, index, highlighted: item.highlighted };
  });
  for (const item of liveShots.values()) {
    if (used.has(item.id) || items.some(existing => existing.id === item.id)) continue;
    items.push({ ...item, index: items.length, highlighted: false });
  }
  const states = { empty: 0, loading: 0, ready: 0, error: 0 };
  const counts = { character: 0, shot: 0, voice: 0, final: 0 };
  for (const item of items) {
    states[item.state] += 1;
    counts[item.kind] += 1;
  }
  return { items, final: base.final, states, counts };
}

/**
 * Follow the real clip/take API during a run. Only landed takes receive media
 * URLs. Ticket responses are cached until shortly before they expire.
 */
export function createLiveAssetGallery(options: LiveGalleryOptions): LiveGalleryController {
  const every = Math.max(500, options.pollMs ?? 4000);
  const startTimer = options.setTimer ?? setInterval;
  const stopTimer = options.clearTimer ?? clearInterval;
  const ticketCache = new Map<string, { url: string; expiresAt: number }>();
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let packageId: string | null = null;
  let flight: Promise<void> | null = null;

  async function mediaFor(packageIdValue: string, clip: ClipsResponse['clips'][number]): Promise<{ url: string | null; takeState: string }> {
    if (!readyState(clip.state)) return { url: null, takeState: clip.state };
    const detail: TakesResponse = await options.api.getTakes(packageIdValue, clip.clipId);
    const take = activeReviewTake(detail.takes, detail.selected ?? clip.selected);
    if (!take) return { url: null, takeState: 'generating' };
    const cached = ticketCache.get(take.takeId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return { url: cached.url, takeState: 'ready' };
    const ticket = await options.api.takeTicket(packageIdValue, clip.clipId, take.takeId);
    const expiresAt = ticket.expiresAt ? Date.parse(ticket.expiresAt) : Date.now() + 10 * 60_000;
    ticketCache.set(take.takeId, { url: ticket.url, expiresAt });
    return { url: ticket.url, takeState: 'ready' };
  }

  async function update(): Promise<void> {
    const id = packageId;
    const ticket = generation;
    if (!id) return;
    try {
      const result = await options.api.listClips(id);
      const items = await Promise.all(result.clips.map(async (clip, index): Promise<GalleryItem> => {
        const base = {
          id: `shot:${clip.sceneId || clip.assetId}`,
          kind: 'shot' as const,
          label: labelFor(clip.sceneId, index),
          highlighted: false,
          index,
        };
        if (clip.state === 'failed' || clip.state === 'rejected') {
          return { ...base, state: 'error', url: null, reason: 'This shot needs attention' };
        }
        try {
          const media = await mediaFor(id, clip);
          return {
            ...base,
            state: media.url ? 'ready' : 'loading',
            url: media.url,
            reason: null,
          };
        } catch {
          // A state can advance between listClips and getTakes. Keep the card
          // pending and retry next interval; never fabricate a ready asset.
          return { ...base, state: 'loading', url: null, reason: null };
        }
      }));
      if (generation === ticket && packageId === id) options.onUpdate(items);
    } catch (error) {
      if (generation === ticket && packageId === id) options.onError?.(error as Error);
    }
  }

  function refresh(): Promise<void> {
    if (flight) return flight;
    flight = update().finally(() => { flight = null; });
    return flight;
  }

  return {
    start(id) {
      if (!id) return;
      if (packageId === id && timer !== null) return;
      this.stop();
      packageId = id;
      generation += 1;
      void refresh();
      timer = startTimer(() => { void refresh(); }, every);
    },
    stop() {
      generation += 1;
      packageId = null;
      ticketCache.clear();
      if (timer !== null) stopTimer(timer);
      timer = null;
    },
    refresh,
  };
}
