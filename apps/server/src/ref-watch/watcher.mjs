import { join } from 'node:path';
// RW01: watch verified still previews and seed one reference review per keyframe sha.
// Pure module: the caller injects enqueue/onEvent, and no disk, network or clock is read.
import { REF_EVENTS } from '../../../../packages/schema/src/ref-review.mjs';

const REF_REVIEW_STARTED = 'ref_review_started';
if (!REF_EVENTS.includes(REF_REVIEW_STARTED)) throw new Error(`${REF_REVIEW_STARTED} is not a contract event`);

const IMAGE_OUTPUT = /\.(?:png|jpe?g|webp)$/i;
const VIDEO_OUTPUT = /\.(?:mp4|webm)$/i;
const VIDEO_KINDS = new Set(['plate', 'upscale', 'presenter']);
const SHA256 = /^[a-f0-9]{64}$/i;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRelativePath = value => typeof value === 'string' && value.length > 0
  && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value)
  && !value.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..');

function isVideoJob(job) {
  return job.outputKind === 'video' || VIDEO_KINDS.has(job.kind) || VIDEO_OUTPUT.test(job.output ?? '');
}

function keyframeConsumers(jobs, jobId) {
  const consumers = [];
  for (const job of jobs) {
    if (job.id === jobId || !isVideoJob(job)) continue;
    const fileInputs = Array.isArray(job.fileInputs) ? job.fileInputs : [];
    if (fileInputs.some(input => isObject(input) && input.from === 'job' && input.job === jobId)) {
      consumers.push(job.id);
    }
  }
  return consumers;
}

export function createRefWatcher({ jobsDoc, enqueue, onEvent, now }) {
  const jobs = (Array.isArray(jobsDoc?.jobs) ? jobsDoc.jobs : []).filter(isObject);
  const jobsById = new Map(jobs.map(job => [job.id, job]));
  const productionId = jobsDoc?.productionId ?? jobsDoc?.packageId ?? null;
  const seen = new Set();
  let stopped = false;

  async function handle(event) {
    if (stopped) return;
    if (!isObject(event) || event.type !== 'preview_ready') return;
    const entries = Array.isArray(event.manifest?.jobs) ? event.manifest.jobs : [];
    for (const entry of entries) {
      if (stopped) break;
      if (!isObject(entry)) continue;
      const job = jobsById.get(entry.job);
      if (!job) continue;
      const outputs = Array.isArray(entry.outputs) ? entry.outputs : [];
      for (const output of outputs) {
        if (stopped) break;
        if (!isObject(output)) continue;
        const imagePath = output.relative;
        if (!IMAGE_OUTPUT.test(imagePath ?? '') || !isRelativePath(imagePath)) continue;
        const keyframeSha256 = typeof output.sha256 === 'string' ? output.sha256.toLowerCase() : '';
        if (!SHA256.test(keyframeSha256)) continue;
        const consumers = keyframeConsumers(jobs, job.id);
        if (consumers.length === 0) continue;
        const key = `${job.id}:${keyframeSha256}`;
        if (seen.has(key)) continue;
        // imagePath stays package-relative (regen/edit inputs name it); imageFile is the collected
        // file on this host, which is what the judge has to read.
        const imageFile = typeof event.outputDir === 'string' && event.outputDir ? join(event.outputDir, imagePath) : null;
        await enqueue({ jobId: job.id, keyframeSha256, imagePath, ...(imageFile ? { imageFile } : {}), consumers });
        seen.add(key);
        onEvent({
          type: REF_REVIEW_STARTED,
          productionId,
          jobId: job.id,
          keyframeSha256,
          state: 'reviewing',
          at: typeof now === 'function' ? now() : null,
        });
      }
    }
  }

  function stop() {
    stopped = true;
  }

  return { handle, stop };
}
