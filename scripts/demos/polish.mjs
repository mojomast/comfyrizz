/** Apply CPU-only art-direction refinements after media collection, before narration/render. */
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {validatePackage} from '../../packages/schema/src/index.mjs';
import {findLayoutOverlaps} from '../../apps/renderer/src/layout-model.js';
import {measureCode} from '../../packages/schema/src/code-layout.mjs';
import {sanitizeSvg,renderCheck} from '../../packages/vector/dist/src/index.js';
const require=createRequire(new URL('../../packages/vector/package.json',import.meta.url));
const {Resvg}=require('@resvg/resvg-js');
const rootArg=process.argv.indexOf('--root');
if(rootArg<0||!process.argv[rootArg+1])throw Error('Usage: node scripts/demos/polish.mjs --root <source-or-applied-packages-root>');
const root=resolve(process.argv[rootArg+1]);
const hash=data=>createHash('sha256').update(data).digest('hex');
for(const name of readdirSync(root)){
  const dir=join(root,name), file=join(dir,'package.json');if(!existsSync(file))continue;
  const pkg=JSON.parse(readFileSync(file));
  if(!pkg.id.startsWith('pkg_rich'))continue;
  for(const asset of Object.values(pkg.assets)){
    if(asset.kind!=='svg'||!asset.file)continue;
    const path=join(dir,asset.file);
    const source=readFileSync(path,'utf8').replace(/<svg\b([^>]*)>/,(_,attributes)=>`<svg${attributes.replace(/\s(?:width|height)="[^"]*"/g,'')} width="100%" height="100%">`);
    const sanitized=sanitizeSvg(source);if(!sanitized.ok)throw Error(`SVG validation failed: ${asset.file}`);
    const check=renderCheck(sanitized.svg,{width:512});if(!check.ok)throw Error(`SVG render check failed: ${asset.file}`);
    writeFileSync(path,sanitized.svg);asset.bytes=Buffer.byteLength(sanitized.svg);asset.sha256=hash(sanitized.svg);
  }
  const dark=pkg.id.includes('hermes')?'#070B14':pkg.id.includes('ministry')?'#25352F':'#211D18';
  const accent=pkg.id.includes('hermes')?'#58C7D6':pkg.id.includes('ministry')?'#C9AB79':'#DF8A52';
  if(!pkg.id.includes('hermes')){
    // A package-wide light-paper text colour became unreadable on the generated
    // dark plates. Use a consistent ink-room palette for both media and cards.
    pkg.theme.text='#F3EBDD';pkg.theme.text_muted='#CABFAE';pkg.theme.text_on_accent=dark;
    pkg.theme.palette=pkg.id.includes('ministry')
      ? [dark,'#3C5147',accent,'#AB6266','#F3EBDD']
      : [dark,'#423326',accent,'#739CC3','#F3EBDD'];
  }
  for(const scene of pkg.scenes){
    if(!pkg.id.includes('hermes')&&scene.background?.procedural)scene.background.procedural.palette=pkg.theme.palette;
    // Keep the original SVGs outside the conservative layout copy zones.
    for(const item of scene.foreground??[]){
      if(pkg.assets[item.asset]?.kind!=='svg')continue;
      if(scene.layout==='list'){item.x=.85;item.w=.23;}
      if(scene.layout==='stat'){item.x=.88;item.w=.14;}
      if(scene.layout==='title'){item.x=.87;item.y=.13;item.w=.12;}
    }
    if(scene.id==='s_u04')scene.copy.items=['Bound agent','Move panes','Local SQLite'];
    if(scene.id==='s_h09')scene.copy.items=['Task + elapsed time','Live transcript','Steer or stop'];
    if(scene.id==='s_m02')scene.copy.body='−0.4%';
    if(scene.id==='s_u07')scene.code.code='if (state.circuitState === "open") {\n  if (!state.circuitOpenUntil ||\n      state.circuitOpenUntil > now) {\n    return false;\n  }\n  state.circuitState = "half-open";\n}';
    if(scene.id==='s_u11')scene.code.code='export function hashBytes(bytes) {\n  if (!(bytes instanceof Uint8Array)) {\n    throw new TypeError("hashBytes requires bytes");\n  }\n  return createHash("sha256")\n    .update(bytes).digest("hex");\n}';
    if(scene.code){const fit=measureCode(scene.code.code,pkg.format.width,pkg.format.height);if(fit.lines>fit.maxLines||fit.longest>fit.maxChars)throw Error(JSON.stringify({scene:scene.id,fit}));}
    const comparisonTitles={s_u05:'Proposal → receipt',s_u06:'One arena. Two apps.',s_h06:'Trust the channel.',s_m04:'Compliant. Joyless.',s_m09:'Unsigned. Rejected.'};
    if(comparisonTitles[scene.id])scene.copy.headline=comparisonTitles[scene.id];
    if(scene.layout==='chart'){
      // Compact release-date labels fit their real chart columns at full HD.
      for(const dataset of Object.values(pkg.datasets??{}))for(const row of dataset.values??[]){
        if(typeof row.label==='string'&&/^\d\d-\d\d to \d\d-\d\d$/.test(row.label))row.label=row.label.split(' to ').at(-1);
      }
    }
    if(scene.id==='s_h10'){
      // Code layouts intentionally own the full terminal area; show this generated
      // still in a genuine image-bearing hero rather than an ignored foreground.
      scene.layout='hero';scene.variant='split';delete scene.code;
      scene.copy.body='Gateway process checks after reboot. Longer local-model turns on laptops. Corrective release: v0.22.2.';
      scene.motion.focus={x:.62,y:.26,width:.32,height:.49};
    }
    if(!['compare','split'].includes(scene.layout))continue;
    const source=(scene.foreground??[]).map(f=>pkg.assets[f.asset]).find(a=>a?.kind==='svg');
    let original=null;
    if(source)original=new Resvg(readFileSync(join(dir,source.file),'utf8'),{fitTo:{mode:'width',value:640}}).render().asPng();
    scene.media=(scene.media??[]).map((plate,index)=>{
      if(plate.asset)return plate;
      const artwork=index===1&&original
        ? `<image href="data:image/png;base64,${original.toString('base64')}" x="160" y="330" width="640" height="480"/>`
        : `<g transform="translate(160 400)"><rect width="640" height="360" rx="28" fill="#FFFFFF" fill-opacity=".06" stroke="${accent}" stroke-width="3"/><g fill="${accent}">${[0,1,2].map(i=>`<circle cx="65" cy="${80+i*100}" r="16"/><rect x="115" y="${69+i*100}" width="${370-i*80}" height="22" rx="11" opacity="${1-i*.2}"/>`).join('')}</g><path d="M65 96V164 M65 196V264" stroke="${accent}" stroke-width="3"/></g>`;
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1080" viewBox="0 0 960 1080"><rect width="960" height="1080" fill="${dark}"/><path d="M64 320H896 M64 820H896" stroke="${accent}" opacity=".25" stroke-width="2"/>${artwork}</svg>`;
      const data=new Resvg(svg).render().asPng();
      const id=`a_${scene.id}_panel${index}`, path=`assets/${scene.id}-panel-${index}.png`;
      mkdirSync(join(dir,'assets'),{recursive:true});writeFileSync(join(dir,path),data);
      pkg.assets[id]={kind:'image',origin:'upload',status:'ready',file:path,bytes:data.length,sha256:hash(data),redistributable:true,license:{id:'CC0-1.0'},source:{provider:'repo',title:'Original comparison illustration',creator:'Comfyrizz showcase'}};
      return {asset:id,fit:'cover',label:plate.label};
    });
    delete scene.foreground;
    if(scene.motion?.recipe==='focus')scene.motion.focus={x:.59,y:.31,width:.32,height:.43};
  }
  const validation=validatePackage(pkg);if(!validation.valid)throw Error(JSON.stringify(validation.errors));
  const overlaps=findLayoutOverlaps(pkg);if(overlaps.length)throw Error(JSON.stringify({packageId:pkg.id,overlaps}));
  writeFileSync(file,JSON.stringify(pkg,null,2)+'\n');
  console.log(JSON.stringify({packageId:pkg.id,scenes:pkg.scenes.length,polished:true}));
}
