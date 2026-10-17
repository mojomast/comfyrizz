#!/usr/bin/env node
// C5 live check: one OpenCode Go run through the local server's /api/agent.
// It is skipped cleanly when no key is configured. The key is never printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';

const port = process.env.COMFYRIZZ_PORT ?? '4320';
const base = `http://127.0.0.1:${port}`;
const brief = process.argv.slice(2).join(' ') || 'Make a calm CPU launch video with an icon, a diagram, a dot pattern and animated bars, and plan one nebula illustration for GPU later.';

if (!process.env.OPENCODE_GO_API_KEY && !process.env.OPENCODE_API_KEY) {
  console.log('skip: OPENCODE_GO_API_KEY / OPENCODE_API_KEY not set; no network call made');
  process.exit(0);
}

let token = process.env.COMFYRIZZ_TOKEN;
if (!token) {
  try {
    token = readFileSync(join(repoRoot, 'apps', 'server', '.runtime', 'server-token'), 'utf8').trim();
  } catch {
    console.error(`cannot read a token; is the server running on ${base}?`);
    process.exit(1);
  }
}

const startedAt = Date.now();
const response = await fetch(`${base}/api/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-comfyrizz-token': token, origin: base },
  body: JSON.stringify({ brief, provider: 'opencode-go' }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`live run failed: HTTP ${response.status} ${body.error ?? ''}`);
  if (Array.isArray(body.details)) for (const detail of body.details.slice(0, 8)) console.error(`  - ${detail.path ?? detail.instancePath}: ${detail.message}`);
  process.exit(1);
}
console.log(`live ok: ${body.package.id} rev ${body.revision} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
console.log(`  provider=${body.provider} model=${body.model} live=${body.live} fallback=${body.fallback}`);
console.log(`  title=${body.package.title}`);
console.log(`  svg assets=${body.svgAssets.length} pending gpu=${body.pendingGpu.length}`);
console.log(`  timeline=${body.timeline.durationInFrames} frames @ ${body.timeline.fps}fps`);
console.log(`  routes=${body.routes.map(route => route.tool).join(',')}`);
