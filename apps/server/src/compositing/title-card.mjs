// SPW08: title-card cutout jobs and layers.
//
// A title card is a plate, a text layer and the accepted still's subject cut
// out in front of them. The cutout plan and the layer order come from SP04's
// subject-cutout module; this file only turns an accepted still into a complete
// BiRefNet job and states the 1920x1080 text style. Pure: the jobs document and
// the ref-watch acceptance list are injected, so nothing here touches the
// network, a clock or the disk.
import { cacheKeyFor } from '../../../../packages/jobs/src/plan.mjs';
import { refGateOpen } from '../../../../packages/schema/src/ref-review.mjs';
import {
  SUBJECT_CUTOUT_SOLID_WORKFLOW,
  SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW,
  cutoutLayer,
  planSubjectCutout,
} from './subject-cutout.mjs';

export const TITLE_CARD_BATCH = 'cutouts';
export const TITLE_CARD_WIDTH = 1920;
export const TITLE_CARD_HEIGHT = 1080;
export const TITLE_CARD_FONT_SIZE = 96;
export const TITLE_CARD_TEXT_Y = 810;

// The committed BiRefNet graphs, mirrored from packages/agent/src/workflow-manifest.ts.
// The cache key has to name the graph it will run; the jobs planner verifies the
// manifest against the files, so drift fails there rather than silently reusing a
// cutout from a different graph.
const WORKFLOW_SHA256 = Object.freeze({
  [SUBJECT_CUTOUT_TRANSPARENT_WORKFLOW]: 'b3f81ecde4e8333bbad2480f886c0871464a9849789cc3c0191ff1158a6b7d01',
  [SUBJECT_CUTOUT_SOLID_WORKFLOW]: '90cef015641f972a175a0ff7608779f3bd54dc07d5c4a524bdc1faf9ca5fd541',
});

function fail(message) {
  throw new Error(`Title card: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function recordJobId(record) {
  return textOf(record?.jobId) || textOf(record?.id) || null;
}

function recordStatus(record) {
  return textOf(record?.status) || textOf(record?.state) || null;
}

function assetIdOf(stillJob) {
  return textOf(stillJob?.asset) || stillJob.id;
}

function acceptedByJobId(acceptedStills) {
  const map = new Map();
  for (const record of acceptedStills) {
    const jobId = recordJobId(record);
    if (!jobId) continue;
    const current = map.get(jobId);
    if (current === undefined || (!refGateOpen(recordStatus(current)) && refGateOpen(recordStatus(record)))) {
      map.set(jobId, record);
    }
  }
  return map;
}

function cacheKeyArgs(stillJob, spec) {
  return {
    workflowSha256: WORKFLOW_SHA256[spec.workflow] ?? null,
    generator: spec.generator,
    model: null,
    modelRevision: null,
    params: spec.params,
    seed: null,
    width: stillJob.dims?.width ?? null,
    height: stillJob.dims?.height ?? null,
    frames: null,
  };
}

/**
 * One BiRefNet title-cutout job per accepted title.
 *
 * `titles` is `[{ stillJobId, text, background? }]`. A still must be accepted
 * (or overridden) by ref-watch and present in `jobsDoc.jobs`; anything else is
 * listed in `skipped` with the reason instead of being submitted. The returned
 * jobs are complete jobs-doc entries for the birefnet graph.
 */
export function titleCardJobs({ jobsDoc, acceptedStills, titles } = {}) {
  if (!isObject(jobsDoc) || !Array.isArray(jobsDoc.jobs)) fail('jobsDoc with a jobs array is required');
  if (!Array.isArray(titles)) fail('titles must be an array');

  const accepted = acceptedByJobId(Array.isArray(acceptedStills) ? acceptedStills : []);
  const jobsById = new Map(
    jobsDoc.jobs.filter(isObject).map((job) => [job.id, job]),
  );
  const jobs = [];
  const skipped = [];
  const claimed = new Set();

  for (const title of titles) {
    const stillJobId = textOf(title?.stillJobId);
    if (!stillJobId) {
      skipped.push({ stillJobId: null, reason: 'title needs a stillJobId' });
      continue;
    }
    if (claimed.has(stillJobId)) {
      skipped.push({ stillJobId, reason: 'duplicate title cutout for this still' });
      continue;
    }

    const record = accepted.get(stillJobId);
    if (record === undefined) {
      skipped.push({ stillJobId, reason: 'still is not accepted by ref-watch' });
      continue;
    }
    const status = recordStatus(record);
    if (!refGateOpen(status)) {
      skipped.push({
        stillJobId,
        reason: `still status ${JSON.stringify(status)} is not accepted or overridden`,
      });
      continue;
    }

    const stillJob = jobsById.get(stillJobId);
    if (stillJob === undefined) {
      skipped.push({ stillJobId, reason: 'still job is not in the jobs doc' });
      continue;
    }

    const stillId = assetIdOf(stillJob);
    let spec;
    try {
      spec = planSubjectCutout({
        still: { id: stillId, status },
        purpose: 'title',
        background: title.background,
      });
    } catch (error) {
      skipped.push({ stillJobId, reason: String(error?.message ?? error) });
      continue;
    }

    claimed.add(stillJobId);
    const keyArgs = cacheKeyArgs(stillJob, spec);
    jobs.push({
      id: spec.id,
      kind: 'still',
      batch: TITLE_CARD_BATCH,
      asset: stillId,
      scene: stillJob.scene ?? null,
      sceneIndex: stillJob.sceneIndex ?? null,
      generator: spec.generator,
      workflow: spec.workflow,
      workflowSha256: keyArgs.workflowSha256,
      model: keyArgs.model,
      modelRevision: keyArgs.modelRevision,
      deps: [stillJobId],
      output: `assets/${spec.output}`,
      outputKind: 'image',
      params: spec.params,
      seed: keyArgs.seed,
      cacheKey: cacheKeyFor(keyArgs),
      fileInputs: [{ param: 'image', from: 'job', job: stillJobId }],
    });
  }

  return { jobs, skipped };
}

/**
 * The composite stack for one title card, in `cutoutLayer` order:
 * background plate, title text, accepted subject cutout. The title text layer
 * carries its 1920x1080 style so the stack renders without a second lookup.
 */
export function titleCardLayers({ title, plate, cutout } = {}) {
  if (!isObject(title)) fail('title is required');
  const text = textOf(title.text);
  if (!text) fail('title text is required');
  if (!isObject(plate)) fail('plate layer is required');
  if (!isObject(cutout)) fail('cutout layer is required');

  const stillJobId = textOf(title.stillJobId);
  const titleLayer = {
    id: stillJobId ? `${stillJobId}.title` : 'title',
    kind: 'text',
    text,
    fontSize: TITLE_CARD_FONT_SIZE,
    y: TITLE_CARD_TEXT_Y,
    background: plate,
  };

  return cutoutLayer({ cutout, titleLayer });
}
