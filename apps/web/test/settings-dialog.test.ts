// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderSettingsDialog, settingsSectionFromSearch, SETTINGS_SECTIONS } from '../src/settings/sections.ts';

const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

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

test('run controls live in settings, not a top-bar popover', () => {
  const html = renderSettingsDialog('colab');
  for (const id of ['backend', 'llm', 'agent-model', 'agent-model-options', 'agent-settings-open', 'budget', 'render-location']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="render-location"[^>]*data-final-mp4/);
  assert.match(html, /id="budget"[^>]*readonly/);
  assert.equal(html.includes('BYO ComfyUI'), false);
  assert.equal(html.includes('Google Colab G4'), false);
  assert.equal(html.includes('>LLM<'), false);
  assert.equal(indexHtml.includes('id="run-settings-popover"'), false);
  assert.equal(indexHtml.includes('id="run-settings-toggle"'), false);
  assert.match(indexHtml, /id="settings-open"/);
});

test('every settings section has an h2', () => {
  const html = renderSettingsDialog('shortcuts');
  const headings = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
  assert.deepEqual(headings, SETTINGS_SECTIONS.map((section) => section.title));
  assert.equal(headings.length, 5);
});
