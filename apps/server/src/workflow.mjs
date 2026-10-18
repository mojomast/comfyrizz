// W1: per-asset ComfyUI workflow download.
//
// The runner writes `<stem>.workflow.api.json` and `<stem>.workflow.md` next to
// each generated still, plate and ×2 file. This module finds those sidecars
// from the asset's `file` (no extra package field — the schema does not have
// one) and redacts again on the way out.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OPEN_IN_COMFYUI_MARKDOWN, redactWorkflowDocument } from '../../../packages/sources/dist/src/index.js';

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const ASSET_ID = /^a[A-Za-z0-9_-]{0,63}$/;

export function isInside(root, file) {
  if (typeof file !== 'string' || file.length === 0 || isAbsolute(file)) return false;
  const rel = relative(resolve(root), resolve(root, file));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** `assets/a.png` → the API graph and the instructions that sit beside it. */
export function workflowSidecars(file) {
  if (typeof file !== 'string' || file.length === 0 || isAbsolute(file)) return null;
  const normalized = file.replace(/\\/g, '/');
  if (normalized.split('/').some(part => part === '' || part === '.' || part === '..')) return null;
  const slash = normalized.lastIndexOf('/');
  const dir = slash >= 0 ? normalized.slice(0, slash + 1) : '';
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const stem = base.slice(0, dot);
  return {
    api: `${dir}${stem}.workflow.api.json`,
    readme: `${dir}${stem}.workflow.md`,
  };
}

/**
 * The file a generated still or plate would have a workflow for.
 * `variant: "upscaled"` selects the ×2 file. SVG, audio and stock assets are not Comfy graphs.
 */
export function assetWorkflowTarget(asset, variant = null) {
  if (!asset || asset.origin !== 'generated') return null;
  if (asset.kind !== 'image' && asset.kind !== 'video') return null;
  const generator = asset.gen?.generator;
  if (generator === 'kokoro' || generator === 'llm-svg') return null;
  const file = variant === 'upscaled' ? asset.variants?.upscaled?.file : asset.file;
  if (typeof file !== 'string' || file.length === 0) return null;
  return workflowSidecars(file);
}

/** Every captured-workflow path that should travel with this package, when the file exists. */
export function collectCapturedWorkflows(pkg, packageDir) {
  const files = {};
  for (const asset of Object.values(pkg?.assets ?? {})) {
    for (const variant of [null, 'upscaled']) {
      const target = assetWorkflowTarget(asset, variant);
      if (!target) continue;
      for (const rel of [target.api, target.readme]) {
        if (!isInside(packageDir, rel) || files[rel]) continue;
        const abs = join(packageDir, rel);
        if (!existsSync(abs) || !statSync(abs).isFile()) continue;
        if (statSync(abs).size > MAX_WORKFLOW_BYTES) continue;
        files[rel] = readFileSync(abs);
      }
    }
  }
  return files;
}

function filenameFor(rel, assetId, format) {
  const base = rel.split('/').pop() || '';
  const safe = base.replace(/[^A-Za-z0-9_.@-]/g, '_');
  if (safe) return safe;
  return format === 'readme' ? `${assetId}.workflow.md` : `${assetId}.workflow.api.json`;
}

/**
 * Read one asset's captured workflow for the download endpoint.
 * @returns {{status: number, error?: string, reason?: string, body?: string, filename?: string, contentType?: string, format?: string}}
 */
export function loadAssetWorkflow({ packageDir, pkg, assetId, format = 'api', variant = null } = {}) {
  if (typeof assetId !== 'string' || !ASSET_ID.test(assetId)) {
    return { status: 400, error: 'invalid asset id' };
  }
  const asset = pkg?.assets?.[assetId];
  if (!asset) return { status: 404, error: 'unknown asset' };
  if (variant && variant !== 'upscaled') return { status: 400, error: 'unknown workflow variant' };
  const wantReadme = format === 'readme' || format === 'md';
  if (format !== 'api' && !wantReadme) return { status: 400, error: 'unknown workflow format' };
  const target = assetWorkflowTarget(asset, variant);
  if (!target) {
    return {
      status: 404,
      error: 'no captured workflow',
      reason: 'Open in ComfyUI is for a generated still or plate, and the workflow is saved after that ComfyUI job succeeds.',
    };
  }
  const rel = wantReadme ? target.readme : target.api;
  const abs = join(packageDir, rel);
  const present = isInside(packageDir, rel) && existsSync(abs) && statSync(abs).isFile();
  if (!present) {
    if (wantReadme && isInside(packageDir, target.api) && existsSync(join(packageDir, target.api))) {
      return {
        status: 200,
        format: 'readme',
        filename: filenameFor(target.readme, assetId, 'readme'),
        contentType: 'text/markdown; charset=utf-8',
        body: redactWorkflowDocument(OPEN_IN_COMFYUI_MARKDOWN),
      };
    }
    return {
      status: 404,
      error: 'no captured workflow',
      reason: 'This still or plate has no saved workflow yet. It is written when the ComfyUI job succeeds.',
    };
  }
  if (statSync(abs).size > MAX_WORKFLOW_BYTES) return { status: 413, error: 'workflow file is too large' };
  const raw = readFileSync(abs, 'utf8');
  return {
    status: 200,
    format: wantReadme ? 'readme' : 'api',
    filename: filenameFor(rel, assetId, wantReadme ? 'readme' : 'api'),
    contentType: wantReadme ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
    body: redactWorkflowDocument(raw),
  };
}
