export type ViewerKind = 'image' | 'video' | 'audio' | 'text';

export interface ViewerTarget {
  packageId?: string;
  shotId?: string;
  clipId?: string;
  takeId?: string;
  assetId?: string;
}

export interface ViewerItem {
  id: string;
  kind: ViewerKind;
  title?: string;
  src?: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  target?: ViewerTarget;
}

export interface ViewerCapabilities {
  time: boolean;
  region: boolean;
  playback: boolean;
  frameStep: boolean;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TimeAt {
  at: number;
}

export interface TimeRange {
  in: number;
  out: number;
}

export type AnnotationTime = TimeAt | TimeRange;

export interface Annotation {
  time?: AnnotationTime;
  region?: Region;
}

export interface ViewerState {
  open: boolean;
  items: readonly ViewerItem[];
  index: number;
  item: ViewerItem | null;
  kind: ViewerKind | null;
  playing: boolean;
  time: number;
  annotation: Annotation;
  regionMode: boolean;
  compare: boolean;
  canPrev: boolean;
  canNext: boolean;
}

export type ViewerCommand =
  | 'prev'
  | 'next'
  | 'togglePlay'
  | 'seekBack'
  | 'seekForward'
  | 'frameBack'
  | 'frameForward'
  | 'markIn'
  | 'markOut'
  | 'toggleRegion'
  | 'iterate'
  | 'toggleCompare'
  | 'close'
  | 'regionMoveLeft'
  | 'regionMoveRight'
  | 'regionMoveUp'
  | 'regionMoveDown'
  | 'regionGrowWidth'
  | 'regionShrinkWidth'
  | 'regionGrowHeight'
  | 'regionShrinkHeight';

export interface KeyBinding {
  key: string;
  shift?: boolean;
  command: ViewerCommand;
  when?: (state: ViewerState) => boolean;
}

export interface ViewerKeyResult {
  state: ViewerState;
  command: ViewerCommand | null;
  handled: boolean;
}

export const KIND_CAPABILITIES: Record<ViewerKind, ViewerCapabilities> = {
  image: { time: false, region: true, playback: false, frameStep: false },
  video: { time: true, region: true, playback: true, frameStep: true },
  audio: { time: true, region: false, playback: true, frameStep: false },
  text: { time: false, region: false, playback: false, frameStep: false },
};

export const REGION_STEP = 0.01;
export const SEEK_STEP = 5;
export const REGION_DEFAULT: Region = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The immutable target of one viewer item. An asset id is always the item id;
 * shot, clip and take come only from the item's own metadata, so navigating the
 * viewer can never borrow the target of the asset that opened it.
 */
export function viewerTarget(
  item: ViewerItem | null,
  packageId?: string,
): ViewerTarget {
  const target: ViewerTarget = {};
  const declared = item?.target;
  const pkg = identifier(declared?.packageId) ?? identifier(packageId);
  if (pkg) target.packageId = pkg;
  if (identifier(declared?.shotId)) target.shotId = declared!.shotId;
  if (identifier(declared?.clipId)) target.clipId = declared!.clipId;
  if (identifier(declared?.takeId)) target.takeId = declared!.takeId;
  const assetId = identifier(declared?.assetId) ?? identifier(item?.id);
  if (assetId) target.assetId = assetId;
  return Object.freeze(target);
}

const MIN_TIME_GAP = 0.001;
const FALLBACK_FPS = 30;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function durationOf(item: ViewerItem | null): number {
  const duration = item?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function capabilitiesOf(state: ViewerState): ViewerCapabilities {
  if (!state.kind) return KIND_CAPABILITIES.text;
  return KIND_CAPABILITIES[state.kind];
}

function isOpen(state: ViewerState): boolean {
  return state.open && state.item !== null;
}

function atRegionMode(state: ViewerState): boolean {
  return isOpen(state) && state.regionMode && capabilitiesOf(state).region;
}

function emptyState(items: readonly ViewerItem[]): ViewerState {
  return {
    open: false,
    items,
    index: -1,
    item: null,
    kind: null,
    playing: false,
    time: 0,
    annotation: {},
    regionMode: false,
    compare: false,
    canPrev: false,
    canNext: false,
  };
}

function position(state: ViewerState, index: number): ViewerState {
  const item = state.items[index] ?? null;
  if (!item) return { ...state, ...emptyState(state.items), compare: state.compare };
  return {
    ...state,
    open: true,
    index,
    item,
    kind: item.kind,
    playing: false,
    time: 0,
    annotation: {},
    regionMode: false,
    canPrev: index > 0,
    canNext: index < state.items.length - 1,
  };
}

export function openViewer(items: readonly ViewerItem[], index: number): ViewerState {
  const state = emptyState(items);
  if (items.length === 0) return state;
  const requested = Number.isFinite(index) ? Math.trunc(index) : 0;
  return position(state, clamp(requested, 0, items.length - 1));
}

export function nextViewer(state: ViewerState): ViewerState {
  if (!state.open || !state.canNext) return state;
  return position(state, state.index + 1);
}

export function prevViewer(state: ViewerState): ViewerState {
  if (!state.open || !state.canPrev) return state;
  return position(state, state.index - 1);
}

function canNavigate(state: ViewerState): boolean {
  return isOpen(state) && !state.regionMode;
}

function canPlay(state: ViewerState): boolean {
  return isOpen(state) && capabilitiesOf(state).playback;
}

function canStep(state: ViewerState): boolean {
  return isOpen(state) && capabilitiesOf(state).frameStep;
}

function canMark(state: ViewerState): boolean {
  return isOpen(state) && capabilitiesOf(state).time;
}

function canRegion(state: ViewerState): boolean {
  return isOpen(state) && capabilitiesOf(state).region;
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { key: 'ArrowLeft', shift: false, command: 'regionMoveLeft', when: atRegionMode },
  { key: 'ArrowLeft', shift: true, command: 'regionShrinkWidth', when: atRegionMode },
  { key: 'ArrowRight', shift: false, command: 'regionMoveRight', when: atRegionMode },
  { key: 'ArrowRight', shift: true, command: 'regionGrowWidth', when: atRegionMode },
  { key: 'ArrowUp', shift: false, command: 'regionMoveUp', when: atRegionMode },
  { key: 'ArrowUp', shift: true, command: 'regionGrowHeight', when: atRegionMode },
  { key: 'ArrowDown', shift: false, command: 'regionMoveDown', when: atRegionMode },
  { key: 'ArrowDown', shift: true, command: 'regionShrinkHeight', when: atRegionMode },
  { key: 'ArrowLeft', command: 'prev', when: state => canNavigate(state) && state.canPrev },
  { key: 'ArrowRight', command: 'next', when: state => canNavigate(state) && state.canNext },
  { key: ' ', command: 'togglePlay', when: canPlay },
  { key: 'j', command: 'seekBack', when: canPlay },
  { key: 'k', command: 'togglePlay', when: canPlay },
  { key: 'l', command: 'seekForward', when: canPlay },
  { key: ',', command: 'frameBack', when: canStep },
  { key: '.', command: 'frameForward', when: canStep },
  { key: 'i', command: 'markIn', when: canMark },
  { key: 'o', command: 'markOut', when: canMark },
  { key: 'r', command: 'toggleRegion', when: canRegion },
  { key: 'e', command: 'iterate', when: isOpen },
  { key: 'c', command: 'toggleCompare', when: isOpen },
  { key: 'Escape', command: 'close', when: isOpen },
];

const KEY_ALIASES: Record<string, string> = {
  Esc: 'Escape',
  Space: ' ',
  Spacebar: ' ',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
};

function normalizeKey(key: string): string {
  if (KEY_ALIASES[key]) return KEY_ALIASES[key];
  if (key.length === 1) return key.toLowerCase();
  return key;
}

export function resolveKey(state: ViewerState, key: string, shift = false): ViewerCommand | null {
  if (!isOpen(state)) return null;
  const normalized = normalizeKey(key);
  for (const binding of KEY_BINDINGS) {
    if (binding.key !== normalized) continue;
    if (binding.shift !== undefined && binding.shift !== shift) continue;
    if (binding.when && !binding.when(state)) continue;
    return binding.command;
  }
  return null;
}

export function clampTime(value: number, duration: number): number {
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return clamp(finite(value), 0, max);
}

export function validTimeRange(range: TimeRange, duration: number): boolean {
  return (
    Number.isFinite(duration) &&
    duration > 0 &&
    Number.isFinite(range.in) &&
    Number.isFinite(range.out) &&
    range.in >= 0 &&
    range.in < range.out &&
    range.out <= duration
  );
}

export function normalizeTime(time: AnnotationTime, duration: number): AnnotationTime {
  if ('at' in time) return { at: clampTime(time.at, duration) };
  return normalizeRange(time, duration);
}

function normalizeRange(range: TimeRange, duration: number): TimeRange {
  if (!Number.isFinite(duration) || duration <= 0) return { in: 0, out: 0 };
  const start = clampTime(Math.min(range.in, range.out), duration);
  let end = clampTime(Math.max(range.in, range.out), duration);
  if (end > start) return { in: start, out: end };
  const gap = Math.min(MIN_TIME_GAP, duration);
  if (end >= duration) return { in: Math.max(0, duration - gap), out: duration };
  end = Math.min(duration, start + gap);
  return { in: start, out: end };
}

export function setTimeAt(annotation: Annotation, at: number, duration: number): Annotation {
  return { ...annotation, time: { at: clampTime(at, duration) } };
}

export function setTimeRange(annotation: Annotation, range: TimeRange, duration: number): Annotation {
  return { ...annotation, time: normalizeRange(range, duration) };
}

export function markIn(annotation: Annotation, at: number, duration: number): Annotation {
  const value = clampTime(at, duration);
  if (!Number.isFinite(duration) || duration <= 0) return annotation;
  const current = annotation.time;
  const existingOut = current && 'in' in current ? current.out : duration;
  const out = value < existingOut ? existingOut : Math.min(duration, value + MIN_TIME_GAP);
  return { ...annotation, time: normalizeRange({ in: value, out }, duration) };
}

export function markOut(annotation: Annotation, at: number, duration: number): Annotation {
  const value = clampTime(at, duration);
  if (!Number.isFinite(duration) || duration <= 0) return annotation;
  const current = annotation.time;
  const existingIn = current && 'in' in current ? current.in : 0;
  return { ...annotation, time: normalizeRange({ in: existingIn, out: value }, duration) };
}

export function clampRegion(region: Region): Region {
  const x = finite(region.x);
  const y = finite(region.y);
  const w = Math.max(0, finite(region.w));
  const h = Math.max(0, finite(region.h));
  const left = clamp(x, 0, 1);
  const right = clamp(x + w, 0, 1);
  const top = clamp(y, 0, 1);
  const bottom = clamp(y + h, 0, 1);
  return {
    x: left,
    y: top,
    w: Math.max(0, right - left),
    h: Math.max(0, bottom - top),
  };
}

export function moveRegion(region: Region, dx: number, dy: number): Region {
  const current = clampRegion(region);
  return {
    x: clamp(current.x + finite(dx), 0, 1 - current.w),
    y: clamp(current.y + finite(dy), 0, 1 - current.h),
    w: current.w,
    h: current.h,
  };
}

export function resizeRegion(region: Region, dw: number, dh: number): Region {
  const current = clampRegion(region);
  return {
    x: current.x,
    y: current.y,
    w: clamp(current.w + finite(dw), 0, 1 - current.x),
    h: clamp(current.h + finite(dh), 0, 1 - current.y),
  };
}

export function displayedToMediaRegion(
  region: Region,
  display: Rect,
  media: Size,
  zoom = 1,
): Region {
  const selected = clampRegion(region);
  if (
    !Number.isFinite(display.width) ||
    !Number.isFinite(display.height) ||
    display.width <= 0 ||
    display.height <= 0 ||
    !Number.isFinite(media.width) ||
    !Number.isFinite(media.height) ||
    media.width <= 0 ||
    media.height <= 0
  ) {
    return selected;
  }
  const originX = finite(display.x);
  const originY = finite(display.y);
  const scale = Math.min(display.width / media.width, display.height / media.height);
  const boxWidth = media.width * scale;
  const boxHeight = media.height * scale;
  const boxX = originX + (display.width - boxWidth) / 2;
  const boxY = originY + (display.height - boxHeight) / 2;

  const left = originX + selected.x * display.width;
  const top = originY + selected.y * display.height;
  const right = originX + (selected.x + selected.w) * display.width;
  const bottom = originY + (selected.y + selected.h) * display.height;

  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const pin = (value: number, origin: number, size: number): number => {
    const contained = clamp((value - origin) / size, 0, 1);
    return clamp(0.5 + (contained - 0.5) / factor, 0, 1);
  };

  const x = pin(left, boxX, boxWidth);
  const y = pin(top, boxY, boxHeight);
  const x2 = pin(right, boxX, boxWidth);
  const y2 = pin(bottom, boxY, boxHeight);

  return {
    x,
    y,
    w: Math.max(0, x2 - x),
    h: Math.max(0, y2 - y),
  };
}

function withRegion(state: ViewerState, region: Region): ViewerState {
  return { ...state, annotation: { ...state.annotation, region: clampRegion(region) } };
}

function currentRegion(state: ViewerState): Region {
  return clampRegion(state.annotation.region ?? REGION_DEFAULT);
}

function seek(state: ViewerState, delta: number): ViewerState {
  return { ...state, time: clampTime(state.time + delta, durationOf(state.item)) };
}

function frameStep(state: ViewerState): number {
  const fps = state.item?.fps;
  return 1 / (typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : FALLBACK_FPS);
}

export function handleKey(state: ViewerState, key: string, shift = false): ViewerKeyResult {
  const command = resolveKey(state, key, shift);
  if (!command) return { state, command: null, handled: false };

  switch (command) {
    case 'prev':
      return { state: prevViewer(state), command, handled: true };
    case 'next':
      return { state: nextViewer(state), command, handled: true };
    case 'togglePlay':
      return { state: { ...state, playing: !state.playing }, command, handled: true };
    case 'seekBack':
      return { state: seek(state, -SEEK_STEP), command, handled: true };
    case 'seekForward':
      return { state: seek(state, SEEK_STEP), command, handled: true };
    case 'frameBack':
      return { state: seek(state, -frameStep(state)), command, handled: true };
    case 'frameForward':
      return { state: seek(state, frameStep(state)), command, handled: true };
    case 'markIn':
      return {
        state: { ...state, annotation: markIn(state.annotation, state.time, durationOf(state.item)) },
        command,
        handled: true,
      };
    case 'markOut':
      return {
        state: { ...state, annotation: markOut(state.annotation, state.time, durationOf(state.item)) },
        command,
        handled: true,
      };
    case 'toggleRegion':
      if (state.regionMode) return { state: { ...state, regionMode: false }, command, handled: true };
      return {
        state: {
          ...state,
          regionMode: true,
          annotation: { ...state.annotation, region: state.annotation.region ?? { ...REGION_DEFAULT } },
        },
        command,
        handled: true,
      };
    case 'toggleCompare':
      return { state: { ...state, compare: !state.compare }, command, handled: true };
    case 'close':
      return { state: { ...state, open: false, playing: false }, command, handled: true };
    case 'iterate':
      return { state, command, handled: true };
    case 'regionMoveLeft':
      return { state: withRegion(state, moveRegion(currentRegion(state), -REGION_STEP, 0)), command, handled: true };
    case 'regionMoveRight':
      return { state: withRegion(state, moveRegion(currentRegion(state), REGION_STEP, 0)), command, handled: true };
    case 'regionMoveUp':
      return { state: withRegion(state, moveRegion(currentRegion(state), 0, -REGION_STEP)), command, handled: true };
    case 'regionMoveDown':
      return { state: withRegion(state, moveRegion(currentRegion(state), 0, REGION_STEP)), command, handled: true };
    case 'regionGrowWidth':
      return { state: withRegion(state, resizeRegion(currentRegion(state), REGION_STEP, 0)), command, handled: true };
    case 'regionShrinkWidth':
      return { state: withRegion(state, resizeRegion(currentRegion(state), -REGION_STEP, 0)), command, handled: true };
    case 'regionGrowHeight':
      return { state: withRegion(state, resizeRegion(currentRegion(state), 0, REGION_STEP)), command, handled: true };
    case 'regionShrinkHeight':
      return { state: withRegion(state, resizeRegion(currentRegion(state), 0, -REGION_STEP)), command, handled: true };
  }
}
