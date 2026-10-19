import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const runtimeDir = join(here, '.runtime');

/**
 * C1 dev-only export route. C2 replaces this with the token/Host-checked local
 * server and SSE progress; here it is one synchronous CPU render.
 */
/**
 * TEMPORARY STAND-IN until CA-1's browser-safe planner export drops `node:crypto`.
 * Lets the timeline call the real `compileTimeline` in the browser. The shim hash
 * is not used for save or export.
 */
function shimNodeCrypto(): Plugin {
  const shim = join(here, 'src/editor/stand-in/node-crypto-shim.ts');
  return {
    name: 'comfyrizz-node-crypto-shim',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'node:crypto' || id === 'crypto') return shim;
      return null;
    },
  };
}

function renderApi(): Plugin {
  return {
    name: 'comfyrizz-render-api',
    configureServer(server) {
      server.middlewares.use('/api/render', async (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        try {
          const parsed = JSON.parse(body) as { package?: unknown };
          if (!parsed.package || typeof parsed.package !== 'object') throw new Error('missing package');
          mkdirSync(runtimeDir, { recursive: true });
          const id = `render-${Date.now()}`;
          const packagePath = join(runtimeDir, `${id}.package.json`);
          writeFileSync(packagePath, JSON.stringify(parsed.package, null, 2));
          const script = join(here, 'scripts', 'render-package.mjs');
          const child = spawn(process.execPath, [script, packagePath], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', chunk => (stdout += chunk));
          child.stderr.on('data', chunk => (stderr += chunk));
          const code: number = await new Promise(resolveCode => child.on('close', resolveCode));
          if (code !== 0) throw new Error(stderr.trim().split('\n').slice(-4).join(' ') || `render exited ${code}`);
          const file = join(runtimeDir, `${id}.mp4`);
          if (!existsSync(file)) throw new Error(`render produced no MP4: ${stdout.slice(-400)}`);
          response.statusCode = 200;
          response.setHeader('content-type', 'video/mp4');
          response.setHeader('content-disposition', 'attachment; filename="comfyrizz-export.mp4"');
          response.setHeader('content-length', String(readFileSync(file).byteLength));
          createReadStream(file).pipe(response);
        } catch (error) {
          server.config.logger.error(`render failed: ${(error as Error).message}`);
          response.statusCode = 500;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
    },
  };
}

export default defineConfig({
  publicDir: join(repoRoot, 'apps', 'renderer', 'public'),
  plugins: [shimNodeCrypto(), react(), renderApi()],
  resolve: {
    dedupe: ['remotion', 'react', 'react-dom'],
    alias: {
      remotion: join(here, 'node_modules', 'remotion'),
      react: join(here, 'node_modules', 'react'),
      'react-dom': join(here, 'node_modules', 'react-dom'),
    },
  },
  server: { host: '127.0.0.1', port: 4174, fs: { allow: [repoRoot] } },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022' },
});
