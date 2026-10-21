// Preserve the selected native takes and final editorial timing in a ready package.
// Usage: node gpu-artists-apply.mjs <production-directory>
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { validatePackage } from '../../packages/schema/src/index.mjs';
import { applyManifestToPackage } from '../../packages/jobs/src/apply.mjs';

const root = resolve(process.argv[2]);
const read = path => JSON.parse(readFileSync(join(root, path)));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const pkg = read('package.json'), jobs = read('jobs.json'), edits = read('final/edit.json');
const records = [];
mkdirSync(join(root, 'workflows/selected'), { recursive: true });
for (const shot of edits) {
  const receipt = read(`outputs/${shot.id}.json`);
  const file = `outputs/${shot.id}.mp4`;
  if (receipt.status !== 'succeeded' || hash(join(root, file)) !== receipt.sha256) throw new Error('Invalid take: ' + shot.id);
  const workflow = `workflows/selected/${shot.id}.api.json`;
  writeFileSync(join(root, workflow), JSON.stringify(receipt.graph, null, 2));
  copyFileSync(join(root, 'workflows/fasth3_omni_ref2va.api.params.json'), join(root, workflow.replace('.json', '.params.json')));
  const asset = pkg.assets['a_' + shot.id];
  const job = jobs.jobs.find(j => j.asset === 'a_' + shot.id);
  job.workflow = workflow;
  job.workflowSha256 = hash(join(root, workflow));
  asset.gen.inputs.prompt = receipt.graph['8'].inputs.prompt;
  asset.gen.inputs.seed = receipt.graph['13'].inputs.noise_seed;
  asset.gen.inputs.frames = receipt.graph['8'].inputs.length;
  asset.gen.inputs.width = receipt.graph['8'].inputs.width;
  asset.gen.inputs.height = receipt.graph['8'].inputs.height;
  const video = receipt.probe.streams.find(s => s.codec_type === 'video');
  records.push({ job: job.id, job_id: receipt.promptId, status: 'succeeded', outputs: [{
    relative: file, sha256: receipt.sha256, bytes: receipt.bytes,
    measured: { width: video.width, height: video.height, fps: 24, frames: Number(video.nb_frames), durationSeconds: Number(video.duration) },
  }] });
  pkg.scenes.find(s => s.id === shot.id).preferredFrames = shot.editFrames;
}
const ready = applyManifestToPackage(pkg, { jobsDoc: jobs, manifest: { jobs: records }, backend: 'byo-comfyui' }).package;
const validation = validatePackage(ready);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors, null, 2));
writeFileSync(join(root, 'package.ready.json'), JSON.stringify(ready, null, 2));
console.log(JSON.stringify({ ready: true, assets: records.length, frames: ready.scenes.reduce((n,s)=>n+s.preferredFrames,0) }));
