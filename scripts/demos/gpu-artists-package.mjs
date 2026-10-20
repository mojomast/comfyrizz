// Turn the prepared short into a normal pending Comfyrizz package + jobs document.
// Usage: node scripts/demos/gpu-artists-package.mjs <prepared-production-directory>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../../packages/schema/src/index.mjs';
import { planJobs, checkJobsDoc } from '../../packages/jobs/src/plan.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.argv[2]);
if (out === repo || out.startsWith(repo + '/')) throw new Error('Keep production media outside Git');
const film = JSON.parse(readFileSync(join(out, 'film.json')));
const workflow = 'workflows/fasth3_omni_ref2va.api.json';
mkdirSync(join(out, 'workflows'), { recursive: true });
for (const name of [workflow, workflow.replace('.json', '.params.json')]) copyFileSync(join(repo, name), join(out, name));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const pkg = {
  schemaVersion: 1, revision: 1, id: 'pkg_gpu_artists_fasth3', title: film.title,
  format: { width: 1920, height: 1080, fps: 24 }, duration: { mode: 'target', targetFrames: 5760 },
  voice: { enabled: false }, audio: { ambience: { enabled: true, gain_db: 0 } },
  scenes: [], assets: {}, compliance: { open_weights_only: true, backends_used: [] },
};
for (const shot of film.shots) {
  const refs = {};
  for (const key of ['image', 'reference', 'audio']) {
    const file = shot[key], id = 'a_ref_' + file.replace(/^refs\//, '').replace(/\W/g, '_');
    refs[key] = id;
    pkg.assets[id] = {
      kind: key === 'audio' ? 'audio' : 'image', origin: 'upload', status: 'ready', file,
      sha256: hash(join(out, file)), bytes: statSync(join(out, file)).size,
      license: { id: 'CC0-1.0' }, redistributable: true,
    };
  }
  const asset = 'a_' + shot.id;
  pkg.assets[asset] = {
    kind: 'video', origin: 'generated', status: 'pending',
    gen: { generator: 'fasth3-omni', workflow, workflow_sha256: hash(join(out, workflow)),
      model: 'FastVideo/FastH3-Omni-Comfy', model_revision: '82eff2a6eee6c962846879f4bab52610a4df24d3',
      inputs: { ...refs, prompt: shot.prompt, width: shot.width, height: shot.height, frames: shot.frames, fps: 24, seed: shot.seed } },
  };
  pkg.scenes.push({ id: shot.id, layout: 'hero', variant: 'full-bleed', preferredFrames: shot.seconds * 24,
    copy: { headline: shot.title }, background: { asset, fit: 'cover', loop: false }, transitionOut: { type: 'cut', frames: 0 } });
}
const validation = validatePackage(pkg);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors, null, 2));
const jobs = planJobs(pkg);
const errors = checkJobsDoc(jobs);
if (errors.length) throw new Error(errors.join('\n'));
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2));
writeFileSync(join(out, 'jobs.json'), JSON.stringify(jobs, null, 2));
console.log(JSON.stringify({ package: pkg.id, scenes: pkg.scenes.length, jobs: jobs.jobs.length, valid: true }));
