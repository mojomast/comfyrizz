const DEFAULT_FPS = 30;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const toNumber = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const firstNumber = (...values) => {
  for (const value of values) {
    const number = toNumber(value);
    if (number !== null) return number;
  }
  return null;
};

const firstText = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

const round = value => Math.round(value * 1000) / 1000;

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const frames = (value, fps) => {
  const number = toNumber(value);
  return number === null ? null : number / fps;
};

function timelineFps(timeline) {
  const fps = toNumber(timeline?.fps);
  return fps !== null && fps > 0 ? fps : DEFAULT_FPS;
}

function timelineDuration(timeline, fps) {
  const seconds = firstNumber(timeline?.durationSec, timeline?.durationSeconds, timeline?.duration);
  if (seconds !== null) return Math.max(0, seconds);
  const fromFrames = frames(timeline?.durationInFrames, fps);
  return fromFrames === null ? null : Math.max(0, fromFrames);
}

function itemStart(item, fps) {
  return firstNumber(
    item.startSec,
    item.startSeconds,
    item.startTime,
    item.start_time,
    frames(item.from, fps),
    frames(item.startFrame, fps),
    frames(item.start_frame, fps),
    frames(item.fromFrame, fps),
    item.start,
  );
}

function itemDuration(item, fps) {
  return firstNumber(
    item.durationSec,
    item.durationSeconds,
    item.lengthSec,
    item.lengthSeconds,
    frames(item.durationInFrames, fps),
    frames(item.durationFrames, fps),
    frames(item.duration_frames, fps),
    item.duration,
    item.length,
  );
}

/**
 * Derive one storyboard chip per scene (or clip) in timeline time order.
 * @param {unknown} timeline
 * @returns {Array<{id: string, index: number, label: string, startSec: number, durationSec: number, kind: string, status: string}>}
 */
export function sceneChips(timeline) {
  if (!isObject(timeline)) return [];

  const source = Array.isArray(timeline.scenes) && timeline.scenes.length > 0
    ? timeline.scenes
    : Array.isArray(timeline.clips) && timeline.clips.length > 0
      ? timeline.clips
      : [];

  if (source.length === 0) return [];

  const fps = timelineFps(timeline);
  const totalSec = timelineDuration(timeline, fps);
  const provisionalTimeline = timeline.provisional === true;

  const entries = source
    .filter(isObject)
    .map((item, sourceIndex) => {
      const startSec = Math.max(0, itemStart(item, fps) ?? 0);
      const durationSec = itemDuration(item, fps);
      const id = item.id ?? item.sceneId ?? item.scene_id;
      return {
        sourceIndex,
        id: String(id ?? `scene-${sourceIndex + 1}`),
        label: firstText(
          item.copy?.headline,
          item.label,
          item.name,
          item.title,
          item.headline,
          item.id,
          item.sceneId,
        ) ?? `Scene ${sourceIndex + 1}`,
        startSec: round(startSec),
        durationSec: durationSec === null ? null : round(durationSec),
        kind: firstText(item.layout, item.kind, item.type, item.layoutId) ?? 'scene',
        status: firstText(item.status, item.state)
          ?? ((item.provisional === true || provisionalTimeline) ? 'provisional' : 'ready'),
      };
    });

  entries.sort((a, b) => a.startSec - b.startSec || a.sourceIndex - b.sourceIndex);

  return entries.map((entry, index) => {
    const nextStart = entries[index + 1]?.startSec;
    let durationSec = entry.durationSec;

    if (durationSec === null) {
      if (nextStart !== undefined && nextStart > entry.startSec) {
        durationSec = nextStart - entry.startSec;
      } else if (totalSec !== null && totalSec > entry.startSec) {
        durationSec = totalSec - entry.startSec;
      } else {
        durationSec = 0;
      }
    }

    return {
      id: entry.id,
      index: index + 1,
      label: entry.label,
      startSec: entry.startSec,
      durationSec: round(Math.max(0, durationSec)),
      kind: entry.kind,
      status: entry.status,
    };
  });
}

/** Format a duration in seconds as a compact chip label, e.g. `4.0s`. */
export function formatDuration(sec) {
  const value = Math.max(0, toNumber(sec) ?? 0);
  return `${(Math.round(value * 10) / 10).toFixed(1)}s`;
}

/**
 * Render storyboard chips as accessible HTML. All text and attribute values are escaped.
 * @param {unknown} chips
 * @param {{activeId?: unknown}} [options]
 * @returns {string}
 */
export function renderSceneChips(chips, options = {}) {
  const { activeId } = options ?? {};
  const list = Array.isArray(chips) ? chips : [];
  const items = list.map((chip, index) => {
    if (!isObject(chip)) return '';
    const id = String(chip.id ?? `scene-${index + 1}`);
    const chipIndex = toNumber(chip.index) ?? index + 1;
    const label = String(chip.label ?? `Scene ${chipIndex}`);
    const kind = String(chip.kind ?? 'scene');
    const status = String(chip.status ?? 'ready');
    const current = activeId !== undefined && activeId !== null && String(activeId) === id
      ? ' aria-current="true"'
      : '';

    return `<li><button type="button" class="scene-chip" data-scene-id="${esc(id)}" data-kind="${esc(kind)}" data-status="${esc(status)}"${current}><span class="scene-chip-index">${esc(chipIndex)}</span><span class="scene-chip-label">${esc(label)}</span><span class="scene-chip-time">${esc(formatDuration(chip.durationSec))}</span></button></li>`;
  }).filter(Boolean);

  return `<ol class="scene-chips" aria-label="Storyboard">${items.length ? `\n${items.join('\n')}\n` : ''}</ol>`;
}
