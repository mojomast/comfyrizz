// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../src/agent-settings.ts', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../src/agent-settings.css', import.meta.url)), 'utf8');

test('the agent settings dialog is not rendered open in its closed state', () => {
  assert.doesNotMatch(source, /<dialog[^>]*\bopen\b/);
  assert.doesNotMatch(source, /dialog\.setAttribute\(\s*['"]open['"]/);
  assert.doesNotMatch(source, /dialog\.open\s*=\s*true/);
});

test('mounting opens the dialog with showModal', () => {
  assert.match(source, /\.showModal\(\)/);
});

test('the closed dialog is hidden rather than drawn offscreen', () => {
  assert.match(css, /\.agent-settings\s*\{\s*display:\s*none/);
  assert.match(css, /\.agent-settings\[open\]\s*\{\s*display:\s*flex/);
});
