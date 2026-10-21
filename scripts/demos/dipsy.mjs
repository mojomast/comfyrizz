/** Source authoring for Dipsy's original sci-fi adventure. All media stays external.
 * Usage: node scripts/demos/dipsy.mjs build|time <project-directory>
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTimeline } from '../../packages/planner/dist/src/index.js';
import { narrationOptions } from '../../apps/renderer/scripts/render-package-lib.mjs';
import { validatePackage } from '../../packages/schema/src/index.mjs';
import { planJobs, checkJobsDoc } from '../../packages/jobs/src/index.mjs';
import { sanitizeSvg, renderCheck, SANITIZER_VERSION } from '../../packages/vector/dist/src/index.js';

const [stage, directory] = process.argv.slice(2);
if (!['build', 'time'].includes(stage) || !directory) throw Error('Usage: dipsy.mjs build|time <external-project-directory>');
const repo = fileURLToPath(new URL('../../', import.meta.url)), out = resolve(directory);
if (out.startsWith(resolve(repo) + '/')) throw Error('Production media must remain outside the repository');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sid = i => `s_${String(i + 1).padStart(2, '0')}`;
const date = '2026-10-20T18:00:00.000Z';
const palette = ['#091727', '#68E4D1', '#F3F4DF', '#FFB56B', '#B2B1EB'];
const identity = 'Dipsy is an original small lime-green alien mechanic with a rounded pear-shaped body, two short rounded ears, large dark eyes, a small copper aviator helmet with a single narrow white stripe, an orange scarf, and a compact blue backpack. Friendly expressive face, two arms and two legs, no antenna, no logos.';
const world = 'Original cinematic 3D animated science-fiction family adventure. Planet Luma has turquoise rivers, violet basalt cliffs, rounded ivory houses, luminous garden trees and a delicate golden planetary shield lattice overhead. Rescue drones are small amber spherical robots with one cyan circular lens and two tiny side fins. Tactile materials, volumetric lighting, clear silhouettes, cinematic depth, restrained bloom.';
const beats = [
 ['A small home, a wide sky', 'On the little planet Luma, Dipsy could fix almost anything. Except, perhaps, the sky.', 'Wide establishing view: Dipsy tends a glowing seedling on a hillside overlooking ivory houses and turquoise rivers beneath a golden sky lattice.', 'Dipsy gently waters the glowing seedling, looks up, and watches a thin golden arc flicker above the valley. Slow forward camera drift.'],
 ['The sky begins to break', 'One morning, the planet’s shield cracked. A violet storm pushed through, straight toward home.', 'Extreme wide landscape: a golden sky lattice tears above a violet mountain pass, a purple storm funnel approaches the distant ivory town, no character.', 'A bright gap opens in the golden sky lattice. Purple storm clouds roll through the gap and advance slowly across the valley.'],
 ['Something worth saving', 'Dipsy packed the village’s last starseed and ran for the old repair tower.', 'Medium tracking view of Dipsy carrying a small glowing seed capsule along a stone footbridge toward an ivory repair tower.', 'Dipsy tucks the glowing seed capsule into the blue backpack, runs across the bridge, and looks back at the approaching storm.'],
 ['Too many broken places', 'The tower answered with a spark. Broken relays stretched across canyons, far beyond one pair of hands.', 'Dipsy at the base of a damaged ivory relay tower with a copper control lever; jagged violet canyons and other dark towers in the distance.', 'Dipsy pulls the copper lever. A tiny blue spark jumps, the tower stays dark, and Dipsy lowers their shoulders before looking toward the distant relays.'],
 ['A different kind of toolkit', 'So Dipsy opened DeepSeek. Together, they turned one impossible rescue into smaller jobs.', 'Close over-shoulder shot: Dipsy opens a small blue wrist computer projecting three simple luminous geometric clusters, the storm soft in the background. The screen contains shapes only.', 'Dipsy opens the wrist computer. Three small holographic clusters rise from the screen and separate while Dipsy points at each one.'],
 ['Build the rescue swarm', 'Scouts would find the damage. Builders would repair it. Couriers would carry power where it was needed.', null, null],
 ['The first helpers', 'Dipsy gave the plan a thousand little bodies. The workshop filled with bright, impatient eyes.', 'Inside a compact ivory workshop, Dipsy stands among many small amber spherical rescue drones with cyan circular lenses, some resting on worktables.', 'Dipsy turns a small switch. Drone eyes illuminate one row at a time, then several amber drones rise gently from their worktables.'],
 ['Scouts over the canyon', 'The scouts skimmed the canyons, tracing every broken connection before the storm could hide it.', 'Wide aerial action view: a small formation of amber cyan-eyed drones flies low over turquoise river bends between violet basalt cliffs, no character.', 'The drone formation flies along the canyon, separates around a rock pillar, and converges beside a broken golden relay cable. The camera follows smoothly.'],
 ['Power for the journey', 'The couriers found sleeping energy crystals beneath the hills. Now the rescue had something to run on.', 'A group of amber spherical drones hovers inside a violet crystal cavern around one large pale-blue crystal on a low stone pedestal.', 'Four drones descend around the blue crystal, lift it together on thin light beams, and carry it slowly toward the bright cavern entrance.'],
 ['Try one small repair', 'DeepSeek suggested a patch. Dipsy tested one small relay before trusting it with an entire world.', 'Dipsy kneels beside a small broken copper relay on a workbench outside the tower, a single amber drone hovers nearby.', 'Dipsy connects a short blue cable to the test relay. The amber drone holds it steady. A steady golden light appears, and Dipsy gives a relieved nod.'],
 ['A thousand little departures', 'The test held. Dipsy released the swarm, and a thousand tiny engines answered the dark.', 'Epic wide shot of Dipsy on a ridge with orange scarf and blue backpack, many amber drones rising toward a dramatic violet sky.', 'Dipsy raises one arm. The amber drones lift from the ridge and divide into three flowing formations heading toward distant relay towers. Slow camera pullback.'],
 ['The storm changes the rules', 'Then the storm twisted. Magnetic lightning scattered the swarm and swallowed the shortest route.', 'Action view of amber rescue drones near violet cliffs as a broad purple storm front sweeps across the canyon, distant lightning flashes.', 'A purple gust pushes the drone formation sideways. The drones separate and stabilize, but one small drone wobbles downward toward a stone ledge.'],
 ['Nobody left behind', 'Dipsy caught the falling scout. Its tiny lens blinked once. The rescue would have to change.', 'Close cinematic view of Dipsy braced on a stone ledge, arms extended toward a small damaged amber drone, orange scarf blowing sideways.', 'Dipsy catches the wobbling drone with both hands, shields it from the wind, and gently taps its casing. The cyan lens glows again.'],
 ['Share a safer route', 'Dipsy sent DeepSeek the storm map. The agents shared a safer route through the mountain, together.', null, null],
 ['Through the mountain', 'Under the thunder, Dipsy led the couriers through an old tunnel, following the scouts’ blue lights.', 'Dipsy walks through a violet stone tunnel followed by amber drones carrying a pale-blue energy crystal, small cyan guide lights mark the route.', 'Dipsy walks forward, following cyan lights that illuminate ahead one by one. The crystal-carrying drones follow through the narrow tunnel. Camera tracks backward.'],
 ['Many hands, one repair', 'Above them, the builders joined the broken relays. Tiny repairs became one unbroken path.', 'Three amber drones work around a severed golden cable between two ivory relay pylons on a violet ridge; storm behind them.', 'The drones hold the two cable ends in alignment. Brief blue welding sparks flicker. A golden pulse travels across the newly joined cable and into the pylon.'],
 ['The final connection', 'At the tower’s heart, Dipsy placed the crystal. For one long heartbeat, nothing happened.', 'Intimate medium shot inside the ivory tower: Dipsy holds a pale-blue crystal beside an empty copper socket, amber drones hover silently behind.', 'Dipsy carefully lowers the blue crystal into the copper socket, withdraws both hands, and waits. A faint warm glow begins deep inside the socket.'],
 ['Wait for the answer', 'Then the relays answered, one after another. The swarm had carried the signal all the way home.', null, null],
 ['The sky holds', 'A golden wave climbed the sky. The shield closed, and the violet storm broke against the light.', 'Extreme wide planetary landscape: ivory city, turquoise river and violet cliffs beneath a damaged golden sky dome, no character.', 'A golden wave rises from the relay tower and spreads across the sky lattice, closing the gap. The purple clouds roll away from the restored luminous dome.'],
 ['Home, again', 'Windows opened. Gardens lifted their glowing leaves. A thousand tired helpers drifted down through the morning.', 'Warm sunrise over an ivory village garden with luminous trees and turquoise canal; small amber drones descend gently between rooftops.', 'The amber drones settle softly on garden walls as flowers unfold and sunlight warms the ivory houses. Slow cinematic pan across the restored village.'],
 ['One more small job', 'Dipsy planted the starseed. Saving a world, it turned out, began with helping one small thing grow.', 'Dipsy kneels beside the original glowing seedling on the hillside, orange scarf, copper helmet and blue backpack, a repaired amber drone rests nearby under the golden sky.', 'Dipsy presses the starseed gently into soft earth. A tiny glowing shoot rises. The repaired drone hovers close, and Dipsy smiles as the camera slowly pulls back.'],
];
const manifest = { version: 1, scenes: [
 {sceneId:'s_06',component:'mechanism-journey',params:{title:'DeepSeek → a coordinated rescue',signalLabel:'Shared mission: protect Luma',stations:[{label:'Scouts',detail:'Find broken connections'},{label:'Builders',detail:'Repair the relays'},{label:'Couriers',detail:'Carry power to the repairs'}],resultLabel:'Different jobs. One shared mission.',qualifier:'Dipsy directs the swarm in this fictional adventure.'},cues:{action:{phrase:'Scouts'},result:{phrase:'where it was needed'}}},
 {sceneId:'s_14',component:'mechanism-journey',params:{title:'The plan changes with the world',signalLabel:'DeepSeek / updated rescue plan',stations:[{label:'Observe',detail:'Scouts report the storm'},{label:'Reroute',detail:'Use the sheltered tunnel'},{label:'Coordinate',detail:'Share the new path'}],resultLabel:'A safer route, shared by every team.',qualifier:'The agents adapt to new information.'},cues:{action:{phrase:'storm map'},result:{phrase:'through the mountain'}}},
 {sceneId:'s_18',component:'object-transfer',params:{title:'The last connection',objectLabel:'Power + signal',fromLabel:'Repaired relays',toLabel:'Luma’s shield',resultLabel:'Connection confirmed.',qualifier:'A thousand small repairs complete one path.'},cues:{action:{phrase:'relays answered'},result:{phrase:'all the way home'}}}
]};
const path = join(out, 'package.json');
if (stage === 'build') {
 if (existsSync(path)) throw Error('Choose a fresh source directory');
 mkdirSync(join(out,'assets'),{recursive:true});mkdirSync(join(out,'compositions'),{recursive:true});
 const assets = {}, scenes = [];
 const gen = (generator, workflow, inputs, seed) => ({generator, workflow:`workflows/${workflow}.api.json`,workflow_sha256:hash(readFileSync(join(repo,`workflows/${workflow}.api.json`))),model:generator==='ltx25'?'ltx-2.5-22b-distilled':'flux-3-image-klein',quantization:generator==='ltx25'?'int8':'bf16',seed,created_at:date,caption:inputs.prompt,inputs});
 const pending = (kind,gen) => ({kind,origin:'generated',status:'pending',redistributable:true,license:{id:'CC0-1.0'},model_license:{id:kind==='video'?'LicenseRef-LTX-2.5':'LicenseRef-FLUX.3-Image-Klein',url:kind==='video'?'https://huggingface.co/Lightricks/LTX-2.5':'https://huggingface.co/black-forest-labs/flux-3-image-klein'},gen});
 function overlay(id, heading, subtitle) {
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect x="80" y="60" width="1760" height="175" rx="18" fill="#091727" opacity=".86"/><text x="125" y="140" fill="#F3F4DF" font-family="DejaVu Sans,sans-serif" font-size="54" font-weight="600">${heading}</text><text x="128" y="197" fill="#68E4D1" font-family="DejaVu Sans,sans-serif" font-size="28">${subtitle}</text></svg>`;
  const cleaned=sanitizeSvg(svg);const checked=renderCheck(cleaned.svg,{width:960,palette});if(!cleaned.ok||!checked.ok)throw Error('Overlay failed render check');
  const bytes=Buffer.from(cleaned.svg),file=`assets/${id}.svg`;writeFileSync(join(out,file),bytes);
  assets[id]={kind:'svg',origin:'generated',status:'ready',file,bytes:bytes.length,sha256:hash(bytes),redistributable:true,license:{id:'CC0-1.0'},gen:{generator:'llm-svg',sanitizer_version:SANITIZER_VERSION,render_check:{ok:true,version:'1',rasterizer:'resvg',width:checked.width,height:checked.height,blank:false,palette_ok:true,at:date}}};
 }
 overlay('a_title','Dipsy and the Thousand Little Helpers','An original science-fiction adventure');
 overlay('a_deepseek','DEEPSEEK / RESCUE WORKSPACE','Dipsy’s goal: bring the planetary shield back online');
 beats.forEach(([title,narration,visual,action],i)=>{
  const id=sid(i),seed=20281020+i*79;
  const scene={id,layout:'hero',media_only:true,preferredFrames:i===0?210:180,copy:{headline:title},narration,transitionOut:{type:'cut',frames:0}};
  if(visual){
   const prompt=`${visual} ${visual.includes('Dipsy')?identity:''} ${world} Main action in the upper two-thirds, uncluttered lower caption margin. Landscape 16:9. No written text, no subtitles, no watermarks.`;
   assets[`a_still${i}`]=pending('image',gen('flux3-klein','flux3_klein_t2i',{prompt,width:1024,height:576,seed,steps:16},seed));
   assets[`a_plate${i}`]=pending('video',gen('ltx25','ltx25_i2v_2stage',{prompt:`${action} Preserve the reference image's characters, objects, colors and materials. ${world} A continuous animated shot, no jump cuts, no text or overlays.`,image:`a_still${i}`,width:1024,height:576,frames:193,fps:24,seed,stage2_seed:seed+1,role:'background',strength:1},seed));
   scene.background={asset:`a_plate${i}`,fit:'cover',muted:true,scrim:0,loop:false,speed:1};
  }else {scene.background={procedural:{pattern:'gradient',palette:[palette[0],palette[0]]}};delete scene.media_only;}
  if(i===0||i===4)scene.foreground=[{asset:i===0?'a_title':'a_deepseek',x:.5,y:.5,w:1,anim:'fade-in'}];
  scenes.push(scene);
 });
 const pkg={schemaVersion:1,revision:1,id:'pkg_dipsy_swarm20261020',title:'Dipsy and the Thousand Little Helpers',createdAt:date,format:{width:1920,height:1080,fps:30},duration:{mode:'target',targetFrames:scenes.reduce((total,s)=>total+s.preferredFrames,0)},theme:{font:'Inter',palette,text:palette[2],text_muted:'#B4C8D8',text_on_accent:palette[0]},voice:{enabled:true,engine:'kokoro',voice:'af_heart',speed:1,language:'en-us',chunking:'sentence'},captions:{style:'sentence'},scenes,assets,datasets:{},compliance:{open_weights_only:true,closed_apis_used:[],warnings:['Original fiction. Dipsy, Luma, the storm and the rescue are invented.','DeepSeek is depicted as a fictional planning assistant; this film makes no claim of demonstrated real-world autonomous rescue capability.','Synthetic imagery and original synthesized score.','Word timings are syllable estimates inside measured sentence audio.']}};
 writeFileSync(path,JSON.stringify(pkg,null,2));writeFileSync(join(out,'compositions/manifest.json'),JSON.stringify(manifest,null,2));
 writeFileSync(join(out,'STORYBOARD.md'),`# ${pkg.title}\n\n${identity}\n\n${world}\n\n18 generated video scenes; 3 native HyperFrames explainers.\n\n`+beats.map(([title,n,visual,action],i)=>`## ${i+1}. ${title}\n\n${n}\n\n${visual??'HyperFrames: '+manifest.scenes.find(s=>s.sceneId===sid(i)).component}\n\n${action??'Semantic phrase-cued motion, followed by an inspection hold.'}\n`).join('\n'));
}
const pkg=JSON.parse(readFileSync(path));
if(stage==='time'){
 const durations=JSON.parse(readFileSync(join(out,'audio/durations.json')));
 for(const [i,scene] of pkg.scenes.entries())scene.preferredFrames=Math.ceil(Math.max(i===0||i===20?7:5.4,durations.scenes[scene.id].seconds+.35)*30);
 pkg.duration={mode:'target',targetFrames:pkg.scenes.reduce((total,s)=>total+s.preferredFrames,0)};
 const timeline=compileTimeline(pkg,narrationOptions(out));
 for(const scene of timeline.scenes){const raw=pkg.scenes.find(s=>s.id===scene.id),asset=pkg.assets[raw.background?.asset];if(asset?.kind==='video')asset.gen.inputs.frames=Math.ceil(((scene.durationInFrames/30+.65)*24-1)/8)*8+1;}
 writeFileSync(path,JSON.stringify(pkg,null,2));writeFileSync(join(out,'timeline.json'),JSON.stringify(timeline,null,2));
}
const valid=validatePackage(pkg);if(!valid.valid)throw Error(JSON.stringify(valid.errors));const jobs=planJobs(pkg);const errors=checkJobsDoc(jobs);if(errors.length)throw Error(errors.join('\n'));
console.log(JSON.stringify({stage,id:pkg.id,scenes:21,motionScenes:18,hyperframesScenes:3,jobs:jobs.jobs.length,frames:compileTimeline(pkg,narrationOptions(out)).durationInFrames}));
