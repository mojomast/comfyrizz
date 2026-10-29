// CPU-only recovery of a failed collection. Inputs are selected by a durable
// server run id, never uploaded media/metadata or caller-supplied filesystem paths.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { planJobs } from '../../../packages/jobs/src/plan.mjs';
import { applyManifestToPackage } from '../../../packages/jobs/src/apply.mjs';
import { verifyRecoveredGeneration, recordRecoveredGenerationReceipts } from '../../../packages/jobs/src/model-contribution.mjs';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status }); };

export function createDownloadedOutputRecovery({ runtimeDir, store, productionStore, completeRun, isBusy, publish }) {
  const runsDir = join(runtimeDir, 'runs');
  let activeId = null;
  const pending = new Map();
  function ownedRead(runId, relative) {
    if (!idPattern.test(runId)) fail('INVALID_RUN_ID', 'Invalid run id.', 400);
    const root = realpathSync(runsDir), path = realpathSync(join(runsDir, runId, relative));
    if (!path.startsWith(root + sep)) fail('RECOVERY_NOT_OWNED', 'Recovery requires server-owned run files.');
    const bytes = readFileSync(path);
    return { value: JSON.parse(bytes), sha256: hash(bytes) };
  }
  function inspect(runId, baseRevision) {
    let state, pkgDoc, jobs, manifest;
    try {
      state = ownedRead(runId, 'state.json'); pkgDoc = ownedRead(runId, 'work/package.json');
      jobs = ownedRead(runId, 'work/jobs.json'); manifest = ownedRead(runId, 'out/manifest.json');
    } catch (error) {
      if (error.code?.startsWith('RECOVERY_')) throw error;
      fail('RECOVERY_NOT_AVAILABLE', 'This run has no complete server-owned collection to recover.', 422);
    }
    const old = state.value, pkg = pkgDoc.value;
    if (old.schema !== 'comfyrizz.run-record/v1' || old.runId !== runId || old.status !== 'failed' || old.finished !== true
      || old.teardown?.state !== 'stopped' || !old.settlement || old.render
      || old.packageId !== pkg.id || jobs.value.packageId !== pkg.id || jobs.value.revision !== pkg.revision)
      fail('RECOVERY_NOT_AVAILABLE', 'Recovery requires a finished, settled failed run with confirmed shutdown.');
    const production = productionStore.read(old.productionId);
    const journal = productionStore.readEvents(old.productionId);
    const action = journal.filter(event => event.type === 'action.state_changed' && event.data?.id === old.actionId).at(-1)?.data;
    const approved = journal.some(event => event.type === 'plan.approved' && event.data?.planHash === old.actionPlanHash
      && event.data.packageRevision === pkg.revision);
    if (production?.packageId !== pkg.id || !approved || action?.runId !== runId || action?.state !== 'failed'
      || action.kind !== 'final' || action.planHash !== old.actionPlanHash || action.expected?.packageRevision !== pkg.revision)
      fail('RECOVERY_NOT_APPROVED', 'The failed run is not bound to the approved final package.');
    const current = store.read(pkg.id);
    if (!current || !isDeepStrictEqual(current, pkg) || (baseRevision !== undefined && baseRevision !== pkg.revision))
      fail('RECOVERY_STALE', 'The reviewed package changed. Recovery cannot replace a later revision.');
    if (planJobs(pkg).hash !== jobs.value.hash) fail('RECOVERY_EVIDENCE_INVALID', 'The staged jobs do not match the reviewed package.', 422);
    // Preserve the original staging's schema-valid backend spelling without
    // constructing a provider or guessing hardware from today's configuration.
    const backendTags = new Set(jobs.value.jobs.map(job => pkg.assets[job.asset]?.gen?.backend).filter(tag => /^colab:[A-Za-z0-9]+$/.test(tag ?? '')));
    const appliedBackendId = old.backendId === 'byo-comfyui' ? old.backendId : backendTags.size === 1 ? [...backendTags][0] : null;
    if (!appliedBackendId) fail('RECOVERY_NOT_AVAILABLE', 'The original staging does not identify its backend hardware.');
    return { old, pkg, jobsDoc: jobs.value, manifest: manifest.value,
      outputDir: join(runsDir, runId, 'out'), workDir: join(runsDir, runId, 'work'), backend: old.backendId, appliedBackendId,
      sourceHashes: { state: state.sha256, package: pkgDoc.sha256, jobs: jobs.sha256, manifest: manifest.sha256 } };
  }
  function persist(record, event) {
    const dir = join(runsDir, record.runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    record.events.push({ type: event, at: new Date().toISOString(), status: record.status });
    const path = join(dir, 'state.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    publish({ type: event, runId: record.runId, sourceRunId: record.sourceRunId, packageId: record.packageId, status: record.status });
  }
  async function execute(record, source) {
    try {
      // Validate all original outputs first. No source writes, no backend factory.
      verifyRecoveredGeneration(source);
      const outputDir = join(runsDir, record.runId, 'out');
      const sourceDir = join(runsDir, record.runId, 'source');
      mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
      for (const [name, relative] of Object.entries({ state: 'state.json', package: 'work/package.json', jobs: 'work/jobs.json', manifest: 'out/manifest.json' })) {
        const document = ownedRead(record.sourceRunId, relative);
        if (document.sha256 !== source.sourceHashes[name]) fail('RECOVERY_STALE', 'The original run evidence changed during verification.');
        // Preserve exact source bytes, not a serialized reconstruction.
        const bytes = readFileSync(join(runsDir, record.sourceRunId, relative));
        if (hash(bytes) !== document.sha256) fail('RECOVERY_STALE', 'The original run evidence changed during copying.');
        writeFileSync(join(sourceDir, `${name}.json`), bytes, { mode: 0o600, flag: 'wx' });
      }
      for (const entry of source.manifest.jobs) for (const output of entry.outputs) {
        for (const relative of [output.relative, output.workflow]) {
          const from = join(source.outputDir, relative);
          if (!existsSync(from)) continue; // missing captures stay missing; embedded source is explicit
          if (!realpathSync(from).startsWith(realpathSync(source.outputDir) + sep)) fail('RECOVERY_NOT_OWNED', 'Output escaped the owned collection.');
          const to = join(outputDir, relative);
          mkdirSync(dirname(to), { recursive: true, mode: 0o700 }); copyFileSync(from, to);
        }
      }
      // Validate the copied bytes again before minting receipts. Preserve original
      // manifest and staged jobs as operation evidence, not edited replacements.
      writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(source.manifest), { mode: 0o600 });
      const receipts = recordRecoveredGenerationReceipts({ ...source, outputDir, packageDir: outputDir,
        evidenceDir: join(runsDir, record.runId, 'captures'), recoveryId: record.runId });
      record.receipts = receipts.map(receipt => ({ outputSha256: receipt.outputSha256, captureSource: receipt.captureSource }));
      record.status = 'rendering'; persist(record, 'recovery.verified');
      // Recheck freshness after CPU verification and before the normal apply/CAS path.
      inspect(record.sourceRunId, record.baseRevision);
      const applied = applyManifestToPackage(source.pkg, { ...source, outDir: outputDir, backend: source.appliedBackendId });
      const completed = await completeRun({ pkg: source.pkg,
        result: { ...applied, ok: true, manifest: source.manifest, jobsDoc: source.jobsDoc, verification: { dir: outputDir } },
        record: { ...record, outputDir, strictSourcePackage: source.pkg } });
      Object.assign(record, completed, { status: 'completed', finished: true, finishedAt: new Date().toISOString() });
      persist(record, 'recovery.completed');
    } catch (error) {
      Object.assign(record, { status: 'failed', finished: true, finishedAt: new Date().toISOString(), error: error.message, errorCode: error.code ?? 'RECOVERY_FAILED' });
      persist(record, 'recovery.failed');
    } finally { activeId = null; pending.delete(record.runId); }
  }
  function start(runId, { baseRevision } = {}) {
    if (!Number.isSafeInteger(baseRevision)) fail('RECOVERY_REVISION_REQUIRED', 'Review the source package revision first.', 400);
    if (activeId || isBusy()) fail('RECOVERY_BUSY', 'Another operation is active.');
    const source = inspect(runId, baseRevision);
    const recoveryId = `recovery_${randomUUID()}`;
    const record = { schema: 'comfyrizz.output-recovery/v1', runId: recoveryId, sourceRunId: runId,
      packageId: source.pkg.id, productionId: source.old.productionId, backendId: source.backend,
      command: { type: 'recover_downloaded_outputs', id: randomUUID(), baseRevision, requestedAt: new Date().toISOString() },
      baseRevision, sourceHashes: source.sourceHashes, status: 'verifying', finished: false,
      allocation: 'none', additionalGenerationCredits: 0, render: null, events: [] };
    activeId = recoveryId; persist(record, 'recovery.requested');
    const done = Promise.resolve().then(() => execute(record, source));
    pending.set(recoveryId, done);
    return { runId: recoveryId, sourceRunId: runId, status: record.status };
  }
  return { inspect, start, active: () => activeId, wait: id => pending.get(id) ?? Promise.resolve() };
}

// A small supported UI for historical failed runs, including after server restart.
// Credentials remain in the authenticated page URL; no file/graph input is accepted.
export function recoveryPage(runId, revision) {
  return `<!doctype html><meta charset="utf-8"><title>Recover downloaded outputs</title>
<style>body{font:18px system-ui;max-width:760px;margin:8vh auto;padding:24px;background:#10151c;color:#eef2f8}button,a{font:inherit;padding:12px;color:inherit}button{background:#245c65;border:1px solid #73b9b3;border-radius:8px}pre{white-space:pre-wrap}</style>
<h1>Recover downloaded outputs</h1><p>Source run: ${runId}</p><p>Reviewed package revision: ${revision}</p>
<p>Verify the completed local media and original workflow metadata, apply it to this unchanged reviewed package, and render on CPU. Additional generation credits: 0. The earlier failed run and its settlement remain in history.</p>
<button id="recover">Recover downloaded outputs and render</button><pre id="status"></pre><a id="download" hidden>Download MP4</a>
<script>const token=new URL(location.href).searchParams.get('token');const status=document.getElementById('status');
const api=async(path,options={})=>{const r=await fetch(path,{...options,headers:{'content-type':'application/json','x-comfyrizz-token':token}});const j=await r.json();if(!r.ok)throw Error(j.error);return j};
document.getElementById('recover').onclick=async()=>{document.getElementById('recover').disabled=true;try{const started=await api('/api/run/${runId}/recovery',{method:'POST',body:JSON.stringify({baseRevision:${revision}})});status.textContent='Verifying downloaded media…';
const poll=async()=>{try{const {run}=await api('/api/run/'+started.runId);status.textContent=run.status+(run.error?' — '+run.error:'');if(run.render){const a=document.getElementById('download');a.href=run.render.url+'?token='+encodeURIComponent(token);a.hidden=false;}else if(!run.finished)setTimeout(poll,1000)}catch(e){status.textContent=e.message}};await poll();}catch(e){status.textContent=e.message;}};</script>`;
}
