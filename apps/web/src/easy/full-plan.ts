import { escapeHtml } from './components.ts';
import { planInputsHash } from './store.ts';
import type { EasyStepContext, EasyState } from './types.ts';
import { readPlanCard, type PlanCard } from '../productions/cards/plan-card.ts';

const LOAD_ERROR = 'We couldn’t load the full plan. Close and try again.';
const PLANNING_ERROR = 'We couldn’t prepare the plan. No generation was started.';
const CONFLICT_ERROR = 'This project changed elsewhere. Your edits were not overwritten. Close and reopen the full plan to load the latest version.';

interface LoadedPackage {
  package: Record<string, unknown>;
  editor: Record<string, unknown> | null;
  revision: number;
}

interface FullPlanHooks {
  onSnapshot(snapshot: unknown): void;
}

class FullPlanHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FullPlanHttpError';
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOwn(value: Record<string, unknown> | null, key: string): boolean {
  return value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function displayOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '—';
}

function revisionOf(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Unknown error';
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T;
  const record = asRecord(value);
  if (!record) return value;
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    Object.defineProperty(clone, key, {
      value: cloneValue(entry),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return clone as T;
}

function encodePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function decodePointerSegment(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

function pointerSegments(path: string): string[] {
  if (!path.startsWith('/') || path === '/') throw new Error('Invalid full-plan field path.');
  const segments = path.slice(1).split('/').map(decodePointerSegment);
  if (segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) {
    throw new Error('Unsafe full-plan field path.');
  }
  return segments;
}

function arrayIndex(segment: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(segment)) return null;
  const index = Number(segment);
  return Number.isSafeInteger(index) ? index : null;
}

function valueAtPointer(root: unknown, segments: readonly string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = arrayIndex(segment);
      if (index === null) return undefined;
      current = current[index];
    } else {
      const record = asRecord(current);
      if (!record || !hasOwn(record, segment)) return undefined;
      current = record[segment];
    }
  }
  return current;
}

function itemLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function setPointer(root: Record<string, unknown>, segments: readonly string[], value: string): void {
  let current: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    if (Array.isArray(current)) {
      const itemIndex = arrayIndex(segment);
      if (itemIndex === null) throw new Error('Invalid array index in full-plan field path.');
      if (!asRecord(current[itemIndex]) && !Array.isArray(current[itemIndex])) {
        current[itemIndex] = arrayIndex(nextSegment) === null ? {} : [];
      }
      current = current[itemIndex];
      continue;
    }
    const record = asRecord(current);
    if (!record) throw new Error('Invalid full-plan field path.');
    if (!asRecord(record[segment]) && !Array.isArray(record[segment])) {
      Object.defineProperty(record, segment, {
        value: arrayIndex(nextSegment) === null ? {} : [],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    current = record[segment];
  }

  const finalSegment = segments[segments.length - 1];
  const nextValue = finalSegment === 'items' ? itemLines(value) : value;
  if (Array.isArray(current)) {
    const itemIndex = arrayIndex(finalSegment);
    if (itemIndex === null) throw new Error('Invalid array index in full-plan field path.');
    current[itemIndex] = nextValue;
    return;
  }
  const record = asRecord(current);
  if (!record) throw new Error('Invalid full-plan field path.');
  Object.defineProperty(record, finalSegment, {
    value: nextValue,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Apply pointer-addressed text edits to a deep clone, leaving pkg untouched. */
export function applyFullPlanFields<T>(pkg: T, fields: Readonly<Record<string, string>>): T {
  const edited = cloneValue(pkg);
  if (!asRecord(edited)) throw new Error('The full project must be an object.');
  for (const [path, value] of Object.entries(fields)) {
    const segments = pointerSegments(path);
    const previous = valueAtPointer(edited, segments);
    // Blank core controls do not create new empty objects merely by opening
    // and saving the dialog. Once text is entered, the missing path is built.
    if (previous === undefined && value === '') continue;
    if (typeof previous === 'string' && previous === value) continue;
    if (Array.isArray(previous) && previous.every((entry) => typeof entry === 'string')
      && previous.join('\n') === value) continue;
    setPointer(edited as Record<string, unknown>, segments, String(value));
  }
  return edited;
}

interface TextFieldOptions {
  id: string;
  label: string;
  path: string;
  value: unknown;
  multiline?: boolean;
  rows?: number;
  hint?: string;
}

function textField(options: TextFieldOptions): string {
  const value = Array.isArray(options.value)
    ? options.value.map((entry) => textOf(entry)).join('\n')
    : textOf(options.value);
  const hintId = options.hint ? `${options.id}-hint` : '';
  const describedBy = hintId ? ` aria-describedby="${escapeHtml(hintId)}"` : '';
  const hint = options.hint
    ? `<span class="easy-full-plan-field-hint" id="${escapeHtml(hintId)}">${escapeHtml(options.hint)}</span>`
    : '';
  const control = options.multiline
    ? `<textarea id="${escapeHtml(options.id)}" data-full-plan-path="${escapeHtml(options.path)}" rows="${options.rows ?? 3}"${describedBy}>${escapeHtml(value)}</textarea>`
    : `<input id="${escapeHtml(options.id)}" type="text" data-full-plan-path="${escapeHtml(options.path)}" value="${escapeHtml(value)}"${describedBy} />`;
  return `<div class="easy-full-plan-field"><label for="${escapeHtml(options.id)}">${escapeHtml(options.label)}</label>${control}${hint}</div>`;
}

function sceneMarkup(scene: Record<string, unknown>, index: number): string {
  const copy = asRecord(scene.copy);
  const base = `/scenes/${index}`;
  const copyBase = `${base}/copy`;
  const prefix = `easy-full-plan-scene-${index}`;
  const headline = textOf(copy?.headline);
  const title = headline || textOf(scene.id) || `Scene ${index + 1}`;
  const fields = [
    textField({ id: `${prefix}-kicker`, label: 'Kicker', path: `${copyBase}/kicker`, value: copy?.kicker }),
    textField({ id: `${prefix}-headline`, label: 'Headline', path: `${copyBase}/headline`, value: copy?.headline }),
    textField({ id: `${prefix}-sub`, label: 'Subheadline', path: `${copyBase}/sub`, value: copy?.sub, multiline: true, rows: 2 }),
    textField({ id: `${prefix}-body`, label: 'Body copy', path: `${copyBase}/body`, value: copy?.body, multiline: true, rows: 4 }),
    textField({ id: `${prefix}-quote`, label: 'Quote', path: `${copyBase}/quote`, value: copy?.quote, multiline: true, rows: 3 }),
    textField({ id: `${prefix}-attribution`, label: 'Attribution', path: `${copyBase}/attribution`, value: copy?.attribution }),
    textField({ id: `${prefix}-footnote`, label: 'Footnote', path: `${copyBase}/footnote`, value: copy?.footnote }),
    textField({ id: `${prefix}-cta`, label: 'Call to action', path: `${copyBase}/cta`, value: copy?.cta }),
    textField({ id: `${prefix}-items`, label: 'Items', path: `${copyBase}/items`, value: copy?.items, multiline: true, rows: 4, hint: 'One item per line.' }),
    textField({ id: `${prefix}-narration`, label: 'Narration', path: `${base}/narration`, value: scene.narration, multiline: true, rows: 4 }),
    textField({ id: `${prefix}-notes`, label: 'Notes / visual direction', path: `${base}/notes`, value: scene.notes, multiline: true, rows: 4 }),
  ];
  if (hasOwn(scene, 'narration_text')) {
    fields.push(textField({ id: `${prefix}-narration-text`, label: 'Narration text', path: `${base}/narration_text`, value: scene.narration_text, multiline: true, rows: 4 }));
  }
  if (hasOwn(scene, 'visualDirection')) {
    fields.push(textField({ id: `${prefix}-visual-direction`, label: 'Visual direction', path: `${base}/visualDirection`, value: scene.visualDirection, multiline: true, rows: 4 }));
  }
  if (hasOwn(scene, 'visual_direction')) {
    fields.push(textField({ id: `${prefix}-visual-direction-snake`, label: 'Visual direction', path: `${base}/visual_direction`, value: scene.visual_direction, multiline: true, rows: 4 }));
  }
  return `<details class="easy-full-plan-card easy-full-plan-scene"${index === 0 ? ' open' : ''}>
<summary><span class="easy-full-plan-card-number">Scene ${index + 1}</span><span>${escapeHtml(title)}</span></summary>
<div class="easy-full-plan-card-body"><div class="easy-full-plan-field-grid">${fields.join('')}</div></div>
</details>`;
}

interface AssetEntry {
  id: string;
  path: string;
  asset: Record<string, unknown>;
}

function assetEntries(pkg: Record<string, unknown>): AssetEntry[] {
  const assets = pkg.assets;
  if (Array.isArray(assets)) {
    return assets.flatMap((value, index) => {
      const asset = asRecord(value);
      return asset ? [{ id: textOf(asset.id) || `Asset ${index + 1}`, path: String(index), asset }] : [];
    });
  }
  const record = asRecord(assets);
  if (!record) return [];
  return Object.entries(record).flatMap(([id, value]) => {
    const asset = asRecord(value);
    return asset ? [{ id, path: id, asset }] : [];
  });
}

function assetMarkup(entry: AssetEntry, index: number): string {
  const { asset } = entry;
  const gen = asRecord(asset.gen);
  const inputs = asRecord(gen?.inputs);
  const direction = asRecord(gen?.direction);
  const base = `/assets/${encodePointerSegment(entry.path)}/gen`;
  const prefix = `easy-full-plan-asset-${index}`;
  const fields: string[] = [];
  const inputFields: Array<{ key: string; label: string; rows: number }> = [
    { key: 'prompt', label: 'Prompt', rows: 5 },
    { key: 'negative', label: 'Negative prompt', rows: 3 },
    { key: 'style', label: 'Style', rows: 2 },
    { key: 'finishing_sound', label: 'Input finishing sound', rows: 3 },
    { key: 'plan', label: 'Audio plan', rows: 4 },
  ];
  for (const field of inputFields) {
    if (hasOwn(inputs, field.key)) {
      fields.push(textField({ id: `${prefix}-input-${field.key}`, label: field.label, path: `${base}/inputs/${field.key}`, value: inputs?.[field.key], multiline: true, rows: field.rows }));
    }
  }
  const directionFields: Array<{ key: string; label: string; rows: number }> = [
    { key: 'subject', label: 'Direction · subject', rows: 4 },
    { key: 'composition', label: 'Direction · composition', rows: 4 },
    { key: 'action', label: 'Direction · action', rows: 4 },
    { key: 'camera', label: 'Direction · camera', rows: 3 },
    { key: 'soundscape', label: 'Direction · soundscape', rows: 4 },
    { key: 'non_diegetic_music', label: 'Direction · non-diegetic music', rows: 3 },
  ];
  for (const field of directionFields) {
    if (hasOwn(direction, field.key)) {
      fields.push(textField({ id: `${prefix}-direction-${field.key}`, label: field.label, path: `${base}/direction/${field.key}`, value: direction?.[field.key], multiline: true, rows: field.rows }));
    }
  }
  const dialogue = asRecord(direction?.dialogue);
  const dialogueFields: Array<{ key: string; label: string; rows: number; hint?: string }> = [
    { key: 'text', label: 'Dialogue · exact spoken text', rows: 3, hint: 'Keep this exact line consistent with the scene narration and source video.' },
    { key: 'conditioningText', label: 'Dialogue · conditioning transcript', rows: 3 },
    { key: 'language', label: 'Dialogue · language', rows: 2 },
    { key: 'voice', label: 'Dialogue · voice direction', rows: 2 },
    { key: 'delivery', label: 'Dialogue · delivery', rows: 3 },
  ];
  for (const field of dialogueFields) {
    if (hasOwn(dialogue, field.key)) {
      fields.push(textField({ id: `${prefix}-dialogue-${field.key}`, label: field.label, path: `${base}/direction/dialogue/${field.key}`, value: dialogue?.[field.key], multiline: true, rows: field.rows, ...(field.hint ? { hint: field.hint } : {}) }));
    }
  }
  if (hasOwn(gen, 'finishing_sound')) {
    fields.push(textField({ id: `${prefix}-finishing-sound`, label: 'Finishing sound', path: `${base}/finishing_sound`, value: gen?.finishing_sound, multiline: true, rows: 3 }));
  }
  const body = fields.length
    ? `<div class="easy-full-plan-field-grid">${fields.join('')}</div>`
    : '<p class="easy-full-plan-empty">This asset has no editable generation directions.</p>';
  const kind = displayOf(asset.kind);
  const status = displayOf(asset.status);
  return `<details class="easy-full-plan-card easy-full-plan-asset">
<summary><span>${escapeHtml(entry.id)}</span><span class="easy-full-plan-card-meta">${escapeHtml(kind)} · ${escapeHtml(status)}</span></summary>
<div class="easy-full-plan-card-body">${body}</div>
</details>`;
}

function actionTarget(action: Record<string, unknown>): string {
  const direct = textOf(action.targetId) || textOf(action.target);
  if (direct) return direct;
  if (!Array.isArray(action.targetIds)) return '—';
  const targets = action.targetIds.map((entry) => textOf(entry)).filter(Boolean);
  return targets.length ? targets.join(', ') : '—';
}

function actionAssets(action: Record<string, unknown>): string {
  if (Array.isArray(action.assetIds)) {
    const ids = action.assetIds.map((entry) => textOf(entry)).filter(Boolean);
    return ids.length ? ids.join(', ') : '—';
  }
  return textOf(action.assetId) || '—';
}

function actionTakes(action: Record<string, unknown>): string {
  for (const key of ['takes', 'versions', 'count']) {
    if (hasOwn(action, key)) return displayOf(action[key]);
  }
  return '—';
}

function gpuMarkup(cardInput: unknown): string {
  const inputRecord = asRecord(cardInput);
  const card = inputRecord && Array.isArray(inputRecord.actions)
    ? inputRecord
    : cardInput === null || cardInput === undefined
      ? null
      : asRecord(readPlanCard(cardInput));
  if (!card) {
    return '<p class="easy-full-plan-empty">No current plan card is available. Re-propose to create a plan without starting GPU work.</p>';
  }
  const actions = Array.isArray(card.actions)
    ? card.actions.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const rows = actions.map((action, index) => `<li class="easy-full-plan-action">
<div class="easy-full-plan-action-heading"><strong>${escapeHtml(textOf(action.kind) || `Action ${index + 1}`)}</strong><span>${escapeHtml(actionTarget(action))}</span></div>
<dl>
<div><dt>Kind</dt><dd>${escapeHtml(displayOf(action.kind))}</dd></div>
<div><dt>Target</dt><dd>${escapeHtml(actionTarget(action))}</dd></div>
<div><dt>Versions</dt><dd>${escapeHtml(actionTakes(action))}</dd></div>
<div><dt>Upper bound</dt><dd>${escapeHtml(displayOf(action.upperBound))}</dd></div>
<div><dt>Asset IDs</dt><dd>${escapeHtml(actionAssets(action))}</dd></div>
</dl>
</li>`).join('');
  const ceiling = displayOf(card.reservationCeiling);
  const reserve = displayOf(card.collectAndStopReserve);
  return `<div class="easy-full-plan-cost" aria-label="Server plan cost upper bounds">
<p><strong>Reservation ceiling:</strong> ${escapeHtml(ceiling)} units</p>
<p><strong>Collect-and-stop reserve:</strong> ${escapeHtml(reserve)} units</p>
</div>
${rows ? `<ol class="easy-full-plan-actions">${rows}</ol>` : '<p class="easy-full-plan-empty">The signed plan has no GPU actions.</p>'}`;
}

function packageJson(pkg: unknown): string {
  try {
    return JSON.stringify(pkg, null, 2) ?? '';
  } catch {
    return 'Project JSON is unavailable.';
  }
}

/** Render the complete editor contents. All package and plan text is escaped. */
export function fullPlanMarkup(pkg: unknown, card?: unknown): string {
  const record = asRecord(pkg) ?? {};
  const scenes = Array.isArray(record.scenes)
    ? record.scenes.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const assets = assetEntries(record);
  const sceneCards = scenes.map((scene, index) => sceneMarkup(scene, index)).join('');
  const assetCards = assets.map((asset, index) => assetMarkup(asset, index)).join('');
  return `<div class="easy-full-plan" data-full-plan>
<header class="easy-full-plan-header">
<div><p class="easy-full-plan-eyebrow">Creative review</p><h2 id="easy-full-plan-title">Review &amp; edit full plan</h2><p>Check every word and generation direction before approving any work.</p></div>
<button type="button" class="btn btn-ghost easy-full-plan-close" data-full-plan-close aria-label="Close full plan editor">Close</button>
</header>
<div class="easy-full-plan-error" data-full-plan-error role="alert" tabindex="-1" hidden></div>
<div class="easy-full-plan-scroll">
<nav class="easy-full-plan-index" aria-label="Full plan sections">
<strong>On this plan</strong>
<a href="#easy-full-plan-overview">Overview</a>
<a href="#easy-full-plan-scenes">Scenes <span>${scenes.length}</span></a>
<a href="#easy-full-plan-assets">Generation assets <span>${assets.length}</span></a>
<a href="#easy-full-plan-gpu">GPU actions &amp; cost</a>
</nav>
<main class="easy-full-plan-content">
<section id="easy-full-plan-overview" class="easy-full-plan-section" aria-labelledby="easy-full-plan-overview-title">
<div class="easy-full-plan-section-heading"><div><p class="easy-full-plan-step">01</p><h3 id="easy-full-plan-overview-title">Overview</h3></div><span>Revision ${escapeHtml(displayOf(record.revision))}</span></div>
<div class="easy-full-plan-overview-grid">
${textField({ id: 'easy-full-plan-package-title', label: 'Title', path: '/title', value: record.title })}
${textField({ id: 'easy-full-plan-logline', label: 'Proposal logline', path: '/proposal/logline', value: asRecord(record.proposal)?.logline, multiline: true, rows: 3 })}
${textField({ id: 'easy-full-plan-look', label: 'Look', path: '/proposal/look', value: asRecord(record.proposal)?.look, multiline: true, rows: 2 })}
${textField({ id: 'easy-full-plan-soundtrack', label: 'Soundtrack', path: '/proposal/soundtrack', value: asRecord(record.proposal)?.soundtrack, multiline: true, rows: 2 })}
</div>
</section>
<section id="easy-full-plan-scenes" class="easy-full-plan-section" aria-labelledby="easy-full-plan-scenes-title">
<div class="easy-full-plan-section-heading"><div><p class="easy-full-plan-step">02</p><h3 id="easy-full-plan-scenes-title">Scenes</h3></div><span>${scenes.length} total</span></div>
<div class="easy-full-plan-cards">${sceneCards || '<p class="easy-full-plan-empty">This project has no scenes.</p>'}</div>
</section>
<section id="easy-full-plan-assets" class="easy-full-plan-section" aria-labelledby="easy-full-plan-assets-title">
<div class="easy-full-plan-section-heading"><div><p class="easy-full-plan-step">03</p><h3 id="easy-full-plan-assets-title">Generation assets</h3></div><span>${assets.length} total</span></div>
<div class="easy-full-plan-cards">${assetCards || '<p class="easy-full-plan-empty">This project has no generation assets.</p>'}</div>
</section>
<section id="easy-full-plan-gpu" class="easy-full-plan-section" aria-labelledby="easy-full-plan-gpu-title">
<div class="easy-full-plan-section-heading"><div><p class="easy-full-plan-step">04</p><h3 id="easy-full-plan-gpu-title">GPU actions &amp; cost</h3></div><span>Read only</span></div>
<p class="easy-full-plan-section-intro">These are the signed plan’s slots and server upper bounds. Reviewing or re-proposing never approves them.</p>
${gpuMarkup(card)}
<details class="easy-full-plan-json"><summary>Full signed plan JSON <span>Read only</span></summary><pre>${escapeHtml(packageJson(card ?? null))}</pre></details>
</section>
<details class="easy-full-plan-json"><summary>Full project JSON <span>Read only</span></summary><pre data-full-plan-json>${escapeHtml(packageJson(pkg))}</pre></details>
</main>
</div>
<footer class="easy-full-plan-savebar">
<div class="easy-full-plan-save-copy"><strong>Save and re-sign, then approve separately.</strong><span data-full-plan-status role="status" aria-live="polite">No paid work starts here.</span></div>
<div class="easy-full-plan-save-actions">
<button type="button" class="btn btn-secondary" data-full-plan-cancel>Cancel</button>
<button type="button" class="btn btn-primary" data-full-plan-save>Save &amp; re-sign plan</button>
</div>
</footer>
</div>`;
}

function planActions(card: unknown): Record<string, unknown>[] {
  const record = asRecord(card);
  if (!record || !Array.isArray(record.actions)) return [];
  return record.actions.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null);
}

/** Preserve shot scope, but never accidentally scope a final whole-film plan. */
export function fullPlanProposalScope(card: unknown): { onlyShotIds?: string[] } {
  const actions = planActions(card);
  if (actions.some((action) => textOf(action.kind) === 'final')) return {};
  const onlyShotIds: string[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (textOf(action.kind) !== 'shot.generate') continue;
    const targets = Array.isArray(action.targetIds) ? action.targetIds : [action.targetId];
    for (const target of targets) {
      const id = textOf(target).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      onlyShotIds.push(id);
    }
  }
  return onlyShotIds.length ? { onlyShotIds } : {};
}

function hasSignedPlan(card: PlanCard | null): boolean {
  return Boolean(card && typeof card.planId === 'string' && card.planId && typeof card.planHash === 'string' && card.planHash);
}

function productionIdOf(body: unknown): string | null {
  const record = asRecord(body);
  const production = asRecord(record?.production);
  return textOf(record?.productionId).trim()
    || textOf(production?.id).trim()
    || textOf(record?.id).trim()
    || null;
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const parsed = await response.json().catch(() => ({}));
  const body = asRecord(parsed) ?? {};
  if (!response.ok) {
    const message = textOf(body.message) || textOf(body.error) || textOf(body.code) || `HTTP ${response.status}`;
    throw new FullPlanHttpError(response.status, message);
  }
  return body;
}

async function loadPackage(ctx: EasyStepContext): Promise<{ latest: LoadedPackage; packageId: string }> {
  const state = ctx.store.get();
  const api = ctx.api as unknown as { getPackage?: (packageId: string | null) => Promise<unknown> };
  let body: unknown;
  if (typeof api.getPackage === 'function') {
    body = await api.getPackage.call(ctx.api, state.packageId);
  } else if (state.packageId) {
    const response = await ctx.host.apiFetch(`/api/package/${encodeURIComponent(state.packageId)}`);
    body = await readResponse(response);
  }
  const wrapper = asRecord(body);
  const fallback = asRecord(ctx.host.getPackage());
  const pkg = asRecord(wrapper?.package) ?? (wrapper && hasOwn(wrapper, 'id') && hasOwn(wrapper, 'scenes') ? wrapper : fallback);
  if (!pkg) throw new Error('The current project is unavailable.');
  const packageId = state.packageId || textOf(pkg.id);
  if (!packageId) throw new Error('The current project id is unavailable.');
  return {
    latest: {
      package: pkg,
      editor: asRecord(wrapper?.editor) ?? asRecord(ctx.host.editorStore.getState().doc.editor),
      revision: revisionOf(wrapper?.revision ?? pkg.revision),
    },
    packageId,
  };
}

function readyPlan(ctx: EasyStepContext): void {
  const current = ctx.store.get();
  ctx.store.patch({
    planHash: planInputsHash(current),
    plan: { ...current.plan, status: 'ready', wordsChanged: false, error: null, errorAt: null },
  });
}

/** Ensure proposal-only projects have a production and a signed plan first. */
async function prepareInitialPlan(ctx: EasyStepContext, hooks: FullPlanHooks): Promise<{ snapshot: unknown; card: PlanCard }> {
  let state = ctx.store.get();
  let snapshot: unknown = null;
  let card: PlanCard | null = null;
  if (state.productionId) {
    snapshot = await ctx.api.getProduction(state.productionId);
    card = readPlanCard(snapshot);
  }

  if (!hasSignedPlan(card)) {
    if (typeof ctx.writePlan === 'function') {
      // Phase 2 reuses the package. makeCtx also persists the selected level.
      const current = ctx.store.get();
      ctx.store.patch({ plan: { ...current.plan, status: 'building', error: null, errorAt: null } });
      await ctx.writePlan();
      const written = ctx.store.get();
      if (written.plan.status === 'error') throw new Error(written.plan.error || PLANNING_ERROR);
      if (!written.productionId) throw new Error('The production id is unavailable after planning.');
    } else {
      state = ctx.store.get();
      if (!state.productionId) {
        ctx.store.patch({ plan: { ...state.plan, status: 'building', error: null, errorAt: null } });
        const created = await ctx.api.createProduction({ conversationId: state.chatId, packageId: state.packageId });
        const productionId = productionIdOf(created);
        if (!productionId) throw new Error('The server did not return a production id.');
        ctx.store.patch({ productionId });
      }
      state = ctx.store.get();
      if (!state.productionId) throw new Error('The production id is unavailable.');
      ctx.store.patch({ plan: { ...state.plan, status: 'proposing', error: null, errorAt: null } });
      await ctx.api.proposeEasyPlan(state.productionId, { level: state.level, compute: state.compute });
    }

    state = ctx.store.get();
    if (!state.productionId) throw new Error('The production id is unavailable.');
    snapshot = await ctx.api.getProduction(state.productionId);
    card = readPlanCard(snapshot);
    if (!hasSignedPlan(card)) throw new Error('The server did not return a signed plan.');
    readyPlan(ctx);
  }

  if (!snapshot || !card) throw new Error(PLANNING_ERROR);
  hooks.onSnapshot(snapshot);
  return { snapshot, card };
}

function requiredElement<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(LOAD_ERROR);
  return element;
}

/**
 * Open the native full-plan editor. Package saves and plan proposals are the
 * only mutations; this module never approves a plan or starts a run.
 */
export async function openFullPlanEditor(ctx: EasyStepContext, hooks: FullPlanHooks): Promise<void> {
  const document = globalThis.document;
  if (!document) {
    ctx.shell.alert(LOAD_ERROR);
    return;
  }
  const active = document.activeElement;
  const opener = active && typeof (active as HTMLElement).focus === 'function' ? active as HTMLElement : null;

  let loaded: { latest: LoadedPackage; packageId: string };
  try {
    loaded = await loadPackage(ctx);
  } catch (error) {
    ctx.shell.alert(`${LOAD_ERROR} ${messageOf(error)}`);
    return;
  }

  let initial: { snapshot: unknown; card: PlanCard };
  ctx.shell.setStatus('Preparing the full plan…');
  try {
    initial = await prepareInitialPlan(ctx, hooks);
  } catch (error) {
    const current = ctx.store.get();
    if (current.plan.status !== 'error') {
      ctx.store.patch({ plan: { ...current.plan, status: 'error', error: messageOf(error), errorAt: 'proposal' } });
    }
    ctx.shell.alert(`${PLANNING_ERROR} ${messageOf(error)}`);
    return;
  }

  let latest = loaded.latest;
  const dialog = document.createElement('dialog');
  dialog.className = 'easy-full-plan-dialog';
  dialog.setAttribute('aria-labelledby', 'easy-full-plan-title');
  dialog.innerHTML = fullPlanMarkup(latest.package, initial.card);
  document.body.append(dialog);

  await new Promise<void>((resolve) => {
    let busy = false;
    let closed = false;
    const saveButton = requiredElement<HTMLButtonElement>(dialog, '[data-full-plan-save]');
    const cancelButton = requiredElement<HTMLButtonElement>(dialog, '[data-full-plan-cancel]');
    const closeButton = requiredElement<HTMLButtonElement>(dialog, '[data-full-plan-close]');
    const errorElement = requiredElement<HTMLElement>(dialog, '[data-full-plan-error]');
    const statusElement = requiredElement<HTMLElement>(dialog, '[data-full-plan-status]');

    function setStatus(message: string): void {
      statusElement.textContent = message;
      errorElement.hidden = true;
      errorElement.textContent = '';
    }

    function showError(message: string): void {
      errorElement.textContent = message;
      errorElement.hidden = false;
      statusElement.textContent = 'Review the message above. Your edits are still here.';
      errorElement.focus();
    }

    function setBusy(value: boolean): void {
      busy = value;
      dialog.setAttribute('aria-busy', String(value));
      saveButton.disabled = value;
      cancelButton.disabled = value;
      closeButton.disabled = value;
    }

    function finish(): void {
      if (closed) return;
      closed = true;
      dialog.remove();
      if (opener && opener.isConnected !== false) opener.focus();
      resolve();
    }

    function closeEditor(force = false): void {
      if (busy && !force) return;
      if (dialog.open) dialog.close();
      else finish();
    }

    function fieldsFromDialog(): Record<string, string> {
      const fields: Record<string, string> = {};
      const controls = dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-full-plan-path]');
      controls.forEach((control) => {
        const path = control.getAttribute('data-full-plan-path');
        if (path) fields[path] = control.value;
      });
      return fields;
    }

    function editedPackage(): Record<string, unknown> {
      return applyFullPlanFields(latest.package, fieldsFromDialog()) as Record<string, unknown>;
    }

    function unchanged(edited: Record<string, unknown>): boolean {
      return packageJson(edited) === packageJson(latest.package);
    }

    async function saveChanges(): Promise<boolean> {
      if (busy || closed) return false;
      let edited: Record<string, unknown>;
      try {
        edited = editedPackage();
      } catch (error) {
        showError(`We couldn’t read these edits. ${messageOf(error)}`);
        return false;
      }
      if (unchanged(edited)) {
        setStatus('No changes to save.');
        return true;
      }

      setBusy(true);
      setStatus('Saving the full project…');
      try {
        const editor = cloneValue(latest.editor ?? asRecord(ctx.host.editorStore.getState().doc.editor) ?? { version: 1, captionOverrides: [] });
        const response = await ctx.host.apiFetch(`/api/package/${encodeURIComponent(loaded.packageId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ package: edited, editor, baseRevision: latest.revision }),
        });
        const body = await readResponse(response);
        const saved = asRecord(body.package) ?? edited;
        const savedEditor = asRecord(body.editor) ?? editor;
        latest = {
          package: saved,
          editor: savedEditor,
          revision: revisionOf(body.revision ?? saved.revision ?? latest.revision),
        };
        const compileResponse = await ctx.host.apiFetch('/api/compile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ package: saved, editor: savedEditor, revision: latest.revision }),
        });
        const compiled = await readResponse(compileResponse);
        if (!compiled.timeline) throw new Error('The server did not return a refreshed timeline.');
        ctx.host.adoptBuiltPackage({
          package: saved,
          editor: savedEditor,
          revision: latest.revision,
          timeline: compiled.timeline,
          preservePreviewState: true,
        });
        const current = ctx.store.get();
        ctx.store.patch({ planHash: planInputsHash(current) });
        const json = dialog.querySelector<HTMLElement>('[data-full-plan-json]');
        if (json) json.textContent = packageJson(saved);
        setStatus('Saved. Refreshing the signed plan…');
        return true;
      } catch (error) {
        if (error instanceof FullPlanHttpError && error.status === 409) showError(CONFLICT_ERROR);
        else showError(`We couldn’t save the full project. ${messageOf(error)}`);
        return false;
      } finally {
        setBusy(false);
      }
    }

    async function saveAndRepropose(): Promise<void> {
      if (busy || closed) return;
      if (!await saveChanges()) return;
      const productionId = ctx.store.get().productionId;
      if (!productionId) {
        showError('The production id is unavailable. No generation was started.');
        return;
      }

      setBusy(true);
      setStatus('Re-proposing the signed plan. No GPU work is starting…');
      const current = ctx.store.get();
      ctx.store.patch({ plan: { ...current.plan, status: 'proposing', error: null, errorAt: null } });
      try {
        const before = await ctx.api.getProduction(productionId);
        const scope = fullPlanProposalScope(readPlanCard(before));
        const live = ctx.store.get();
        await ctx.api.proposeEasyPlan(productionId, {
          level: live.level,
          compute: live.compute,
          ...scope,
        });
        const snapshot = await ctx.api.getProduction(productionId);
        hooks.onSnapshot(snapshot);
        readyPlan(ctx);
        closeEditor(true);
      } catch (error) {
        const failed = ctx.store.get();
        ctx.store.patch({ plan: { ...failed.plan, status: 'error', error: messageOf(error), errorAt: 'proposal' } });
        showError(`We couldn’t re-propose the plan. No generation was started. ${messageOf(error)}`);
      } finally {
        setBusy(false);
      }
    }

    saveButton.addEventListener('click', () => { void saveAndRepropose(); });
    cancelButton.addEventListener('click', () => closeEditor());
    closeButton.addEventListener('click', () => closeEditor());
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeEditor();
    });
    dialog.addEventListener('close', finish);
    dialog.addEventListener('input', () => {
      if (!busy) setStatus('Unsaved changes. Saving does not start GPU work.');
    });

    try {
      dialog.showModal();
      dialog.querySelector<HTMLInputElement>('[data-full-plan-path="/title"]')?.focus();
    } catch (error) {
      finish();
      ctx.shell.alert(`${LOAD_ERROR} ${messageOf(error)}`);
    }
  });
}
