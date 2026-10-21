#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { createCpuAgentRunner } from './agent-runner.mjs';
import { createProviderSettings } from './provider-settings.mjs';
import { seedDemoProject } from './seed-demo.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** The editable project the editor opens by default. */
export const DEFAULT_DEMO = 'pip-night-shift';
/** The original bundled demo, kept as a second seeded project. */
export const LAUNCH_DEMO = 'launch-demo';

const PACKAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * `COMFYRIZZ_DEMO=launch` restores the pre-PIP-DEMO default. Every other
 * value (including an unset variable) seeds Pip's Night Shift.
 */
export function demoMode(env = process.env) {
  return env?.COMFYRIZZ_DEMO === 'launch' ? 'launch' : 'pip';
}

function readLaunchPackage(api, path) {
  if (!api.existsSync(path)) return null;
  const raw = api.readFileSync(path);
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const pkg = JSON.parse(text);
  if (!pkg || typeof pkg.id !== 'string' || !PACKAGE_ID_RE.test(pkg.id)) {
    throw new Error('launch-demo package.json has an invalid id');
  }
  return { pkg, bytes: raw };
}

/**
 * Preserve the original launch-demo boot behaviour: seed the package only when
 * absent, then copy its committed SVG assets into the runtime package folder.
 */
function seedLaunchDemo({ runtimeDir, examplesDir, api }) {
  const exampleDir = join(examplesDir, LAUNCH_DEMO);
  const parsed = readLaunchPackage(api, join(exampleDir, 'package.json'));
  if (!parsed) return { packageId: null, seeded: false, assets: [] };

  const target = join(runtimeDir, 'packages', `${parsed.pkg.id}.json`);
  let seeded = false;
  if (!api.existsSync(target)) {
    api.mkdirSync(dirname(target), { recursive: true });
    api.writeFileSync(target, parsed.bytes);
    seeded = true;
  }

  const sourceAssets = join(exampleDir, 'assets');
  if (api.existsSync(sourceAssets)) {
    api.cpSync(sourceAssets, join(runtimeDir, 'packages', 'assets'), { recursive: true });
  }
  return { packageId: parsed.pkg.id, seeded, assets: sourceAssets };
}

/**
 * Seed the demo projects into a runtime directory.
 *
 * No side effects at import time and every dependency is injectable, so tests
 * can use a temporary directory and a tracking fs. The default run seeds
 * Pip's Night Shift first and keeps launch-demo as a second project; the
 * launch mode seeds only launch-demo, exactly like the old server boot.
 *
 * @param {{
 *   runtimeDir: string,
 *   examplesDir?: string,
 *   env?: Record<string, string|undefined>,
 *   fs?: object,
 *   generateMedia?: boolean,
 *   clock?: () => Date|string|number,
 *   chatId?: string,
 * }} options
 * @returns {{ mode: string, packageIds: string[], pip: object|null, launch: object }}
 */
export function seedProjects(options = {}) {
  if (!options || typeof options !== 'object') throw new Error('seedProjects options must be an object');
  const runtimeDir = options.runtimeDir;
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) throw new Error('runtimeDir is required');
  const examplesDir = options.examplesDir ?? join(repoRoot, 'examples');
  const env = options.env ?? process.env;
  const api = { ...nodeFs, ...(options.fs && typeof options.fs === 'object' ? options.fs : {}) };
  const mode = demoMode(env);
  const report = { mode, packageIds: [], pip: null, launch: null };

  if (mode === 'pip') {
    const pip = seedDemoProject({
      runtimeDir,
      exampleDir: join(examplesDir, DEFAULT_DEMO),
      fs: api,
      generateMedia: options.generateMedia !== false,
      ...(typeof options.clock === 'function' ? { clock: options.clock } : {}),
      ...(typeof options.chatId === 'string' ? { chatId: options.chatId } : {}),
    });
    report.pip = pip;
    report.packageIds.push(pip.packageId);
  }

  const launch = seedLaunchDemo({ runtimeDir, examplesDir, api });
  report.launch = launch;
  if (launch.packageId) report.packageIds.push(launch.packageId);
  return report;
}

function startServer() {
  const port = Number(process.env.COMFYRIZZ_PORT ?? 4319);
  const host = '127.0.0.1';
  const runtimeDir = process.env.COMFYRIZZ_RUNTIME ?? join(repoRoot, 'apps', 'server', '.runtime');
  mkdirSync(runtimeDir, { recursive: true });

  const tokenPath = join(runtimeDir, 'server-token');
  const token = process.env.COMFYRIZZ_TOKEN ?? randomBytes(32).toString('hex');
  writeFileSync(tokenPath, `${token}\n`);
  chmodSync(tokenPath, 0o600);

  const providerSettings = createProviderSettings({ runtimeDir });
  const app = createApp({
    root: repoRoot,
    token,
    runtimeDir,
    providerSettings,
    agentRunner: createCpuAgentRunner({
      runtimeDir,
      resolveProviderConfig: providerSettings.resolve,
    }),
  });
  seedProjects({ runtimeDir, examplesDir: join(repoRoot, 'examples'), env: process.env });

  const server = createServer(app.handler);
  server.listen(port, host, () => {
    const url = `http://${host}:${port}/#token=${token}`;
    console.log('Comfyrizz local server');
    console.log(`  open   ${url}`);
    console.log(`  token  ${tokenPath} (0600)`);
    console.log(`  web    ${app.webDist}`);
  });
  server.on('error', error => {
    console.error(`comfyrizz server failed: ${error.message}`);
    process.exit(1);
  });

  function shutdown(signal) {
    console.log(`\n${signal}: closing`);
    app.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) startServer();
