#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.mjs';
import { createCpuAgentRunner } from './agent-runner.mjs';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';

const port = Number(process.env.COMFYRIZZ_PORT ?? 4319);
const host = '127.0.0.1';
const runtimeDir = process.env.COMFYRIZZ_RUNTIME ?? join(repoRoot, 'apps', 'server', '.runtime');
mkdirSync(runtimeDir, { recursive: true });

const tokenPath = join(runtimeDir, 'server-token');
const token = process.env.COMFYRIZZ_TOKEN ?? randomBytes(32).toString('hex');
writeFileSync(tokenPath, `${token}\n`);
chmodSync(tokenPath, 0o600);

const app = createApp({
  root: repoRoot,
  token,
  runtimeDir,
  agentRunner: createCpuAgentRunner({
    runtimeDir,
    // The custom preset (spec 5.4) can be pointed at a local OpenAI-compatible
    // server without editing the preset list. The key stays in COMFYRIZZ_CUSTOM_API_KEY.
    ...(process.env.COMFYRIZZ_CUSTOM_BASE_URL
      ? { providers: { custom: { baseUrl: process.env.COMFYRIZZ_CUSTOM_BASE_URL } } }
      : {}),
  }),
});
const seedPath = join(repoRoot, 'examples', 'launch-demo', 'package.json');
if (existsSync(seedPath)) {
  app.store.seed(JSON.parse(readFileSync(seedPath, 'utf8')));
  // The package JSON references assets/*.svg; the store keeps packages in
  // <runtime>/packages, so copy the example's committed vectors next to it.
  // Without this the seeded demo cannot render or export its SVG assets.
  const seedAssets = join(repoRoot, 'examples', 'launch-demo', 'assets');
  if (existsSync(seedAssets)) cpSync(seedAssets, join(runtimeDir, 'packages', 'assets'), { recursive: true });
}

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
