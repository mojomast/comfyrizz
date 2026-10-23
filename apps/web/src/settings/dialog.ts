import './settings.css';
import { mountSettingsCard } from '../colab-card.ts';
import { mountColabHistory } from '../colab-history.ts';
import { apiFetch } from '../editor/api.ts';
import { setDensity, type UiDensity } from '../ui/prefs.ts';
import { readRenderLocation, writeRenderLocation } from '../voice-settings.ts';
import { renderSettingsDialog, settingsSectionFromSearch, SETTINGS_SECTIONS, type SettingsSectionId } from './sections.ts';

const DEFAULT_CAP_KEY = 'comfyrizz.defaultSpendCap';

function isSection(value: string | undefined): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/** Open the settings dialog from `?settings=` and from every Settings button. */
export function mountSettingsDialog(root: ParentNode = document.body): { open: (id?: string) => void; close: () => void } {
  const holder = document.createElement('div');
  holder.innerHTML = renderSettingsDialog(settingsSectionFromSearch(globalThis.location?.search ?? ''));
  const dialog = holder.querySelector('dialog');
  if (!dialog) throw new Error('settings dialog markup is missing');
  root.append(dialog);

  const show = (id: string | undefined) => {
    const section = isSection(id) ? id : 'ai';
    dialog.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== section;
    });
    dialog.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach((button) => {
      button.setAttribute('aria-selected', button.dataset.settingsSection === section ? 'true' : 'false');
    });
    const colab = dialog.querySelector<HTMLElement>('[data-settings-colab]');
    if (colab && colab.childElementCount === 0) {
      mountSettingsCard(colab, (input, init) => apiFetch(input, init));
    }
    const history = dialog.querySelector<HTMLElement>('[data-settings-colab-history]');
    if (history && history.childElementCount === 0) {
      mountColabHistory(history, { runs: [] });
    }
  };

  dialog.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.<HTMLButtonElement>('[data-settings-section]');
    if (!button) return;
    show(button.dataset.settingsSection);
  });

  const cap = dialog.querySelector<HTMLInputElement>('[data-default-cap]');
  if (cap) {
    try {
      const stored = globalThis.localStorage?.getItem(DEFAULT_CAP_KEY);
      if (stored) cap.value = stored;
    } catch {
      /* private mode */
    }
    cap.addEventListener('change', () => {
      try { globalThis.localStorage?.setItem(DEFAULT_CAP_KEY, cap.value); } catch { /* private mode */ }
    });
  }

  const mp4 = dialog.querySelector<HTMLSelectElement>('[data-final-mp4]');
  if (mp4) {
    mp4.value = readRenderLocation();
    mp4.addEventListener('change', () => { writeRenderLocation(mp4.value); });
  }

  const density = dialog.querySelector<HTMLSelectElement>('[data-density-choice]');
  density?.addEventListener('change', () => {
    const value = density.value;
    if (value === 'compact' || value === 'comfortable') setDensity(value as UiDensity);
  });

  const motion = dialog.querySelector<HTMLInputElement>('[data-reduced-motion]');
  motion?.addEventListener('change', () => {
    document.documentElement.dataset.reducedMotion = motion.checked ? 'reduce' : 'no-preference';
  });

  const open = (id?: string) => {
    show(id ?? settingsSectionFromSearch(globalThis.location?.search ?? ''));
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  };
  const close = () => {
    if (dialog.open) dialog.close();
  };

  document.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.('button');
    if (!button || button.closest('dialog.settings-dialog')) return;
    if ((button.textContent || '').replace(/\s+/g, ' ').trim() === 'Settings') {
      event.preventDefault();
      open();
    }
  });

  if (new URLSearchParams(globalThis.location?.search ?? '').has('settings')) open();
  return { open, close };
}
