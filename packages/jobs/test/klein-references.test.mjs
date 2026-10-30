import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planJobs, checkJobsDoc, sha256Hex } from '../src/plan.mjs';
import { REF_EDIT_WORKFLOW, REF2_EDIT_WORKFLOW } from '../src/klein-references.mjs';

const read = path => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url)));
const workflowHash = path => sha256Hex(readFileSync(new URL(`../../../${path}`, import.meta.url)));
function pkg(inputs = {}, workflow = REF_EDIT_WORKFLOW) {
  return {
    id: 'reference-capacity', revision: 1, format: { width: 1024, height: 1024, fps: 30 },
    assets: { edited: { kind: 'image', origin: 'generated', status: 'pending',
      gen: { generator: 'flux3-klein', workflow, workflow_sha256: workflowHash(workflow),
        inputs: { prompt: 'Keep the first image composition and the second image identity.', reference: 'assets/first.png', ...inputs } } } },
  };
}

test('third reference and unsupported list/slot overrides fail before returning any payable jobs document', () => {
  for (const inputs of [
    { reference_2: 'assets/second.png', reference_3: 'assets/third.png' },
    { _reference_2: 'assets/second.png', _reference_3: 'assets/third.png' },
    { reference_99: 'assets/third.png' },
    { _reference_03: 'assets/third.png' },
    { images: ['assets/first.png', 'assets/second.png', 'assets/third.png'] },
    { images: 'assets/third.png' },
    { image: 'assets/other.png' },
    { reference_2: 'assets/second.png', _reference_2: 'assets/other.png' },
  ]) {
    const source = pkg(inputs), before = structuredClone(source);
    assert.throws(() => planJobs(source), /PLAN_KLEIN_REFERENCE_UNSUPPORTED/, JSON.stringify(inputs));
    assert.deepEqual(source, before, 'failure must not rewrite authored sources');
  }
});

test('two explicit references plus implicit cast refuse instead of dropping the cast source', () => {
  const source = pkg({ reference_2: 'assets/second.png' });
  source.cast = [{ id: 'cast', ref_asset: 'cast-ref' }];
  source.assets.edited.cast = 'cast';
  source.assets['cast-ref'] = { kind: 'image', origin: 'upload', status: 'ready', file: 'assets/third.png', sha256: 'a'.repeat(64) };
  assert.throws(() => planJobs(source), /cast cast-ref would exceed two connected references/);
  source.assets['cast-ref'].file = 'assets/second.png';
  source.assets.edited.gen.inputs.reference_2 = 'cast-ref';
  const result = planJobs(source).jobs[0];
  assert.equal(result.workflow, REF2_EDIT_WORKFLOW);
  assert.equal(result.fileInputs.length, 2, 'the same cast asset already present is deduplicated');
});

test('one and two references retain order, graph hashes and genuine zero-based conditioning links', () => {
  const single = planJobs(pkg()).jobs[0];
  assert.equal(single.workflow, REF_EDIT_WORKFLOW);
  assert.equal(single.workflowSha256, workflowHash(REF_EDIT_WORKFLOW));
  assert.deepEqual(single.fileInputs.map(f => [f.param, f.path]), [['reference', 'assets/first.png']]);
  const doc = planJobs(pkg({ reference_2: 'assets/second.png' }));
  assert.deepEqual(checkJobsDoc(doc), []);
  const pair = doc.jobs[0];
  assert.equal(pair.workflow, REF2_EDIT_WORKFLOW);
  assert.equal(pair.workflowSha256, workflowHash(REF2_EDIT_WORKFLOW));
  assert.deepEqual(pair.fileInputs.map(f => [f.param, f.path]), [['reference', 'assets/first.png'], ['_reference_2', 'assets/second.png']]);
  assert.equal(pair.params.reference_2, undefined);
  const graph = read(pair.workflow), mapping = read(pair.workflow.replace('.json', '.params.json'));
  for (const [index, input] of pair.fileInputs.entries()) {
    const [node, field] = mapping.map[input.param];
    assert.equal(graph[node].class_type, 'LoadImage');
    assert.equal(field, 'image');
    assert.deepEqual(graph['12'].inputs[`images.image${index}`], [node, 0]);
  }
  assert.deepEqual(graph['7'].inputs.positive, ['12', 0]);
  assert.deepEqual(graph['7'].inputs.negative, ['12', 1]);
  assert.notEqual(pair.cacheKey, single.cacheKey);
  assert.deepEqual(planJobs(pkg({ _reference_2: 'assets/second.png' })), doc, 'public and canonical second-slot spellings resolve identically');
  const reversed = planJobs(pkg({ reference: 'assets/second.png', reference_2: 'assets/first.png' }));
  assert.notEqual(reversed.hash, doc.hash);
  assert.notEqual(reversed.jobs[0].cacheKey, pair.cacheKey);
});

test('image alias remains first when the planner appends a second reference', () => {
  const source = pkg({ image: 'assets/first.png', reference_2: 'assets/second.png' });
  delete source.assets.edited.gen.inputs.reference;
  const pair = planJobs(source).jobs[0];
  assert.deepEqual(pair.fileInputs.map(f => f.path), ['assets/first.png', 'assets/second.png']);
  assert.equal(pair.params.image, undefined, 'no two different files compete for node 10');
});

test('direct jobs documents cannot bypass reference capacity via params, files, maps or a one-image graph', () => {
  const valid = planJobs(pkg({ reference_2: 'assets/second.png' }));
  for (const mutate of [
    job => { job.params._reference_3 = 'assets/third.png'; },
    job => { job.params.images = ['assets/first.png', 'assets/second.png', 'assets/third.png']; },
    job => { job.fileInputs.push({ param: '_reference_3', from: 'package', path: 'assets/third.png' }); },
    job => { job.fileInputs.push({ ...job.fileInputs[0] }); },
    job => { job.workflow = REF_EDIT_WORKFLOW; },
    job => { job.paramsSource = 'custom'; },
  ]) {
    const doc = structuredClone(valid); mutate(doc.jobs[0]);
    assert.ok(checkJobsDoc(doc).some(p => p.includes('PLAN_KLEIN_REFERENCE_UNSUPPORTED')));
  }
  const unmapped = pkg({ _reference_2: 'assets/second.png' }, 'workflows/flux3_klein_t2i.api.json');
  assert.throws(() => planJobs(unmapped), /not connected/);
});
