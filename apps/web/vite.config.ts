import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { request as httpRequest } from 'node:http';
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

/**
 * E2E only. Forwards `/api` to the local Comfyrizz server while keeping the
 * browser Host and Origin, which the server requires to match on POST.
 * Unset COMFYRIZZ_API leaves the dev server unchanged.
 */
function apiProxy(): Plugin {
  const target = process.env.COMFYRIZZ_API;
  return {
    name: 'comfyrizz-api-proxy',
    configureServer(server) {
      if (!target) return;
      const upstream = new URL(target);
      server.middlewares.use((req, res, next) => {
        const path = req.url ?? '';
        if (!path.startsWith('/api')) return next();
        const proxy = httpRequest({
          hostname: upstream.hostname,
          port: upstream.port,
          path,
          method: req.method,
          headers: req.headers,
        }, upstreamResponse => {
          res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(res);
        });
        proxy.on('error', () => {
          if (res.headersSent) return;
          res.statusCode = 502;
          res.end(JSON.stringify({ error: 'api proxy failed' }));
        });
        req.pipe(proxy);
      });
    },
  };
}

export default defineConfig({
  publicDir: join(repoRoot, 'apps', 'renderer', 'public'),
  plugins: [apiProxy(), react(), renderApi()],
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
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: 'index.html', demo: 'demo.html' } },
  },
});
