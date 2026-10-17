#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const app = createApp({ root: repoRoot, token, runtimeDir, agentRunner: createCpuAgentRunner({ runtimeDir }) });
const seedPath = join(repoRoot, 'examples', 'launch-demo', 'package.json');
if (existsSync(seedPath)) app.store.seed(JSON.parse(readFileSync(seedPath, 'utf8')));

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
