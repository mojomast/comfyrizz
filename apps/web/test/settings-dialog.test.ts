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

test('AI provider options use plain-language labels', () => {
  const html = renderSettingsDialog('ai');
  const options = [...html.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
    .filter(([, value]) => ['none', 'opencode-go', 'custom', 'openrouter'].includes(value))
    .map(([, value, label]) => [value, label]);
  assert.deepEqual(options, [
    ['none', 'None (offline templates)'],
    ['opencode-go', 'OpenCode Go'],
    ['custom', 'Custom (OpenAI-compatible)'],
    ['openrouter', 'OpenRouter'],
  ]);
  assert.equal(html.includes('local · scripted model'), false);
  assert.equal(html.includes('Custom · OpenAI-compatible'), false);
});

test('agent setup is inlined with the provider field, not a standalone Agent settings button', () => {
  const html = renderSettingsDialog('ai');
  assert.equal(html.includes('>Agent settings<'), false);
  assert.match(html, /<\/select><button[^>]*id="agent-settings-open"[^>]*>Manage connections<\/button>/);
});

test('keyboard shortcuts list every documented shortcut', () => {
  const html = renderSettingsDialog('shortcuts');
  const panel = html.match(/data-settings-panel="shortcuts">([\s\S]*?)<\/section>/)?.[1] ?? '';
  const items = [...panel.matchAll(/<li>([^<]+)<\/li>/g)].map((match) => match[1]);
  assert.deepEqual(items, [
    'Space — Play or pause',
    '? — Keyboard shortcuts',
    'Tab / Shift+Tab — Move through the step',
    'Enter — Activate the primary action; in a text area, insert a new line',
    'Ctrl/Cmd+Enter — Run the primary action',
    'Arrow keys — Move within choices, the shot strip and the version switcher',
    'Alt+← / Alt+→ — Previous or next step',
    'Esc — Close dialog',
    'Ctrl/Cmd+Shift+A — Switch studio/editor',
  ]);
});

test('every settings section has an h2', () => {
  const html = renderSettingsDialog('shortcuts');
  const headings = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
  assert.deepEqual(headings, SETTINGS_SECTIONS.map((section) => section.title));
  assert.equal(headings.length, 5);
});
