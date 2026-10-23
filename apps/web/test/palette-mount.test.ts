// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCommands, registerCommand, resetCommands } from '../src/editor/commands.ts';

const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');

const REQUIRED_TITLES = [
  'Export MP4',
  'Open in studio',
  'Characters',
  'Settings',
  'Generate tab',
  'Activity',
  'Files',
  'Jobs',
];

function loadEditorPaletteCommands() {
  const match = source.match(/export function editorPaletteCommands\(\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('editorPaletteCommands missing from main.ts');
  const body = match[0].replace(/^export /, '');
  return new Function(`${body}\nreturn editorPaletteCommands;`)();
}

test('the mounted command list includes Export MP4, Open in studio, Characters, Settings, Generate tab and the rail tabs', () => {
  const defined = loadEditorPaletteCommands()();
  const definedTitles = defined.map(command => command.title);
  for (const title of REQUIRED_TITLES) {
    assert.ok(definedTitles.includes(title), `missing ${title}`);
  }

  resetCommands();
  for (const command of defined) registerCommand(command);
  const titles = getCommands().map(command => command.title);
  for (const title of REQUIRED_TITLES) {
    assert.ok(titles.includes(title), `command list missing ${title}`);
  }

  assert.match(source, /mountPalette\(/);
  assert.match(source, /setAttribute\('aria-label', 'Commands'\)/);
});
