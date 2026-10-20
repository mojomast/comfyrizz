// D10 - doctor CLI.
//
// Assembles every preflight check, runs them with real dependencies, and prints
// either the text report or a stable JSON document. Read-only: nothing is
// installed, fixed or written, and no secret value ever reaches the output.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeResult, runChecks, summarize } from './checks.mjs';
import { redact } from './redact.mjs';
import { renderJson, renderText } from './report.mjs';
import { createToolChecks } from './check-tools.mjs';
import { createChecks as createRepoChecks } from './check-repo.mjs';
import {
  SERVER_CHECK_ID,
  SERVER_CHECK_TITLE,
  createServerCheck,
} from './check-server.mjs';
import {
  CHECK_ID as COMFY_CHECK_ID,
  CHECK_TITLE as COMFY_CHECK_TITLE,
  runComfyCheck,
} from './check-comfy.mjs';
import {
  CHECK_ID as LLM_CHECK_ID,
  CHECK_TITLE as LLM_CHECK_TITLE,
  runLlmCheck,
} from './check-llm.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const CHECK_TIMEOUT_MS = 5000;

export const EXEC_TIMEOUT_MS = 4000;

export const DEFAULT_MIN_NODE = '20';

export const USAGE = `Usage: node scripts/doctor/doctor.mjs [options]

Read-only setup preflight for Comfyrizz. Reports ok|warn|fail|skip.

Options:
  --json            print the machine-readable report
  --only <ids>     run only these check ids (comma-separated, repeatable)
  --offline         skip the local server and own-ComfyUI network checks
  -h, --help        show this help`;

/** An exec(cmd, args)->{code, stdout, stderr} adapter around child_process.execFile. */
export function createExec({ execFileImpl = execFile, timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  return function exec(command, args = []) {
    return new Promise((resolve, reject) => {
      execFileImpl(
        command,
        args,
        { timeout: timeoutMs, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          const output = {
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
          };
          if (!error) {
            resolve({ code: 0, ...output });
            return;
          }
          if (typeof error.code === 'number') {
            resolve({ code: error.code, ...output });
            return;
          }
          reject(error);
        },
      );
    });
  };
}

/** A tiny fs adapter for the repo checks (exists only). */
export function createNodeFs() {
  return {
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function addOnly(list, value) {
  for (const part of String(value ?? '').split(',')) {
    const id = part.trim();
    if (id) list.push(id);
  }
}

/** Parse CLI flags without touching the environment or the filesystem. */
export function parseArgs(argv = []) {
  const options = { json: false, offline: false, only: null, help: false };
  let only = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--offline') {
      options.offline = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--only') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--only requires a comma-separated list of check ids');
      }
      index += 1;
      only ??= [];
      addOnly(only, value);
    } else if (arg.startsWith('--only=')) {
      only ??= [];
      addOnly(only, arg.slice('--only='.length));
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (only !== null) options.only = [...new Set(only)];
  return options;
}

/** Minimum Node version from the root package.json engines field. */
export function minNodeFromRoot(rootDir = REPO_ROOT) {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    const match = String(pkg?.engines?.node ?? '').match(/(\d+)/);
    return match ? match[1] : DEFAULT_MIN_NODE;
  } catch {
    return DEFAULT_MIN_NODE;
  }
}

function offlineSkip(id, title) {
  return makeResult({
    id,
    title,
    status: 'skip',
    detail: 'skipped by --offline (network check)',
  });
}

/** Build the ordered check list with its dependencies bound. */
export function buildChecks({
  rootDir = REPO_ROOT,
  env = {},
  fetch: fetchImpl = globalThis.fetch,
  exec = createExec(),
  offline = false,
  minNode = DEFAULT_MIN_NODE,
} = {}) {
  const checks = [
    ...createToolChecks({ exec, minNode }),
    ...createRepoChecks(rootDir),
  ];

  if (offline) {
    checks.push({
      id: SERVER_CHECK_ID,
      title: SERVER_CHECK_TITLE,
      run: () => offlineSkip(SERVER_CHECK_ID, SERVER_CHECK_TITLE),
    });
    checks.push({
      id: COMFY_CHECK_ID,
      title: COMFY_CHECK_TITLE,
      run: () => offlineSkip(COMFY_CHECK_ID, COMFY_CHECK_TITLE),
    });
  } else {
    checks.push(createServerCheck({ fetch: fetchImpl, env }));
    checks.push({
      id: COMFY_CHECK_ID,
      title: COMFY_CHECK_TITLE,
      run: (ctx = {}) => runComfyCheck({ ...ctx, env, fetch: fetchImpl }),
    });
  }

  checks.push({
    id: LLM_CHECK_ID,
    title: LLM_CHECK_TITLE,
    run: (ctx = {}) => runLlmCheck({ ...ctx, env }),
  });

  return checks;
}

function colorEnabled(env, stdout) {
  if (!stdout?.isTTY) return false;
  if (Object.hasOwn(env ?? {}, 'NO_COLOR')) return false;
  return true;
}

/**
 * Run the CLI. Dependencies are injectable so tests can call it directly;
 * every write goes through redact() with the same env the checks saw.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  rootDir = REPO_ROOT,
  fetch: fetchImpl = globalThis.fetch,
  exec = createExec(),
  fs = createNodeFs(),
} = {}) {
  const write = (stream, text) => {
    stream.write(`${redact(text, env)}\n`);
  };

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    write(stderr, `doctor: ${error instanceof Error ? error.message : String(error)}`);
    write(stderr, USAGE);
    return 2;
  }

  if (options.help) {
    write(stdout, USAGE);
    return 0;
  }

  const checks = buildChecks({
    rootDir,
    env,
    fetch: fetchImpl,
    exec,
    offline: options.offline,
    minNode: minNodeFromRoot(rootDir),
  });
  const selected = options.only === null
    ? checks
    : checks.filter((check) => options.only.includes(check.id));

  const results = await runChecks(selected, { env, fs }, { timeoutMs: CHECK_TIMEOUT_MS });
  const output = options.json
    ? renderJson(results)
    : renderText(results, { color: colorEnabled(env, stdout) });

  write(stdout, output);
  return summarize(results).exitCode;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const code = await main();
  process.exitCode = code;
}
