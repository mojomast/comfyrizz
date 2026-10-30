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

test('an installed browser is used, otherwise Remotion manages its own', () => {
  const browser = resolveBrowserExecutable({});
  assert.ok(browser === null || (typeof browser === 'string' && existsSync(browser)));
  assert.notEqual(browser, '/usr/bin/google-chrome');
});
