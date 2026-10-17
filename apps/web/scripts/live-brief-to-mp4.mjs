#!/usr/bin/env node
// C8 live check: a live brief on a chosen provider goes through the running
// local server -> package -> the M2 edit loop (headline + chart value) ->
// /api/render -> an MP4 on disk, then ffprobe reports the result.
//
// It is skipped cleanly when the chosen provider has no key, and never prints a
// key. Start the server first (apps/server `npm start`), then:
//
//   COMFYRIZZ_PROVIDER=opencode-go node apps/web/scripts/live-brief-to-mp4.mjs
//   COMFYRIZZ_PROVIDER=custom COMFYRIZZ_CUSTOM_BASE_URL=http://127.0.0.1:8000/v1 node apps/web/scripts/live-brief-to-mp4.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';

const provider = process.env.COMFYRIZZ_PROVIDER ?? 'opencode-go';
const model = process.env.COMFYRIZZ_MODEL;
const port = process.env.COMFYRIZZ_PORT ?? '4319';
const base = `http://127.0.0.1:${port}`;
const brief =
  process.argv.slice(2).join(' ') ||
  'Make a calm launch video with an icon, a diagram, a dot pattern and animated bars, plus one nebula illustration to plan for GPU later.';

const keyByProvider = {
  'opencode-go': ['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  custom: [],
};
if (!(provider in keyByProvider)) {
  console.error(`unknown provider ${provider}; use opencode-go, openrouter or custom`);
  process.exit(2);
}
if (!keyByProvider[provider].some(name => process.env[name])) {
  console.log(`skip: no key for ${provider} (${keyByProvider[provider].join(' / ') || 'none required'}); no network call made`);
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

const headers = { 'content-type': 'application/json', 'x-comfyrizz-token': token, origin: base };
const json = async (path, init) => {
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.error ?? ''}`);
  return body;
};

const startedAt = Date.now();
const built = await json('/api/agent', {
  method: 'POST',
  body: JSON.stringify({ brief, provider, ...(model ? { model } : {}) }),
});
console.log(`agent ok: ${built.package.id} rev ${built.revision} live=${built.live} fallback=${built.fallback} provider=${built.provider ?? provider} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
console.log(`  svg assets=${built.svgAssets.length} pending gpu=${built.pendingGpu.length} timeline=${built.timeline.durationInFrames} frames`);
if (!built.live) console.log('  note: the server ran the scripted model, not the live provider');

// M2 edit loop: change a headline and a chart value, persist with a base revision.
const current = await json(`/api/package/${encodeURIComponent(built.package.id)}`);
const pkg = current.package;
const titleScene = pkg.scenes.find(scene => scene.id === 's_title');
const firstDataset = Object.values(pkg.datasets ?? {})[0];
if (titleScene?.copy) titleScene.copy.headline = 'Edited by the live C8 loop';
if (firstDataset?.values?.[0]) firstDataset.values[0].value = 99;
const saved = await json(`/api/package/${encodeURIComponent(pkg.id)}`, {
  method: 'PATCH',
  body: JSON.stringify({ baseRevision: current.revision, package: pkg }),
});
console.log(`edit ok: revision ${current.revision} -> ${saved.revision}`);

// Export the edited revision to a real MP4.
const renderResponse = await fetch(`${base}/api/render`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ packageId: pkg.id, baseRevision: saved.revision }),
});
if (!renderResponse.ok) throw new Error(`/api/render: HTTP ${renderResponse.status} ${(await renderResponse.text()).slice(0, 200)}`);
const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-c8-live-'));
const output = join(dir, 'c8-live.mp4');
writeFileSync(output, Buffer.from(await renderResponse.arrayBuffer()));

const probe = JSON.parse(
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames', '-show_entries', 'format=duration', '-of', 'json', output]).toString(),
);
const video = probe.streams.find(stream => stream.codec_name === 'h264');
console.log(`render ok: ${output}`);
console.log(`  ${video?.codec_name} ${video?.width}x${video?.height} ${video?.nb_frames} frames, ${Number(probe.format.duration).toFixed(3)} s`);
console.log(`  provider=${provider} model=${built.model ?? model ?? '(provider default)'} live=${built.live} fallback=${built.fallback}`);
