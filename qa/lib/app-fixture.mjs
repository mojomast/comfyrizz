// UX20: an isolated, mounted Comfyrizz server for acceptance tests.
//
// `startQaApp` builds the REAL `createApp` handler (every route, every guard)
// over a throwaway runtime directory, behind the egress guard, with fake
// execution adapters and a scripted model on loopback. It never attaches to a
// live service, never reads provider credentials and cannot reach Google Colab
// or any external host. Tests drive it over real HTTP.
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../apps/server/src/app.mjs';
import { createProductionStore } from '../../apps/server/src/productions/store.mjs';
import { createCommandHandler } from '../../apps/server/src/productions/commands.mjs';
import { installEgressGuard } from './egress-guard.mjs';
import { createFakeRuntime } from './fake-runtime.mjs';
import { startScriptedProvider } from './scripted-provider.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const QA_TOKEN = 'qa-acceptance-token-0123456789abcdef';

const clone = value => JSON.parse(JSON.stringify(value));

export function loadExamplePackage(name = 'launch-demo') {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'examples', name, 'package.json'), 'utf8'));
}

export function exampleDir(name = 'launch-demo') {
  return join(REPO_ROOT, 'examples', name);
}

/**
 * @param {import('node:test').TestContext} t  cleanup is registered on it
 * @param {{ packages?: object[], provider?: object|boolean, copyExampleAssets?: string|null }} [options]
 */
export async function startQaApp(t, { packages = [], provider = false, copyExampleAssets = null } = {}) {
  const guard = installEgressGuard({ label: 'qa-app' });
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-qa-'));
  const fake = createFakeRuntime();
  const scripted = provider ? await startScriptedProvider(typeof provider === 'object' ? provider : {}) : null;
  const providerSettings = scripted
    ? {
        resolve: () => ({ baseUrl: scripted.url, apiKey: 'qa-not-a-secret', model: scripted.model }),
        redact: value => value,
        snapshot: () => ({ profiles: [] }),
      }
    : null;
  const app = createApp({
    token: QA_TOKEN,
    runtimeDir,
    root: REPO_ROOT,
    render: fake.render,
    renderScene: fake.render,
    pipelineLaunch: fake.pipelineLaunch,
    backendFactory: fake.backendFactory,
    fakeBackend: false,
    providers: { available: [] },
    ...(providerSettings ? { providerSettings } : {}),
  });
  for (const pkg of packages) app.store.seed(clone(pkg));
  if (copyExampleAssets) cpSync(join(exampleDir(copyExampleAssets), 'assets'), join(runtimeDir, 'packages', 'assets'), { recursive: true });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const productionStore = createProductionStore({ runtimeDir });
  const commands = createCommandHandler({ store: productionStore });
  let seq = 0;
  const nextId = prefix => `${prefix}_qa_${(seq += 1)}`;

  const ctx = {
    app, base, runtimeDir, token: QA_TOKEN, fake, scripted, guard, productionStore, commands,
    request(path, body, { method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
      return fetch(base + path, {
        method,
        headers: { origin: base, 'x-comfyrizz-token': QA_TOKEN, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    async json(path, body, options) {
      const response = await ctx.request(path, body, options);
      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      return { status: response.status, body: parsed, text };
    },
    /** Bind a package to a production through the same command handler the server uses. */
    bindProduction(packageId, { intent = 'active', shotIds = [], conversationId = nextId('chat') } = {}) {
      const created = commands.execute({
        commandId: nextId('cmd'), idempotencyKey: nextId('key'), kind: 'production.create', expected: { productionRevision: 0 },
        payload: { conversationId, packageId, intent, shotIds },
      }, { actor: 'user', userEventId: nextId('ue') });
      return created.productionId;
    },
    command(productionId, kind, payload = {}) {
      const snapshot = productionStore.read(productionId);
      return commands.execute({
        commandId: nextId('cmd'), idempotencyKey: nextId('key'), kind, productionId,
        expected: { productionRevision: snapshot.revision }, payload,
      }, { actor: 'user', userEventId: nextId('ue') });
    },
    packageFile: packageId => join(runtimeDir, 'packages', `${packageId}.json`),
    readPackage: packageId => JSON.parse(readFileSync(join(runtimeDir, 'packages', `${packageId}.json`), 'utf8')),
    writeFile(relative, contents) {
      const target = join(runtimeDir, relative);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
      return target;
    },
    async close() {
      app.close();
      await new Promise(resolve => server.close(resolve));
      if (scripted) await scripted.close();
      guard.uninstall();
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
  t.after(async () => {
    await ctx.close();
    guard.assertNoOutbound();
  });
  return ctx;
}
