// The render commands must not depend on `npx` or a Linux-only browser path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { remotionCli } from '../scripts/remotion-cli.mjs';
import { resolveBrowserExecutable } from '../scripts/browser-executable.mjs';

test('the local Remotion CLI resolves to an installed file', () => {
  assert.equal(existsSync(remotionCli), true);
});

test('REMOTION_BROWSER wins over the platform default', () => {
  assert.equal(resolveBrowserExecutable({ REMOTION_BROWSER: '/custom/chrome' }), '/custom/chrome');
  assert.equal(resolveBrowserExecutable({ REMOTION_BROWSER: '  C:\\Chrome\\chrome.exe  ' }), 'C:\\Chrome\\chrome.exe');
});

test('a platform default exists when no override is set', () => {
  const browser = resolveBrowserExecutable({});
  assert.equal(typeof browser, 'string');
  assert.notEqual(browser, '');
  if (process.platform !== 'win32') assert.equal(browser, '/usr/bin/google-chrome');
});
