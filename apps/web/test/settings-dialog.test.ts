// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSettingsDialog, settingsSectionFromSearch, SETTINGS_SECTIONS } from '../src/settings/sections.ts';

test('the settings dialog has five nav items', () => {
  assert.equal(SETTINGS_SECTIONS.length, 5);
  const html = renderSettingsDialog('ai');
  const labels = [...html.matchAll(/data-settings-section="([^"]+)"[^>]*>([^<]+)</g)].map((match) => match[2]);
  assert.deepEqual(labels, [
    'AI provider',
    'Google Colab and spend',
    'My ComfyUI',
    'Appearance',
    'Keyboard shortcuts',
  ]);
});

test('?settings=colab opens that section', () => {
  const section = settingsSectionFromSearch('?settings=colab');
  assert.equal(section, 'colab');
  const html = renderSettingsDialog(section);
  assert.match(html, /data-settings-panel="colab">/);
  assert.match(html, /data-settings-panel="ai" hidden>/);
  assert.match(html, /data-settings-section="colab"[^>]*aria-selected="true"/);
});

test('every settings section has an h2', () => {
  const html = renderSettingsDialog('shortcuts');
  const headings = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
  assert.deepEqual(headings, SETTINGS_SECTIONS.map((section) => section.title));
  assert.equal(headings.length, 5);
});
