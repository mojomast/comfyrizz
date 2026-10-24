import { COPY, fill } from './copy.ts';

export type GalleryItemKind = 'character' | 'shot' | 'voice' | 'final';
export type GalleryItemState = 'empty' | 'loading' | 'ready' | 'error';

export interface GalleryItem {
  id: string;
  kind: GalleryItemKind;
  label: string;
  state: GalleryItemState;
  url: string | null;
  reason: string | null;
  highlighted: boolean;
  index: number;
}

export interface GalleryModel {
  items: GalleryItem[];
  final: GalleryItem;
  counts: Record<GalleryItemKind, number>;
  states: Record<GalleryItemState, number>;
}

export const GALLERY_KINDS: readonly GalleryItemKind[] = Object.freeze([
  'character',
  'shot',
  'voice',
  'final',
]);

type RecordValue = Record<string, unknown>;

const URL_KEYS = Object.freeze([
  'url',
  'imageUrl',
  'image_url',
  'thumbnailUrl',
  'thumbnail_url',
  'thumbUrl',
  'posterUrl',
  'poster_url',
  'previewUrl',
  'preview_url',
  'src',
  'href',
  'videoUrl',
  'video_url',
  'audioUrl',
  'audio_url',
  'mediaUrl',
  'media_url',
  'assetUrl',
  'asset_url',
  'outputUrl',
  'output_url',
  'renderUrl',
  'render_url',
  'downloadUrl',
  'download_url',
  'clipUrl',
  'clip_url',
  'stillUrl',
  'still_url',
  'artworkUrl',
  'artwork_url',
]);

const URL_CONTAINERS = Object.freeze([
  'metadata',
  'media',
  'asset',
  'preview',
  'thumbnail',
  'poster',
  'image',
  'video',
  'audio',
  'render',
  'output',
  'delivery',
  'clip',
  'take',
  'result',
  'link',
]);

const VOICE_ARTIFACT_KINDS = new Set([
  'audition',
  'voice_reference',
  'transcript',
]);

const READY_STATES = new Set([
  'ready',
  'complete',
  'completed',
  'done',
  'succeeded',
  'success',
  'available',
  'landed',
  'approved',
  'kept',
  'rendered',
  'delivered',
  'finished',
]);

const LOADING_STATES = new Set([
  'loading',
  'queued',
  'queue',
  'dispatching',
  'running',
  'collecting',
  'verifying',
  'generating',
  'rendering',
  'starting',
  'started',
  'active',
  'processing',
  'in_progress',
  'working',
  'uploading',
  'downloading',
  'waiting',
]);

const ERROR_STATES = new Set([
  'error',
  'failed',
  'failure',
  'errored',
  'interrupted',
  'cancelled',
  'canceled',
  'rejected',
  'blocked',
]);

const CHARACTER_EVENT = /^character\.(?:created|updated|image\.added|cast\.added|cast\.updated)$/u;
const VOICE_EVENT = /audition|voice[._](?:take|clip|line|audio|ready|landed|generated)/iu;

const FAILURE_STAGE: Readonly<Record<GalleryItemKind, string>> = Object.freeze({
  character: 'the characters',
  shot: 'this shot',
  voice: 'the voice',
  final: 'the video',
});

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): RecordValue | null {
  return isRecord(value) ? value : null;
}

function mergeRecord(outer: RecordValue, nested: unknown): RecordValue {
  const inner = asRecord(nested);
  return inner === null ? outer : { ...outer, ...inner };
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function valuesAt(root: RecordValue, production: RecordValue | null, keys: readonly string[]): unknown[] {
  const found: unknown[] = [];
  for (const key of keys) {
    found.push(...listOf(root[key]));
    if (production !== null && production !== root) found.push(...listOf(production[key]));
  }
  return found;
}

function nestedField(record: RecordValue, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  for (const container of ['metadata', 'data', 'artifact', 'take', 'clip', 'action']) {
    const nested = asRecord(record[container]);
    if (nested === null || nested === record) continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(nested, key)) return nested[key];
    }
  }
  return undefined;
}

function textField(record: RecordValue, keys: readonly string[]): string {
  return textOf(nestedField(record, keys));
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(text)?.[1]?.toLowerCase();
  if (scheme === undefined) return text;
  if (scheme === 'http' || scheme === 'https' || scheme === 'blob') return text;
  if (scheme === 'data' && /^data:(?:image|audio|video)\//iu.test(text)) return text;
  return null;
}

function readUrl(record: RecordValue, depth = 0): string | null {
  if (depth > 6) return null;
  for (const key of URL_KEYS) {
    const url = safeUrl(record[key]);
    if (url !== null) return url;
  }
  for (const key of URL_CONTAINERS) {
    const nested = asRecord(record[key]);
    if (nested === null) continue;
    const url = readUrl(nested, depth + 1);
    if (url !== null) return url;
  }
  return null;
}

function firstUrl(records: readonly RecordValue[]): string | null {
  for (const record of records) {
    const url = readUrl(record);
    if (url !== null) return url;
  }
  return null;
}

function readStatus(record: RecordValue): string {
  const direct = firstText(record.status, record.state, record.clipState, record.clip_state);
  if (direct !== '') return direct;
  const nested = firstText(
    asRecord(record.action)?.status,
    asRecord(record.action)?.state,
    asRecord(record.clip)?.status,
    asRecord(record.clip)?.state,
    asRecord(record.take)?.status,
    asRecord(record.take)?.state,
    asRecord(record.render)?.status,
    asRecord(record.result)?.status,
  );
  if (nested !== '') return nested;
  const metadata = asRecord(record.metadata);
  return metadata === null ? '' : firstText(metadata.status, metadata.state);
}

function statusKey(value: string): GalleryItemState | null {
  const key = value.trim().toLowerCase().replace(/[-\s]+/gu, '_');
  if (ERROR_STATES.has(key)) return 'error';
  if (READY_STATES.has(key)) return 'ready';
  if (LOADING_STATES.has(key)) return 'loading';
  return null;
}

function resolveState(records: readonly RecordValue[], url: string | null): GalleryItemState {
  const keys = new Set<GalleryItemState>();
  for (const record of records) {
    const key = statusKey(readStatus(record));
    if (key !== null) keys.add(key);
  }
  if (keys.has('error')) return 'error';
  if (url !== null || keys.has('ready')) return 'ready';
  if (keys.has('loading')) return 'loading';
  return 'empty';
}

function failureReason(kind: GalleryItemKind): string {
  return fill(COPY.gallery.error, { stage: FAILURE_STAGE[kind] });
}

function pickLabel(records: readonly RecordValue[]): string {
  for (const record of records) {
    const label = firstText(
      nestedField(record, ['name', 'label', 'title', 'displayName', 'display_name']),
      asRecord(record.metadata)?.name,
    );
    if (label !== '') return label;
  }
  return '';
}

function itemId(kind: GalleryItemKind, rawId: string): string {
  return `${kind}:${rawId}`;
}

function makeItem(
  kind: Exclude<GalleryItemKind, 'final'>,
  rawId: string,
  label: string,
  records: readonly RecordValue[],
): Omit<GalleryItem, 'index' | 'highlighted'> {
  const url = firstUrl(records);
  const state = resolveState(records, url);
  return {
    id: itemId(kind, rawId),
    kind,
    label,
    state,
    url,
    reason: state === 'error' ? failureReason(kind) : null,
  };
}

function unwrapSnapshot(snapshot: unknown): RecordValue {
  const root = asRecord(snapshot);
  if (root === null) return {};
  const wrapped = asRecord(root.snapshot);
  return wrapped ?? root;
}

function productionOf(root: RecordValue): RecordValue | null {
  const production = asRecord(root.production);
  if (production !== null) return production;
  if (
    Object.prototype.hasOwnProperty.call(root, 'shotIds')
    || Object.prototype.hasOwnProperty.call(root, 'characterBindings')
    || Object.prototype.hasOwnProperty.call(root, 'schema')
  ) {
    return root;
  }
  return null;
}

function collectEvents(root: RecordValue, production: RecordValue | null): RecordValue[] {
  return valuesAt(root, production, ['events', 'journal'])
    .map(asRecord)
    .filter((event): event is RecordValue => event !== null);
}

function eventData(event: RecordValue): RecordValue | null {
  return asRecord(event.data) ?? asRecord(event.payload);
}

function eventType(event: RecordValue): string {
  return firstText(event.type, event.event);
}

function collectArtifacts(
  root: RecordValue,
  production: RecordValue | null,
  events: readonly RecordValue[],
): RecordValue[] {
  const artifacts: RecordValue[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    const record = asRecord(value);
    if (record === null) return;
    const id = textField(record, ['id', 'artifactId', 'artifact_id', 'logicalId', 'logical_id']);
    if (id !== '') {
      if (seen.has(id)) return;
      seen.add(id);
    }
    artifacts.push(record);
  };
  for (const value of valuesAt(root, production, ['artifacts'])) add(value);
  for (const event of events) {
    if (eventType(event) !== 'artifact.attached') continue;
    const data = eventData(event);
    if (data === null) continue;
    add(mergeRecord(data, data.artifact));
  }
  return artifacts;
}

function collectActions(
  root: RecordValue,
  production: RecordValue | null,
  events: readonly RecordValue[],
): RecordValue[] {
  const byId = new Map<string, RecordValue>();
  const unnamed: RecordValue[] = [];
  const add = (value: unknown): void => {
    const record = asRecord(value);
    if (record === null) return;
    const id = textField(record, ['id', 'actionId', 'action_id']);
    if (id === '') {
      unnamed.push(record);
      return;
    }
    byId.set(id, record);
  };
  for (const value of valuesAt(root, production, ['actions', 'pendingActions'])) add(value);
  for (const event of events) {
    if (eventType(event) !== 'action.state_changed') continue;
    const data = eventData(event);
    if (data === null) continue;
    add(mergeRecord(data, data.action));
  }
  return [...byId.values(), ...unnamed];
}

function collectDeliveries(
  root: RecordValue,
  production: RecordValue | null,
  events: readonly RecordValue[],
): Map<string, RecordValue> {
  const deliveries = new Map<string, RecordValue>();
  const add = (value: unknown): void => {
    const record = asRecord(value);
    if (record === null) return;
    const id = textField(record, ['id', 'deliveryId', 'delivery_id'])
      || `delivery-${deliveries.size + 1}`;
    deliveries.set(id, record);
  };
  for (const value of valuesAt(root, production, ['deliveries', 'delivery'])) add(value);
  for (const event of events) {
    if (eventType(event) !== 'delivery.updated') continue;
    const data = eventData(event);
    if (data === null) continue;
    add(mergeRecord(data, data.delivery));
  }
  return deliveries;
}

function characterEventRecord(event: RecordValue): RecordValue | null {
  if (!CHARACTER_EVENT.test(eventType(event))) return null;
  const data = eventData(event);
  if (data === null) return null;
  return mergeRecord(data, data.character);
}

function isVoiceEvent(event: RecordValue): boolean {
  return VOICE_EVENT.test(eventType(event));
}

function isVoiceArtifact(record: RecordValue): boolean {
  return VOICE_ARTIFACT_KINDS.has(textField(record, ['kind', 'artifactKind', 'artifact_kind']));
}

function isVoiceAction(record: RecordValue): boolean {
  const label = textField(record, ['stage', 'kind', 'type', 'actionKind']);
  return /(?:^|[._-])(?:voice|audio)(?:$|[._-])/iu.test(label);
}

function shotIdOf(record: RecordValue): string {
  return textField(record, ['shotId', 'shot_id', 'sceneId', 'scene_id']);
}

function characterIdOf(record: RecordValue): string {
  return textField(record, ['characterId', 'character_id', 'castId', 'cast_id']);
}

function buildCharacterItems(
  root: RecordValue,
  production: RecordValue | null,
  events: readonly RecordValue[],
  artifacts: readonly RecordValue[],
): { items: Array<Omit<GalleryItem, 'index' | 'highlighted'>>; labels: Map<string, string> } {
  const groups = new Map<string, RecordValue[]>();
  const order: string[] = [];
  const add = (rawId: string, record: RecordValue): void => {
    if (rawId === '') return;
    if (!groups.has(rawId)) {
      groups.set(rawId, []);
      order.push(rawId);
    }
    groups.get(rawId)?.push(record);
  };

  const bindings = valuesAt(root, production, ['characterBindings'])
    .map(asRecord)
    .filter((record): record is RecordValue => record !== null);
  let fallback = 0;
  for (const binding of bindings) {
    fallback += 1;
    add(characterIdOf(binding) || `character-${fallback}`, binding);
  }

  const characterRecords = valuesAt(root, production, ['characters', 'cast'])
    .map(asRecord)
    .filter((record): record is RecordValue => record !== null);
  const eventRecords = events
    .map(characterEventRecord)
    .filter((record): record is RecordValue => record !== null);
  let characterFallback = 0;
  for (const record of [...characterRecords, ...eventRecords]) {
    characterFallback += 1;
    add(characterIdOf(record) || textField(record, ['id']) || `character-${characterFallback}`, record);
  }

  for (const artifact of artifacts) {
    const artifactCharacterId = characterIdOf(artifact);
    if (artifactCharacterId !== '' && !groups.has(artifactCharacterId)) {
      groups.set(artifactCharacterId, [artifact]);
      order.push(artifactCharacterId);
    }
  }

  const artifactById = new Map<string, RecordValue>();
  for (const artifact of artifacts) {
    const id = textField(artifact, ['id', 'artifactId', 'artifact_id', 'logicalId', 'logical_id']);
    if (id !== '') artifactById.set(id, artifact);
  }

  const items: Array<Omit<GalleryItem, 'index' | 'highlighted'>> = [];
  const labels = new Map<string, string>();
  for (const rawId of order) {
    const records = groups.get(rawId) ?? [];
    const withArtifacts = [...records];
    for (const record of records) {
      const artifactId = textField(record, ['artifactId', 'artifact_id']);
      const artifact = artifactId === '' ? undefined : artifactById.get(artifactId);
      if (artifact !== undefined) withArtifacts.push(artifact);
    }
    for (const artifact of artifacts) {
      if (characterIdOf(artifact) === rawId) withArtifacts.push(artifact);
    }
    const label = pickLabel(withArtifacts) || `Character ${items.length + 1}`;
    labels.set(rawId, label);
    items.push(makeItem('character', rawId, label, withArtifacts));
  }
  return { items, labels };
}

function collectShotOrder(
  root: RecordValue,
  production: RecordValue | null,
  actions: readonly RecordValue[],
  artifacts: readonly RecordValue[],
  events: readonly RecordValue[],
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (id === '' || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };

  const shotIds = valuesAt(root, production, ['shotIds']);
  for (const value of shotIds) {
    if (typeof value === 'string') add(value);
    else {
      const record = asRecord(value);
      if (record !== null) add(textField(record, ['id', 'shotId', 'shot_id']));
    }
  }

  for (const value of valuesAt(root, production, ['shots'])) {
    const record = asRecord(value);
    if (record !== null) add(textField(record, ['id', 'shotId', 'shot_id']));
  }

  for (const action of actions) add(shotIdOf(action));
  for (const artifact of artifacts) {
    if (!isVoiceArtifact(artifact)) add(shotIdOf(artifact));
  }
  for (const event of events) {
    if (isVoiceEvent(event)) continue;
    const data = eventData(event);
    if (data !== null) add(shotIdOf(data));
  }
  return order;
}

function buildShotItems(
  root: RecordValue,
  production: RecordValue | null,
  actions: readonly RecordValue[],
  artifacts: readonly RecordValue[],
  events: readonly RecordValue[],
): { items: Array<Omit<GalleryItem, 'index' | 'highlighted'>>; labels: Map<string, string> } {
  const order = collectShotOrder(root, production, actions, artifacts, events);
  const shotRecords = new Map<string, RecordValue[]>();
  for (const value of valuesAt(root, production, ['shots'])) {
    const record = asRecord(value);
    if (record === null) continue;
    const id = textField(record, ['id', 'shotId', 'shot_id']);
    if (id === '') continue;
    const group = shotRecords.get(id) ?? [];
    group.push(record);
    shotRecords.set(id, group);
  }

  const actionsByShot = new Map<string, RecordValue[]>();
  for (const action of actions) {
    const id = shotIdOf(action);
    if (id === '') continue;
    const group = actionsByShot.get(id) ?? [];
    group.push(action);
    actionsByShot.set(id, group);
  }

  const artifactsByShot = new Map<string, RecordValue[]>();
  for (const artifact of artifacts) {
    if (isVoiceArtifact(artifact)) continue;
    const id = shotIdOf(artifact);
    if (id === '') continue;
    const group = artifactsByShot.get(id) ?? [];
    group.push(artifact);
    artifactsByShot.set(id, group);
  }

  const eventsByShot = new Map<string, RecordValue[]>();
  for (const event of events) {
    if (isVoiceEvent(event)) continue;
    const data = eventData(event);
    if (data === null) continue;
    const id = shotIdOf(data);
    if (id === '') continue;
    const group = eventsByShot.get(id) ?? [];
    group.push(data);
    eventsByShot.set(id, group);
  }

  const items: Array<Omit<GalleryItem, 'index' | 'highlighted'>> = [];
  const labels = new Map<string, string>();
  let index = 0;
  for (const shotId of order) {
    index += 1;
    const records = [
      ...(shotRecords.get(shotId) ?? []),
      ...(artifactsByShot.get(shotId) ?? []),
      ...(eventsByShot.get(shotId) ?? []),
      ...(actionsByShot.get(shotId) ?? []),
    ];
    const label = pickLabel(shotRecords.get(shotId) ?? []) || `Shot ${index}`;
    labels.set(shotId, label);
    items.push(makeItem('shot', shotId, label, records));
  }
  return { items, labels };
}

function voiceKeyOf(record: RecordValue, fallback: string): string {
  return textField(record, ['id', 'voiceId', 'voice_id', 'takeId', 'take_id', 'artifactId', 'artifact_id'])
    || shotIdOf(record)
    || characterIdOf(record)
    || fallback;
}

function buildVoiceItems(
  root: RecordValue,
  production: RecordValue | null,
  actions: readonly RecordValue[],
  artifacts: readonly RecordValue[],
  events: readonly RecordValue[],
  characterLabels: ReadonlyMap<string, string>,
  shotLabels: ReadonlyMap<string, string>,
): Array<Omit<GalleryItem, 'index' | 'highlighted'>> {
  const groups = new Map<string, RecordValue[]>();
  const order: string[] = [];
  let fallback = 0;
  const add = (record: RecordValue): void => {
    fallback += 1;
    const key = voiceKeyOf(record, `voice-${fallback}`);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)?.push(record);
  };

  for (const value of valuesAt(root, production, ['voices', 'voiceItems', 'voice'])) {
    for (const entry of listOf(value)) {
      const record = asRecord(entry);
      if (record !== null) add(record);
      else if (typeof entry === 'string') add({ id: entry });
    }
  }
  for (const artifact of artifacts) {
    if (isVoiceArtifact(artifact)) add(artifact);
  }
  for (const event of events) {
    if (!isVoiceEvent(event)) continue;
    const data = eventData(event);
    if (data === null) continue;
    add(mergeRecord(data, data.voice ?? data.take));
  }
  for (const action of actions) {
    if (isVoiceAction(action)) add(action);
  }

  const items: Array<Omit<GalleryItem, 'index' | 'highlighted'>> = [];
  for (const key of order) {
    const records = groups.get(key) ?? [];
    const shotId = shotIdOf(records[0] ?? {});
    const characterId = characterIdOf(records[0] ?? {});
    const shotLabel = shotLabels.get(shotId);
    const characterLabel = characterLabels.get(characterId);
    const label = pickLabel(records)
      || (shotLabel === undefined ? '' : `Voice for ${shotLabel}`)
      || (characterLabel === undefined ? '' : `Voice for ${characterLabel}`)
      || COPY.stages.voice;
    items.push(makeItem('voice', key, label, records));
  }
  return items;
}

function finalSourceRecord(value: unknown): RecordValue | null {
  if (typeof value === 'string') return safeUrl(value) === null ? null : { url: value };
  return asRecord(value);
}

function buildFinalItem(
  root: RecordValue,
  production: RecordValue | null,
  deliveries: ReadonlyMap<string, RecordValue>,
  items: readonly Omit<GalleryItem, 'index' | 'highlighted'>[],
): Omit<GalleryItem, 'index' | 'highlighted'> {
  const chosen: RecordValue[] = [];
  const add = (record: RecordValue | null): void => {
    if (record !== null) chosen.push(record);
  };

  add(finalSourceRecord(root.final));
  add(production === null ? null : finalSourceRecord(production.final));
  add(finalSourceRecord(root.finalVideo));
  add(production === null ? null : finalSourceRecord(production.finalVideo));

  const latestDeliveryId = production === null
    ? ''
    : textField(production, ['latestDeliveryId', 'latest_delivery_id']);
  const latest = latestDeliveryId === '' ? null : deliveries.get(latestDeliveryId);
  if (latest !== undefined && latest !== null) chosen.push(latest);
  else if (deliveries.size > 0) {
    const last = [...deliveries.values()].at(-1);
    if (last !== undefined) chosen.push(last);
  }

  add(asRecord(root.render));
  add(production === null ? null : asRecord(production.render));

  const url = firstUrl(chosen);
  let state = resolveState(chosen, url);
  if (state === 'empty' && items.some((item) => item.state === 'loading')) state = 'loading';
  return {
    id: 'final',
    kind: 'final',
    label: COPY.stages.video,
    state,
    url,
    reason: state === 'error' ? failureReason('final') : null,
  };
}

export function buildGalleryModel(snapshot: unknown): GalleryModel {
  const root = unwrapSnapshot(snapshot);
  const production = productionOf(root);
  const events = collectEvents(root, production);
  const artifacts = collectArtifacts(root, production, events);
  const actions = collectActions(root, production, events);
  const deliveries = collectDeliveries(root, production, events);

  const characters = buildCharacterItems(root, production, events, artifacts);
  const shots = buildShotItems(root, production, actions, artifacts, events);
  const voices = buildVoiceItems(
    root,
    production,
    actions,
    artifacts,
    events,
    characters.labels,
    shots.labels,
  );

  const ordered = [
    ...characters.items,
    ...shots.items,
    ...voices,
  ];
  const finalDraft = buildFinalItem(root, production, deliveries, ordered);

  const counts: Record<GalleryItemKind, number> = {
    character: 0,
    shot: 0,
    voice: 0,
    final: 0,
  };
  const states: Record<GalleryItemState, number> = {
    empty: 0,
    loading: 0,
    ready: 0,
    error: 0,
  };

  const items: GalleryItem[] = [];
  for (const draft of [...ordered, finalDraft]) {
    const item: GalleryItem = {
      ...draft,
      highlighted: draft.kind === 'final' && draft.state === 'ready',
      index: items.length,
    };
    items.push(item);
    counts[item.kind] += 1;
    states[item.state] += 1;
  }

  const final = items.find((item) => item.kind === 'final') as GalleryItem;
  return { items, final, counts, states };
}
