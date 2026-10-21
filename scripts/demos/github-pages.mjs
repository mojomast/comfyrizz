/** Package verified films for GitHub Pages, with full-resolution downloads in Releases.
 * Usage: node scripts/demos/github-pages.mjs <published-root> <site-out> <release-out>
 *        [owner/repository] [release-tag]
 * Produces only public, allowlisted static files. No credentials or app runtime state.
 */
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const [sourceArg,outArg,releaseArg,repository='mojomast/comfyrizz',tag='films-2026-10-20']=process.argv.slice(2);
if(!sourceArg||!outArg||!releaseArg)throw Error('Usage: github-pages.mjs <published-root> <site-out> <release-out> [owner/repository] [release-tag]');
if(!/^[\w.-]+\/[\w.-]+$/.test(repository)||!/^[-\w.]+$/.test(tag))throw Error('Invalid repository or release tag');
const source=resolve(sourceArg),out=resolve(outArg),release=resolve(releaseArg);
if(out===source||out.startsWith(source+'/'))throw Error('Output must be separate from existing publications');
const keys=['forest','clockwork','coolcity','ferment','abyss'];
const releaseURL=`https://github.com/${repository}/releases/download/${tag}`;
const repoURL=`https://github.com/${repository}`;
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const textFiles=['chapters.json','script.md','CREDITS.md','verification.json','captions.srt','captions.vtt'];
mkdirSync(out,{recursive:true});mkdirSync(release,{recursive:true});
const manifest={version:1,repository,releaseTag:tag,films:[]};
for(const key of keys){
 const src=join(source,`long-${key}`),dest=join(out,`long-${key}`);
 if(!existsSync(join(src,'.comfyrizz-rich-demo.json')))throw Error(`Unmanaged source ${key}`);
 const verification=JSON.parse(readFileSync(join(src,'verification.json')));
 if(!Object.values(verification.checks).every(v=>v===true))throw Error(`Unverified source ${key}`);
 mkdirSync(dest,{recursive:true});
 for(const name of [...textFiles,'poster.jpg'])copyFileSync(join(src,name),join(dest,name));
 const downloads=[['video.mp4',`${key}-1080p.mp4`],['package.zip',`${key}-project.zip`]].map(([file,name])=>{
  copyFileSync(join(src,file),join(release,name));return {name,bytes:statSync(join(release,name)).size,sha256:hash(join(release,name)),url:`${releaseURL}/${name}`};
 });
 const video=join(dest,'video.mp4');
 // Same edit/audio; lower-resolution delivery encode, with an early MP4 index for seeking.
 execFileSync('ffmpeg',['-v','error','-y','-i',join(src,'video.mp4'),'-map','0:v:0','-map','0:a:0','-vf','scale=1280:720','-c:v','libx264','-preset','fast','-crf','25','-maxrate','1800k','-bufsize','3600k','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',video],{stdio:'inherit'});
 const bytes=statSync(video).size;if(bytes>=95*1024*1024)throw Error(`${key}: delivery video too large for Git`);
 const stream=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=width,height,nb_read_frames','-of','json',video],{encoding:'utf8'})).streams[0];
 const marker=JSON.parse(readFileSync(join(src,'.comfyrizz-rich-demo.json')));
 if(stream.width!==1280||stream.height!==720||Number(stream.nb_read_frames)!==marker.frames)throw Error(`${key}: delivery encode differs from verified edit`);
 let html=readFileSync(join(src,'index.html'),'utf8');
 html=html.replace('href="video.mp4" download',`href="${downloads[0].url}" download`).replace('Download MP4','Download 1080p MP4').replace('href="package.zip"',`href="${downloads[1].url}"`);
 html=html.replace(/<footer>[\s\S]*?<\/footer>/,`<footer><p>Web player: 720p. Original 1080p MP4 and editable project available above. Original synthetic imagery and score; educational imagery is illustrative. The clockmaker story is fiction.</p><nav><a href="../index.html">← Five-film collection</a><a href="${repoURL}">Project source</a><a href="${repoURL}/releases/tag/${tag}">All downloads</a></nav></footer>`);
 writeFileSync(join(dest,'index.html'),html);
 manifest.films.push({key,frames:marker.frames,web:{file:`long-${key}/video.mp4`,bytes,sha256:hash(video),width:1280,height:720},downloads});
 console.log(JSON.stringify({film:key,webBytes:bytes,frames:marker.frames}));
}
let gallery=readFileSync(join(source,'longform/index.html'),'utf8');
for(const f of manifest.films){gallery=gallery.replaceAll(`href="../long-${f.key}/video.mp4"`,`href="${f.downloads[0].url}"`).replaceAll(`href="../long-${f.key}/package.zip"`,`href="${f.downloads[1].url}"`);}
gallery=gallery.replaceAll('../long-','long-').replace(/<nav><a href="\.\.\/rich-anonymous[\s\S]*?<\/nav>/,`<nav><a href="${repoURL}">Project source</a><a href="${repoURL}/releases/tag/${tag}">Full-resolution downloads</a></nav>`);
writeFileSync(join(out,'index.html'),gallery);writeFileSync(join(out,'.nojekyll'),'');
writeFileSync(join(out,'media-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
writeFileSync(join(release,'SHA256SUMS.txt'),manifest.films.flatMap(f=>f.downloads.map(d=>`${d.sha256}  ${d.name}`)).join('\n')+'\n');
writeFileSync(join(out,'README.md'),`# Five Worlds — Comfyrizz film gallery\n\nStatic GitHub Pages publication. Web videos are 720p delivery encodes; original 1080p MP4s and editable projects are attached to [${tag}](${repoURL}/releases/tag/${tag}).\n\nGenerated using scripts/demos/github-pages.mjs. No editor API or private runtime files are deployed.\n`);
console.log(JSON.stringify({site:out,release,webVideoBytes:manifest.films.reduce((n,f)=>n+f.web.bytes,0)}));
