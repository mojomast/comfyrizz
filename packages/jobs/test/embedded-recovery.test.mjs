import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contributionStore, recordGenerationReceipts, recordRecoveredGenerationReceipts, verifyRecoveredGeneration } from '../src/model-contribution.mjs';
import { recoveryFixture, hash } from './recovery-fixture.mjs';
import { canonical } from '../src/plan.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'embedded-recovery-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = recoveryFixture(join(root, 'original'));
  return { ...f, root, packageDir: join(root, 'recovery', 'out'), evidenceDir: join(root, 'recovery', 'captures'), recoveryId: 'recovery_01234567' };
}
test('embedded MP4 recovery preserves raw metadata, validates full graph and audits only LoadImage is_changed', t => {
  const f = fixture(t);
  const captures = verifyRecoveredGeneration(f);
  assert.equal(captures.length, 2);
  const original = readFileSync(join(f.outputDir, f.manifest.jobs[1].outputs[0].relative));
  const receipts = recordRecoveredGenerationReceipts(f);
  const video = receipts[1];
  assert.equal(video.captureSource, 'embedded-mp4');
  assert.deepEqual(video.recovery.normalization, [{ nodeId: '30', field: 'is_changed', value: [f.manifest.jobs[0].outputs[0].sha256] }]);
  assert.equal(hash(readFileSync(join(f.evidenceDir, video.recovery.source))), video.recovery.rawMetadataSha256);
  assert.equal(existsSync(join(f.outputDir, f.manifest.jobs[1].outputs[0].workflow)), false, 'no invented capture sidecar');
  assert.deepEqual(readFileSync(join(f.outputDir, f.manifest.jobs[1].outputs[0].relative)), original);
  assert.ok(existsSync(join(contributionStore(f.packageDir), `${video.outputSha256}.json`)));
  assert.equal(recordGenerationReceipts(f).length, 1, 'legacy recorder still rejects absent capture');
});
test('paired capture must equal embedded graph after only audited annotation removal', t => {
  const f = fixture(t), graph = structuredClone(f.graphs[1]); delete graph['30'].is_changed;
  const path = join(f.outputDir, f.manifest.jobs[1].outputs[0].workflow);
  writeFileSync(path, JSON.stringify(graph));
  assert.equal(verifyRecoveredGeneration(f)[1].receipt.recovery.pairedCaptureSha256, hash(readFileSync(path)));
  graph['5'].inputs.text = 'different capture'; writeFileSync(path, JSON.stringify(graph));
  assert.throws(() => recordRecoveredGenerationReceipts(f), /disagree/);
  assert.equal(existsSync(contributionStore(f.packageDir)), false);
});
test('historical LTX receipt-read pins cannot authorize recovery of an old pending job', t => {
  const f = fixture(t);
  f.jobsDoc.jobs[1].workflowSha256 = '97e205ad993996ac937a9a65ef7040973260bdc939041a23c3109184dc48c5e3';
  // Keep the run/plan identities internally consistent to reach workflow validation.
  f.jobsDoc.hash = hash(canonical({ ...f.jobsDoc, hash: undefined }));
  f.manifest.jobsHash = f.jobsDoc.hash;
  assert.throws(() => recordRecoveredGenerationReceipts(f), /pinned workflow mismatch/);
  assert.equal(existsSync(contributionStore(f.packageDir)), false);
  assert.equal(existsSync(f.evidenceDir), false);
});
test('internally consistent recovery cannot certify an unconnected Klein reference', t => {
  const f = fixture(t);
  f.jobsDoc.jobs[0].params._reference_3 = 'assets/unconnected.png';
  f.jobsDoc.hash = hash(canonical({ ...f.jobsDoc, hash: undefined }));
  f.manifest.jobsHash = f.jobsDoc.hash;
  assert.throws(() => recordRecoveredGenerationReceipts(f), /pinned workflow mismatch/);
  assert.equal(existsSync(contributionStore(f.packageDir)), false);
  assert.equal(existsSync(f.evidenceDir), false);
});
for (const [name, mutate] of Object.entries({
  'output hash mismatch': f => { f.manifest.jobs[1].outputs[0].sha256 = '0'.repeat(64); },
  'missing media': f => rmSync(join(f.outputDir, f.manifest.jobs[1].outputs[0].relative)),
  'incomplete manifest': f => { f.manifest.complete = false; },
  'contradictory completion counts': f => { f.manifest.counts.failed = 1; },
  'failed job': f => { f.manifest.jobs[1].status = 'failed'; },
  'unsubmitted capture': f => { f.manifest.jobs[1].outputs[0].workflow_submitted = false; },
  'changed jobs': f => { f.jobsDoc.jobs[1].params.prompt = 'different'; },
  'conditioning hash mismatch': f => { f.manifest.jobs[1].outputs[0].conditioning_inputs[0].sha256 = '0'.repeat(64); },
  'missing embedded metadata': f => f.replaceVideo(null),
  'changed prompt with valid media hash': f => { const g = structuredClone(f.graphs[1]); g['5'].inputs.text = 'different'; f.replaceVideo(g); },
  'changed model with valid media hash': f => { const g = structuredClone(f.graphs[1]); g['1'].inputs.unet_name = 'wrong'; f.replaceVideo(g); },
  'extra semantic node': f => { const g = structuredClone(f.graphs[1]); g['999'] = { class_type: 'SaveImage', inputs: {} }; f.replaceVideo(g); },
  'changed runtime hash': f => { const g = structuredClone(f.graphs[1]); g['30'].is_changed = ['0'.repeat(64)]; f.replaceVideo(g); },
  'unapproved runtime field': f => { const g = structuredClone(f.graphs[1]); g['5'].is_changed = ['0'.repeat(64)]; f.replaceVideo(g); },
})) test(`recovery refuses ${name} before any receipts`, t => {
  const f = fixture(t); mutate(f);
  assert.throws(() => recordRecoveredGenerationReceipts(f), error => error.code === 'RECOVERY_EVIDENCE_INVALID');
  assert.equal(existsSync(contributionStore(f.packageDir)), false);
  assert.equal(existsSync(f.evidenceDir), false);
});
