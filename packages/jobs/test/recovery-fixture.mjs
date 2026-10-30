// Synthetic CPU fixtures only; never live generation evidence.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planJobs } from '../src/plan.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('../../../', import.meta.url));
export function recoveryPackage() {
  const pkg = JSON.parse(readFileSync(join(root, 'packages/schema/fixtures/valid/minimal.json')));
  delete pkg.theme.logo_asset;
  pkg.duration.targetFrames = 90; pkg.scenes[0].preferredFrames = 90;
  pkg.scenes[0].transitionOut = { type: 'cut', frames: 0 };
  pkg.scenes[0].background = { asset: 'a_video' };
  pkg.voice = { enabled: false, engine: 'none' };
  const asset = (kind, generator, workflow, inputs) => ({ kind, origin: 'generated', status: 'pending',
    gen: { generator, workflow, workflow_sha256: hash(readFileSync(join(root, workflow))), inputs } });
  pkg.assets = {
    a_image: asset('image', 'flux3-klein', 'workflows/flux3_klein_t2i.api.json', { prompt: 'Synthetic test color image', width: 128, height: 128, seed: 0 }),
    a_video: asset('video', 'ltx25', 'workflows/ltx25_i2v_2stage.api.json', { image: 'a_image', prompt: 'Synthetic test color film', width: 128, height: 128, frames: 73, fps: 24, seed: 0 }),
  };
  pkg.assets.a_image.gen.backend = 'colab:G4';
  return pkg;
}

export function recoveryFixture(dir, pkg = recoveryPackage()) {
  const workDir = join(dir, 'work'), outputDir = join(dir, 'out');
  mkdirSync(workDir, { recursive: true }); mkdirSync(outputDir, { recursive: true });
  symlinkSync(join(root, 'workflows'), join(workDir, 'workflows'));
  const jobsDoc = planJobs(pkg);
  const manifest = { v: 1, run_id: 'synthetic-remote-run', packageId: pkg.id, revision: pkg.revision,
    jobsHash: jobsDoc.hash, complete: true, counts: { succeeded: 2 }, jobs: [] };
  const graphs = [];
  for (const job of jobsDoc.jobs) {
    const graph = JSON.parse(readFileSync(join(root, job.workflow)));
    const mapping = JSON.parse(readFileSync(join(root, job.workflow.replace(/\.json$/, '.params.json'))));
    const params = { ...job.params }, consumed = [];
    if (job.fileInputs?.length) {
      const dep = manifest.jobs[0].outputs[0];
      params.image = `a_image_${dep.sha256.slice(0, 8)}.png`;
      consumed.push({ nodeId: '30', input: 'image', sha256: dep.sha256, bytes: dep.bytes, uploadedName: params.image });
    }
    for (const [name, value] of Object.entries(params)) {
      const map = mapping.map[name];
      if (map) for (const [id, field, opts] of Array.isArray(map[0]) ? map : [map]) graph[id].inputs[field] = opts ? value * opts.mul : value;
    }
    const path = join(outputDir, job.output); mkdirSync(dirname(path), { recursive: true });
    const output = { relative: job.output, workflow: job.output.replace(/\.[^/.]+$/, '.workflow.api.json'),
      workflow_submitted: true, conditioning_inputs: consumed, measured: { width: 128, height: 128,
        ...(job.kind === 'plate' ? { fps: 24, frames: 73, durationSeconds: 73 / 24 } : {}) } };
    if (job.kind === 'still') {
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x128', '-frames:v', '1', '-threads', '1', '-y', path]);
      writeFileSync(join(outputDir, output.workflow), JSON.stringify(graph));
    } else {
      graph['30'].is_changed = [consumed[0].sha256];
      writeVideo(path, graph);
    }
    const bytes = readFileSync(path); Object.assign(output, { sha256: hash(bytes), bytes: bytes.length });
    manifest.jobs.push({ job: job.id, status: 'succeeded', job_id: `prompt-${job.id}`, attempt_id: `attempt-${job.id}`, cache_key: job.cacheKey, outputs: [output] });
    graphs.push(graph);
  }
  const save = () => {
    writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(workDir, 'jobs.json'), JSON.stringify(jobsDoc));
    writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest));
  };
  save();
  return { pkg, jobsDoc, manifest, outputDir, workDir, backend: 'colab', graphs, save,
    replaceVideo(graph) { const output = manifest.jobs[1].outputs[0]; const path = join(outputDir, output.relative);
      writeVideo(path, graph); const bytes = readFileSync(path); output.sha256 = hash(bytes); output.bytes = bytes.length; save(); } };
}
export function writeVideo(path, graph) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x128:r=24', '-frames:v', '73', '-c:v', 'libx264', '-threads', '1',
    ...(graph ? ['-metadata', `prompt=${JSON.stringify(graph)}`, '-movflags', 'use_metadata_tags'] : []), '-y', path]);
}
