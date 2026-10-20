import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fingerprint } from '../../apps/server/src/pipeline-contract.mjs';

export const json = path => JSON.parse(readFileSync(path, 'utf8'));

/** Rebase older absolute receipts when a complete artifact directory has moved. */
export function completedShowcase(root) {
  const result = json(join(root, 'result.json'));
  if (result.state?.status !== 'completed') throw Error('Showcase must complete before using its outputs');
  const { state } = result;
  if (!/^pipe_[a-f0-9]{32}$/.test(state.runId)) throw Error('Invalid showcase run ID');
  const runDir = resolve(root, 'runtime', 'pipelines', state.runId);
  const stored = json(join(runDir, 'state.json'));
  const source = json(join(root, 'source/package.json'));
  if (stored.status !== 'completed' || stored.inputHash !== state.inputHash || fingerprint(source) !== state.inputHash) {
    throw Error('Source and completed pipeline result differ; render this source before publishing');
  }
  const pkg = json(join(runDir, 'work/package.json'));
  const timeline = json(join(runDir, 'work/timeline.json'));
  if (pkg.id !== state.packageId || timeline.durationInFrames !== state.result.frames || timeline.fps !== state.result.fps || pkg.format.width !== timeline.width || pkg.format.height !== timeline.height) {
    throw Error('Showcase package, timeline and result metadata differ');
  }
  return { state, runDir, pkg, timeline };
}

export function ensureFreshSource(root, pkg) {
  const receipt = join(root, 'result.json');
  if (existsSync(receipt) && json(receipt).state?.inputHash !== fingerprint(pkg)) {
    throw Error('This output directory already contains a different showcase. Choose a new --out directory (including for portrait variants).');
  }
}
