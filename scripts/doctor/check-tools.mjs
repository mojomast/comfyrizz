import { makeResult } from './checks.mjs';
import { fixHint } from './fix-hints.mjs';

const DEFAULT_MIN_NODE = '20';

export function parseVersion(text) {
  const match = String(text ?? '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

export function parseMinVersion(range) {
  if (range && typeof range === 'object' && Number.isFinite(range.major)) {
    return {
      major: Number(range.major),
      minor: Number(range.minor ?? 0),
      patch: Number(range.patch ?? 0),
    };
  }
  return parseVersion(range);
}

export function formatVersion(version) {
  if (!version) return 'unknown';
  return `${version.major}.${version.minor}.${version.patch}`;
}

function compareVersions(left, right) {
  return (left.major - right.major)
    || (left.minor - right.minor)
    || (left.patch - right.patch);
}

function hint(id, fallback) {
  return fixHint(id) ?? fallback;
}

function outputOf(result) {
  const stdout = result?.stdout;
  const stderr = result?.stderr;
  return String(stdout ?? '') || String(stderr ?? '');
}

async function probe(exec, command, args) {
  try {
    const result = await exec(command, args);
    const code = Number(result?.code ?? 0);
    return { found: true, code, output: outputOf(result) };
  } catch {
    return { found: false, code: null, output: '' };
  }
}

function missingResult(id, title, command, status, hintText) {
  return makeResult({
    id,
    title,
    status,
    detail: `${command} not found`,
    fix: hintText,
  });
}

async function nodeCheck(exec, minNode) {
  const id = 'node';
  const title = 'Node.js';
  const minimum = parseMinVersion(minNode) ?? parseMinVersion(DEFAULT_MIN_NODE);
  const fix = hint(id, `install Node.js >= ${formatVersion(minimum)} (https://nodejs.org)`);
  const probeResult = await probe(exec, 'node', ['--version']);
  if (!probeResult.found) return missingResult(id, title, 'node', 'fail', fix);
  if (probeResult.code !== 0) {
    return makeResult({
      id,
      title,
      status: 'fail',
      detail: 'node --version failed',
      fix,
    });
  }
  const version = parseVersion(probeResult.output);
  if (!version) {
    return makeResult({ id, title, status: 'fail', detail: 'could not parse node version', fix });
  }
  if (compareVersions(version, minimum) < 0) {
    return makeResult({
      id,
      title,
      status: 'fail',
      detail: `node ${formatVersion(version)} is older than required ${formatVersion(minimum)}`,
      fix,
    });
  }
  return makeResult({
    id,
    title,
    status: 'ok',
    detail: `node ${formatVersion(version)} (requires >= ${formatVersion(minimum)})`,
  });
}

async function pnpmCheck(exec) {
  const id = 'pnpm';
  const title = 'pnpm';
  const fix = hint(id, 'install pnpm (https://pnpm.io/installation)');
  const probeResult = await probe(exec, 'pnpm', ['--version']);
  if (!probeResult.found) return missingResult(id, title, 'pnpm', 'fail', fix);
  if (probeResult.code !== 0) {
    return makeResult({ id, title, status: 'fail', detail: 'pnpm --version failed', fix });
  }
  const version = parseVersion(probeResult.output);
  return makeResult({
    id,
    title,
    status: 'ok',
    detail: version ? `pnpm ${formatVersion(version)}` : 'pnpm available',
  });
}

async function uvCheck(exec) {
  const id = 'uv';
  const title = 'uv (optional)';
  const fix = hint(id, 'install uv (https://docs.astral.sh/uv/getting-started/installation/)');
  const probeResult = await probe(exec, 'uv', ['--version']);
  if (!probeResult.found) {
    return missingResult(id, title, 'uv', 'warn', fix);
  }
  if (probeResult.code !== 0) {
    return makeResult({
      id,
      title,
      status: 'warn',
      detail: 'uv --version failed',
      fix,
    });
  }
  const version = parseVersion(probeResult.output);
  return makeResult({
    id,
    title,
    status: 'ok',
    detail: version ? `uv ${formatVersion(version)}` : 'uv available',
  });
}

async function pythonCheck(exec) {
  const id = 'python';
  const title = 'Python 3.12';
  const fix = hint(id, 'uv python install 3.12');
  const minimum = { major: 3, minor: 12, patch: 0 };
  const probeResult = await probe(exec, 'python3', ['--version']);
  if (!probeResult.found) return missingResult(id, title, 'python3', 'fail', fix);
  if (probeResult.code !== 0) {
    return makeResult({
      id,
      title,
      status: 'fail',
      detail: 'python3 --version failed',
      fix,
    });
  }
  const version = parseVersion(probeResult.output);
  if (!version) {
    return makeResult({ id, title, status: 'fail', detail: 'could not parse python3 version', fix });
  }
  if (compareVersions(version, minimum) < 0) {
    return makeResult({
      id,
      title,
      status: 'fail',
      detail: `python3 ${formatVersion(version)} is older than required 3.12`,
      fix,
    });
  }
  return makeResult({
    id,
    title,
    status: 'ok',
    detail: `python3 ${formatVersion(version)}`,
  });
}

async function ffmpegCheck(exec) {
  const id = 'ffmpeg';
  const title = 'ffmpeg (optional)';
  const fix = hint(id, 'install ffmpeg (https://ffmpeg.org/download.html)');
  const probeResult = await probe(exec, 'ffmpeg', ['-version']);
  if (!probeResult.found) {
    return missingResult(id, title, 'ffmpeg', 'warn', fix);
  }
  if (probeResult.code !== 0) {
    return makeResult({
      id,
      title,
      status: 'warn',
      detail: 'ffmpeg -version failed',
      fix,
    });
  }
  const version = parseVersion(probeResult.output);
  return makeResult({
    id,
    title,
    status: 'ok',
    detail: version ? `ffmpeg ${formatVersion(version)}` : 'ffmpeg available',
  });
}

export function createToolChecks({ exec, minNode = DEFAULT_MIN_NODE } = {}) {
  if (typeof exec !== 'function') {
    throw new TypeError('createToolChecks requires an exec(cmd, args) function');
  }
  return [
    { id: 'node', title: 'Node.js', run: () => nodeCheck(exec, minNode) },
    { id: 'pnpm', title: 'pnpm', run: () => pnpmCheck(exec) },
    { id: 'uv', title: 'uv (optional)', run: () => uvCheck(exec) },
    { id: 'python', title: 'Python 3.12', run: () => pythonCheck(exec) },
    { id: 'ffmpeg', title: 'ffmpeg (optional)', run: () => ffmpegCheck(exec) },
  ];
}
