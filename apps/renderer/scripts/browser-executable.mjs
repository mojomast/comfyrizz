// Pick the Chromium Remotion should drive. The Linux default is unchanged;
// Windows needs one of its installed Chrome or Edge executables.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const LINUX_DEFAULT = '/usr/bin/google-chrome';

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
  if (process.platform !== 'win32') return LINUX_DEFAULT;
  return windowsCandidates(env).find((path) => existsSync(path)) ?? LINUX_DEFAULT;
}
