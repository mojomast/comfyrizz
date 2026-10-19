// Real Qwen narration with the existing Colab ownership registry/watchdog/verified teardown.
// --dry-run validates and archives the exact CPU inputs without allocating a runtime.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../../packages/sources/dist/src/index.js';
import { validatePackage } from '../../packages/schema/src/index.mjs';
import { ColabCli } from '../../packages/backends/src/cli.mjs';
import { createColabBackend } from '../../packages/backends/src/colab-backend.mjs';
import { argvExec, argvUpload, argvDownload } from '../../packages/backends/src/colab-plan.mjs';

const flag = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packagePath = resolve(flag('--package', 'package.json'));
const out = resolve(flag('--out', 'qwen-out'));
const units = Number(flag('--units-ceiling', '4'));
if (!(units > 0 && units <= 4)) throw Error('Qwen test run ceiling must be in (0, 4] units');
const pkg = JSON.parse(readFileSync(packagePath));
const validation = validatePackage(pkg);
if (!validation.valid) throw Error(JSON.stringify(validation.errors));
if (pkg.voice?.engine !== 'qwen3-tts' || pkg.voice?.strict !== true) throw Error('Explicit strict Qwen voice selection required');
mkdirSync(out, { recursive: true });
const py = join(root, 'packages/tts/py');
const entries = readdirSync(py).filter(n => n.endsWith('.py') && !n.startsWith('test_')).map(n => ({ path: `py/${n}`, data: readFileSync(join(py, n)) }));
entries.push({ path: 'package.json', data: readFileSync(packagePath) }, { path: 'models.lock.json', data: readFileSync(join(root, 'colab/qwen-models.lock.json')) });
const input = join(out, 'input.zip');
writeFileSync(input, createZip(entries));
const watchdogMinutes = Math.max(1, Math.floor((units - 0.3) / 8.9 * 60));
console.log(JSON.stringify({ dryRun: process.argv.includes('--dry-run'), input, scenes: pkg.scenes.length, unitsCeiling: units, watchdogMinutes }));
if (!process.argv.includes('--dry-run')) {
  const cli = new ColabCli({ bin: join(process.env.HOME, '.local/bin/colab'), logDir: join(out, 'logs'), onLog: text => process.stdout.write(text) });
  const backend = createColabBackend({ cli, packageId: `${pkg.id}_qwen`, scratchDir: join(out, 'scratch'), logDir: join(out, 'logs'), budgetUnits: units, watchdogMinutes });
  let before, after, stopped, failure;
  const step = async (args, options = {}) => {
    const r = await cli.run(args, { wallMs: 180000, silenceMs: 180000, ...options });
    if (r.code !== 0 || r.timedOut) throw Error(`Colab step failed: ${args[0]}: ${r.output.slice(-1000)}`);
    return r;
  };
  try {
    before = await backend.usage();
    if (!Number.isFinite(before.balance) || before.balance < units) throw Error('Insufficient or unreadable balance');
    const session = (await backend.ensureUp({ approved: true })).session;
    await step(argvUpload({ session, localPath: input, remotePath: '/content/comfyrizz-qwen-input.zip' }));
    const r = await step(argvExec({ session, file: 'qwen_narrate.py', timeout: watchdogMinutes * 60 - 60 }), { cwd: join(root, 'colab'), wallMs: watchdogMinutes * 60000, silenceMs: watchdogMinutes * 60000 });
    await step(argvDownload({ session, remotePath: '/content/comfyrizz-qwen-output.zip', localPath: join(out, 'audio.zip') }));
    if (!r.output.includes('COMFYRIZZ_OK qwen-narrate')) throw Error(`Qwen worker did not finish: ${r.output.slice(-2000)}`);
  } catch (e) { failure = e; }
  finally {
    stopped = await backend.teardown('Qwen narration finished');
    after = await backend.usage();
    const spent = before && Number.isFinite(after.balance) ? Number((before.balance - after.balance).toFixed(2)) : null;
    writeFileSync(join(out, 'run.json'), JSON.stringify({ before, after, stopped, spent, unitsCeiling: units, error: failure?.message ?? null }, null, 2));
    if (stopped.state !== 'stopped') throw Error(`Runtime teardown ${stopped.state}`);
    if (spent === null || spent > units) throw Error(`Run spend ${spent} exceeds ceiling ${units}`);
  }
  if (failure) throw failure;
}
