import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  compileComposition, validateCompositionManifest, loadCompositionManifest,
  collectCompositionExtras, MAX_MANIFEST_BYTES,
} from '../src/index.mjs';

const pkg = {
  scenes: [{ id: 's1' }, { id: 's2' }], format: { width: 1280, height: 720, fps: 30 },
  datasets: { trial: { label: 'Measured trial', unit: 'ms', source: 'user', note: 'n=20; same device', values: [
    { label: 'Before', value: 125 }, { label: 'After', value: 75 }, { label: 'Delta', value: -50 },
  ] } },
};
const transfer = { sceneId: 's1', component: 'object-transfer', params: {
  title: 'Give the receipt a home', objectLabel: 'Receipt', fromLabel: 'Unassigned',
  toLabel: 'Project Atlas', resultLabel: 'Receipt assigned', qualifier: 'Illustrative workflow',
} };
const mechanism = { sceneId: 's1', component: 'mechanism-journey', params: {
  title: 'From heat to motion', signalLabel: 'Energy', resultLabel: 'The piston moves',
  stations: [
    { label: 'Heat', detail: 'The burner adds energy' },
    { label: 'Expansion', detail: 'Gas pressure rises' },
    { label: 'Force', detail: 'Pressure pushes the piston' },
    { label: 'Motion', detail: 'The shaft turns' },
  ],
} };
const evidence = { sceneId: 's1', component: 'evidence-reveal', params: {
  title: 'Measured latency', dataset: 'trial', rows: ['Before', 'After', 'Delta'],
  resultLabel: 'Latency fell by 50 ms', qualifier: 'One controlled trial',
} };
const manifest = entry => ({ version: 1, scenes: [entry] });
function compile(entry = transfer, overrides = {}) {
  return compileComposition({ entry, pkg, scene: pkg.scenes[0],
    timelineScene: { id: 's1', from: 100, durationInFrames: 120 },
    timeline: { fps: 30, width: 1280, height: 720, captions: [] }, ...overrides });
}
function runtime(output) {
  const elements = new Map([...output.html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], { style: {}, dataset: {} }]));
  let source;
  const document = { getElementById: id => elements.get(id), fonts: { ready: Promise.resolve() } };
  const window = { __hyperframes: { registerFrameSource: value => { source = value; } } };
  vm.runInNewContext(output.html.match(/<script>([\s\S]*)<\/script>/)[1], { document, window });
  assert.equal(source.element, elements.get('root'));
  return { elements, source, config: window.__comfyrizzComposition.config,
    frame(frame) { source.render(frame / output.fps); return JSON.stringify([...elements]); } };
}

test('manifest accepts curated data only and unique actual scene IDs', () => {
  for (const entry of [transfer, mechanism, evidence]) assert.equal(validateCompositionManifest(manifest(entry), pkg).version, 1);
  const invalid = [
    { version: 2, scenes: [] },
    { version: 1, scenes: [transfer, transfer] },
    manifest({ ...transfer, sceneId: 'unknown' }),
    manifest({ ...transfer, component: 'html' }),
    manifest({ ...transfer, html: '<script>bad()</script>' }),
    manifest({ ...transfer, params: { ...transfer.params, file: 'secret.html' } }),
    manifest({ ...transfer, params: { ...transfer.params, url: 'https://example.com' } }),
    manifest({ ...transfer, params: { ...transfer.params, title: '' } }),
    manifest({ ...transfer, cues: { inspection: { frame: 1 } } }),
    manifest({ ...transfer, cues: { action: { frame: 0.5 } } }),
    manifest({ ...mechanism, params: { ...mechanism.params, stations: [{ label: 'A', detail: 'B' }] } }),
  ];
  for (const value of invalid) assert.throws(() => validateCompositionManifest(value, pkg), /Composition:/);
});

test('evidence references exact labeled dataset rows and preserves values, units and qualifiers', () => {
  const output = compile(evidence);
  assert.match(output.html, /125 ms/);
  assert.match(output.html, /-50 ms/);
  assert.match(output.html, /n=20; same device/);
  assert.match(output.html, /Measured trial · user/);
  for (const rows of [['Missing', 'After'], ['Before', 'Before'], [125, 75]]) {
    assert.throws(() => compile({ ...evidence, params: { ...evidence.params, rows } }));
  }
  assert.throws(() => compile(evidence, { pkg: { ...pkg, datasets: { trial: { ...pkg.datasets.trial, source: 'example' } } } }), /approved/);
  assert.throws(() => compile(evidence, { pkg: { ...pkg, datasets: { trial: { ...pkg.datasets.trial, values: [...pkg.datasets.trial.values, { label: 'Before', value: 5 }] } } } }), /exactly one/);
  assert.throws(() => compile(evidence, { pkg: { ...pkg, datasets: { trial: { ...pkg.datasets.trial, values: [{ label: 'Before', value: Infinity }, ...pkg.datasets.trial.values.slice(1)] } } } }), /finite value/);
});

test('standalone source escapes HTML, script strings and theme injection without losing human text', () => {
  const malicious = '</script><script>alert("x")</script>&\u2028';
  const output = compile({ ...transfer, params: { ...transfer.params, title: malicious, objectLabel: '<img onerror=bad()>' } },
    { pkg: { ...pkg, theme: { text: 'red; background:url(https://bad)', palette: ['#000000', '</style>'] } } });
  assert.equal((output.html.match(/<script>/g) ?? []).length, 1);
  assert.match(output.html, /&lt;script&gt;alert/);
  assert.doesNotMatch(output.html, /<img|url\(|https:\/\/bad|<script src|@import/);
  assert.match(output.html, /font-family:ComfyrizzSystem;src:local\(/);
  assert.doesNotThrow(() => runtime(output));
});

test('frame source has exact duration and deterministic repeat, random and reverse seeks for every component', () => {
  for (const entry of [transfer, mechanism, evidence]) {
    const output = compile(entry);
    assert.deepEqual([output.frames, output.width, output.height, output.fps], [120, 1280, 720, 30]);
    assert.match(output.html, /data-no-timeline/);
    assert.match(output.html, /data-duration="4"/);
    assert.doesNotMatch(output.html, /gsap|requestAnimationFrame|setTimeout|Math.random|fetch\(/);
    const player = runtime(output);
    const snapshots = new Map([0, 1, 25, 26, 50, 75, 76, 90, 119].map(frame => [frame, player.frame(frame)]));
    for (const frame of [119, 75, 1, 90, 0, 26, 50, 119, 76, 25]) assert.equal(player.frame(frame), snapshots.get(frame));
    player.frame(player.config.result - 1);
    assert.equal(player.elements.get('result').style.opacity, '0');
    const held = player.frame(player.config.result);
    assert.equal(player.elements.get('result').style.opacity, '1');
    player.frame(119);
    // Dataset frame metadata changes, while all visual properties intentionally hold.
    const endStyles = [...player.elements].map(([id, node]) => [id, { ...node.style }]);
    player.frame(player.config.result);
    assert.deepEqual([...player.elements].map(([id, node]) => [id, { ...node.style }]), endStyles);
    assert.ok(held);
  }
});

test('negative bars grow from zero and retain exact final lengths', () => {
  const player = runtime(compile(evidence));
  const negative = player.config.bars[2];
  player.frame(player.config.action);
  assert.equal(player.elements.get('bar-2').style.left, `${negative.zero}px`);
  assert.equal(player.elements.get('bar-2').style.width, '0px');
  player.frame(player.config.result);
  assert.equal(player.elements.get('bar-2').style.left, `${negative.zero - negative.width}px`);
  assert.equal(player.elements.get('bar-2').style.width, `${negative.width}px`);
});

test('motion assertions account for upstream sampling without weakening exact native cue frames', () => {
  for (const frames of [120, 1200]) {
    const result = Math.floor((frames - 1) * 0.64);
    const output = compile(transfer, { timelineScene: { id: 's1', from: 100, durationInFrames: frames } });
    const sampleCount = Math.min(300, Math.ceil((frames / 30) * 20) + 1);
    const step = (frames / 30) / (sampleCount - 1);
    const deadline = output.motionSpec.assertions.find(item => item.kind === 'appearsBy').bySec;
    assert.ok(deadline >= result / 30);
    assert.ok(deadline < result / 30 + step + 0.002);
    const player = runtime(output);
    player.frame(result - 1);
    assert.equal(player.elements.get('result').style.opacity, '0');
    player.frame(result);
    assert.equal(player.elements.get('result').style.opacity, '1');
    assert.equal(output.diagnostics.find(item => item.code === 'COMPOSITION_NOT_BEFORE').frame, result);
  }
});

test('aspect reflow changes transfer axis and mechanism grid; content reserves caption bottom', () => {
  for (const [width, height, aspect] of [[1280, 720, 'landscape'], [720, 1280, 'portrait'], [720, 720, 'square']]) {
    const timeline = { fps: 24, width, height };
    const output = compile(transfer, { timeline });
    const player = runtime(output);
    assert.equal(player.config.dx > 0, aspect === 'landscape');
    assert.equal(player.config.dy > 0, aspect !== 'landscape');
    assert.equal(output.diagnostics.find(item => item.code === 'COMPOSITION_ASPECT').aspect, aspect);
    assert.match(output.html, /data-duration="5"/);
    assert.equal(output.diagnostics.find(item => item.code === 'COMPOSITION_ASPECT').captionSafeBottom, height * 0.8);
    const points = runtime(compile(mechanism, { timeline })).config.points;
    if (aspect === 'square') assert.equal(points[0].x, points[2].x);
    if (aspect === 'portrait') assert.equal(points[0].x, points[3].x);
    if (aspect === 'landscape') assert.equal(points[0].y, points[3].y);
    assert.ok(points.every(point => point.x > 0 && point.x < width && point.y > 0 && point.y < height * 0.625));
  }
});

test('cue resolution preserves explicit precedence, local integer frames and planner provenance', () => {
  const timelineScene = { id: 's1', from: 100, durationInFrames: 120, motionCues: [
    { phrase: 'move it', frame: 130, source: 'word-cues', estimated: true, timing: 'syllable-fallback', occurrence: 1 },
    { phrase: 'done', frame: 180, source: 'word-cues', estimated: false, timing: 'forced-alignment' },
  ] };
  const entry = { ...transfer, cues: { action: { phrase: 'Move it!' }, result: { phrase: 'done' } } };
  const output = compile(entry, { timelineScene });
  const cue = output.diagnostics.find(item => item.slot === 'action');
  assert.deepEqual([cue.frame, cue.source, cue.estimated, cue.timing], [30, 'word-cues', true, 'syllable-fallback']);
  assert.equal(output.diagnostics.find(item => item.slot === 'result').frame, 80);
  const explicit = compile({ ...entry, cues: { action: { frame: 20, phrase: 'missing' }, result: { frame: 90 } } });
  assert.equal(explicit.diagnostics.find(item => item.slot === 'action').source, 'explicit-frame');
  assert.throws(() => compile({ ...transfer, cues: { action: { phrase: 'not spoken' } } }), /no narration timing/);
  assert.throws(() => compile({ ...transfer, cues: { action: { frame: 120 } } }), /local cue frame/);
  assert.throws(() => compile({ ...transfer, cues: { action: { frame: 90 }, result: { frame: 20 } } }), /must follow/);
});

test('phrase cues resolve narration words or caption anchors with conservative provenance', () => {
  const entry = { ...transfer, cues: { action: { phrase: 'pressure rises' }, result: { phrase: 'shaft turns' } } };
  const captions = [
    { sceneId: 's2', from: 0, text: 'Pressure rises' },
    { sceneId: 's1', from: 110, estimated: false, timing: 'syllable-fallback', text: 'The pressure rises', words: [
      { text: 'The', from: 110 }, { text: 'pressure', from: 123 }, { text: 'rises', from: 130 },
    ] },
    { sceneId: 's1', from: 180, text: 'The shaft turns', estimated: true },
  ];
  const output = compile(entry, { scene: { id: 's1', narration: 'The pressure rises. The shaft turns.' }, timeline: { fps: 30, width: 1280, height: 720, captions } });
  assert.equal(output.diagnostics.find(item => item.slot === 'action').frame, 23);
  assert.equal(output.diagnostics.find(item => item.slot === 'action').estimated, true);
  assert.equal(output.diagnostics.find(item => item.slot === 'result').source, 'estimated-caption');
  assert.equal(output.diagnostics.find(item => item.slot === 'result').frame, 80);
});

test('display-only caption corrections cannot introduce or move sentence-level spoken cues', () => {
  const scene = { id: 's1', narration: 'The pressure rises. The shaft turns.' };
  const timeline = { fps: 30, width: 1280, height: 720, captions: [
    { sceneId: 's1', from: 110, text: 'The pressure rises.', estimated: false },
    { sceneId: 's1', from: 180, text: 'The shaft turns.', estimated: false },
  ] };
  const entry = { ...transfer, cues: { action: { phrase: 'pressure rises' }, result: { phrase: 'shaft turns' } } };
  const unchanged = compile(entry, { scene, timeline });
  assert.equal(unchanged.diagnostics.find(item => item.slot === 'result').frame, 80);
  const corrected = structuredClone(timeline);
  corrected.captions[1].text = 'The wheel spins.';
  assert.throws(() => compile({ ...entry, cues: { ...entry.cues, result: { phrase: 'wheel spins' } } }, { scene, timeline: corrected }), /cannot verify spoken text/);
  const moved = structuredClone(timeline);
  moved.captions[0].text = 'The shaft turns.';
  moved.captions[1].text = 'The pressure rises.';
  assert.throws(() => compile({ ...transfer, cues: { action: { phrase: 'shaft turns' }, result: { frame: 100 } } }, { scene, timeline: moved }), /cannot verify spoken text/);
  assert.throws(() => compile(entry, { timeline }), /cannot verify spoken text/);
});

test('original word timings survive display corrections and retain estimated-word provenance', () => {
  const scene = { id: 's1', narration: 'The pressure rises. The shaft turns.' };
  const timeline = { fps: 30, width: 1280, height: 720, captions: [
    { sceneId: 's1', from: 110, text: 'Completely corrected display wording', estimated: false, timing: 'syllable-fallback', words: [
      { text: 'The', from: 110 }, { text: 'pressure', from: 123 }, { text: 'rises', from: 130 },
    ] },
    { sceneId: 's1', from: 180, text: 'The shaft turns.', estimated: false, timing: 'syllable-fallback' },
  ] };
  const entry = { ...transfer, cues: { action: { phrase: 'pressure rises' }, result: { phrase: 'shaft turns' } } };
  const output = compile(entry, { scene, timeline });
  const action = output.diagnostics.find(item => item.slot === 'action');
  assert.deepEqual([action.frame, action.source, action.estimated, action.timing], [23, 'word-cues', true, 'syllable-fallback']);
  const result = output.diagnostics.find(item => item.slot === 'result');
  // A measured sentence start remains measured even if its unused word-timing
  // method is estimated; it must not claim word alignment without words[].
  assert.deepEqual([result.frame, result.source, result.estimated, result.timing], [80, 'measured-caption', false, undefined]);
  assert.throws(() => compile({ ...transfer, cues: { action: { phrase: 'corrected display' } } }, { scene, timeline }), /no narration timing/);
});

test('source hashes are key-order stable and change for content, frames, cues, data, theme and aspect', () => {
  const initial = compile();
  assert.equal(initial.sourceHash, compile({ params: transfer.params, component: transfer.component, sceneId: transfer.sceneId }).sourceHash);
  const variants = [
    compile({ ...transfer, params: { ...transfer.params, resultLabel: 'Edited result' } }),
    compile(transfer, { timelineScene: { id: 's1', from: 100, durationInFrames: 121 } }),
    compile({ ...transfer, cues: { result: { frame: 100 } } }),
    compile(transfer, { pkg: { ...pkg, theme: { text: '#ffeecc' } } }),
    compile(transfer, { timeline: { fps: 30, width: 720, height: 1280 } }),
  ];
  for (const value of variants) assert.notEqual(initial.sourceHash, value.sourceHash);
  const changedPkg = structuredClone(pkg);
  changedPkg.datasets.trial.values[1].value = 74;
  assert.notEqual(compile(evidence).sourceHash, compile(evidence, { pkg: changedPkg }).sourceHash);
  // Unrelated package edits should not invalidate this scene.
  assert.equal(initial.sourceHash, compile(transfer, { pkg: { ...pkg, title: 'Unrelated title' } }).sourceHash);
});

test('manifest loading and export bound size and reject external, dangling or directory symlinks', t => {
  const root = mkdtempSync('/tmp/opencode/compositions-test-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'package');
  mkdirSync(dir);
  assert.equal(loadCompositionManifest(dir, pkg), null);
  assert.deepEqual(collectCompositionExtras(pkg, dir), []);
  mkdirSync(join(dir, 'compositions'));
  assert.equal(loadCompositionManifest(dir, pkg), null);
  const path = join(dir, 'compositions/manifest.json');
  const data = Buffer.from(JSON.stringify(manifest(transfer)));
  writeFileSync(path, data);
  assert.deepEqual(loadCompositionManifest(dir, pkg), manifest(transfer));
  assert.deepEqual(collectCompositionExtras(pkg, dir), [{ path: 'compositions/manifest.json', data }]);
  writeFileSync(join(dir, 'compositions/ignored.html'), '<script>bad()</script>');
  assert.equal(collectCompositionExtras(pkg, dir).length, 1);
  writeFileSync(path, ' '.repeat(MAX_MANIFEST_BYTES + 1));
  assert.throws(() => loadCompositionManifest(dir, pkg), /at most/);
  rmSync(path);
  writeFileSync(join(root, 'external.json'), data);
  symlinkSync(join(root, 'external.json'), path);
  assert.throws(() => collectCompositionExtras(pkg, dir), /without symlinks/);
  rmSync(path);
  symlinkSync(join(root, 'missing.json'), path);
  assert.throws(() => loadCompositionManifest(dir, pkg));
  rmSync(join(dir, 'compositions'), { recursive: true });
  mkdirSync(join(root, 'external-folder'));
  symlinkSync(join(root, 'external-folder'), join(dir, 'compositions'));
  assert.throws(() => loadCompositionManifest(dir, pkg), /must not be a symlink/);
});

test('shared directories isolate scoped package sources and export their actual staging paths', t => {
  const root = mkdtempSync('/tmp/opencode/compositions-scoped-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = { ...pkg, id: 'project_A-1' };
  const second = { ...pkg, id: 'project_B', scenes: [{ id: 'different_scene' }] };
  const secondEntry = { ...transfer, sceneId: 'different_scene', params: { ...transfer.params, title: 'Independent project' } };
  const firstData = Buffer.from(JSON.stringify(manifest(transfer)));
  const secondData = Buffer.from(JSON.stringify(manifest(secondEntry)));
  for (const [project, data] of [[first, firstData], [second, secondData]]) {
    mkdirSync(join(root, 'compositions', project.id), { recursive: true });
    writeFileSync(join(root, 'compositions', project.id, 'manifest.json'), data);
  }
  assert.deepEqual(loadCompositionManifest(root, first), manifest(transfer));
  assert.deepEqual(loadCompositionManifest(root, second), manifest(secondEntry));
  assert.equal(loadCompositionManifest(root, { ...pkg, id: 'unrelated' }), null);
  assert.deepEqual(collectCompositionExtras({ ...pkg, id: 'unrelated' }, root), []);
  const extras = collectCompositionExtras(first, root);
  assert.deepEqual(extras, [{ path: 'compositions/project_A-1/manifest.json', data: firstData }]);
  assert.deepEqual(collectCompositionExtras(second, root), [{ path: 'compositions/project_B/manifest.json', data: secondData }]);
  const staging = join(root, 'staging');
  for (const extra of extras) {
    mkdirSync(join(staging, 'compositions', first.id), { recursive: true });
    writeFileSync(join(staging, extra.path), extra.data);
  }
  assert.deepEqual(loadCompositionManifest(staging, first), manifest(transfer));
  assert.deepEqual(collectCompositionExtras(first, staging), extras);
  // A scoped source takes precedence even when a generic standalone source exists.
  writeFileSync(join(root, 'compositions/manifest.json'), secondData);
  assert.deepEqual(loadCompositionManifest(root, first), manifest(transfer));
  const standalone = join(root, 'standalone');
  mkdirSync(join(standalone, 'compositions'), { recursive: true });
  writeFileSync(join(standalone, 'compositions/manifest.json'), firstData);
  assert.deepEqual(loadCompositionManifest(standalone, first), manifest(transfer));
  assert.equal(collectCompositionExtras(first, standalone)[0].path, 'compositions/manifest.json');
});

test('scoped lookup rejects unsafe IDs and intermediate or manifest symlinks', t => {
  const root = mkdtempSync('/tmp/opencode/compositions-scoped-path-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const id of ['../other', 'a/b', 'a\\b', '.', '..', '', 'project.json', 1, null]) {
    assert.throws(() => loadCompositionManifest(root, { ...pkg, id }), /package id must match/);
    assert.throws(() => collectCompositionExtras({ ...pkg, id }, root), /package id must match/);
  }
  const project = { ...pkg, id: 'safe' };
  mkdirSync(join(root, 'compositions'));
  mkdirSync(join(root, 'external'));
  writeFileSync(join(root, 'external/manifest.json'), JSON.stringify(manifest(transfer)));
  // The generic source must not mask a scoped-directory symlink.
  writeFileSync(join(root, 'compositions/manifest.json'), JSON.stringify(manifest(transfer)));
  symlinkSync(join(root, 'external'), join(root, 'compositions/safe'));
  assert.throws(() => loadCompositionManifest(root, project), /must not be a symlink/);
  assert.throws(() => collectCompositionExtras(project, root), /must not be a symlink/);
  rmSync(join(root, 'compositions/safe'));
  symlinkSync(join(root, 'missing'), join(root, 'compositions/safe'));
  assert.throws(() => loadCompositionManifest(root, project), /must not be a symlink/);
  rmSync(join(root, 'compositions/safe'));
  mkdirSync(join(root, 'compositions/safe'));
  symlinkSync(join(root, 'external/manifest.json'), join(root, 'compositions/safe/manifest.json'));
  assert.throws(() => loadCompositionManifest(root, project), /without symlinks/);
});
