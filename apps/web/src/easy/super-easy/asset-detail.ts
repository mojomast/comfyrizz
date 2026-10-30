import { escapeHtml } from '../components.ts';
import type { GalleryItem, GalleryModel } from './gallery-model.ts';
import { publicAssetText, readGalleryAssetDetails, safeGalleryUrl } from './gallery-asset.ts';

export function assetDetailMarkup(item: GalleryItem): string {
  const details = readGalleryAssetDetails(item.details) ?? {};
  const role = details.role === 'reference' ? 'Conditioning reference — not a generated clip'
    : details.role === 'generated' ? 'Generated shot' : item.kind === 'final' ? 'Final video' : 'Asset';
  const rows: Array<[string, unknown]> = [
    ['Role', role], ['Scene', details.sceneId], ['Asset', details.assetId ?? item.id], ['Take', details.takeId],
    ['Status', details.status ?? item.state], ['Generation prompt', details.prompt ?? 'Not recorded'],
    ['Model', details.model ?? 'Not recorded'], ['Workflow', details.workflow ?? 'Not recorded'],
    ['Dimensions', details.width && details.height ? `${details.width} × ${details.height}` : undefined],
    ['Duration', details.durationSeconds === undefined ? undefined : `${details.durationSeconds} seconds`], ['Seed', details.seed],
  ];
  return `<dl>${rows.filter(([, value]) => value !== undefined).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(publicAssetText(String(value)) ?? '')}</dd>`).join('')}</dl>`;
}

interface AssetInspectorOptions {
  root: HTMLElement;
  gallery(): GalleryModel;
  /** Includes project and authenticated view identity; changing it clears media. */
  scope(): string;
  fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** One mount owns its authenticated media. No shared or persistent blob cache. */
export function createAssetInspector(options: AssetInspectorOptions) {
  const { root } = options;
  const doc = root.ownerDocument;
  let scope = options.scope();
  let epoch = 0;
  let dialog: HTMLDialogElement | null = null;
  let selected: string | null = null;
  let opener: HTMLElement | null = null;
  let detailKey = '';
  let mediaKey = '';
  const media = new Map<string, { controller: AbortController; promise: Promise<string>; url?: string }>();
  const observedMedia = new WeakSet<HTMLElement>();

  function release(key: string) {
    const entry = media.get(key);
    if (!entry) return;
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
    media.delete(key);
  }
  function close() {
    if (!dialog) return;
    const previousId = selected;
    dialog.querySelectorAll('video,audio').forEach(node => { (node as HTMLMediaElement).pause(); node.removeAttribute('src'); });
    dialog.remove(); dialog = null; selected = null; detailKey = ''; mediaKey = '';
    if (opener?.isConnected) opener.focus();
    else Array.from(root.querySelectorAll?.<HTMLElement>('[data-super-easy-inspect]') ?? []).find(node => node.dataset.superEasyInspect === previousId)?.focus();
    opener = null;
  }
  function clear() { epoch++; close(); for (const key of media.keys()) release(key); }
  function load(raw: string): Promise<string> {
    const url = safeGalleryUrl(raw);
    if (!url) return Promise.reject(new Error('Unavailable media'));
    if (/^(?:blob:|data:)/u.test(url)) return Promise.resolve(url);
    const cached = media.get(url);
    if (cached) return cached.promise;
    const controller = new AbortController();
    const ticket = epoch;
    const entry: { controller: AbortController; promise: Promise<string>; url?: string } = { controller, promise: Promise.resolve('') };
    entry.promise = (async () => {
      const absolute = new URL(url, doc.baseURI);
      const local = absolute.origin === new URL(doc.baseURI).origin;
      const response = local && options.fetch
        ? await options.fetch(url, { signal: controller.signal })
        : await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Unavailable media');
      const blob = await response.blob();
      if (ticket !== epoch || controller.signal.aborted || scope !== options.scope()) throw new Error('Expired media');
      entry.url = URL.createObjectURL(blob);
      return entry.url;
    })().catch(error => { if (media.get(url) === entry) release(url); throw error; });
    media.set(url, entry);
    return entry.promise;
  }
  function bind(node: HTMLImageElement | HTMLMediaElement, item: GalleryItem) {
    if (!item.url) return;
    const ticket = epoch, source = item.url;
    const unavailable = () => {
      if (ticket !== epoch || !node.isConnected) return;
      node.setAttribute('aria-label', `${item.label}: preview unavailable; open details for status`);
      if (dialog?.contains(node)) {
        const status = dialog.querySelector('[data-asset-detail-status]');
        if (status) status.textContent = 'Preview unavailable. Close and reopen to retry.';
      } else {
        const tile = node.closest?.('[data-super-easy-gallery-item]');
        if (tile && !tile.querySelector('[data-gallery-media-error]')) {
          const status = doc.createElement('p'); status.dataset.galleryMediaError = '';
          status.textContent = 'Preview unavailable · open details'; tile.append(status);
        }
      }
    };
    if (!observedMedia.has(node)) {
      observedMedia.add(node);
      node.addEventListener?.('error', unavailable);
    }
    void load(source).then(url => {
      if (ticket === epoch && scope === options.scope() && node.isConnected && options.gallery().items.some(next => next.id === item.id && next.url === source)) {
        if (node.getAttribute('src') !== url) node.src = url;
      }
    }).catch(unavailable);
  }
  function refreshDetail(item: GalleryItem) {
    if (!dialog) return;
    const next = assetDetailMarkup(item);
    if (detailKey !== next) { dialog.querySelector('[data-asset-detail-fields]')!.innerHTML = next; detailKey = next; }
    const type = item.details?.mediaType ?? (item.kind === 'voice' ? 'audio' : item.kind === 'final' || /\.(mp4|webm|mov)(?:[?#]|$)/iu.test(item.url ?? '') ? 'video' : 'image');
    const nextMedia = `${type}|${item.url ?? ''}`;
    if (mediaKey !== nextMedia) {
      const container = dialog.querySelector<HTMLElement>('[data-asset-detail-media]')!;
      container.querySelectorAll('video,audio').forEach(node => (node as HTMLMediaElement).pause());
      container.replaceChildren(); mediaKey = nextMedia;
      if (safeGalleryUrl(item.url)) {
        const node = doc.createElement(type === 'image' ? 'img' : type);
        node.setAttribute('aria-label', item.label);
        if (type === 'image') (node as HTMLImageElement).alt = item.label;
        else { (node as HTMLMediaElement).controls = true; node.setAttribute('preload', 'metadata'); node.setAttribute('playsinline', ''); }
        container.append(node); bind(node, item);
      }
    }
    dialog.querySelector('[data-asset-detail-status]')!.textContent = item.url ? ''
      : item.state === 'error' ? 'This asset needs attention. No preview is available.'
        : `No preview yet · ${item.details?.status ?? (item.state === 'empty' ? 'planned' : 'queued or generating')}`;
  }
  function open(item: GalleryItem, trigger: HTMLElement) {
    close(); selected = item.id; opener = trigger;
    dialog = doc.createElement('dialog'); dialog.className = 'super-easy-asset-dialog';
    dialog.setAttribute('aria-labelledby', 'super-easy-asset-title');
    dialog.innerHTML = `<header><h2 id="super-easy-asset-title">${escapeHtml(item.label)}</h2><button type="button" data-asset-detail-close aria-label="Close asset details">Close</button></header><div data-asset-detail-media></div><p role="status" data-asset-detail-status></p><section data-asset-detail-fields></section>`;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => {
      if ((event.target as Element)?.closest('[data-asset-detail-close]')) close();
      else if (event.target === dialog) {
        const rect = dialog!.getBoundingClientRect(), click = event as MouseEvent;
        if (click.clientX < rect.left || click.clientX > rect.right || click.clientY < rect.top || click.clientY > rect.bottom) close();
      }
    });
    doc.body.append(dialog); refreshDetail(item); dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button')!.focus();
  }
  function click(event: Event) {
    const target = event.target as Element | null;
    if (!target?.closest || target.closest('audio,video[controls]')) return;
    const button = target.closest<HTMLElement>('[data-super-easy-inspect]');
    const tile = target.closest<HTMLElement>('[data-super-easy-gallery-item]');
    const id = button?.dataset.superEasyInspect ?? (target.closest('.super-easy-progress-slot-media') ? tile?.dataset.superEasyGalleryItem : null);
    const item = options.gallery().items.find(item => item.id === id);
    if (!item) return;
    event.preventDefault();
    open(item, button ?? tile!.querySelector<HTMLElement>('[data-super-easy-inspect]')!);
  }
  function sync() {
    if (scope !== options.scope()) { clear(); scope = options.scope(); }
    const items = options.gallery().items;
    const urls = new Set(items.map(item => item.url));
    for (const key of media.keys()) if (!urls.has(key)) release(key);
    for (const node of root.querySelectorAll?.<HTMLImageElement | HTMLMediaElement>('[data-gallery-media]') ?? []) {
      const item = items.find(item => item.id === node.getAttribute('data-gallery-media'));
      if (item) bind(node, item);
    }
    if (selected) { const item = items.find(item => item.id === selected); if (item) refreshDetail(item); else close(); }
  }
  root.addEventListener('click', click);
  return { sync, clear, destroy() { clear(); root.removeEventListener('click', click); } };
}
