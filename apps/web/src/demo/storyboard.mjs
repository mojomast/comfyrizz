import { formatDuration, sceneChips } from '../scene-chips.mjs';

const STATUSES = new Set(['ready', 'stale', 'rerendering', 'failed']);
const STATUS_ALIASES = {
  rendering: 'rerendering',
  're-rendering': 'rerendering',
  rerender: 'rerendering',
  provisional: 'stale',
  error: 'failed',
};

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function normalizeStatus(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const status = STATUS_ALIASES[text] ?? text;
  return STATUSES.has(status) ? status : 'ready';
}

function statusFromScenes(scenes, id) {
  if (scenes instanceof Map) {
    const entry = scenes.get(id);
    return statusValue(entry);
  }

  if (Array.isArray(scenes)) {
    for (const entry of scenes) {
      if (Array.isArray(entry) && String(entry[0]) === id) return statusValue(entry[1]);
      if (entry && typeof entry === 'object' && String(entry.id ?? entry.sceneId ?? entry.scene_id) === id) {
        return statusValue(entry);
      }
    }
    return undefined;
  }

  if (scenes && typeof scenes === 'object') return statusValue(scenes[id]);
  return undefined;
}

function statusValue(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return entry.status ?? entry.state;
  return undefined;
}

function sceneStatus(scenes, chip) {
  return normalizeStatus(statusFromScenes(scenes, chip.id) ?? chip.status);
}

/**
 * Render the storyboard scene chips with per-scene status and a re-run action.
 * @param {unknown} timeline
 * @param {{scenes?: unknown, selectedId?: unknown}} [options]
 * @returns {string}
 */
export function renderStoryboard(timeline, options = {}) {
  const { scenes, selectedId } = options ?? {};
  const chips = sceneChips(timeline);
  const selected = selectedId === undefined || selectedId === null ? null : String(selectedId);

  const items = chips.map(chip => {
    const status = sceneStatus(scenes, chip);
    const current = selected !== null && selected === chip.id ? ' aria-current="true"' : '';

    return `<li class="storyboard-scene" data-scene-id="${esc(chip.id)}" data-status="${esc(status)}">` +
      `<button type="button" class="storyboard-chip" data-action="select" data-scene-id="${esc(chip.id)}"${current}>` +
      `<span class="storyboard-chip-index" aria-hidden="true">${esc(chip.index)}</span>` +
      `<span class="storyboard-chip-label">${esc(chip.label)}</span>` +
      `<span class="storyboard-chip-time">${esc(formatDuration(chip.durationSec))}</span>` +
      `<span class="storyboard-status storyboard-status-${esc(status)}" data-status="${esc(status)}">${esc(status)}</span>` +
      `</button>` +
      `<button type="button" class="storyboard-rerun" data-action="rerun" data-scene-id="${esc(chip.id)}" aria-label="Re-run ${esc(chip.label)}">Re-run</button>` +
      `</li>`;
  });

  const list = items.length
    ? `<ol class="storyboard-scenes" aria-label="Scenes">\n${items.join('\n')}\n</ol>`
    : '<p class="storyboard-empty">No scenes yet.</p>';

  return `<section class="storyboard" aria-label="Storyboard">\n${list}\n</section>`;
}

function sceneIdOf(element) {
  const id = element?.getAttribute?.('data-scene-id');
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Wire selection and re-run events on rendered storyboard markup.
 * @param {Element} root
 * @param {{onSelect?: (sceneId: string) => void, onRerun?: (sceneId: string) => void}} [handlers]
 * @returns {{destroy: () => void}}
 */
export function mountStoryboard(root, handlers = {}) {
  const onSelect = typeof handlers?.onSelect === 'function' ? handlers.onSelect : () => {};
  const onRerun = typeof handlers?.onRerun === 'function' ? handlers.onRerun : () => {};

  if (!root || typeof root.addEventListener !== 'function' || typeof root.querySelectorAll !== 'function') {
    return { destroy() {} };
  }

  const chips = () => Array.from(root.querySelectorAll('[data-action="select"]'));

  const setCurrent = target => {
    for (const chip of chips()) {
      if (chip === target) chip.setAttribute('aria-current', 'true');
      else chip.removeAttribute('aria-current');
    }
  };

  const currentChip = () => {
    const selected = root.querySelector?.('[aria-current="true"]');
    if (selected) return selected;
    return chips().find(chip => chip.getAttribute('aria-current') === 'true') ?? null;
  };

  const onClick = event => {
    const target = event?.target;
    if (!target || typeof target.closest !== 'function') return;

    const rerun = target.closest('[data-action="rerun"]');
    if (rerun) {
      event.preventDefault?.();
      const id = sceneIdOf(rerun);
      if (id !== null) onRerun(id);
      return;
    }

    const chip = target.closest('[data-action="select"]');
    if (!chip) return;

    const id = sceneIdOf(chip);
    if (id === null) return;
    setCurrent(chip);
    onSelect(id);
  };

  const onKeyDown = event => {
    const key = event?.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;

    const list = chips();
    if (list.length === 0) return;

    const target = event?.target;
    const focused = target && typeof target.closest === 'function'
      ? target.closest('[data-action="select"]')
      : null;
    const current = focused ?? currentChip();
    const index = current ? list.indexOf(current) : -1;
    const from = index < 0 ? 0 : index;
    const nextIndex = key === 'ArrowRight'
      ? Math.min(from + 1, list.length - 1)
      : Math.max(from - 1, 0);
    const next = list[nextIndex];

    event.preventDefault?.();
    if (!next || next === current) return;

    setCurrent(next);
    next.focus?.();
    const id = sceneIdOf(next);
    if (id !== null) onSelect(id);
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);

  return {
    destroy() {
      root.removeEventListener?.('click', onClick);
      root.removeEventListener?.('keydown', onKeyDown);
    },
  };
}
