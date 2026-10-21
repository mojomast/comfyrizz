/** Install the authored episode as a normal editable UI project; no paid inference.
 * node nrcu-episode2-project.mjs PRODUCTION RECUT RUNTIME
 * Requires Pillow in COMFYRIZZ_PYTHON, FFmpeg and the installed NRCU character library.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PackageStore } from '../../apps/server/src/store.mjs';
import { createCharacterStore } from '../../apps/server/src/characters/store.mjs';
import { addToProject } from '../../apps/server/src/characters/cast.mjs';
import { planJobs, checkJobsDoc } from '../../packages/jobs/src/plan.mjs';
import { compileTimeline } from '../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../packages/schema/src/index.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [production, recut, runtime] = process.argv.slice(2).map(p => resolve(p));
if (!runtime) throw Error('Usage: nrcu-episode2-project.mjs PRODUCTION RECUT RUNTIME');
const id = 'pkg_nrcu_episode2', chatId = 'chat_nrcu_episode2';
const root = join(runtime, 'packages'), store = new PackageStore(root);
if (store.read(id) || existsSync(join(runtime, 'conversations', chatId + '.json'))) throw Error('Episode project already exists; preserve UI edits instead of re-importing.');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2)); };
const film = read(join(production, 'film.json'));
const keys = read(join(production, 'keyframes-plan.json')).images;
const environment = read(join(production, 'assets-plan.json')).images.filter(s => !['witcheer', 'sidbin'].includes(s.id));
const prefix = 'assets/nrcu-episode2';
mkdirSync(join(root, prefix), { recursive: true });
const pkg = {
  schemaVersion: 1, revision: 1, id, title: 'Episode 2 — The Road Beneath the World',
  format: { width: 1920, height: 1080, fps: 24 }, duration: { mode: 'target', targetFrames: 5760 },
  voice: { enabled: false },
  audio: { music: { asset: 'a_ep2_rock', gain_db: -12, loop: true, fade_in_seconds: .2, fade_out_seconds: 1.5 }, ambience: { enabled: true, gain_db: 0 } },
  scenes: [], assets: {}, cast: [],
  compliance: { open_weights_only: true, backends_used: [], warnings: [
    'Episode-two working edit: 48 new native FastH3 takes remain pending. Review generated speech and timing before final delivery.',
    'Approved episode ceiling: 14.5 Colab credits. All motion and spoken performances must use FastH3 Omni; narrator TTS is disabled.',
    'Draft music bed reuses the original 144 BPM pilot rock instrumental. Fine timing/ducking follows take review.',
  ] },
};

function ready(assetId, file, kind, media = {}, generated = false) {
  const path = join(root, file);
  pkg.assets[assetId] = { kind, origin: 'upload', status: 'ready', file, sha256: digest(path), bytes: statSync(path).size,
    license: { id: generated ? 'CC0-1.0' : 'LicenseRef-NRCU-Private-Production' }, redistributable: generated, media };
  return assetId;
}
function picture(name, source) {
  const assetId = 'a_ep2_ref_' + name.replaceAll('-', '_');
  if (pkg.assets[assetId]) return assetId;
  const file = `${prefix}/${name}.jpg`;
  execFileSync(process.env.COMFYRIZZ_PYTHON || 'python3', ['-c',
    'from PIL import Image,ImageOps;import sys;ImageOps.pad(Image.open(sys.argv[1]).convert("RGB"),(1344,768),color=(10,20,30)).save(sys.argv[2],quality=95)', source, join(root, file)]);
  return ready(assetId, file, 'image', { width: 1344, height: 768 });
}
const library = createCharacterStore({ rootDir: runtime });
let cast = [];
const castIds = {}, sourceAssets = {};
for (const [who, handle] of [['don','don-piedro'],['turbo','turbo'],['hermes','hermes'],['molty','molty'],['witcheer','witcheer'],['sidbin','sidbin']]) {
  const character = library.list().find(c => c.handle === handle);
  if (!character) throw Error('Missing character ' + handle);
  const primary = character.visual.images.find(i => i.primary);
  const imageDir = library.imagesDir(character.id);
  const prepared = join(production, `refs/assets/${who}.png`);
  const source = existsSync(prepared) ? prepared : join(imageDir, readdirSync(imageDir).find(name => name.startsWith(primary.imgId + '.')));
  const asset = picture(who, source);
  sourceAssets[`refs/assets/${who}.png`] = asset;
  cast = addToProject(cast, character);
  const castId = cast.find(c => c.characterId === character.id).castId;
  castIds[who] = castId;
  pkg.cast.push({ id: castId, name: character.name, description: character.summary, ref_asset: asset });
}
for (const name of ['workers','kart','molty-kart','regulator','world']) {
  sourceAssets[`refs/assets/${name}.png`] = picture(name, join(production, `refs/assets/${name}.png`));
}
const voiceIds = {};
for (const who of ['don','turbo','hermes','molty','witcheer','sidbin','silence']) {
  const file = `${prefix}/voice-${who}.wav`;copyFileSync(join(production, `refs/${who}.wav`), join(root, file));
  voiceIds[who] = ready(`a_ep2_voice_${who}`, file, 'audio', { audio: 'present' }, true);
}
const music = `${prefix}/rock-draft.mp3`;
execFileSync('ffmpeg', ['-v','error','-y','-i',join(recut,'audio/music.wav'),'-c:a','libmp3lame','-b:a','192k',join(root,music)]);
ready('a_ep2_rock', music, 'audio', { audio: 'present', durationSeconds: 65 }, true);

function generated(assetId, generator, workflow, inputs, kind) {
  pkg.assets[assetId] = { kind, origin: 'generated', status: 'pending',
    gen: { generator, workflow, workflow_sha256: digest(join(repo, workflow)),
      model: generator === 'fasth3-omni' ? 'FastVideo/FastH3-Omni-Comfy' : 'flux-3-image-klein',
      model_revision: generator === 'fasth3-omni' ? '82eff2a6eee6c962846879f4bab52610a4df24d3' : '337337621b8526e120f2275d250242f4a6bedd75', inputs },
    ...(kind === 'video' ? { media: { width: 1344, height: 768, frames: inputs.frames, fps: 24, audio: 'present' } } : {}) };
  return assetId;
}
for (const spec of environment) {
  const asset = generated('a_ep2_env_' + spec.id, 'flux3-klein', 'workflows/flux3_klein_t2i.api.json',
    { prompt: spec.prompt, width: 1344, height: 768, steps: 12, seed: 2026102300 + Object.keys(sourceAssets).length }, 'image');
  sourceAssets[`refs/assets/${spec.id}.png`] = asset;
}
for (const spec of keys) {
  const refs = spec.refs.map(path => { if (!sourceAssets[path]) throw Error('Unknown reference ' + path);return sourceAssets[path]; });
  const workflow = refs.length === 2 ? 'workflows/nrcu/flux3_klein_ref2.api.json' : refs.length ? 'workflows/flux3_klein_ref_edit.api.json' : 'workflows/flux3_klein_t2i.api.json';
  generated('a_ep2_key_' + spec.id, 'flux3-klein', workflow, { prompt: spec.prompt, steps: 12,
    seed: parseInt(createHash('sha256').update(spec.id).digest('hex').slice(0,8),16),
    ...(refs.length ? { reference: refs[0], megapixels: 1.032, ...(refs[1] ? { _reference_2: refs[1] } : {}) } : { width: 1344, height: 768 }),
  }, 'image');
}
const edits = read(join(recut, 'final/edit.json'));
for (const shot of film.shots) {
  const assetId = 'a_ep2_video_' + shot.id;
  if (shot.reusedFrom) {
    const oldId = shot.reusedFrom.shot, edit = edits.find(s => s.id === oldId);
    if (!edit || edit.seconds !== shot.seconds) throw Error('Pilot timing changed: ' + shot.id);
    const file = `${prefix}/${shot.id}.mp4`;
    execFileSync('ffmpeg', ['-v','error','-y','-i',join(recut,`final/parts/${oldId}.mkv`),'-map','0:v:0','-map','0:a:0','-c','copy','-movflags','+faststart',join(root,file)]);
    ready(assetId,file,'video',{width:1920,height:1080,fps:24,frames:Math.round(shot.seconds*24),durationSeconds:shot.seconds,audio:'present'});
  } else {
    const deadline = Math.max(1, shot.seconds - .2).toFixed(2);
    const prompt = shot.prompt.replace(/finish before [\d.]+ seconds/, `finish before ${deadline} seconds`);
    generated(assetId, 'fasth3-omni', 'workflows/fasth3_omni_ref2va.api.json', {
      image:'a_ep2_key_'+shot.id, reference:'a_ep2_key_'+shot.id, audio:voiceIds[shot.speaker || 'silence'],
      prompt, width:shot.width,height:shot.height,frames:shot.frames,fps:24,seed:shot.seed,
    }, 'video');
  }
  const ids = new Set();
  const key = keys.find(s => s.id === shot.id);
  for (const path of key?.refs ?? []) { const who=path.split('/').at(-1).replace('.png','');if(castIds[who])ids.add(castIds[who]); }
  if (castIds[shot.speaker]) ids.add(castIds[shot.speaker]);
  pkg.scenes.push({ id:'s_'+shot.id,layout:'hero',variant:'full-bleed',media_only:true,preferredFrames:Math.round(shot.seconds*24),
    copy:{headline:shot.title},background:{asset:assetId,fit:'contain',loop:false,speed:1},transitionOut:{type:'cut',frames:0},
    ...(shot.line ? {narration:shot.line,speaker:castIds[shot.speaker]} : {}),
    ...(ids.size ? {cast:[...ids]} : {}),
    notes:`${shot.section} | ${shot.reusedFrom?'Verified pilot edit, original native dialogue.':'Pending FastH3 shot; review dialogue and edit timing after generation.'} ${shot.action}`,
  });
}
const validation = validatePackage(pkg);
if (!validation.valid) throw Error(JSON.stringify(validation.errors,null,2));
const jobs = planJobs(pkg);const errors = checkJobsDoc(jobs);if(errors.length)throw Error(errors.join('\n'));
const timeline = compileTimeline(pkg);if(timeline.durationInFrames!==5760)throw Error('Wrong episode timing: '+timeline.durationInFrames);
const placements = pkg.scenes.flatMap(s => (s.cast??[]).map(castId => ({castId,sceneId:s.id,role:'subject'})));
const conversation = {id:chatId,revision:1,phase:'built',projectId:id,projectRevision:1,plan:null,
  cast:[...cast],castPlacements:placements,castProposals:[],referenceAssignments:[],
  messages:[{role:'user',content:'Episode 2: The Road Beneath the World. Four minutes, native FastH3, rock music, Don speaks broken English, Molty sounds menacing. Episode ceiling: 14.5 credits.'},
    {role:'assistant',content:'The 68-shot episode is prepared: 20 verified pilot edits, 48 pending FastH3 performances, and 53 reference/keyframe still jobs. Six characters and their voice-conditioning WAVs are attached. Narrator TTS is off so speech stays native to FastH3. Choose Google Colab and a 14.5-credit ceiling. Use the clip/Takes controls to generate and review shots, or explicitly choose a working-preview override in the render gate for a full pipeline attempt. G4 availability is determined when you start. The music bed is a draft and new speech timing needs review.'}],
};
store.seed(pkg);write(join(runtime,'conversations',chatId+'.json'),conversation);
write(join(root,'run-defaults',id+'.json'),{budgetUnits:14.5});
write(join(production,'ui-project.json'),pkg);write(join(production,'ui-jobs.json'),jobs);write(join(production,'ui-timeline.json'),timeline);
const report={packageId:id,chatId,scenes:pkg.scenes.length,frames:timeline.durationInFrames,seconds:timeline.durationInFrames/24,cast:cast.length,jobs:jobs.jobs.length,
  stills:jobs.jobs.filter(j=>j.kind==='still').length,videos:jobs.jobs.filter(j=>j.generator==='fasth3-omni').length,
  url:`https://mail.tailec998.ts.net:8451/?package=${id}&chat=${chatId}`};
write(join(production,'ui-import.json'),report);console.log(JSON.stringify(report,null,2));
