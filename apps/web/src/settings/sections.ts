export const SETTINGS_SECTIONS = Object.freeze([
  { id: 'ai', label: 'AI provider', title: 'AI provider' },
  { id: 'colab', label: 'Google Colab and spend', title: 'Google Colab and spend' },
  { id: 'comfyui', label: 'My ComfyUI', title: 'My ComfyUI' },
  { id: 'appearance', label: 'Appearance', title: 'Appearance' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', title: 'Keyboard shortcuts' },
]);

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

const SECTION_IDS = new Set(SETTINGS_SECTIONS.map((section) => section.id));

export function settingsSectionFromSearch(search: string): SettingsSectionId {
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('settings');
  if (value && SECTION_IDS.has(value as SettingsSectionId)) return value as SettingsSectionId;
  return 'ai';
}

function bodyFor(id: SettingsSectionId): string {
  switch (id) {
    case 'ai':
      return '<div data-settings-agent></div>';
    case 'colab':
      return '<div data-settings-colab></div><label>Default spend cap for new videos<input data-default-cap type="number" min="0.5" max="500" step="0.5" value="15"></label><div data-settings-colab-history></div><label>Final MP4 location<select data-final-mp4><option value="local">This machine</option><option value="colab">Google Colab VM</option></select></label>';
    case 'comfyui':
      return '<label>My ComfyUI address<input data-comfyui-url type="url" placeholder="http://127.0.0.1:8188"></label>';
    case 'appearance':
      return '<label>Density<select data-density-choice><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label><input data-reduced-motion type="checkbox"> Reduced motion</label>';
    case 'shortcuts':
      return '<ul><li>Space — Play or pause</li><li>? — Keyboard shortcuts</li></ul>';
    default:
      return '';
  }
}

/** Dialog markup. The active section is the only one without the hidden attribute. */
export function renderSettingsDialog(active: string): string {
  const current = SECTION_IDS.has(active as SettingsSectionId) ? active : 'ai';
  const nav = SETTINGS_SECTIONS.map((section) => {
    const selected = section.id === current ? 'true' : 'false';
    return `<button type="button" role="tab" data-settings-section="${section.id}" aria-selected="${selected}">${section.label}</button>`;
  }).join('');
  const panels = SETTINGS_SECTIONS.map((section) => {
    const hidden = section.id === current ? '' : ' hidden';
    return `<section data-settings-panel="${section.id}"${hidden}><h2>${section.title}</h2>${bodyFor(section.id)}</section>`;
  }).join('');
  return `<dialog class="settings-dialog" aria-label="Settings"><nav aria-label="Settings sections">${nav}</nav><div class="settings-panels">${panels}</div></dialog>`;
}
