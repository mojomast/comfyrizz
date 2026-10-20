// Ship the editor's package and a renderer bundle to the Google Colab VM, run the
// render plus mix verification there, and bring back the MP4 and reports.
// Generated plates stay on the VM and are linked, not downloaded, unless this fails.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions, repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { namedAssetFiles } from './run-assets.mjs';
import {
  listRenderBundleFiles,
  planColabRenderJob,
  renderBundleStamp,
  writeZipArchive,
} from '../../../packages/backends/src/colab-render-plan.mjs';

const renderDirsScript = join(repoRoot, 'colab', 'render_dirs.py');
const renderScript = join(repoRoot, 'colab', 'render_remote.py');
const python = () => process.env.COMFYRIZZ_PYTHON || 'python3';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safeRelative(file) {
  if (typeof file !== 'string' || !file || file.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return file;
}

function filesUnder(workDir, rel) {
  const root = join(workDir, rel);
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [rel];
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const next = join(dir, entry);
      const name = `${prefix}/${entry}`;
      if (statSync(next).isDirectory()) walk(next, name);
      else found.push(name);
    }
  };
  walk(root, rel);
  return found;
}

/** Files the renderer needs from the host, and generated names that stay on the VM. */
export function projectTransferLists(pkg, workDir) {
  const present = (file) => {
    const safe = safeRelative(file);
    if (!safe) return false;
    const path = join(workDir, safe);
    return existsSync(path) && statSync(path).isFile();
  };
  const named = namedAssetFiles(pkg).map(safeRelative).filter(Boolean);
  const upload = [];
  const link = [];
  for (const file of named) {
    if (present(file)) upload.push(file);
    else link.push(file);
  }
  const extras = [...filesUnder(workDir, 'audio')];
  for (const file of ['package.json', 'timeline.json', 'media.json']) if (present(file)) extras.push(file);
  for (const font of pkg.theme?.fonts ?? []) if (present(font?.file)) extras.push(font.file);
  return {
    uploadFiles: [...new Set([...extras, ...upload])],
    linkFiles: link,
    archiveFiles: named,
  };
}

export function prepareRenderJob(workDir, { voiced = false, presenters = false } = {}) {
  const packagePath = join(workDir, 'package.json');
  const pkg = readJson(packagePath);
  const timeline = compileTimeline(pkg, narrationOptions(workDir));
  writeFileSync(join(workDir, 'timeline.json'), JSON.stringify(timeline));
  const lists = projectTransferLists(pkg, workDir);
  const bundleFiles = listRenderBundleFiles(repoRoot);
  if (!bundleFiles.some((file) => file.name === 'apps/renderer/package.json')) {
    throw new Error('The render bundle is missing the renderer package');
  }
  if (!bundleFiles.some((file) => file.name.startsWith('packages/planner/dist/'))) {
    throw new Error('The render bundle is missing the built timeline compiler. Build @comfyrizz/planner first.');
  }
  const stamp = renderBundleStamp(bundleFiles);
  const job = planColabRenderJob({ ...lists, voiced, presenters, stamp });
  return { pkg, timeline, bundleFiles, job };
}

function unzipSafe(archive, dest) {
  const script = `
import sys, zipfile
from pathlib import Path
archive, dest = sys.argv[1:]
root = Path(dest)
root.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as bundle:
    for name in bundle.namelist():
        path = Path(name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit("unsafe zip member")
    bundle.extractall(root)
`;
  const result = spawnSync(python(), ['-c', script, archive, dest], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not unpack ${archive}: ${(result.stderr || '').slice(-400)}`);
}

/**
 * @param {object} backend a Google Colab backend that is already up (uploadFile, execStep, downloadFile)
 */
export async function runColabRender({ backend, workDir, runDir, voiced = false, presenters = false, signal, onEvent = () => {} } = {}) {
  if (!backend || typeof backend.uploadFile !== 'function' || typeof backend.execStep !== 'function' || typeof backend.downloadFile !== 'function') {
    throw new Error('This Google Colab backend cannot run a remote render');
  }
  const scratch = join(runDir, 'colab-render');
  mkdirSync(scratch, { recursive: true });
  const { bundleFiles, job } = prepareRenderJob(workDir, { voiced, presenters });
  writeFileSync(join(scratch, 'job.json'), JSON.stringify(job));
  onEvent({ phase: 'bundling', progress: null });
  writeZipArchive(join(scratch, 'bundle.zip'), bundleFiles);
  writeZipArchive(join(scratch, 'project.zip'), job.uploadFiles.map((name) => ({ name, path: join(workDir, name) })));
  const forward = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.phase) onEvent({ phase: event.phase, progress: event.progress ?? null, message: event.message });
    else if (event.event === 'progress' && event.phase) onEvent({ phase: event.phase, progress: event.progress ?? null });
  };
  signal?.throwIfAborted();
  onEvent({ phase: 'preparing', progress: null });
  const dirs = await backend.execStep(renderDirsScript, 'render-dirs', { timeout: 180, signal, onEvent: forward });
  if (!dirs?.ok) throw new Error(dirs?.note || 'Google Colab render directories were not created');
  signal?.throwIfAborted();
  onEvent({ phase: 'uploading', progress: null });
  await backend.uploadFile(join(scratch, 'bundle.zip'), job.bundleZip);
  await backend.uploadFile(join(scratch, 'project.zip'), job.projectZip);
  await backend.uploadFile(join(scratch, 'job.json'), job.jobFile);
  signal?.throwIfAborted();
  onEvent({ phase: 'bootstrapping', progress: null });
  const rendered = await backend.execStep(renderScript, 'render', { timeout: 3600, silenceMs: 180000, signal, onEvent: forward });
  if (!rendered?.ok) throw new Error(rendered?.note || 'Google Colab render did not finish');
  signal?.throwIfAborted();
  onEvent({ phase: 'collecting', progress: { mode: 'measured', completed: 0, total: 2, unit: 'files' } });
  const resultsZip = join(scratch, 'results.zip');
  const mediaZip = join(scratch, 'media.zip');
  await backend.downloadFile(job.resultsZip, resultsZip);
  await backend.downloadFile(job.mediaZip, mediaZip);
  onEvent({ phase: 'collecting', progress: { mode: 'measured', completed: 2, total: 2, unit: 'files' } });
  unzipSafe(resultsZip, runDir);
  unzipSafe(mediaZip, workDir);
  const renderPath = join(runDir, 'render.json');
  if (!existsSync(join(runDir, 'video.mp4')) || !existsSync(renderPath) || !existsSync(join(runDir, 'verification.json'))) {
    throw new Error('Google Colab render did not return the MP4 and verification report');
  }
  const renderResult = readJson(renderPath);
  renderResult.bytes = statSync(join(runDir, 'video.mp4')).size;
  renderResult.location = 'colab';
  return { renderResult, job };
}
