import { activeReviewTake, type ClipsResponse, type TakesApi, type TakesResponse } from '../../takes/api.ts';
import { readGalleryAssetDetails } from './gallery-asset.ts';
import type { GalleryItem, GalleryModel } from './gallery-model.ts';

interface LiveGalleryOptions {
  api: Pick<TakesApi, 'listClips' | 'getTakes' | 'takeTicket'>;
  onUpdate(items: GalleryItem[]): void;
  onError?(error: Error): void;
  pollMs?: number;
  setTimer?: typeof setInterval;
  clearTimer?: typeof clearInterval;
  /** Saved package, for exact prompt/model/media metadata on each preview. */
  package?: () => Record<string, any> | null;
}

export interface LiveGalleryController {
  start(packageId: string): void;
  stop(): void;
  refresh(): Promise<void>;
}

function readyState(state: string): boolean {
  // A stale take is still a real take with bytes. Reopening a project after a
  // reference change must show its media; the stale label stays in details.
  return state === 'review' || state === 'approved' || state === 'stale';
}

function labelFor(sceneId: string, index: number): string {
  const number = /^s(?:cene)?[_-]?(\d+)$/iu.exec(sceneId)?.[1];
  return number ? `Shot ${Number(number)}` : `Shot ${index + 1}`;
}

/** Merge live take media without replacing characters, voice or the final film. */
export function mergeLiveGallery(base: GalleryModel, live: readonly GalleryItem[]): GalleryModel {
  const liveMedia = new Map(live.filter(item => item.kind === 'shot' || item.kind === 'character').map(item => [item.id, item]));
  const used = new Set<string>();
  const items = base.items.map((item, index) => {
    const replacement = item.kind === 'shot' || item.kind === 'character' ? liveMedia.get(item.id) : undefined;
    if (!replacement) return { ...item, index };
    used.add(item.id);
    // A normalized snapshot binds this preview to exact generation metadata.
    // Legacy take polling must not replace it with a URL-only card (or label a
    // conditioning image as the generated shot). Snapshot refresh owns it.
    if (item.details && item.url) return { ...item, index };
    if (replacement.state !== 'ready' && item.state === 'ready') return { ...item, index };
    return { ...replacement, index, highlighted: item.highlighted };
  });
  for (const item of liveMedia.values()) {
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

  function detailsFor(assetId: string, role: 'reference' | 'generated', state: string, take?: any) {
    if (!options.package) return undefined;
    const pkg = options.package();
    const asset = pkg?.assets?.[assetId];
    const gen = (asset?.gen ?? take?.gen ?? {}) as Record<string, any>;
    const inputs = (gen.inputs ?? {}) as Record<string, any>;
    const media = (asset?.media ?? take?.media ?? {}) as Record<string, any>;
    const frames = Number(media.frames ?? inputs.frames);
    const fps = Number(media.fps ?? inputs.fps);
    return readGalleryAssetDetails({
      assetId, role, mediaType: asset?.kind ?? take?.kind,
      status: asset?.status ?? state,
      prompt: inputs.prompt, model: gen.model, workflow: gen.workflow,
      width: media.width ?? inputs.width, height: media.height ?? inputs.height,
      durationSeconds: Number.isFinite(frames) && Number.isFinite(fps) && fps > 0 ? frames / fps : undefined,
      seed: inputs.seed,
    });
  }

  async function mediaFor(packageIdValue: string, clip: ClipsResponse['clips'][number]): Promise<{ url: string | null; takeState: string; take?: any }> {
    if (!readyState(clip.state)) return { url: null, takeState: clip.state };
    const detail: TakesResponse = await options.api.getTakes(packageIdValue, clip.clipId);
    const take = activeReviewTake(detail.takes, detail.selected ?? clip.selected);
    if (!take) return { url: null, takeState: 'generating' };
    const cached = ticketCache.get(take.takeId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return { url: cached.url, takeState: clip.state === 'stale' ? 'stale' : 'ready', take };
    const ticket = await options.api.takeTicket(packageIdValue, clip.clipId, take.takeId);
    const expiresAt = ticket.expiresAt ? Date.parse(ticket.expiresAt) : Date.now() + 10 * 60_000;
    ticketCache.set(take.takeId, { url: ticket.url, expiresAt });
    return { url: ticket.url, takeState: clip.state === 'stale' ? 'stale' : 'ready', take };
  }

  async function referenceFor(packageIdValue: string, reference: NonNullable<ClipsResponse['references']>[number], index: number): Promise<GalleryItem> {
    const base = {
      id: `character:${reference.assetId}`,
      kind: 'character' as const,
      label: `Visual reference ${index + 1}`,
      highlighted: false,
      index,
    };
    try {
      const details = detailsFor(reference.assetId, 'reference', 'ready');
      const cached = ticketCache.get(reference.takeId);
      if (cached && cached.expiresAt > Date.now() + 60_000) {
        return { ...base, state: 'ready', url: cached.url, reason: null, ...(details ? { details } : {}) };
      }
      const ticket = await options.api.takeTicket(packageIdValue, reference.assetId, reference.takeId);
      const expiresAt = ticket.expiresAt ? Date.parse(ticket.expiresAt) : Date.now() + 10 * 60_000;
      ticketCache.set(reference.takeId, { url: ticket.url, expiresAt });
      return { ...base, state: 'ready', url: ticket.url, reason: null, ...(details ? { details } : {}) };
    } catch {
      return { ...base, state: 'loading', url: null, reason: null };
    }
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
          const details = media.url ? detailsFor(clip.assetId, 'generated', media.takeState, media.take) : undefined;
          return {
            ...base,
            state: media.url ? 'ready' : 'loading',
            url: media.url,
            reason: null,
            ...(details ? { details } : {}),
          };
        } catch {
          // A state can advance between listClips and getTakes. Keep the card
          // pending and retry next interval; never fabricate a ready asset.
          return { ...base, state: 'loading', url: null, reason: null };
        }
      }));
      const references = await Promise.all((result.references ?? []).map((reference, index) => referenceFor(id, reference, index)));
      if (generation === ticket && packageId === id) options.onUpdate([...references, ...items]);
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
