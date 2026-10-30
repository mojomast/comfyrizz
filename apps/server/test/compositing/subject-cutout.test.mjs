import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUBJECT_CUTOUT_GENERATOR,
  SUBJECT_CUTOUT_SOLID_WORKFLOW,
  SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW,
  cutoutLayer,
  planSubjectCutout,
} from '../../src/compositing/subject-cutout.mjs';

const acceptedStill = (overrides = {}) => ({
  id: 'still_s03',
  status: 'accepted',
  file: 'assets/still_s03.png',
  ...overrides,
});

test('a title purpose plans the transparent BiRefNet cutout', () => {
  const spec = planSubjectCutout({ still: acceptedStill(), purpose: 'title' });

  assert.equal(spec.generator, SUBJECT_CUTOUT_GENERATOR);
  assert.equal(spec.workflow, SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW);
  assert.equal(spec.output, 'still_s03.cutout.png');
  assert.deepEqual(spec.params, { image: 'still_s03' });
  assert.deepEqual(spec.inputs, { image: 'still_s03' });
  assert.deepEqual(spec.deps, ['still_s03']);
});

test('a composite purpose also uses the transparent cutout', () => {
  const spec = planSubjectCutout({ still: acceptedStill(), purpose: 'composite' });

  assert.equal(spec.workflow, SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW);
  assert.deepEqual(spec.params, { image: 'still_s03' });
});

test('a background colour selects the solid BiRefNet cutout', () => {
  const spec = planSubjectCutout({
    still: acceptedStill(),
    purpose: 'title',
    background: '#12ab34',
  });

  assert.equal(spec.workflow, SUBJECT_CUTOUT_SOLID_WORKFLOW);
  assert.equal(spec.output, 'still_s03.cutout.png');
  assert.deepEqual(spec.params, { image: 'still_s03', colour: 0x12ab34 });
  assert.deepEqual(spec.inputs, { image: 'still_s03', colour: 0x12ab34 });
});

test('a numeric background colour is accepted unchanged', () => {
  const spec = planSubjectCutout({ still: acceptedStill(), background: 0xffffff });

  assert.equal(spec.workflow, SUBJECT_CUTOUT_SOLID_WORKFLOW);
  assert.equal(spec.params.colour, 0xffffff);
});

test('an overridden still is accepted by ref-watch', () => {
  const spec = planSubjectCutout({ still: acceptedStill({ status: 'overridden' }) });

  assert.equal(spec.workflow, SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW);
});

test('a still that ref-watch did not accept is refused', () => {
  for (const status of ['pending', 'reviewing', 'regenerating', 'held', undefined]) {
    assert.throws(
      () => planSubjectCutout({ still: acceptedStill({ status }) }),
      /accepted|overridden/,
      String(status),
    );
  }
  assert.throws(() => planSubjectCutout({}), /still/);
});

test('an unknown purpose is refused', () => {
  assert.throws(
    () => planSubjectCutout({ still: acceptedStill(), purpose: 'background' }),
    /purpose/,
  );
});

test('an invalid background colour is refused', () => {
  assert.throws(
    () => planSubjectCutout({ still: acceptedStill(), background: 'not-a-colour' }),
    /background/,
  );
});

test('the title sits between the background plate and the subject cutout', () => {
  const plate = { id: 'plate_background', kind: 'plate' };
  const titleLayer = { id: 'title_main', kind: 'text', text: 'Mira', background: plate };
  const cutout = { id: 'still_s03.cutout', kind: 'cutout', file: 'still_s03.cutout.png' };

  const layers = cutoutLayer({ cutout, titleLayer });

  assert.equal(layers.length, 3);
  assert.equal(layers[0], plate);
  assert.equal(layers[1], titleLayer);
  assert.equal(layers[2], cutout);
});

test('the layer order always has a background plate first', () => {
  const titleLayer = { id: 'title_main', kind: 'text', text: 'Mira' };
  const cutout = { id: 'still_s03.cutout', kind: 'cutout', file: 'still_s03.cutout.png' };

  const layers = cutoutLayer({ cutout, titleLayer });

  assert.equal(layers.length, 3);
  assert.equal(layers[0].role, 'background');
  assert.equal(layers[1], titleLayer);
  assert.equal(layers[2], cutout);
});

test('cutoutLayer refuses missing layers', () => {
  assert.throws(() => cutoutLayer({ titleLayer: { id: 'title' } }), /cutout/);
  assert.throws(() => cutoutLayer({ cutout: { id: 'cutout' } }), /title/);
});
