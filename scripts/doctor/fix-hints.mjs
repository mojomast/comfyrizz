const DOCS = 'docs/specs/DOCTOR.md';

export const FIX_HINTS = Object.freeze({
  node: 'install Node.js >= 20 (https://nodejs.org)',
  pnpm: 'install pnpm (https://pnpm.io/installation)',
  uv: 'install uv (https://docs.astral.sh/uv/getting-started/installation/)',
  python: 'uv python install 3.12',
  ffmpeg: 'install ffmpeg (https://ffmpeg.org/download.html)',
  'repo-install': 'pnpm i --frozen-lockfile',
  'repo-lockfile': 'pnpm i --frozen-lockfile',
  'repo-venv': 'uv venv .venv -p 3.12',
  server: 'pnpm --filter @comfyrizz/server start',
  comfy: `own ComfyUI is optional - see ${DOCS}`,
  llm: `no provider configured - set one API key env var, see ${DOCS}`,
});

export const BUILD_HINTS = Object.freeze({
  '@comfyrizz/vector': 'pnpm --filter @comfyrizz/vector build',
  '@comfyrizz/planner': 'pnpm --filter @comfyrizz/planner build',
  '@comfyrizz/llm': 'pnpm --filter @comfyrizz/llm build',
  '@comfyrizz/agent': 'pnpm --filter @comfyrizz/agent build',
  '@comfyrizz/sources': 'pnpm --filter @comfyrizz/sources build',
  '@comfyrizz/tts': 'pnpm --filter @comfyrizz/tts build',
  '@comfyrizz/web': 'pnpm --filter @comfyrizz/web build',
});

const PNPM_BUILTINS = new Set([
  'i', 'install', 'add', 'remove', 'update', 'exec', 'dlx', 'why', 'list',
  'outdated', 'licenses', 'config', 'init', 'link', 'unlink', 'publish',
  'pack', 'root', 'bin', 'env', 'help', '-v', '--version', '-h', '--help',
]);

export function fixHint(id) {
  return Object.prototype.hasOwnProperty.call(FIX_HINTS, id) ? FIX_HINTS[id] : null;
}

export function buildHint(packageName) {
  return Object.prototype.hasOwnProperty.call(BUILD_HINTS, packageName)
    ? BUILD_HINTS[packageName]
    : null;
}

export function allHints() {
  return [
    ...Object.entries(FIX_HINTS).map(([id, hint]) => ({ id, hint })),
    ...Object.entries(BUILD_HINTS).map(([name, hint]) => ({ id: `build:${name}`, hint })),
  ];
}

export function parsePnpmHint(hint) {
  const tokens = String(hint).trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== 'pnpm') return null;
  let i = 1;
  let filter = null;
  if (tokens[i] === '--filter' || tokens[i] === '-F') {
    filter = tokens[i + 1] ?? null;
    i += 2;
  }
  let script = tokens[i] ?? null;
  if (script === 'run') script = tokens[i + 1] ?? null;
  if (!script || PNPM_BUILTINS.has(script)) return null;
  return { filter, script };
}
