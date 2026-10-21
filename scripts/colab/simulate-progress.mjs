// Replay a simulated Google Colab cell through the host's real gauge path, without a VM or a GPU:
// python stdout -> progressLines -> tapColabProgress -> per-run JSONL sink (COMFYRIZZ_COLAB_PROGRESS_DIR).
// The Comfyrizz server's /api/colab/progress and the Orbit Control Plane connector read that sink.
//   node scripts/colab/simulate-progress.mjs [speed]          (speed 1 = ~25 s, 4 = ~6 s)
//   node scripts/colab/simulate-progress.mjs --replay file.jsonl   (replay captured colab_progress lines)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { progressLines } from '../../packages/backends/src/progress-lines.mjs';
import { colabProgressDir, createColabProgressSink, readColabProgress, tapColabProgress } from '../../packages/backends/src/colab-progress.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const sink = createColabProgressSink({ runId: `simulated.run.${new Date().toISOString().replace(/[:.]/g, '-')}` });
const lines = progressLines(tapColabProgress(() => {}, sink));
let count = 0;
const counting = text => { count += (text.match(/"colab_progress"/g) || []).length; lines.write(text); };

if (args[0] === '--replay') {
  const records = readFileSync(args[1], 'utf8').split('\n').filter(Boolean);
  for (const record of records) { counting(`${record}\n`); await new Promise(r => setTimeout(r, Number(args[2] ?? 50))); }
  finish(0);
} else {
  const child = spawn(process.env.COMFYRIZZ_PYTHON || 'python3', [join(here, 'simulate_progress.py'), args[0] ?? '1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', counting);
  child.on('close', code => finish(code));
}

function finish(code) {
  lines.end();
  const run = readColabProgress({ dir: colabProgressDir() }).runs.find(r => r.runId === sink.runId);
  console.log(JSON.stringify({ runId: sink.runId, file: sink.file, lines: count, gauges: run?.gauges.map(g => `${g.stage}:${g.label} ${g.n}/${g.total}${g.state ? ` ${g.state}` : ''}`) }, null, 1));
  process.exit(code ?? 1);
}
