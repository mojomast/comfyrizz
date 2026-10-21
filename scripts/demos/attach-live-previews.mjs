// Attach read-only Colab downloads to an existing run without restarting its
// server or GPU. Takes are content-addressed; the editable package is never saved.
// Usage: node scripts/demos/attach-live-previews.mjs RUNTIME RUN_ID SESSION [API_ORIGIN]
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLivePreviewCollector } from '../../packages/backends/src/live-previews.mjs';
import { createTakeStore } from '../../apps/server/src/takes/store.mjs';
import { ingestRun } from '../../apps/server/src/takes/ingest.mjs';
import { REMOTE_ROOT, resolveColabBinary, argvDownload, redactForLog } from '../../packages/backends/src/colab-plan.mjs';

const [runtimeDir, runId, session, origin = 'http://127.0.0.1:4319'] = process.argv.slice(2);
if (!runtimeDir || !/^run_[\w-]+$/.test(runId ?? '') || !session) throw Error('Expected RUNTIME RUN_ID SESSION [API_ORIGIN]');
const execute = promisify(execFile);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const root = join(runtimeDir, 'runs', runId);
const jobsDoc = readJson(join(root, 'work', 'jobs.json'));
const staged = readJson(join(root, 'work', 'package.json'));
const store = createTakeStore({ runtimeDir, packageDir: join(runtimeDir, 'packages') });
const headers = { 'x-comfyrizz-token': readFileSync(join(runtimeDir, 'server-token'), 'utf8').trim() };
const collector = createLivePreviewCollector({
  jobsDoc, directory: join(root, 'attached-live-previews'), remoteRoot: `${REMOTE_ROOT}/out`,
  download: async ({ remote, local }) => {
    mkdirSync(dirname(local), { recursive: true });
    await execute(resolveColabBinary().bin, argvDownload({ session, remotePath: remote, localPath: local }), { timeout: 60000, maxBuffer: 1024 * 1024 });
  },
  onReady: ({ manifest, outputDir }) => {
    const result = ingestRun({ pkg: staged, manifest, jobsDoc, outputDir, store, runId, backend: 'colab' });
    if (result.failed.length) throw Error(result.failed.map(item => item.error).join('; '));
    console.log(JSON.stringify({ at: new Date().toISOString(), landed: result.takes.map(take => take.assetId) }));
  },
  onError: error => console.error(new Date().toISOString(), redactForLog(error.message)),
});
let stop = false;
process.on('SIGTERM', () => { stop = true; void collector.stop(); });
process.on('SIGINT', () => { stop = true; void collector.stop(); });
try {
  while (!stop) {
    const response = await fetch(`${origin}/api/run/${runId}`, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`Run status HTTP ${response.status}`);
    const { run } = await response.json();
    if (!['starting', 'running'].includes(run?.status)) break;
    try { await collector.poll(); } catch (error) { console.error(new Date().toISOString(), redactForLog(error.message)); }
    if (!stop) await new Promise(resolve => setTimeout(resolve, 10000));
  }
} finally { await collector.stop(); }
