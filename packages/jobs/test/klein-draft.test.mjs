import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { KLEIN_STEPS, KLEIN_DRAFT_EXPERIMENTAL, applyKleinDraft } from '../src/klein-draft.mjs';

const root = new URL('../../../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root)));
const paramsFiles = readdirSync(new URL('workflows/', root))
  .filter(name => /^flux3_klein_.*\.api\.params\.json$/.test(name));

test('draft lowers steps to 8, labels the run experimental and never mutates the input', () => {
  const params = { steps: 16, cfg: 1, sampler_name: 'euler', scheduler: 'simple', prompt: 'a still' };
  const out = applyKleinDraft(params, { draft: true });

  assert.equal(KLEIN_DRAFT_EXPERIMENTAL, true);
  assert.equal(out.steps, KLEIN_STEPS.draft);
  assert.equal(out.steps, 8);
  assert.match(out._draft_note, /experimental/i);
  assert.notEqual(out, params, 'returns a copy');
  assert.equal(params.steps, 16, 'the input is untouched');
  assert.equal(params._draft_note, undefined, 'the input gains no note');
});

test('final keeps steps untouched and draft leaves cfg, sampler and scheduler alone', () => {
  const params = { steps: 16, cfg: 1, sampler_name: 'euler', scheduler: 'simple' };
  const final = applyKleinDraft(params);

  assert.equal(final.steps, 16);
  assert.equal(final._draft_note, undefined);
  assert.notEqual(final, params, 'returns a copy');

  const draft = applyKleinDraft(params, { draft: true });
  assert.equal(draft.steps, 8);
  assert.equal(draft.cfg, params.cfg);
  assert.equal(draft.sampler_name, params.sampler_name);
  assert.equal(draft.scheduler, params.scheduler);
});

test('steps left undefined stay undefined unless a draft asks for 8', () => {
  const final = applyKleinDraft({ prompt: 'a still' });
  assert.equal(final.steps, undefined);
  const draft = applyKleinDraft({ prompt: 'a still' }, { draft: true });
  assert.equal(draft.steps, 8);
});

test('every flux3_klein params map sends draft 8 to its steps node while the final keeps graph 16', () => {
  assert.ok(paramsFiles.length >= 4, `expected the four authoring Klein maps, saw ${paramsFiles.join(', ')}`);
  for (const name of paramsFiles) {
    const mapping = read(`workflows/${name}`);
    const stepMap = mapping.map?.steps;
    assert.ok(stepMap, `${name} maps steps`);
    const [node, field] = stepMap;
    assert.equal(field, 'steps', `${name} maps the KSampler steps field`);

    const graph = read(`workflows/${name.replace(/\.params\.json$/, '.json')}`);
    assert.equal(graph[node].class_type, 'KSampler', `${name} points at the sampler`);
    assert.equal(graph[node].inputs.steps, KLEIN_STEPS.final, `${name} ships the final 16`);

    const draftParams = applyKleinDraft({ steps: graph[node].inputs.steps }, { draft: true });
    const draftGraph = structuredClone(graph);
    draftGraph[node].inputs[field] = draftParams.steps;
    assert.equal(draftGraph[node].inputs.steps, 8, `${name} applies draft 8 at node ${node}`);

    const finalParams = applyKleinDraft({ steps: graph[node].inputs.steps });
    const finalGraph = structuredClone(graph);
    finalGraph[node].inputs[field] = finalParams.steps;
    assert.equal(finalGraph[node].inputs.steps, 16, `${name} keeps final 16 at node ${node}`);
  }
});
