// Pick an installed Chromium Remotion should drive. Returning null lets
// Remotion use its managed browser instead of assuming a Linux-only path.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function windowsCandidates(env) {
  const roots = new Set([
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.LOCALAPPDATA,
    env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : undefined,
  ].filter(Boolean));
  const out = [];
  for (const root of roots) {
    out.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return out;
}

export function resolveBrowserExecutable(env = process.env) {
  const configured = typeof env.REMOTION_BROWSER === 'string' ? env.REMOTION_BROWSER.trim() : '';
  if (configured !== '') return configured;
  const candidates = process.platform === 'win32'
    ? windowsCandidates(env)
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(path => existsSync(path)) ?? null;
}
