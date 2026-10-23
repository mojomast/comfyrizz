// UR28: the Review shot panel.
//
// The panel only chooses among versions the server already made, records the
// user's Keep verdict through the takes client, and routes Try again to either
// the free scene edit on This computer or a separately approved Google Colab
// plan. Rendering is pure; the mount function is the only DOM entry point.

import { COPY, fill } from './copy.ts';
import { escapeHtml } from './components.ts';
import { confirmDialog, openDialog as openEasyDialog } from './dialog.ts';
import type { Compute } from './types.ts';
import type { TakesApi, TakeVerdict } from '../takes/api.ts';

export const SHOT_CARD_CHIP_IDS = ['warmer', 'calmer-motion', 'more-depth', 'less-busy'] as const;
export const SHOT_CARD_SOMETHING_ELSE = 'something-else';
export const NO_CAP_REASON = 'Set a Google Colab spend cap before trying this shot again.';

export interface ShotCardVersion {
  takeId: string;
  n?: number;
  verdict?: TakeVerdict | string;
  [key: string]: unknown;
}

export interface ShotCardShot {
  id?: string;
  shotId?: string;
  clipId?: string;
  sceneId?: string;
  number?: number;
  n?: number;
  title?: string;
  selected?: string | null;
  [key: string]: unknown;
}

export interface ShotCardModel {
  shot: ShotCardShot;
  versions: readonly ShotCardVersion[];
  selectedVersionId: string | null;
  compute: Compute;
  colabLeft?: number | string | null;
  cap?: number | string | null;
  retryCost?: number | null;
  kept?: boolean;
}

export interface RetryCostInput {
  n: number;
  cost: number | string | null | undefined;
  left: number | string | null | undefined;
  cap: number | string | null | undefined;
}

export interface ShotCardTakesApi {
  select: TakesApi['select'];
  verdict: TakesApi['verdict'];
}

export interface ShotCardKeepHost {
  refreshClips(): Promise<void> | void;
}

export interface ShotCardHost extends ShotCardKeepHost {
  previewTake(clipId: string, takeId: string | null): Promise<void> | void;
  applySceneChip?(sceneId: string, chip: string): Promise<void> | void;
}

export interface ShotCardDeps {
  host: ShotCardHost;
  packageId?: string | null;
  takesApi?: ShotCardTakesApi;
  il?: { openCompare?: (shotId: string) => void };
  retryShot?: (shotId: string, chip?: string) => Promise<void> | void;
  openAsk?: (prefill?: string) => void;
  status?: (text: string) => void;
  alert?: (text: string) => void;
  costFor?: (shotId: string, chip: string) => number | null | undefined;
  retryCost?: number | null | (() => number | null | undefined);
  confirm?: typeof confirmDialog;
  openDialog?: typeof openEasyDialog;
}

export interface KeepVersionInput {
  packageId: string;
  clipId: string;
  takeId: string;
  takesApi: ShotCardTakesApi;
  host: ShotCardKeepHost;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function capIsSet(value: unknown): boolean {
  const cap = numberOf(value);
  return cap !== null && cap > 0;
}

export function retryBlockReason(cap: unknown): string | null {
  return capIsSet(cap) ? null : NO_CAP_REASON;
}

export function retryCostText({ n, cost, left, cap }: RetryCostInput): string | null {
  const capValue = numberOf(cap);
  if (capValue === null || capValue <= 0) return null;
  const costValue = numberOf(cost);
  const leftValue = numberOf(left);
  if (costValue === null || leftValue === null) return null;
  return fill(COPY.review.retryCost, {
    n,
    cost: String(costValue),
    left: String(leftValue),
    cap: String(capValue),
  });
}

export function shotCardShotId(shot: ShotCardShot | null | undefined): string {
  return textOf(shot?.shotId) || textOf(shot?.id) || textOf(shot?.sceneId) || textOf(shot?.clipId);
}

export function shotCardClipId(shot: ShotCardShot | null | undefined): string {
  return textOf(shot?.clipId) || textOf(shot?.id) || textOf(shot?.shotId) || textOf(shot?.sceneId);
}

export function shotCardSceneId(shot: ShotCardShot | null | undefined): string {
  return textOf(shot?.sceneId) || shotCardShotId(shot);
}

export function shotCardNumber(shot: ShotCardShot | null | undefined, defaultValue = 1): number {
  const value = numberOf(shot?.number) ?? numberOf(shot?.n);
  return value !== null && value > 0 ? Math.trunc(value) : defaultValue;
}

export function shotCardTitle(shot: ShotCardShot | null | undefined, defaultValue = 1): string {
  const title = textOf(shot?.title);
  return title || `Shot ${shotCardNumber(shot, defaultValue)}`;
}

function versionsOf(model: Pick<ShotCardModel, 'versions'>): ShotCardVersion[] {
  if (!Array.isArray(model.versions)) return [];
  return model.versions.filter((version): version is ShotCardVersion => (
    Boolean(version) && typeof version === 'object' && textOf(version.takeId) !== ''
  ));
}

function selectedVersion(
  model: Pick<ShotCardModel, 'versions' | 'selectedVersionId' | 'shot'>,
): ShotCardVersion | null {
  const versions = versionsOf(model);
  if (versions.length === 0) return null;
  const wanted = textOf(model.selectedVersionId) || textOf(model.shot?.selected);
  return versions.find((version) => textOf(version.takeId) === wanted) ?? versions[0];
}

function selectedIndex(
  model: Pick<ShotCardModel, 'versions' | 'selectedVersionId' | 'shot'>,
): number {
  const versions = versionsOf(model);
  if (versions.length === 0) return -1;
  const current = selectedVersion(model);
  return current ? versions.findIndex((version) => version.takeId === current.takeId) : 0;
}

export function shotCardIsKept(
  model: Pick<ShotCardModel, 'versions' | 'selectedVersionId' | 'shot' | 'kept'>,
): boolean {
  if (model.kept === true) return true;
  return selectedVersion(model)?.verdict === 'approved';
}

function titleIdFor(shot: ShotCardShot): string {
  const raw = shotCardShotId(shot) || 'current';
  return `easy-shot-title-${raw.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function versionSwitcher(model: ShotCardModel, versions: readonly ShotCardVersion[], index: number): string {
  if (versions.length <= 1) return '';
  const text = fill(COPY.review.version, { i: index + 1, count: versions.length });
  return `<div class="easy-shot-card-versions" data-easy-version-switch role="group" aria-label="${escapeHtml(COPY.review.version)}">
<button type="button" class="btn btn-ghost easy-shot-card-version-button" data-easy-version="prev" aria-label="${escapeHtml(COPY.review.prevVersion)}">◀</button>
<span class="easy-shot-card-version" data-easy-version-text aria-live="polite">${escapeHtml(text)}</span>
<button type="button" class="btn btn-ghost easy-shot-card-version-button" data-easy-version="next" aria-label="${escapeHtml(COPY.review.nextVersion)}">▶</button>
</div>`;
}

function chipButton(
  id: string,
  label: string,
  options: { disabled: boolean; reasonId: string | null },
): string {
  const disabled = options.disabled ? ' disabled' : '';
  const describedBy = options.disabled && options.reasonId
    ? ` aria-describedby="${escapeHtml(options.reasonId)}"`
    : '';
  return `<button type="button" class="easy-chip easy-shot-card-chip" data-easy-scene-chip="${escapeHtml(id)}"${disabled}${describedBy}>${escapeHtml(label)}</button>`;
}

function retryChips(reasonId: string, blocked: string | null): string {
  const chips = SHOT_CARD_CHIP_IDS.map((id) => chipButton(
    id,
    COPY.review.retryChips[id],
    { disabled: Boolean(blocked), reasonId },
  )).join('');
  const ask = `<button type="button" class="easy-chip easy-shot-card-chip easy-shot-card-ask" data-easy-ask="${escapeHtml(SHOT_CARD_SOMETHING_ELSE)}">${escapeHtml(COPY.review.somethingElse)}</button>`;
  const warning = blocked
    ? `<p class="easy-shot-card-reason" id="${escapeHtml(reasonId)}" role="status" data-easy-retry-blocked>${escapeHtml(blocked)}</p>`
    : '';
  return `<div class="easy-shot-card-retry" role="group" aria-label="${escapeHtml(COPY.review.retryLabel)}">
<span class="easy-shot-card-retry-label">${escapeHtml(COPY.review.retryLabel)}</span>
${chips}${ask}
</div>${warning}`;
}

export function renderShotCard(model: ShotCardModel): string {
  const versions = versionsOf(model);
  const current = selectedVersion(model);
  const index = selectedIndex(model);
  const n = shotCardNumber(model.shot);
  const title = shotCardTitle(model.shot);
  const titleId = titleIdFor(model.shot);
  const shotId = shotCardShotId(model.shot);
  const sceneId = shotCardSceneId(model.shot);
  const kept = shotCardIsKept(model);
  const keepLabel = kept ? COPY.review.keptLabel : COPY.review.keep;
  const keepState = kept || !current ? ' disabled aria-disabled="true"' : '';
  const versionId = current ? textOf(current.takeId) : '';
  const compare = versions.length >= 2
    ? `<button type="button" class="btn btn-secondary easy-shot-card-compare" data-easy-shot-action="compare">${escapeHtml(COPY.review.compare)}</button>`
    : '';
  const blocked = model.compute === 'colab' ? retryBlockReason(model.cap) : null;
  const reasonId = `easy-shot-cap-${(shotId || 'current').replace(/[^A-Za-z0-9_-]/g, '-')}`;

  return `<section class="easy-shot-card" aria-labelledby="${escapeHtml(titleId)}" data-easy-shot-card data-easy-shot="${escapeHtml(shotId)}" data-easy-scene="${escapeHtml(sceneId)}">
<header class="easy-shot-card-head">
<h2 class="easy-shot-card-title" id="${escapeHtml(titleId)}">${escapeHtml(fill(COPY.review.shotTitle, { n, title }))}</h2>
${versionSwitcher(model, versions, index)}
</header>
<div class="easy-shot-card-actions">
<button type="button" class="btn btn-primary easy-shot-card-keep" data-easy-shot-action="keep" data-easy-version-id="${escapeHtml(versionId)}"${keepState}>${escapeHtml(keepLabel)}</button>
${compare}
</div>
${retryChips(reasonId, blocked)}
<div class="easy-shot-words" data-easy-words></div>
</section>`;
}

export async function keepVersion({ packageId, clipId, takeId, takesApi, host }: KeepVersionInput): Promise<void> {
  const projectId = textOf(packageId);
  const shotId = textOf(clipId);
  const versionId = textOf(takeId);
  if (!projectId || !shotId || !versionId || !takesApi) throw new TypeError('Missing id for Keep');
  await takesApi.select(projectId, shotId, versionId);
  await takesApi.verdict(projectId, shotId, 'approved', { takeId: versionId });
  await host.refreshClips();
}

export interface KeepAllItem {
  shot: ShotCardShot;
  versions: readonly ShotCardVersion[];
  selectedVersionId: string | null;
  kept?: boolean;
}

export function renderKeepAll(items: readonly KeepAllItem[] | null | undefined): string {
  const list = Array.isArray(items) ? items : [];
  const pending = list.filter((item) => !shotCardIsKept(item));
  if (pending.length <= 1) return '';
  return `<button type="button" class="btn btn-secondary easy-shot-card-keep-all" data-easy-keep-all>${escapeHtml(COPY.review.keepAll)}</button>`;
}

export interface KeepAllOptions {
  items: readonly KeepAllItem[];
  packageId: string;
  takesApi: ShotCardTakesApi;
  host: ShotCardKeepHost;
  opener?: HTMLElement | null;
  confirm?: typeof confirmDialog;
  status?: (text: string) => void;
}

export async function keepAllShots(options: KeepAllOptions): Promise<number> {
  const confirmAction = options.confirm ?? confirmDialog;
  const pending = options.items.filter((item) => !shotCardIsKept(item));
  if (pending.length === 0) return 0;
  const names = pending.map((item, index) => (
    fill(COPY.review.shotTitle, {
      n: shotCardNumber(item.shot, index + 1),
      title: shotCardTitle(item.shot, index + 1),
    })
  )).join(', ');
  const ok = await confirmAction({
    title: COPY.review.keepAllTitle,
    text: names,
    confirmLabel: COPY.review.keepAll,
    cancelLabel: COPY.review.cancel,
    opener: options.opener ?? null,
  });
  if (!ok) return 0;

  let kept = 0;
  for (const item of pending) {
    const version = selectedVersion(item);
    if (!version) continue;
    await keepVersion({
      packageId: options.packageId,
      clipId: shotCardClipId(item.shot),
      takeId: version.takeId,
      takesApi: options.takesApi,
      host: options.host,
    });
    kept += 1;
  }
  options.status?.(COPY.review.keptLabel);
  return kept;
}

export interface ShotCardController {
  update(next: ShotCardModel): void;
  current(): ShotCardModel;
  destroy(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '';
}

export function mountShotCard(
  el: HTMLElement,
  model: ShotCardModel,
  deps: ShotCardDeps,
): ShotCardController {
  let current = model;
  let disposed = false;
  const confirmAction = deps.confirm ?? confirmDialog;
  const dialogAction = deps.openDialog ?? openEasyDialog;

  function status(text: string): void {
    deps.status?.(text);
  }

  function alert(text: string): void {
    if (deps.alert) deps.alert(text);
    else status(text);
  }

  function paint(): void {
    if (disposed) return;
    el.innerHTML = renderShotCard(current);
    if (!deps.il?.openCompare) {
      el.querySelector('[data-easy-shot-action="compare"]')?.remove();
    }
  }

  async function preview(step: number): Promise<void> {
    const versions = versionsOf(current);
    if (versions.length <= 1) return;
    const index = selectedIndex(current);
    const nextIndex = (index + step + versions.length) % versions.length;
    const next = versions[nextIndex];
    current = { ...current, selectedVersionId: next.takeId };
    paint();
    try {
      await deps.host.previewTake(shotCardClipId(current.shot), next.takeId);
    } catch (error) {
      const why = messageOf(error);
      alert(why || 'Could not preview this version.');
    }
  }

  async function keep(): Promise<void> {
    const version = selectedVersion(current);
    if (!version || shotCardIsKept(current)) return;
    const projectId = textOf(deps.packageId);
    if (!projectId || !deps.takesApi) {
      alert('Could not keep this version.');
      return;
    }
    try {
      await keepVersion({
        packageId: projectId,
        clipId: shotCardClipId(current.shot),
        takeId: version.takeId,
        takesApi: deps.takesApi,
        host: deps.host,
      });
      current = {
        ...current,
        kept: true,
        versions: current.versions.map((item) => (
          item.takeId === version.takeId ? { ...item, verdict: 'approved' } : item
        )),
      };
      paint();
      status(COPY.review.keptLabel);
    } catch (error) {
      const why = messageOf(error);
      alert(why || 'Could not keep this version.');
    }
  }

  function openCompare(opener: HTMLElement): void {
    const openCompareView = deps.il?.openCompare;
    if (!openCompareView) return;
    const shotId = shotCardShotId(current.shot);
    void dialogAction({
      title: COPY.review.compare,
      bodyHtml: '<div data-il-slot="compare-view"></div>',
      actions: [{ label: COPY.ask.close, value: 'close', kind: 'secondary' }],
      opener,
    });
    openCompareView(shotId);
  }

  function retryCostFor(shotId: string, chip: string): number {
    const fromDeps = deps.costFor?.(shotId, chip);
    const retryCost = typeof deps.retryCost === 'function' ? deps.retryCost() : deps.retryCost;
    return numberOf(fromDeps) ?? numberOf(retryCost) ?? numberOf(current.retryCost) ?? 1;
  }

  async function retryChip(chip: string, opener: HTMLElement): Promise<void> {
    const shotId = shotCardShotId(current.shot);
    if (chip === SHOT_CARD_SOMETHING_ELSE) {
      deps.openAsk?.(fill(COPY.ask.prefill, { n: shotCardNumber(current.shot) }));
      return;
    }
    if (current.compute !== 'colab') {
      try {
        await deps.host.applySceneChip?.(shotCardSceneId(current.shot), chip);
      } catch (error) {
        const why = messageOf(error);
        alert(why || 'Could not try this shot again.');
      }
      return;
    }

    const blocked = retryBlockReason(current.cap);
    if (blocked) {
      alert(blocked);
      return;
    }
    if (!deps.retryShot) {
      alert('Could not try this shot again.');
      return;
    }
    const cap = numberOf(current.cap);
    const left = numberOf(current.colabLeft) ?? cap;
    const text = retryCostText({
      n: shotCardNumber(current.shot),
      cost: retryCostFor(shotId, chip),
      left,
      cap,
    });
    if (!text) {
      alert(NO_CAP_REASON);
      return;
    }
    const ok = await confirmAction({
      title: COPY.review.retryTitle,
      text,
      confirmLabel: COPY.review.retryApprove,
      cancelLabel: COPY.review.cancel,
      opener,
    });
    if (!ok) return;
    try {
      await deps.retryShot(shotId, chip);
    } catch (error) {
      const why = messageOf(error);
      alert(why || 'Could not try this shot again.');
    }
  }

  async function onClick(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const versionButton = target.closest<HTMLElement>('[data-easy-version]');
    if (versionButton && el.contains(versionButton)) {
      await preview(versionButton.getAttribute('data-easy-version') === 'prev' ? -1 : 1);
      return;
    }
    const keepButton = target.closest<HTMLElement>('[data-easy-shot-action="keep"]');
    if (keepButton && el.contains(keepButton)) {
      await keep();
      return;
    }
    const compareButton = target.closest<HTMLElement>('[data-easy-shot-action="compare"]');
    if (compareButton && el.contains(compareButton)) {
      openCompare(compareButton);
      return;
    }
    const askButton = target.closest<HTMLElement>('[data-easy-ask]');
    if (askButton && el.contains(askButton)) {
      await retryChip(SHOT_CARD_SOMETHING_ELSE, askButton);
      return;
    }
    const chipButtonEl = target.closest<HTMLElement>('[data-easy-scene-chip]');
    if (chipButtonEl && el.contains(chipButtonEl)) {
      const chip = chipButtonEl.getAttribute('data-easy-scene-chip');
      if (chip) await retryChip(chip, chipButtonEl);
    }
  }

  const listener = (event: Event): void => {
    void onClick(event);
  };

  el.addEventListener('click', listener);
  paint();

  return {
    update(next: ShotCardModel): void {
      current = next;
      paint();
    },
    current(): ShotCardModel {
      return current;
    },
    destroy(): void {
      disposed = true;
      el.removeEventListener('click', listener);
    },
  };
}

export const bindShotCard = mountShotCard;
