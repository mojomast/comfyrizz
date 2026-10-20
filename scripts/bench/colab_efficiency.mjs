// Bounded experimental runner. Account deltas overlap when other trials are active.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname, basename } from 'node:path';
import { ColabCli } from '../../packages/backends/src/cli.mjs';
import { createColabBackend } from '../../packages/backends/src/colab-backend.mjs';
import { argvUpload, argvExec, argvDownload } from '../../packages/backends/src/colab-plan.mjs';

const flag = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const out = resolve(flag('--out', '.runtime/efficiency'));
const worker = resolve(flag('--worker', 'colab/qwen_efficiency_worker.py'));
const input = resolve(flag('--input', '.runtime/efficiency-input.zip'));
const gpu = flag('--gpu', 'G4');
const units = Number(flag('--units', '3'));
const minutes = Number(flag('--minutes', '18'));
const id = flag('--id', 'eff-qwen-g4');
const rate = { G4: 8.9, L4: 1.54 }[gpu];
if (!rate || !(units > 0 && units <= 5) || !(minutes > 0 && minutes * rate / 60 + 0.3 <= units)) throw Error('Invalid bounded trial');
if (!statSync(worker).isFile() || !statSync(input).isFile() || statSync(input).size > 128 * 1024 * 1024) throw Error('Missing worker or invalid input bundle');
execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert "task.json" in z.namelist()', input]);
mkdirSync(out, { recursive: true });
const event = data => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...data });
  appendFileSync(join(out, 'events.jsonl'), line + '\n');
  console.log(line);
};
const cli = new ColabCli({ bin: join(process.env.HOME, '.local/bin/colab'), logDir: join(out, 'logs') });
const backend = createColabBackend({ cli, packageId: id, gpu, ratePerHour: rate, budgetUnits: units, watchdogMinutes: minutes,
  scratchDir: join(out, 'scratch'), logDir: join(out, 'logs'), hfTokenPath: process.env.COMFYRIZZ_HF_TOKEN_FILE,
  newAttempts: 1 });
const abort = new AbortController();
process.on('SIGINT', () => abort.abort());
process.on('SIGTERM', () => abort.abort());
const started = Date.now();
let before, allocated, after, stopped, error;
const step = async (args, options = {}) => {
  abort.signal.throwIfAborted();
  const start = Date.now();
  const result = await cli.run(args, { wallMs: 180000, silenceMs: 180000, signal: abort.signal, ...options });
  event({ phase: args[0], seconds: (Date.now() - start) / 1000, code: result.code });
  if (result.code !== 0 || result.timedOut) throw Error(`${args[0]} failed: ${result.output.slice(-1500)}`);
  return result;
};
try {
  before = await backend.usage();
  if (!Number.isFinite(before.balance) || before.balance < units) throw Error('Unreadable/insufficient balance');
  event({ phase: 'before', usage: before, units, minutes, gpu });
  const { session } = await backend.ensureUp({ approved: true, onEvent: event });
  allocated = await backend.usage();
  event({ phase: 'allocated', usage: allocated, session });
  // Conservative aggregate-rate cap for the G4/L4 experiment campaign.
  if (!(allocated.ratePerHour <= 20.88 + 0.01)) throw Error('Unexpected rate; stop to reprice');
  const probe = resolve('colab/benchmark_probe.py');
  const probed = await step(argvExec({ session, file: basename(probe), timeout: 30 }), { cwd: dirname(probe), wallMs: 60000, silenceMs: 60000 });
  if (!probed.output.includes('COMFYRIZZ_OK probe')) throw Error('Kernel probe failed');
  await step(argvUpload({ session, localPath: input, remotePath: '/content/comfyrizz-benchmark-input.zip' }));
  if (process.argv.includes('--graphics')) {
    const boot = await backend.bootstrap({ signal: abort.signal, onEvent: e => { if (e.type !== 'bootstrap_log') event(e); } });
    if (boot.lost) throw Error('Bootstrap lost');
  }
  const remaining = Math.floor(minutes * 60 - (Date.now() - started) / 1000 - 90);
  if (remaining < 60) throw Error('Insufficient remaining trial time');
  const result = await step(argvExec({ session, file: basename(worker), timeout: remaining }), {
    cwd: dirname(worker), wallMs: remaining * 1000 + 20000, silenceMs: remaining * 1000,
    onLog: text => { for (const line of text.split('\n')) if (line.startsWith('BENCH ')) console.log(line); },
  });
  // Collect partial evidence even if a remote Python exception was printed with CLI exit 0.
  await step(argvDownload({ session, remotePath: '/content/comfyrizz-benchmark-output.zip', localPath: join(out, 'output.zip') }));
  if (!result.output.includes('COMFYRIZZ_OK benchmark')) throw Error(`Worker incomplete: ${result.output.slice(-1500)}`);
  if (process.argv.includes('--transfer-bench')) {
    const remote = '/content/comfyrizz-benchmark';
    const manifestPath = join(out, 'transfer-manifest.json');
    await step(argvDownload({ session, remotePath: `${remote}/transfer-manifest.json`, localPath: manifestPath }));
    const files = JSON.parse(readFileSync(manifestPath));
    if (!files.length || files.some(f => basename(f.name) !== f.name)) throw Error('Invalid transfer manifest');
    const transfer = async (mode, label) => {
      const dir = join(out, label); mkdirSync(dir, { recursive: true });
      const start = Date.now();
      if (mode === 'zip') {
        await step(argvDownload({ session, remotePath: `${remote}/transfer.zip`, localPath: join(dir, 'transfer.zip') }));
        execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', join(dir, 'transfer.zip'), dir]);
      } else {
        const queue = [...files];
        const errors = [];
        await Promise.all(Array.from({ length: mode === 'parallel4' ? 4 : 1 }, async () => {
          while (queue.length && !errors.length) {
            const file = queue.shift();
            try { await step(argvDownload({ session, remotePath: `${remote}/transfer/${file.name}`, localPath: join(dir, file.name) })); }
            catch (e) { errors.push(e); }
          }
        }));
        if (errors.length) throw errors[0];
      }
      for (const file of files) {
        const data = readFileSync(join(dir, file.name));
        if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw Error('Transfer hash mismatch');
      }
      const report = { phase: 'transfer_trial', mode, label, seconds: (Date.now() - start) / 1000,
        files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), hashesVerified: true };
      event(report); return report;
    };
    let n = 0;
    for (const mode of ['serial', 'parallel4', 'zip', 'zip', 'parallel4', 'serial']) await transfer(mode, `transfer-${n++}-${mode}`);
    const generation = async () => {
      const worker = resolve('colab/graphics_overlap_worker.py');
      const r = await step(argvExec({ session, file: basename(worker), timeout: 300 }), { cwd: dirname(worker), wallMs: 330000, silenceMs: 330000 });
      if (!r.output.includes('COMFYRIZZ_OK overlap')) throw Error('Overlap generation failed');
    };
    for (const overlap of [false, true]) {
      const start = Date.now();
      if (overlap) {
        const results = await Promise.allSettled([generation(), transfer('serial', 'overlap-transfer')]);
        if (results.some(r => r.status === 'rejected')) throw Error('Overlap trial failed');
      } else {
        await generation(); await transfer('serial', 'sequential-transfer');
      }
      event({ phase: 'overlap_trial', overlap, seconds: (Date.now() - start) / 1000 });
    }
  }
} catch (e) { error = e.message; event({ phase: 'error', error }); }
finally {
  try { stopped = await backend.teardown('Efficiency experiment complete'); } catch (e) { stopped = { state: 'stop_unconfirmed', error: e.message }; }
  try { after = await backend.usage(); } catch (e) { after = { error: e.message }; }
  const report = { id, gpu, unitsCeiling: units, watchdogMinutes: minutes, before, allocated, after, stopped, error,
    lifecycleSeconds: (Date.now() - started) / 1000,
    accountDelta: Number.isFinite(before?.balance) && Number.isFinite(after?.balance) ? +(before.balance - after.balance).toFixed(2) : null,
    accountingNote: 'Account delta may include concurrent trials; do not sum overlapping deltas.' };
  writeFileSync(join(out, 'run.json'), JSON.stringify(report, null, 2));
  event({ phase: 'finished', ...report });
  if (error || stopped?.state !== 'stopped') process.exitCode = 1;
}
