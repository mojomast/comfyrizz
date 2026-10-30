// Real Qwen narration with the existing Colab ownership registry/watchdog/verified teardown.
// --dry-run validates and archives the exact CPU inputs without allocating a runtime.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../../packages/sources/dist/src/index.js';
import { validatePackage } from '../../packages/schema/src/index.mjs';
import { ColabCli } from '../../packages/backends/src/cli.mjs';
import { createColabBackend } from '../../packages/backends/src/colab-backend.mjs';
import { argvExec, argvUpload, argvDownload, sessionNameFor } from '../../packages/backends/src/colab-plan.mjs';
import { sessionUsageAccounting } from '../../packages/backends/src/session-accounting.mjs';
import { progressLines } from '../../packages/backends/src/progress-lines.mjs';
import { resolveRatePerHour, reserveUnitsFor, spendingMinutes } from '../../packages/backends/src/budget.mjs';

const flag = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function runQwenColab({ packagePath, out, units = 4, qaOnly = false, dryRun = false, signal,
  accountingMode = 'owner-account', runId, onEvent = () => {} },
  { cliFactory = options => new ColabCli(options), backendFactory = createColabBackend } = {}) {
// Server-owned invocation options only; package/model output cannot opt out of
// the sequential owner's balance comparison. The standalone CLI keeps it too.
if (!['owner-account', 'invite-reserved'].includes(accountingMode)) throw new TypeError('Unknown Qwen accounting mode');
const inviteAccounting = accountingMode === 'invite-reserved';
if (inviteAccounting && (typeof runId !== 'string' || !runId)) throw new TypeError('Invite Qwen accounting requires a run identity');
packagePath = resolve(packagePath); out = resolve(out);
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
entries.push({ path: 'task.json', data: JSON.stringify({ qaOnly }) });
if (qaOnly) {
  const audioDir = join(dirname(packagePath), 'audio');
  const addAudio = (dir, prefix = 'audio') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) addAudio(join(dir, entry.name), `${prefix}/${entry.name}`);
      else if (entry.isFile() && /\.(wav|json)$/.test(entry.name)) entries.push({ path: `${prefix}/${entry.name}`, data: readFileSync(join(dir, entry.name)) });
    }
  };
  addAudio(audioDir);
}
writeFileSync(input, createZip(entries));
// PO-3: the rate and the teardown reserve were written into this formula as 8.9 and 0.3. Both now come
// from the backend budget module, so a changed Colab rate moves the Qwen watchdog and the media deadline
// together instead of only one of them.
const ratePerHour = resolveRatePerHour();
const watchdogMinutes = spendingMinutes(units, ratePerHour);
if (watchdogMinutes * 60 <= 60) throw Error('Qwen budget cannot cover execution and the shutdown reserve');
onEvent({ event: 'qwen_plan', dryRun, scenes: pkg.scenes.length, unitsCeiling: units, watchdogMinutes, ratePerHour, reserveUnits: reserveUnitsFor(ratePerHour) });
if (!dryRun) {
  const lines = progressLines(onEvent, message => onEvent({ event: 'diagnostic', message }));
  const cli = cliFactory({ bin: process.env.COMFYRIZZ_COLAB_BIN || join(process.env.HOME, '.local/bin/colab'), logDir: join(out, 'logs'), onLog: text => lines.write(text) });
  const backend = backendFactory({ cli, packageId: `${pkg.id}_qwen`, scratchDir: join(out, 'scratch'), logDir: join(out, 'logs'),
    budgetUnits: units, ratePerHour, watchdogMinutes, wallClockCapMinutes: watchdogMinutes });
  let session = sessionNameFor(`${pkg.id}_qwen`);
  let before, after, stopped, failure;
  const step = async (args, options = {}) => {
    signal?.throwIfAborted();
    const r = await cli.run(args, { wallMs: 180000, silenceMs: 180000, signal, ...options });
    signal?.throwIfAborted();
    if (r.code !== 0 || r.timedOut) throw Error(`Colab step failed: ${args[0]}: ${r.output.slice(-1000)}`);
    return r;
  };
  try {
    signal?.throwIfAborted();
    onEvent({ event: 'qwen_phase', phase: 'allocating' });
    before = await backend.usage();
    if (!Number.isFinite(before.balance) || before.balance < units) throw Error('Insufficient or unreadable balance');
    session = (await backend.ensureUp({ approved: true, signal })).session;
    onEvent({ event: 'qwen_phase', phase: 'uploading' });
    await step(argvUpload({ session, localPath: input, remotePath: '/content/comfyrizz-qwen-input.zip' }));
    onEvent({ event: 'qwen_phase', phase: 'bootstrapping' });
    const r = await step(argvExec({ session, file: 'qwen_narrate.py', timeout: watchdogMinutes * 60 - 60 }), { cwd: join(root, 'colab'), wallMs: watchdogMinutes * 60000, silenceMs: watchdogMinutes * 60000 });
    onEvent({ event: 'qwen_phase', phase: 'collecting' });
    try {
      await step(argvDownload({ session, remotePath: '/content/comfyrizz-qwen-output.zip', localPath: join(out, 'audio.zip') }));
    } catch (error) {
      if (!r.output.includes('COMFYRIZZ_OK qwen-narrate')) throw Error(`Qwen worker failed before collection: ${r.output.slice(-3000)}`);
      throw error;
    }
    if (!r.output.includes('COMFYRIZZ_OK qwen-narrate')) throw Error(`Qwen worker did not finish: ${r.output.slice(-2000)}`);
  } catch (e) { failure = e; }
  finally {
    onEvent({ event: 'qwen_phase', phase: 'stopping' });
    try { stopped = await backend.teardown('Qwen narration finished'); }
    catch (error) { stopped = { state: 'stop_unconfirmed', evidence: error.message }; }
    try { after = await backend.usage(); } catch { after = { balance: null }; }
    const accountBalanceDeltaUnits = Number.isFinite(before?.balance) && Number.isFinite(after.balance) ? Number((before.balance - after.balance).toFixed(2)) : null;
    const shutdownVerified = stopped.state === 'stopped' || (stopped.state === 'not_owned' && stopped.shutdownVerified === true);
    const noAllocation = shutdownVerified && stopped.allocation === 'not_attempted';
    const spent = noAllocation ? 0 : inviteAccounting ? null : accountBalanceDeltaUnits;
    const costSource = noAllocation ? 'verified_no_allocation' : inviteAccounting ? 'account_balance_delta_unattributed' : 'account_balance_delta';
    const accounting = inviteAccounting ? sessionUsageAccounting({ runId, budget: { ceilingUnits: units, narrationCeilingUnits: units },
      runtimes: { narration: { runId, session, ownership: 'managed', state: shutdownVerified ? 'stopped' : 'stop_unconfirmed',
        shutdownVerified, allocation: noAllocation ? 'not_attempted' : 'attempted_or_unknown', spentUnits: spent, costSource,
        ...(stopped.usageReceipt ? { usageReceipt: stopped.usageReceipt } : {}) } } })
      : { status: 'estimated', actualSpendCu: noAllocation ? 0 : null, costSource, shutdownVerified };
    writeFileSync(join(out, 'run.json'), JSON.stringify({ before, after, stopped, spent, accountBalanceDeltaUnits,
      accountingMode, runId, session, accounting, unitsCeiling: units, error: failure?.message ?? null }, null, 2));
    lines.end();
    onEvent({ event: 'qwen_finished', teardown: stopped, spentUnits: spent, accountBalanceDeltaUnits,
      costSource, accounting, unitsCeiling: units });
    if (!shutdownVerified) throw Error(`Runtime teardown ${stopped.state}`);
    if (!inviteAccounting && (spent === null || spent > units)) throw Error(`Run spend ${spent} exceeds ceiling ${units}`);
  }
  if (failure) throw failure;
  return JSON.parse(readFileSync(join(out, 'run.json')));
}
return { dryRun: true, input, unitsCeiling: units };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  process.on('SIGTERM', () => abort.abort());
  process.on('SIGINT', () => abort.abort());
  await runQwenColab({ packagePath: flag('--package', 'package.json'), out: flag('--out', 'qwen-out'), units: Number(flag('--units-ceiling', '4')), qaOnly: process.argv.includes('--qa-only'), dryRun: process.argv.includes('--dry-run'), signal: abort.signal, onEvent: event => console.log(JSON.stringify(event)) });
}
