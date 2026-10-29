import { referencesPath } from '../../references/api.ts';
import type { SuperEasyContextAttachment } from './context-attachments.ts';

/** The player always uses original-song seconds, just like trim and LRC. */
export function songPreviewMaster(items: readonly SuperEasyContextAttachment[], chatId: string | null | undefined): string | null {
  const songs = items.filter(item => item.source === 'media' && item.kind === 'audio' && item.role === 'song' && item.usage === 'editorial');
  return chatId && songs.length === 1 ? referencesPath(chatId, `/${encodeURIComponent(songs[0].id)}/file`) : null;
}

export function previewRange(start: string, end: string, duration: number, requested: number): { start: number; end: number } | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const blank = start.trim() === '' && end.trim() === '';
  if (!blank && (start.trim() === '' || end.trim() === '')) return null;
  const from = blank ? 0 : Number(start);
  const to = blank ? Math.min(duration, requested) : Number(end);
  return Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && to <= duration ? { start: from, end: to } : null;
}

export interface SongPreviewOptions {
  root: HTMLElement;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  master(): string | null;
  requested(): number;
  changed(): void;
}

export function createSongPreview(options: SongPreviewOptions) {
  const { root } = options;
  let url: string | null = null;
  let source: string | null = null;
  let generation = 0;
  let endAt: number | null = null;
  const audio = () => root.querySelector<HTMLAudioElement>('[data-song-preview-audio]');
  const status = (message: string) => { const el = root.querySelector<HTMLElement>('[data-song-preview-status]'); if (el) el.textContent = message; };
  function clear() {
    generation++;
    endAt = null;
    const player = audio();
    if (player && url) { player.pause(); player.removeAttribute('src'); player.hidden = true; }
    if (url) URL.revokeObjectURL(url);
    url = null;
    source = null;
    const actions = root.querySelector<HTMLElement>('[data-song-preview-actions]');
    if (actions) actions.hidden = true;
  }
  function sync() {
    if (source && source !== options.master()) { clear(); status('Song master changed. Load the new song to preview it.'); }
  }
  async function load() {
    clear();
    const master = options.master();
    if (!master) { status('Select exactly one song master first.'); return; }
    const ticket = generation;
    status('Loading song preview…');
    try {
      const response = await options.fetch(master);
      if (!response.ok) throw new Error('Could not load the song.');
      const blob = await response.blob();
      if (ticket !== generation || master !== options.master()) return;
      const player = audio();
      if (!player) return;
      url = URL.createObjectURL(blob);
      source = master;
      player.src = url;
      player.hidden = false;
      const actions = root.querySelector<HTMLElement>('[data-song-preview-actions]');
      if (actions) actions.hidden = false;
      status('Scrub the original song, then set start and end at the playhead.');
    } catch {
      if (ticket === generation) status('Could not load the song preview.');
    }
  }
  function click(event: Event) {
    const target = event.target as Element | null;
    if (!target?.closest) return;
    if (target.closest('[data-song-preview-load]')) { event.preventDefault(); void load(); return; }
    const startButton = target.closest('[data-song-preview-start]');
    const endButton = target.closest('[data-song-preview-end]');
    const playButton = target.closest('[data-song-preview-play]');
    if (!startButton && !endButton && !playButton) return;
    event.preventDefault();
    const player = audio();
    const start = root.querySelector<HTMLInputElement>('[data-super-easy-song-start]');
    const end = root.querySelector<HTMLInputElement>('[data-super-easy-song-end]');
    if (!player || !source || source !== options.master() || !start || !end) return;
    if (playButton) {
      const range = previewRange(start.value, end.value, player.duration, options.requested());
      if (!range) { status('Enter a valid range within the song before playing it.'); return; }
      player.currentTime = range.start;
      endAt = range.end;
      status('Playing the selected range in original song time.');
      void player.play().catch(() => { endAt = null; status('Playback could not start.'); });
      return;
    }
    endAt = null;
    if (!Number.isFinite(player.currentTime)) return;
    const value = String(Number(player.currentTime.toFixed(3)));
    if (startButton) start.value = value;
    else end.value = value;
    options.changed();
    status('Trim point set from the original song playhead.');
  }
  function timeupdate(event: Event) {
    const player = audio();
    if (event.target === player && player && endAt !== null && player.currentTime >= endAt) {
      player.pause();
      player.currentTime = endAt;
      endAt = null;
    }
  }
  root.addEventListener('click', click);
  root.addEventListener('timeupdate', timeupdate, true);
  return { sync, clear, destroy() { clear(); root.removeEventListener('click', click); root.removeEventListener('timeupdate', timeupdate, true); } };
}
