// SPW08: title-card cutout jobs and layers. Pure: no network, clock or disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { cacheKeyFor } from '../../../../packages/jobs/src/plan.mjs';
import {
  SUBJECT_CUTOUT_GENERATOR,
  SUBJECT_CUTOUT_SOLID_WORKFLOW,
  SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW,
} from '../../src/compositing/subject-cutout.mjs';
import {
  TITLE_CARD_BATCH,
  TITLE_CARD_FONT_SIZE,
  TITLE_CARD_HEIGHT,
  TITLE_CARD_TEXT_Y,
  TITLE_CARD_WIDTH,
  titleCardJobs,
  titleCardLayers,
} from '../../src/compositing/title-card.mjs';

const workflowSha = (name) => createHash('sha256')
  .update(readFileSync(new URL(`../../../../workflows/${name}`, import.meta.url)))
  .digest('hex');

const TRANSPARENT_SHA = workflowSha('birefnet_image_transparent.api.json');
const SOLID_SHA = workflowSha('birefnet_image_solid.api.json');

const stillJob = (overrides = {}) => ({
  id: 'still_s03.still',
  kind: 'still',
  batch: 'stills',
  asset: 'still_s03',
  scene: 's03',
  sceneIndex: 2,
  generator: 'flux3-klein',
  workflow: 'workflows/flux3_klein_t2i.api.json',
  output: 'assets/still_s03.png',
  outputKind: 'image',
  dims: { width: 1024, height: 576 },
  ...overrides,
});

const jobsDocOf = (...jobs) => ({ v: 1, productionId: 'prod_title', jobs });
const acceptedStill = (jobId = 'still_s03.still', status = 'accepted') => ({ jobId, status });
const titleOf = (overrides = {}) => ({
  stillJobId: 'still_s03.still',
  text: 'Harbor Light',
  ...overrides,
});

test('an accepted still becomes one BiRefNet title cutout job', () => {
  const { jobs, skipped } = titleCardJobs({
    jobsDoc: jobsDocOf(stillJob()),
    acceptedStills: [acceptedStill()],
    titles: [titleOf()],
  });

  assert.deepEqual(skipped, []);
  assert.equal(jobs.length, 1);
  const [job] = jobs;

  assert.equal(job.id, 'still_s03.cutout');
  assert.equal(job.kind, 'still');
  assert.equal(job.batch, 'cutouts');
  assert.equal(job.batch, TITLE_CARD_BATCH);
  assert.equal(job.generator, SUBJECT_CUTOUT_GENERATOR);
  assert.equal(job.workflow, SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW);
  assert.equal(job.output, 'assets/still_s03.cutout.png');
  assert.equal(job.outputKind, 'image');
  assert.deepEqual(job.fileInputs, [{ param: 'image', from: 'job', job: 'still_s03.still' }]);
  assert.deepEqual(job.deps, ['still_s03.still']);
  assert.deepEqual(job.params, { image: 'still_s03' });
  assert.equal(job.cacheKey, cacheKeyFor({
    workflowSha256: TRANSPARENT_SHA,
    generator: SUBJECT_CUTOUT_GENERATOR,
    model: null,
    modelRevision: null,
    params: { image: 'still_s03' },
    seed: null,
    width: 1024,
    height: 576,
    frames: null,
  }));
});

test('a still accepted by id is also honoured and an overridden still passes the gate', () => {
  const { jobs, skipped } = titleCardJobs({
    jobsDoc: jobsDocOf(stillJob({ id: 'still_s04', asset: 'still_s04' })),
    acceptedStills: [{ id: 'still_s04', status: 'overridden' }],
    titles: [titleOf({ stillJobId: 'still_s04', text: 'Second Card' })],
  });

  assert.deepEqual(skipped, []);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].output, 'assets/still_s04.cutout.png');
  assert.deepEqual(jobs[0].fileInputs, [{ param: 'image', from: 'job', job: 'still_s04' }]);
});

test('a still outside the ref-watch gate is skipped with a reason', () => {
  const { jobs, skipped } = titleCardJobs({
    jobsDoc: jobsDocOf(stillJob()),
    acceptedStills: [acceptedStill('still_s03.still', 'pending')],
    titles: [titleOf()],
  });

  assert.deepEqual(jobs, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].stillJobId, 'still_s03.still');
  assert.match(skipped[0].reason, /accepted|overridden/);
});

test('a title whose still never reached ref-watch is skipped with a reason', () => {
  const { jobs, skipped } = titleCardJobs({
    jobsDoc: jobsDocOf(stillJob()),
    acceptedStills: [],
    titles: [titleOf()],
  });

  assert.deepEqual(jobs, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /accepted/);
});

test('an accepted still missing from the jobs doc is skipped with a reason', () => {
  const { jobs, skipped } = titleCardJobs({
    jobsDoc: jobsDocOf(),
    acceptedStills: [acceptedStill()],
    titles: [titleOf()],
  });

  assert.deepEqual(jobs, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /jobs doc/);
});

test('a background colour selects the solid BiRefNet graph for the title cutout', () => {
  const { jobs, skipped } = titleCardJobs({
    jobsDoc: jobsDocOf(stillJob()),
    acceptedStills: [acceptedStill()],
    titles: [titleOf({ background: '#12ab34' })],
  });

  assert.deepEqual(skipped, []);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workflow, SUBJECT_CUTOUT_SOLID_WORKFLOW);
  assert.deepEqual(jobs[0].params, { image: 'still_s03', colour: 0x12ab34 });
  assert.equal(jobs[0].cacheKey, cacheKeyFor({
    workflowSha256: SOLID_SHA,
    generator: SUBJECT_CUTOUT_GENERATOR,
    model: null,
    modelRevision: null,
    params: { image: 'still_s03', colour: 0x12ab34 },
    seed: null,
    width: 1024,
    height: 576,
    frames: null,
  }));
});

test('a title with an invalid background is skipped instead of throwing', () => {
  const { jobs, skipped } = titleCardJobs({
    jobsDoc: jobsDocOf(stillJob()),
    acceptedStills: [acceptedStill()],
    titles: [titleOf({ background: 'not-a-colour' })],
  });

  assert.deepEqual(jobs, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /background/);
});

test('two titles for the same still produce one cutout job', () => {
  const { jobs, skipped } = titleCardJobs({
    jobsDoc: jobsDocOf(stillJob()),
    acceptedStills: [acceptedStill()],
    titles: [titleOf(), titleOf({ text: 'Another Card' })],
  });

  assert.equal(jobs.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /duplicate/);
});

test('the layers are the plate, the title text, then the cutout subject', () => {
  const plate = { id: 'plate_title', kind: 'plate', file: 'assets/plate_title.png' };
  const cutout = { id: 'still_s03.cutout', kind: 'cutout', file: 'assets/still_s03.cutout.png' };

  const layers = titleCardLayers({ title: titleOf(), plate, cutout });

  assert.equal(layers.length, 3);
  assert.equal(layers[0], plate);
  assert.equal(layers[1].kind, 'text');
  assert.equal(layers[1].text, 'Harbor Light');
  assert.equal(layers[1].background, plate);
  assert.equal(layers[2], cutout);
  assert.deepEqual(
    { fontSize: layers[1].fontSize, y: layers[1].y },
    { fontSize: TITLE_CARD_FONT_SIZE, y: TITLE_CARD_TEXT_Y },
  );
  assert.equal(TITLE_CARD_WIDTH, 1920);
  assert.equal(TITLE_CARD_HEIGHT, 1080);
});

test('titleCardLayers refuses an empty title or missing layers', () => {
  const plate = { id: 'plate_title', kind: 'plate' };
  const cutout = { id: 'still_s03.cutout', kind: 'cutout' };

  assert.throws(() => titleCardLayers({ title: titleOf({ text: '   ' }), plate, cutout }), /text/);
  assert.throws(() => titleCardLayers({ title: titleOf(), cutout }), /plate/);
  assert.throws(() => titleCardLayers({ title: titleOf(), plate }), /cutout/);
});

test('titleCardJobs does not mutate its inputs', () => {
  const still = stillJob();
  const accepted = acceptedStill();
  const title = titleOf({ background: '#000000' });
  const doc = jobsDocOf(still);

  const before = structuredClone({ doc, accepted, title });
  titleCardJobs({ jobsDoc: doc, acceptedStills: [accepted], titles: [title] });

  assert.deepEqual({ doc, accepted, title }, before);
});
