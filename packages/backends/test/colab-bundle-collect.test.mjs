// CPU-only acceptance of the twelve-job transport shape. The fake CLI executes
// the actual generated packer; local extraction consumes real ZIP bytes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createColabBackend } from '../src/colab-backend.mjs';
import { assessBudget, nextJobUpperEstimate } from '../src/budget.mjs';
import { planJobs } from '../../jobs/src/index.mjs';
import { installFakeColab, makeCli, readLog } from './helpers.mjs';
import { KLEIN_SHA, KLEIN_WORKFLOW, mockCapture, mockOutput } from './mock-generation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const python = process.env.COMFYRIZZ_PYTHON || 'python3';
const remote = '/content/comfyrizz';
const ltxWorkflow = 'workflows/ltx25_i2v_2stage.api.json';
const ltxGraph = readFileSync(new URL(`../../../${ltxWorkflow}`, import.meta.url));

function workspace(t, options = {}) {
  const root = mkdtempSync(join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'colab-bulk-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url)));
  pkg.id = 'pkg_bulkcollect';
  pkg.assets = {};
  pkg.scenes = Array.from({ length: 6 }, (_, i) => ({
    id: `s_bulk${i}`, layout: 'hero', variant: 'full-bleed', preferredFrames: 240,
    copy: { headline: `Shot ${i}` }, background: { asset: `a_video${i}`, fit: 'cover' },
    foreground: [{ asset: `a_image${i}`, x: .7, y: .5, w: .28, anim: 'fade-in' }],
    transitionOut: { type: 'cut', frames: 0 },
  }));
  for (let i = 0; i < 6; i++) {
    pkg.assets[`a_image${i}`] = {
      kind: 'image', origin: 'generated', status: 'pending', model_license: { id: 'FLUX.3-Image-Klein' },
      gen: { generator: 'flux3-klein', workflow: KLEIN_WORKFLOW, workflow_sha256: KLEIN_SHA, model: 'flux-3-image-klein',
        inputs: { prompt: `Reference ${i}`, width: 960, height: 544, seed: i, steps: 16 } },
    };
    pkg.assets[`a_video${i}`] = {
      kind: 'video', origin: 'generated', status: 'pending', model_license: { id: 'LTX-2.x-Community' },
      gen: { generator: 'ltx25', workflow: ltxWorkflow, workflow_sha256: sha(ltxGraph), model: 'ltx-2.5-22b-distilled',
        inputs: { prompt: `Shot ${i}`, image: `a_image${i}`, width: 960, height: 544, frames: 193, fps: 24, seed: i, stage2_seed: i + 10 } },
    };
  }
  const doc = planJobs(pkg);
  assert.equal(doc.jobs.length, 12);
  const files = [], names = [];
  const manifest = { v: 1, packageId: pkg.id, jobsHash: doc.hash, run_id: 'run_bulk', complete: true, counts: { succeeded: 12 }, jobs: [] };
  for (const job of doc.jobs) {
    const content = `TEST-ONLY-${job.id}`;
    const capture = job.kind === 'still' ? mockCapture(job) : { relative: job.output.replace(/\.[^/.]+$/, '.workflow.api.json'), content: ltxGraph.toString() };
    const output = mockOutput(job, content);
    if (job.kind !== 'still') Object.assign(output.measured, { fps: 24, durationSeconds: 193 / 24, frames: 193 });
    manifest.jobs.push({ job: job.id, status: 'succeeded', job_id: `comfy-${job.id}`, attempt_id: `${job.id}_01`, outputs: [output] });
    files.push({ path: `${remote}/out/${job.output}`, content }, { path: `${remote}/out/${capture.relative}`, content: capture.content },
      { path: `${remote}/out/attempts/${job.id}_01.json`, content: JSON.stringify({ job: job.id, status: 'succeeded' }) });
    names.push(job.output, capture.relative);
  }
  files.push({ path: `${remote}/out/manifest.json`, content: JSON.stringify(manifest) });
  const stillManifest = { ...manifest, counts: { succeeded: 6 }, jobs: manifest.jobs.filter(entry => entry.job.endsWith('.still')) };
  const stillNames = new Set(doc.jobs.filter(job => job.kind === 'still').flatMap(job => [job.output, job.output.replace(/\.[^/.]+$/, '.workflow.api.json'), `attempts/${job.id}_01.json`]));
  const stillFiles = files.filter(file => stillNames.has(file.path.slice(`${remote}/out/`.length)));
  stillFiles.push({ path: `${remote}/out/manifest.json`, content: JSON.stringify(stillManifest) });
  const fake = installFakeColab(root, { state: { scripts: { 'run_jobs.py': [{ files: stillFiles }, { files }] } } });
  const cli = makeCli(fake);
  const scratchDir = join(root, 'scratch');
  const backend = createColabBackend({ cli, packageId: pkg.id, scratchDir, budgetUnits: 100, watchdogMinutes: 0, collectionRetryMs: 0, teardownRetryMs: 0, pythonBin: python, ...options });
  delete backend.bootstrap;
  backend.health = async () => ({ ok: true });
  const run = opts => backend.runPackage(pkg, { workDir: join(root, 'work'), outDir: join(root, 'out'), approved: true, gateCommand: null, ...opts });
  const seed = () => { for (const file of files) { const path = join(root, 'remote', file.path.slice(remote.length)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.content); } };
  return { root, pkg, doc, files, names, manifest, fake, cli, backend, scratchDir, run, seed };
}

function changeFake(ws, mutate) {
  const state = JSON.parse(readFileSync(ws.fake.statePath));
  mutate(state);
  writeFileSync(ws.fake.statePath, JSON.stringify(state));
}
const calls = ws => readLog(ws.fake.logPath);
const scriptCount = (ws, name) => calls(ws).filter(call => call.argv[0] === 'exec' && call.argv.includes(name)).length;
const noPartials = ws => assert.deepEqual(readdirSync(ws.scratchDir).filter(name => name.startsWith('collection-')), []);

test('six images + six videos + actual captures collect in six CLI calls across two batches at the exact 2.472-credit quote', async t => {
  let clock = 100000;
  const next = nextJobUpperEstimate({ gpuMinutes: 3.9, overheadMinutes: 4, ratePerHour: 8.9 });
  const quote = assessBudget({ budgetUnits: 100, nextJobUpperEstimate: next, ratePerHour: 8.9 });
  assert.equal(quote.required, 2.472);
  const ws = workspace(t, { budgetUnits: quote.required, now: () => clock });
  ws.backend.state.committedEstimate = next - nextJobUpperEstimate({ gpuMinutes: 3.9, ratePerHour: 8.9 });
  const result = await ws.run({ onEvent: event => { if (event.type === 'collection_attempt') clock += 2200; } });
  assert.equal(result.ok, true, JSON.stringify(result.verification));
  assert.equal(result.generationReceipts.length, 12);
  assert.equal(result.applied.length, 12);
  assert.equal(result.teardown.state, 'stopped');
  assert.equal(ws.backend.state.lastAdmission.decision.required, quote.required);
  assert.deepEqual(ws.backend.state.collectionAttempts.map(a => a.operation), ['list-out', 'bundle-out', 'download', 'list-out', 'bundle-out', 'download']);
  assert.equal(ws.backend.state.collectionSpentMs, 13200, '56 serial connections at this latency would exceed 120 seconds');
  assert.equal(scriptCount(ws, 'run_jobs.py'), 2, 'one invocation per approved batch');
  assert.equal(scriptCount(ws, 'reconcile.py'), 0);
  for (const name of ws.names) assert.ok(existsSync(join(ws.scratchDir, 'out', name)));
  const before = calls(ws).length;
  const named = await ws.backend.downloadListed(ws.names, join(ws.root, 'named'));
  assert.equal(named.fetched.length, 24);
  assert.deepEqual(named.problems, []);
  assert.equal(calls(ws).length, before, 'named provenance/media collection reuses hash-verified local bytes');
  for (const name of ws.names) assert.deepEqual(readFileSync(join(ws.root, 'named', name)), readFileSync(join(ws.scratchDir, 'out', name)));
  noPartials(ws);
});

test('a timed-out partial bundle transfer retains time for one fresh download on the same VM at the exact quote', async t => {
  let clock = 100000;
  const ws = workspace(t, { budgetUnits: 2.472, now: () => clock });
  ws.backend.state.committedEstimate = .801;
  changeFake(ws, state => { state.downloadFailures = { [`${remote}/collection.zip`]: [{ output: 'ReadTimeout: timed out', partial: 'torn zip' }] }; });
  const original = ws.cli.run.bind(ws.cli);
  ws.cli.run = async (args, opts) => {
    const result = await original(args, opts);
    if (args[0] === 'download' && args[3] === `${remote}/collection.zip`) {
      assert.ok(opts.wallMs > 0 && opts.wallMs <= 60000);
      if (result.code !== 0) { clock += 60000; result.timedOut = true; }
    }
    return result;
  };
  const result = await ws.run();
  assert.equal(result.ok, true);
  assert.equal(result.generationReceipts.length, 12);
  assert.deepEqual(ws.backend.state.collectionAttempts.map(a => a.operation), ['list-out', 'bundle-out', 'download', 'download', 'list-out', 'bundle-out', 'download']);
  assert.equal(scriptCount(ws, 'run_jobs.py'), 2);
  assert.equal(scriptCount(ws, 'collection-bundle.py'), 2);
  assert.equal(scriptCount(ws, 'reconcile.py'), 0);
  assert.equal(calls(ws).filter(c => c.argv[0] === 'new').length, 1);
  assert.ok(calls(ws).filter(c => ['exec', 'download'].includes(c.argv[0])).every(c => c.argv[2] === ws.backend.state.session));
  noPartials(ws);
});

test('a lost CPU pack reconnects without replaying either approved inference batch', async t => {
  const ws = workspace(t);
  changeFake(ws, state => { state.scripts['collection-bundle.py'] = [{ noSentinel: true, code: 1, output: 'RuntimeError: Connection was lost.' }, {}]; });
  const result = await ws.run();
  assert.equal(result.ok, true);
  assert.equal(result.generationReceipts.length, 12);
  assert.equal(scriptCount(ws, 'run_jobs.py'), 2);
  assert.equal(scriptCount(ws, 'collection-bundle.py'), 3);
  assert.equal(scriptCount(ws, 'reconcile.py'), 0);
  assert.equal(calls(ws).filter(c => c.argv[0] === 'new').length, 1);
});

test('named collection rehashes cached bytes and repairs a changed file through the normal single-file path', async t => {
  const ws = workspace(t); ws.seed();
  assert.equal((await ws.backend.collectOut()).ok, true);
  const file = join(ws.scratchDir, 'out', ws.names[0]);
  const expected = readFileSync(file);
  writeFileSync(file, 'corrupted cache');
  const before = calls(ws).length;
  const named = await ws.backend.downloadListed(ws.names, join(ws.scratchDir, 'out'));
  assert.deepEqual(named.problems, []);
  assert.equal(named.fetched.length, 24);
  assert.deepEqual(calls(ws).slice(before).map(c => c.argv[0]), ['download']);
  assert.deepEqual(readFileSync(file), expected);
});

test('manifest-only then named media/captures uses two bundles, with no duplicate file transfers', async t => {
  const ws = workspace(t); ws.seed();
  ws.backend.setCollectPolicy('manifest');
  const metadata = await ws.backend.collectOut();
  assert.equal(metadata.fetched, 13);
  assert.equal(existsSync(join(ws.scratchDir, 'out', ws.names[0])), false);
  const named = await ws.backend.downloadListed(ws.names, join(ws.scratchDir, 'out'));
  assert.equal(named.fetched.length, 24);
  assert.deepEqual(named.problems, []);
  assert.equal((await ws.backend.verify(ws.manifest, join(ws.scratchDir, 'out'))).verified, true);
  assert.equal(ws.backend.state.collectionAttempts.length, 6);
  assert.equal(calls(ws).filter(c => c.argv[0] === 'download').length, 2);
  assert.equal(scriptCount(ws, 'run_jobs.py'), 0);
});

test('real CPU packing/extraction verifies a 60 MiB twelve-output payload within the unchanged collection window', async t => {
  const ws = workspace(t, { budgetUnits: 2.472 }); ws.seed();
  ws.backend.state.startedAtMs = Date.now();
  ws.backend.state.committedEstimate = 1.582;
  let bytes = 0;
  for (const entry of ws.manifest.jobs) {
    const output = entry.outputs[0];
    const content = Buffer.alloc((entry.job.endsWith('.still') ? 1 : 9) * 1024 * 1024, 73);
    output.bytes = content.length; output.sha256 = sha(content); bytes += content.length;
    writeFileSync(join(ws.root, 'remote', 'out', output.relative), content);
  }
  writeFileSync(join(ws.root, 'remote', 'out', 'manifest.json'), JSON.stringify(ws.manifest));
  const start = Date.now();
  const result = await ws.backend.collectOut();
  assert.equal(result.ok, true, result.problems.join(';'));
  assert.equal((await ws.backend.verify(ws.manifest, result.local)).verified, true);
  assert.equal(ws.backend.state.collectionAttempts.length, 3);
  assert.ok(ws.backend.state.collectionSpentMs < 120000);
  assert.equal(scriptCount(ws, 'run_jobs.py'), 0);
  t.diagnostic(`${bytes} synthetic media bytes + 12 captured graphs, CPU pack/copy/extract/verification: ${Date.now() - start} ms (fake CLI; not network throughput)`);
  noPartials(ws);
});

test('a missing captured workflow fails closed before any generation receipt or import', async t => {
  const ws = workspace(t);
  changeFake(ws, state => { for (const batch of state.scripts['run_jobs.py']) batch.files = batch.files.filter(file => file.path !== `${remote}/out/${ws.names[1]}`); });
  await assert.rejects(ws.run(), error => {
    assert.match(error.message, /captured workflow.*was not collected/);
    assert.equal(error.runPackage.teardown.state, 'stopped');
    assert.equal(error.runPackage.generationReceipts?.length || 0, 0);
    assert.equal(error.runPackage.applied?.length || 0, 0);
    return true;
  });
  assert.equal(ws.backend.state.collectionAttempts.length, 3);
  assert.equal(scriptCount(ws, 'run_jobs.py'), 1);
  noPartials(ws);
});

test('manifest hash mismatches never mint receipts or import corrupted media, including after fresh bulk retries', async t => {
  const ws = workspace(t);
  changeFake(ws, state => {
    for (const batch of state.scripts['run_jobs.py']) {
      const file = batch.files.find(file => file.path.endsWith('/manifest.json'));
      const manifest = JSON.parse(file.content);
      for (const job of manifest.jobs) job.outputs[0].sha256 = '0'.repeat(64);
      file.content = JSON.stringify(manifest);
    }
  });
  const result = await ws.run();
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.generationReceipts?.length || 0, 0);
  assert.equal(result.verification.attempts, 2);
  assert.match(result.verification.problems.join(';'), /sha256/);
  assert.equal(scriptCount(ws, 'run_jobs.py'), 2);
  assert.equal(scriptCount(ws, 'collection-bundle.py'), 4);
  assert.equal(result.teardown.state, 'stopped');
  noPartials(ws);
});

for (const mode of ['cancel', 'deadline']) {
  test(`${mode} after transfer discards staging and preserves earlier local evidence and teardown reserve`, async t => {
    let clock = 100000;
    const ws = workspace(t, { now: () => clock, budgetUnits: 2.472 });
    const controller = new AbortController();
    const prior = join(ws.scratchDir, 'out', 'previous-evidence.txt');
    mkdirSync(dirname(prior), { recursive: true }); writeFileSync(prior, 'retain me');
    await assert.rejects(ws.run({ signal: controller.signal, onEvent: event => {
      if (event.type === 'collection_attempt' && event.operation === 'download') {
        if (mode === 'cancel') controller.abort(new Error('cancel bulk transfer'));
        else clock += 120000;
      }
    } }), error => {
      assert.match(error.message, mode === 'cancel' ? /cancel bulk/ : /deadline\/budget/);
      assert.equal(error.runPackage.teardown.state, 'stopped');
      return true;
    });
    assert.equal(readFileSync(prior, 'utf8'), 'retain me');
    assert.equal(existsSync(join(ws.scratchDir, 'out', 'manifest.json')), false);
    assert.equal(ws.backend.state.collectionAttempts.length, 3);
    assert.equal(scriptCount(ws, 'run_jobs.py'), 1);
    noPartials(ws);
  });
}

for (const mode of ['cancel', 'deadline']) {
  test(`${mode} during the local extractor kills its process and cleans all partial staging`, async t => {
    let clock = 100000;
    const ws = workspace(t, { now: () => clock }); ws.seed();
    const wrapper = join(ws.root, 'slow-python');
    // A CPU-only process fixture: stall before executing the real extractor. Its pid
    // proves that cancellation/deadline waits for process exit before deleting staging.
    const pidFile = join(ws.root, 'extractor.pid');
    const actualPython = spawnSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(wrapper, `#!${actualPython}\nimport os, sys, time\nopen(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()))\ntime.sleep(10)\nos.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n`, { mode: 0o755 });
    const backend = createColabBackend({ cli: ws.cli, packageId: ws.pkg.id, scratchDir: ws.scratchDir, budgetUnits: 100, now: () => clock, pythonBin: wrapper, watchdogMinutes: 0 });
    const controller = new AbortController();
    const abortTimer = mode === 'cancel' ? setInterval(() => { if (existsSync(pidFile)) controller.abort(new Error('cancel extractor')); }, 10) : null;
    try {
      const promise = backend.collectOut({ signal: controller.signal, onEvent: event => {
        if (mode === 'deadline' && event.type === 'collection_attempt' && event.operation === 'download') clock += 119000;
      } });
      if (mode === 'cancel') await assert.rejects(promise, /cancel extractor/);
      else {
        const result = await promise;
        assert.equal(result.transferFailed, true);
        assert.match(result.problems.join(';'), /extraction deadline/);
      }
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal(existsSync(join(ws.scratchDir, 'out', 'manifest.json')), false);
      noPartials(ws);
    } finally { if (abortTimer) clearInterval(abortTimer); }
  });
}

function corruptBundle(ws, mode) {
  const original = ws.cli.run.bind(ws.cli);
  ws.cli.run = async (args, opts) => {
    const result = await original(args, opts);
    if (args.includes('collection-bundle.py')) {
      const archive = join(ws.root, 'remote', 'collection.zip');
      const altered = spawnSync(python, ['-c', String.raw`
import sys, zipfile, pathlib, stat
p, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
with zipfile.ZipFile(p) as z:
    items = [(i, z.read(i)) for i in z.infolist()]
if mode == 'traversal': items[0][0].filename = '../escape'
if mode == 'absolute': items[0][0].filename = '/tmp/escape'
if mode == 'duplicate': items[0][0].filename = items[1][0].filename
if mode == 'symlink': items[0][0].external_attr = (stat.S_IFLNK | 0o777) << 16
if mode == 'oversize': items[0] = (items[0][0], items[0][1] + b'oversize')
if mode == 'compressed': items[0][0].compress_type = zipfile.ZIP_DEFLATED
with zipfile.ZipFile(p, 'w') as z:
    for info, content in items: z.writestr(info, content)
`, archive, mode], { encoding: 'utf8' });
      assert.equal(altered.status, 0, altered.stderr);
      if (mode !== 'hash') {
        const bytes = readFileSync(archive);
        result.output = result.output.replace(/^COLLECTION_BUNDLE .*$/m, `COLLECTION_BUNDLE ${JSON.stringify({ bytes: bytes.length, sha256: sha(bytes) })}`);
      } else {
        const bytes = readFileSync(archive); bytes[40] ^= 1; writeFileSync(archive, bytes);
      }
    }
    return result;
  };
}

for (const mode of ['traversal', 'absolute', 'duplicate', 'symlink', 'oversize', 'compressed', 'hash']) {
  test(`real ZIP extraction rejects ${mode} before publishing or falling back to per-file downloads`, async t => {
    const ws = workspace(t); ws.seed(); corruptBundle(ws, mode);
    const result = await ws.backend.collectOut();
    assert.equal(result.transferFailed, true);
    assert.match(result.problems.join(';'), /collection (archive|extraction)/);
    assert.equal(result.manifest, null);
    assert.equal(existsSync(join(ws.scratchDir, 'out', ws.names[0])), false);
    assert.equal(ws.backend.state.collectionAttempts.length, 3);
    noPartials(ws);
  });
}

test('oversized inventory is refused before pack/download; local and remote symlinks are never followed', async t => {
  for (const mode of ['inventory', 'remote', 'local']) {
    await t.test(mode, async t => {
      const ws = workspace(t); ws.seed();
      const target = join(ws.root, 'untouched'); writeFileSync(target, 'TEST');
      if (mode === 'inventory') changeFake(ws, state => { state.scripts['list_out.py'] = { walk: null, output: ws.names.map(path => JSON.stringify({ path, bytes: 1024 ** 3 })).join('\n') }; });
      if (mode === 'remote') {
        const file = join(ws.root, 'remote', 'out', ws.names[0]); rmSync(file); symlinkSync(target, file);
      }
      if (mode === 'local') {
        const file = join(ws.scratchDir, 'out', ws.names[0]); mkdirSync(dirname(file), { recursive: true }); symlinkSync(target, file);
      }
      const result = await ws.backend.collectOut();
      assert.equal(result.transferFailed, true);
      assert.equal(readFileSync(target, 'utf8'), 'TEST');
      assert.equal(ws.backend.state.collectionAttempts.length, mode === 'inventory' ? 1 : mode === 'remote' ? 2 : 3);
      noPartials(ws);
    });
  }
});
