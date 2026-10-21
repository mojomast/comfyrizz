import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, symlink, mkdir, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { materializeCompositions, compositionCommand, compositionFingerprint, verifyCompositionProbe, collectCompositionCacheExtras, verifyPreparedCompositions } from '../scripts/composition-worker.mjs';

const checkResult = () => ({ ok: true, browserSkipped: false,
  ...Object.fromEntries(['lint', 'runtime', 'layout', 'motion', 'contrast'].map(key => [key, { ok: true, errorCount: 0, findings: [], enabled: true, samples: [0, 0.5] }])) });

test('VM-produced compositions export offline only when source, timing and bytes still agree', async t => {
  const { options, state, packageDir } = await fixture(t);
  const { compileTimeline } = await import('../../../packages/planner/dist/src/index.js');
  const compiler = await import('../../../packages/compositions/src/index.mjs');
  await cp(new URL('../../../examples/composition-stories/', import.meta.url), packageDir, { recursive: true });
  options.pkg = JSON.parse(await readFile(join(packageDir, 'package.json')));
  options.timeline = compileTimeline(options.pkg);
  options.loadCompositionManifest = compiler.loadCompositionManifest;
  options.compileComposition = input => { const result = compiler.compileComposition(input); state.probe = probeResult(result.frames); return result; };
  const rendered = await materializeCompositions(options);
  const command = async (bin, args) => {
    assert.equal(bin, 'ffprobe', 'portable verification must not invoke Node or HyperFrames');
    const scene = rendered.report.scenes.find(scene => args.at(-1).endsWith(scene.file));
    return { stdout: JSON.stringify(probeResult(scene.probe.frames)) };
  };
  const verify = pkg => verifyPreparedCompositions({ pkg, packageDir, timeline: compileTimeline(pkg), env: {}, command });
  assert.equal((await verify(rendered.pkg)).report.scenes.length, 3);
  assert.equal(state.renders, 3);
  const retimed = structuredClone(rendered.pkg); retimed.scenes[0].preferredFrames += 30;
  await assert.rejects(verify(retimed), /Stale prepared composition/);
  const manifestPath = join(packageDir, 'compositions/manifest.json');
  const original = await readFile(manifestPath);
  const manifest = JSON.parse(original); manifest.scenes[0].params.resultLabel = 'Changed after rendering';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verify(rendered.pkg), /Stale prepared composition/);
  await writeFile(manifestPath, original);
  await writeFile(join(packageDir, rendered.report.scenes[0].file), 'tampered');
  await assert.rejects(verify(rendered.pkg), /cached video hash mismatch/);
});
function probeResult(frames = 30) {
  return { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1280, height: 720, r_frame_rate: '30/1', avg_frame_rate: '30/1', nb_read_frames: String(frames) }] };
}
async function fixture(t) {
  const packageDir = await mkdtemp('/tmp/opencode/composition-test-');
  t.after(() => rm(packageDir, { recursive: true, force: true }));
  const pkg = { scenes: [{ id: 's1', background: { procedural: { pattern: 'grid' } }, copy: { title: 'Example' } }], assets: {} };
  await writeFile(join(packageDir, 'package.json'), JSON.stringify(pkg));
  const timeline = { width: 1280, height: 720, fps: 30, scenes: [{ id: 's1', from: 0, durationInFrames: 30 }] };
  const state = { renders: 0, calls: [], sourceHash: 'source-v1', check: checkResult(), probe: probeResult() };
  const options = { pkg, packageDir, timeline,
    loadCompositionManifest: () => ({ version: 1, scenes: [{ sceneId: 's1', component: 'data-chart', params: { title: 'Example' } }] }),
    compileComposition: ({ timelineScene, timeline }) => ({ html: '<html>original geometry</html>', motionSpec: { version: 1, assertions: [] }, sourceHash: state.sourceHash, frames: timelineScene.durationInFrames, width: timeline.width, height: timeline.height, fps: timeline.fps, diagnostics: [] }),
    resolveRuntime: async () => ({ node: '/node22', cli: '/hyperframes.mjs', env: { HYPERFRAMES_NO_TELEMETRY: '1' }, fingerprint: { browser: 'pinned-test-browser', version: '0.8.181' } }),
    command: async (bin, args, config) => {
      config.signal?.throwIfAborted();
      state.calls.push({ bin, args, config });
      if (bin === 'ffprobe') return { code: 0, stdout: JSON.stringify(state.probe) };
      if (args[1] === 'check') return { code: state.check.ok ? 0 : 1, stdout: JSON.stringify(state.check) };
      if (args[1] === 'render') {
        state.renders++;
        await writeFile(args[args.indexOf('--output') + 1], 'fake-video-unique-content');
        return { code: 0, stdout: '' };
      }
      throw new Error('Unexpected subprocess');
    } };
  return { options, state, pkg, packageDir, timeline };
}

test('no manifest returns original package and does not configure a runtime', async t => {
  const { options, pkg } = await fixture(t);
  options.loadCompositionManifest = () => null;
  options.resolveRuntime = () => { throw new Error('Should not run'); };
  const result = await materializeCompositions(options);
  assert.equal(result.pkg, pkg);
  assert.equal(result.report.status, 'noop');
});

test('materializes a clone with provenance and strict render flags; verified cache avoids rendering', async t => {
  const { options, state, pkg, packageDir } = await fixture(t);
  const original = structuredClone(pkg);
  const events = [];
  options.onEvent = event => events.push(event);
  const first = await materializeCompositions(options);
  assert.deepEqual(pkg, original);
  assert.deepEqual(JSON.parse(await readFile(join(packageDir, 'package.json'))), original);
  const scene = first.pkg.scenes[0];
  assert.equal(scene.media_only, true);
  assert.equal(scene.background.speed, 1);
  assert.equal(scene.background.loop, false);
  const asset = first.pkg.assets[scene.background.asset];
  assert.match(asset.file, /^assets\/derived\/[a-f0-9]{64}\.mp4$/);
  assert.equal(asset.license.id, 'MIT');
  assert.equal(first.report.scenes[0].probe.shortfallFrames, 0);
  assert.ok(first.report.scenes[0].checkHash);
  assert.equal(JSON.parse(await readFile(join(packageDir, first.report.file))).fingerprint, first.report.fingerprint);
  const render = state.calls.find(call => call.args[1] === 'render');
  for (const flag of ['--strict', '--no-best-effort', '--no-browser-gpu', '--no-gpu', '--sdr']) assert.ok(render.args.includes(flag));
  assert.equal(render.args[render.args.indexOf('--workers') + 1], '1');
  assert.equal(render.config.env.HYPERFRAMES_NO_TELEMETRY, '1');
  assert.ok(events.every(event => event.phase === 'composition'));
  const second = await materializeCompositions(options);
  assert.equal(second.report.scenes[0].cache, 'hit');
  assert.equal(state.renders, 1);
  assert.equal(second.report.fingerprint, first.report.fingerprint);
  assert.equal(state.calls.filter(call => call.bin === 'ffprobe').length, 2);
});

test('corrupt owned bytes are rerendered and source/timing edits invalidate keys', async t => {
  const { options, state, packageDir, timeline } = await fixture(t);
  const first = await materializeCompositions(options);
  await writeFile(join(packageDir, first.report.scenes[0].file), 'corruption');
  const repaired = await materializeCompositions(options);
  assert.equal(repaired.report.scenes[0].cache, 'invalid');
  assert.equal(state.renders, 2);
  state.sourceHash = 'source-v2';
  const sourceEdit = await materializeCompositions(options);
  assert.notEqual(sourceEdit.report.fingerprint, first.report.fingerprint);
  timeline.scenes[0].durationInFrames = 60;
  state.probe = probeResult(60);
  const timingEdit = await materializeCompositions(options);
  assert.notEqual(timingEdit.report.fingerprint, sourceEdit.report.fingerprint);
  timeline.scenes[0].motionCues = [{ frame: 15, source: 'word-cues' }];
  const cueEdit = await materializeCompositions(options);
  assert.notEqual(cueEdit.report.fingerprint, timingEdit.report.fingerprint);
});

test('cache identity includes engine/browser configuration and encoding', () => {
  const input = { compiled: { sourceHash: 'x', html: 'html', motionSpec: {}, frames: 30, fps: 30, width: 1280, height: 720 }, entry: {}, timelineScene: {}, identity: { browser: 'one' } };
  const first = compositionFingerprint(input);
  assert.notEqual(first, compositionFingerprint({ ...input, identity: { browser: 'two' } }));
});

test('effective package plus freshly compiled real timeline is idempotent; other manifest edits stay independent', async t => {
  const { options, state, packageDir } = await fixture(t);
  const { compileTimeline } = await import('../../../packages/planner/dist/src/index.js');
  const { loadCompositionManifest, compileComposition } = await import('../../../packages/compositions/src/index.mjs');
  await cp(new URL('../../../examples/composition-stories/', import.meta.url), packageDir, { recursive: true });
  options.pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  options.pkg.scenes[0].motion = { recipe: 'paper-cut', seed: 123 };
  options.timeline = compileTimeline(options.pkg);
  options.loadCompositionManifest = loadCompositionManifest;
  options.compileComposition = input => {
    const compiled = compileComposition(input);
    state.probe = probeResult(compiled.frames);
    return compiled;
  };
  const original = structuredClone(options.pkg);
  const first = await materializeCompositions(options);
  assert.equal(first.pkg.scenes[0].motion.recipe, undefined);
  assert.equal(first.pkg.scenes[0].motion.seed, 123);
  assert.deepEqual(options.pkg, original);
  options.pkg = first.pkg;
  options.timeline = compileTimeline(first.pkg);
  const second = await materializeCompositions(options);
  assert.deepEqual(second.pkg, first.pkg);
  assert.equal(second.report.fingerprint, first.report.fingerprint);
  assert.ok(second.report.scenes.every(scene => scene.cache === 'hit'));
  assert.equal(Object.keys(second.pkg.assets).length, 3);
  assert.equal(state.renders, 3);
  const manifestPath = join(packageDir, 'compositions/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.scenes[0].params.title = 'Edited receipt title';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const changed = await materializeCompositions(options);
  assert.equal(changed.report.scenes[0].cache, 'miss');
  assert.ok(changed.report.scenes.slice(1).every(scene => scene.cache === 'hit'));
  assert.equal(state.renders, 4);
  assert.equal(Object.keys(changed.pkg.assets).length, 3, 'obsolete unreferenced owned entry pruned');
});

test('absolute scene relocation and derived presentation fields are not plate dependencies', () => {
  const compiled = { sourceHash: 'source', html: 'html', motionSpec: {}, frames: 30, fps: 30, width: 1280, height: 720 };
  const source = { compiled, entry: {}, identity: {}, timelineScene: { id: 's1', from: 10, durationInFrames: 30, motionCues: [{ phrase: 'result', frame: 20, seconds: 1 / 3 }] } };
  const effective = { ...source, timelineScene: { ...source.timelineScene, from: 110, background: { asset: 'derived-video' }, mediaOnly: true, motionCues: [{ phrase: 'result', frame: 120, seconds: 1 / 3 }] } };
  assert.equal(compositionFingerprint(source), compositionFingerprint(effective));
});

test('recipe normalization is stable for compiler input and preserves foreground and transitions', async t => {
  const { options, pkg, timeline } = await fixture(t);
  pkg.scenes[0].motion = { recipe: 'morph', seed: 12, cue_phrases: ['Result'], entry: 'fade' };
  pkg.scenes[0].foreground = [{ asset: 'a_logo' }];
  pkg.scenes[0].transitionOut = { type: 'crossfade', frames: 6 };
  const compile = options.compileComposition;
  options.compileComposition = input => {
    assert.equal(input.scene.motion.recipe, undefined);
    assert.equal(input.pkg.scenes[0].motion.recipe, undefined);
    return { ...compile(input), sourceHash: JSON.stringify(input.scene.motion) };
  };
  const first = await materializeCompositions(options);
  assert.deepEqual(first.pkg.scenes[0].foreground, pkg.scenes[0].foreground);
  assert.deepEqual(first.pkg.scenes[0].transitionOut, pkg.scenes[0].transitionOut);
  assert.deepEqual(first.pkg.scenes[0].motion.cue_phrases, ['Result']);
  assert.equal(pkg.scenes[0].motion.recipe, 'morph');
  const second = await materializeCompositions({ ...options, pkg: first.pkg, timeline: { ...timeline, scenes: timeline.scenes.map(scene => ({ ...scene, background: first.pkg.scenes[0].background, mediaOnly: true })) } });
  assert.equal(second.report.scenes[0].cache, 'hit');
  assert.deepEqual(second.pkg, first.pkg);
});

test('malicious package asset collision cannot reuse a valid worker cache', async t => {
  const { options, pkg, state } = await fixture(t);
  const first = await materializeCompositions(options);
  const assetId = first.report.scenes[0].assetId;
  const malicious = structuredClone(first.pkg);
  malicious.assets[assetId].notes = 'User-owned asset';
  await assert.rejects(materializeCompositions({ ...options, pkg: malicious }), /asset ID collision/);
  assert.equal(malicious.assets[assetId].notes, 'User-owned asset');
  const tampered = structuredClone(first.pkg);
  tampered.assets[assetId].sha256 = '0'.repeat(64);
  await assert.rejects(materializeCompositions({ ...options, pkg: tampered }), /asset ID collision/);
  const userCollision = structuredClone(pkg);
  userCollision.assets[assetId] = { file: 'assets/user-video.mp4', kind: 'video', origin: 'upload', status: 'ready' };
  await assert.rejects(materializeCompositions({ ...options, pkg: userCollision }), /asset ID collision/);
  assert.equal(state.renders, 1);
});

test('pruning requires explicit verified ownership and leaves disk artifacts and referenced plates intact', async t => {
  const { options, state, packageDir } = await fixture(t);
  const first = await materializeCompositions(options);
  const oldId = first.report.scenes[0].assetId;
  const oldFile = join(packageDir, first.report.scenes[0].file);
  state.sourceHash = 'new-source';
  const pruned = await materializeCompositions({ ...options, pkg: first.pkg });
  assert.equal(Object.keys(pruned.pkg.assets).length, 1);
  assert.equal(pruned.pkg.assets[oldId], undefined);
  assert.ok(first.pkg.assets[oldId], 'caller asset registry unchanged');
  assert.equal(await readFile(oldFile, 'utf8'), 'fake-video-unique-content');
  const referenced = structuredClone(first.pkg);
  referenced.scenes[0].foreground = [{ asset: oldId }];
  const preserved = await materializeCompositions({ ...options, pkg: referenced });
  assert.ok(preserved.pkg.assets[oldId], 'referenced old plate remains');
  const unowned = structuredClone(first.pkg);
  unowned.assets[oldId].notes = 'User asset, keep this';
  const userPreserved = await materializeCompositions({ ...options, pkg: unowned });
  assert.equal(userPreserved.pkg.assets[oldId].notes, 'User asset, keep this');
});

test('async cache collector ignores ordinary videos without a manifest or runtime configuration', async () => {
  const collected = collectCompositionCacheExtras({ assets: { ordinary: { kind: 'video', file: 'assets/ordinary.mp4' } } }, '/does-not-need-to-exist');
  assert.ok(collected instanceof Promise);
  assert.deepEqual(await collected, []);
});

test('portable cache extras round-trip effective package with sanitized receipts and cache hits', async t => {
  const { options, state, packageDir } = await fixture(t);
  state.check.saved = { report: '/private/runtime/check.json', revision: '/private/runtime/revision' };
  state.check.motion.specPath = '/private/runtime/index.motion.json';
  state.check.snapshots = { files: ['/private/runtime/frame.png'], findingFiles: ['/private/runtime/finding.png'] };
  state.check.layout.findings = [{ severity: 'warning', code: 'sampled-note', message: 'Local file /private/runtime/frame.png inspected', file: '/private/runtime/frame.png' }];
  const first = await materializeCompositions(options);
  const sourceBefore = structuredClone(first.pkg);
  const metadataPath = join(packageDir, first.report.scenes[0].file.replace(/\.mp4$/, '.composition.json'));
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.identity = { browser: '/private/runtime/chrome' };
  metadata.completeReport = { path: '/private/runtime/report.json' };
  await writeFile(metadataPath, JSON.stringify(metadata));
  const extras = await collectCompositionCacheExtras(first.pkg, packageDir);
  assert.equal(extras.length, 3);
  assert.ok(extras.every(extra => /^assets\/derived\/[a-f0-9]{64}\.composition\.(?:json|html|motion\.json)$/.test(extra.path) && Buffer.isBuffer(extra.data)));
  const exported = JSON.parse(extras.find(extra => extra.path.endsWith('.composition.json')).data);
  assert.equal(exported.check.saved, undefined);
  assert.equal(exported.check.motion.specPath, undefined);
  assert.equal(exported.check.snapshots, undefined);
  assert.equal(exported.identity, undefined);
  assert.equal(exported.completeReport, undefined);
  assert.equal(exported.check.layout.findings[0].code, 'sampled-note');
  assert.doesNotMatch(JSON.stringify(exported), /\/private\/runtime/);
  assert.deepEqual(JSON.parse(await readFile(metadataPath)), metadata, 'collector does not rewrite source receipt');
  assert.deepEqual(first.pkg, sourceBefore);
  const destination = await mkdtemp('/tmp/opencode/composition-roundtrip-');
  t.after(() => rm(destination, { recursive: true, force: true }));
  for (const asset of Object.values(first.pkg.assets)) {
    await mkdir(dirname(join(destination, asset.file)), { recursive: true });
    await writeFile(join(destination, asset.file), await readFile(join(packageDir, asset.file)));
  }
  for (const extra of extras) await writeFile(join(destination, extra.path), extra.data);
  await writeFile(join(destination, 'package.json'), JSON.stringify(first.pkg));
  const restored = await materializeCompositions({ ...options, packageDir: destination, pkg: first.pkg });
  assert.equal(restored.report.scenes[0].cache, 'hit');
  assert.equal(restored.report.fingerprint, first.report.fingerprint);
  assert.deepEqual(restored.pkg, first.pkg);
  assert.equal(state.renders, 1);
});

test('cache extras reject tampered owned source, video, provenance, and symlinked artifacts', async t => {
  const { options, packageDir } = await fixture(t);
  const first = await materializeCompositions(options);
  const scene = first.report.scenes[0];
  const htmlPath = join(packageDir, scene.source.html);
  const html = await readFile(htmlPath);
  await writeFile(htmlPath, 'tampered HTML');
  await assert.rejects(collectCompositionCacheExtras(first.pkg, packageDir), /source hash mismatch/);
  await writeFile(htmlPath, html);
  const motionPath = join(packageDir, scene.source.motion);
  const motion = await readFile(motionPath);
  await writeFile(motionPath, '{"tampered":true}');
  await assert.rejects(collectCompositionCacheExtras(first.pkg, packageDir), /source hash mismatch/);
  await writeFile(motionPath, motion);
  const videoPath = join(packageDir, scene.file);
  const video = await readFile(videoPath);
  await writeFile(videoPath, 'tampered video');
  await assert.rejects(collectCompositionCacheExtras(first.pkg, packageDir), /video hash mismatch/);
  await writeFile(videoPath, video);
  const tampered = structuredClone(first.pkg);
  tampered.assets[scene.assetId].bytes++;
  await assert.rejects(collectCompositionCacheExtras(tampered, packageDir), /does not match/);
  const malformed = structuredClone(first.pkg);
  malformed.assets[scene.assetId].notes = 'comfyrizz-composition/v1; key invalid';
  await assert.rejects(collectCompositionCacheExtras(malformed, packageDir), /Inconsistent owned/);
  const userFile = join(packageDir, 'user.html');
  await writeFile(userFile, html);
  await rm(htmlPath);
  await symlink(userFile, htmlPath);
  await assert.rejects(collectCompositionCacheExtras(first.pkg, packageDir), /symlink/);
});

test('missing imported cache receipt gives actionable error and never clobbers its MP4', async t => {
  const { options, packageDir } = await fixture(t);
  const first = await materializeCompositions(options);
  const videoPath = join(packageDir, first.report.scenes[0].file);
  await rm(videoPath.replace(/\.mp4$/, '.composition.json'));
  await assert.rejects(collectCompositionCacheExtras(first.pkg, packageDir), /restore the cache extras/);
  await assert.rejects(materializeCompositions({ ...options, pkg: first.pkg }), /missing cache receipt; restore composition cache extras/);
  assert.equal(await readFile(videoPath, 'utf8'), 'fake-video-unique-content');
});

test('failed rendered checks include findings and never render or publish', async t => {
  const { options, state, packageDir } = await fixture(t);
  state.check.ok = false;
  state.check.layout.findings.push({ severity: 'error', code: 'canvas_overflow', selector: '#title', time: 0.5 });
  const events = [];
  await assert.rejects(materializeCompositions({ ...options, onEvent: event => events.push(event) }), error =>
    error.check?.layout.findings[0].code === 'canvas_overflow' && /canvas_overflow #title at 0.5s/.test(error.message));
  assert.equal(events.at(-1).stage, 'failed');
  assert.equal(events.at(-1).findings[0].selector, '#title');
  assert.equal(state.renders, 0);
  assert.deepEqual(await readdir(join(packageDir, 'assets/derived')), []);
});

test('positive frame shortfall, wrong fps and audio fail exact probe verification', async t => {
  const { options, state, packageDir } = await fixture(t);
  state.probe = probeResult(29);
  await assert.rejects(materializeCompositions(options), /shortfall 1/);
  assert.deepEqual(await readdir(join(packageDir, 'assets/derived')), []);
  const compiled = { frames: 30, fps: 30, width: 1280, height: 720 };
  const rate = probeResult(); rate.streams[0].avg_frame_rate = '24/1';
  assert.throws(() => verifyCompositionProbe(rate, compiled), /frame rate/);
  const audio = probeResult(); audio.streams.push({ codec_type: 'audio' });
  assert.throws(() => verifyCompositionProbe(audio, compiled), /silent/);
});

test('symlinked derived directory is rejected and no user files are overwritten', async t => {
  const { options, packageDir } = await fixture(t);
  await mkdir(join(packageDir, 'assets'));
  await mkdir(join(packageDir, 'user-files'));
  await symlink(join(packageDir, 'user-files'), join(packageDir, 'assets/derived'));
  await assert.rejects(materializeCompositions(options), /symlink/);
  assert.deepEqual(await readdir(join(packageDir, 'user-files')), []);
});

test('unowned cache artifacts cause a collision error rather than overwrite', async t => {
  const { options, packageDir } = await fixture(t);
  const first = await materializeCompositions(options);
  const video = join(packageDir, first.report.scenes[0].file);
  const metadata = video.replace(/\.mp4$/, '.composition.json');
  await rm(metadata);
  await writeFile(video, 'user-owned');
  await assert.rejects(materializeCompositions(options), /unowned/);
  assert.equal(await readFile(video, 'utf8'), 'user-owned');
});

test('abort during render publishes no plate and clears temporary files', async t => {
  const { options, packageDir } = await fixture(t);
  const controller = new AbortController();
  const command = options.command;
  options.signal = controller.signal;
  options.command = async (bin, args, config) => {
    if (args[1] === 'render') { controller.abort(new Error('cancel-render')); config.signal.throwIfAborted(); }
    return command(bin, args, config);
  };
  await assert.rejects(materializeCompositions(options), /cancel-render/);
  assert.deepEqual(await readdir(join(packageDir, 'assets/derived')), []);
});

test('CLI version and Node requirements are verified without package-manager installs', async t => {
  const { options, packageDir } = await fixture(t);
  delete options.resolveRuntime;
  const cli = join(packageDir, 'cli.mjs');
  const browser = join(packageDir, 'browser');
  await writeFile(cli, 'cli'); await writeFile(browser, 'browser');
  options.env = { COMFYRIZZ_HYPERFRAMES_CLI: cli, HYPERFRAMES_BROWSER_PATH: browser, SECRET_TOKEN: 'must-not-inherit' };
  options.command = async (_bin, args, config) => {
    assert.equal(config.env.SECRET_TOKEN, undefined);
    assert.equal(config.env.HYPERFRAMES_NO_TELEMETRY, '1');
    return { code: 0, stdout: args.length === 1 ? 'v22.19.0' : '0.8.180' };
  };
  await assert.rejects(materializeCompositions(options), /pinned to 0.8.181/);
  options.command = async () => ({ code: 0, stdout: 'v20.19.0' });
  await assert.rejects(materializeCompositions(options), /requires Node 22/);
});

test('process cancellation kills SIGTERM-resistant descendants even when leader exits', { skip: process.platform === 'win32' }, async t => {
  const { packageDir } = await fixture(t);
  const pidFile = join(packageDir, 'descendant.pid');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const running = compositionCommand(process.execPath, ['-e', leader], { signal: controller.signal, timeoutMs: 5000, killGraceMs: 50 });
  // Register rejection handling before aborting to avoid an unhandled rejection.
  const rejection = assert.rejects(running, /stop-composition/);
  let pid;
  for (let n = 0; n < 150; n++) {
    try { pid = Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(10); }
  }
  assert.ok(pid, 'descendant started');
  controller.abort(new Error('stop-composition'));
  await rejection;
  let runningChild = true;
  for (let n = 0; n < 100; n++) {
    try { runningChild = !/\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8')); } catch { runningChild = false; }
    if (!runningChild) break;
    await delay(10);
  }
  assert.equal(runningChild, false);
});

test('process timeout terminates a resistant worker', async () => {
  await assert.rejects(compositionCommand(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { timeoutMs: 100, killGraceMs: 20 }), /timed out/);
});
