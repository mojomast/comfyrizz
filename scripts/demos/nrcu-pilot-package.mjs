// Build a validated, reference-conditioned FastH3 package for the NRCU pilot.
// Usage: node nrcu-pilot-package.mjs <production-directory>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../../packages/schema/src/index.mjs';
import { planJobs, checkJobsDoc } from '../../packages/jobs/src/plan.mjs';

const root = resolve(process.argv[2]);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (root === repo || root.startsWith(repo + '/')) throw new Error('Keep production media outside Git');
const film = JSON.parse(readFileSync(join(root, 'film.json')));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const workflow = 'workflows/fasth3_omni_ref2va.api.json';
mkdirSync(join(root, 'workflows'), { recursive: true });
for (const name of [workflow, workflow.replace('.json', '.params.json')]) copyFileSync(join(repo, name), join(root, name));
const pkg = {
  schemaVersion: 1, revision: 1, id: 'pkg_nrcu_lower_road', title: film.title,
  format: { width: 1920, height: 1080, fps: 24 }, duration: { mode: 'target', targetFrames: film.seconds * 24 },
  voice: { enabled: false }, audio: { ambience: { enabled: true, gain_db: 0 } },
  scenes: [], assets: {}, compliance: { open_weights_only: true, backends_used: [] },
};
for (const shot of film.shots) {
  const refs = {};
  for (const param of ['image', 'reference', 'audio']) {
    const file = shot[param], id = 'a_ref_' + file.replace(/^refs\//, '').replace(/\W/g, '_');
    refs[param] = id;
    pkg.assets[id] = { kind: param === 'audio' ? 'audio' : 'image', origin: 'upload', status: 'ready', file,
      sha256: hash(join(root, file)), bytes: statSync(join(root, file)).size,
      license: { id: param === 'audio' ? 'CC0-1.0' : 'LicenseRef-NRCU-Reference-Art' }, redistributable: param === 'audio' };
  }
  const asset = 'a_' + shot.id;
  pkg.assets[asset] = { kind: 'video', origin: 'generated', status: 'pending', gen: {
    generator: 'fasth3-omni', workflow, workflow_sha256: hash(join(root, workflow)),
    model: 'FastVideo/FastH3-Omni-Comfy', model_revision: '82eff2a6eee6c962846879f4bab52610a4df24d3',
    inputs: { ...refs, prompt: shot.prompt, width: shot.width, height: shot.height, frames: shot.frames, fps: 24, seed: shot.seed },
  } };
  pkg.scenes.push({ id: shot.id, layout: 'hero', variant: 'full-bleed', preferredFrames: shot.seconds * 24,
    copy: { headline: shot.title }, background: { asset, fit: 'cover', loop: false }, transitionOut: { type: 'cut', frames: 0 } });
}
const validation = validatePackage(pkg);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors, null, 2));
const jobs = planJobs(pkg), errors = checkJobsDoc(jobs);
if (errors.length) throw new Error(errors.join('\n'));
writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
writeFileSync(join(root, 'jobs.json'), JSON.stringify(jobs, null, 2));
console.log(JSON.stringify({ package: pkg.id, scenes: pkg.scenes.length, frames: film.seconds * 24, valid: true }));
