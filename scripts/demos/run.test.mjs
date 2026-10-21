import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignTotals, assessCampaignAllocation, settleSessionSpend, mergePlansForOneSession, splitMergedManifest} from './run.mjs';
import {planJobs} from '../../packages/jobs/src/index.mjs';
import {readFileSync} from 'node:fs';

test('unknown or missing usage never becomes a zero-cost session', () => {
  for(const balanceDelta of [null, undefined, NaN, -1]) {
    const ledger={capUnits:30,priorSpendUnits:0,entries:[],pendingAllocation:{units:5}};
    settleSessionSpend(ledger,{session:'interrupted',reservedUnits:5,balanceDelta,spentUnits:1});
    assert.equal(campaignTotals(ledger).spentUnits,5);
    assert.equal(ledger.entries[0].costSource,'reserved_fallback');
    assert.equal(ledger.pendingAllocation,null);
    assert.equal(assessCampaignAllocation({capUnits:30,ledger,plannedUnits:26}).allowed,false);
  }
});

test('measured settlement and interrupted reservations consume the same cumulative ceiling', () => {
  const ledger={capUnits:30,priorSpendUnits:0,entries:[],pendingAllocation:{units:4}};
  settleSessionSpend(ledger,{reservedUnits:4,balanceDelta:2.32});
  ledger.pendingAllocation={units:10};
  assert.equal(campaignTotals(ledger).remainingUnits,17.68);
  assert.equal(assessCampaignAllocation({capUnits:30,ledger,plannedUnits:18}).allowed,false);
  settleSessionSpend(ledger,{reservedUnits:10,balanceDelta:null});
  assert.equal(campaignTotals(ledger).remainingUnits,17.68);
});

test('shared-session plans isolate identical job IDs, dependencies, outputs and cache identities', () => {
  const pkg=JSON.parse(readFileSync(new URL('../../packages/jobs/test/fixtures/package-pending.json',import.meta.url)));
  const jobsDoc=planJobs(pkg);
  assert.ok(jobsDoc.jobs.length>0);
  const entries=['one','two'].map(slug=>({pkg:{...pkg,id:`pkg_${slug}`},slug,jobsDoc,jobs:jobsDoc.jobs.length}));
  const merged=mergePlansForOneSession(entries);
  assert.equal(merged.jobs.length,2*jobsDoc.jobs.length);
  assert.equal(new Set(merged.jobs.map(j=>j.id)).size,merged.jobs.length);
  assert.equal(new Set(merged.jobs.map(j=>j.cacheKey)).size,merged.jobs.length);
  for(const job of merged.jobs){const slug=job.id.split('__')[0];assert.ok(job.output.startsWith(`${slug}/`));for(const dep of job.deps)assert.ok(dep.startsWith(`${slug}__`));}
  const manifest={jobs:merged.jobs.map(job=>({job:job.id,status:'succeeded',outputs:[{relative:job.output}]}))};
  for(const entry of entries){const split=splitMergedManifest(entry,manifest);assert.equal(split.complete,true);assert.deepEqual(split.jobs.map(j=>j.job),jobsDoc.jobs.map(j=>j.id));assert.deepEqual(split.jobs.map(j=>j.outputs[0].relative),jobsDoc.jobs.map(j=>j.output));}
});
