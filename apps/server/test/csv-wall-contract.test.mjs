import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { createToolset } from '../../../packages/agent/dist/src/index.js';
import { csvWallProblems, repairCsvWallScenes, recoverCsvWallScene, requestsCsvWall, requestsTileLabels, visualClaimProblems } from '../src/csv-wall-contract.mjs';
import { applyProposalRevision } from '../src/proposal-revision.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { createContextAttachmentStore } from '../src/context-attachments.mjs';
import { replayProvider } from './fake-provider.mjs';

test('explicit per-record wall is replayed from its pinned CSV and can be created by scoped revision', () => {
  const text = readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url), 'utf8');
  const attachment = { id: 'ctx_0123456789abcdef', label: 'campaign.csv', text, contentHash: createHash('sha256').update(text).digest('hex') };
  const brief = 'Each tile represents one actual race start, in chronological order.';
  assert.equal(requestsCsvWall(brief), true);
  assert.equal(requestsCsvWall('Make a data story with a decorative tiled background.'), false);
  const tools = createToolset({ csvAttachments: [attachment] });
  const pkg = tools['storyboard.propose'].run({ brief: 'Data story', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 120 }, { id: 's2', layout: 'hero', preferredFrames: 120 }] }).package;
  assert.equal(csvWallProblems(pkg, brief, [attachment]).length, 1);
  const input = { scene_id: 's1', id: attachment.id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff00aa' }, { value: '2', color: '#aaaaaa' }, { value: '3', color: '#aaaaaa' }], rules: [], require_categories: ['1', '2', '3'], default_color: '#333333', background: '#000000', columns: 19 };
  assert.throws(() => applyProposalRevision(pkg, { edits: [], csvWallCreates: [input] }, 'Replace the wall with one tile per start.', [attachment]), /Name the scene/);
  const revised = applyProposalRevision(pkg, { edits: [], csvWallCreates: [input] }, 'Replace the wall in the first scene with one tile per start.', [attachment]);
  const drawing = revised.scenes[0].drawing;
  assert.equal(drawing.elements.length, 190);
  assert.equal(drawing.elements[189].color, '#ff00aa');
  assert.equal(drawing.source.sha256, attachment.contentHash);
  assert.deepEqual(revised.scenes[1], pkg.scenes[1]);
  assert.deepEqual(revised.assets, pkg.assets);
  assert.equal(revised.scenes[0].preferredFrames, pkg.scenes[0].preferredFrames);
  assert.deepEqual(csvWallProblems(revised, brief, [attachment]), []);
  const fake = structuredClone(revised);
  fake.scenes[0].drawing.elements[189].color = '#333333';
  assert.equal(csvWallProblems(fake, brief, [attachment]).length, 1);
  assert.equal(csvWallProblems(revised, brief, [{ ...attachment, text: 'tampered' }]).length, 1);
  assert.throws(() => applyProposalRevision(pkg, { edits: [], csvWallCreates: [input] }, 'Replace the wall in s1.', [{ ...attachment, text: 'tampered' }]), error => error.code === 'CSV_SOURCE_MISMATCH' && /pinned SHA-256/.test(error.message));
  assert.throws(() => applyProposalRevision(pkg, { edits: [], csvWallCreates: [input] }, 'Replace the wall in s1.', []), error => error.code === 'CSV_SOURCE_UNAVAILABLE');
  assert.throws(() => applyProposalRevision(pkg, { edits: [], csvWallCreates: [{ ...input, colors: [] }] }, 'Replace the wall in s1.', [attachment]), /uncategorized/);
});

test('source labels, explicit visual claims and scene targets are structurally checked', () => {
  const text = 'index,kind\n1,A\n2,B\n3,A\n4,B\n';
  assert.equal(requestsTileLabels('One tile per row labelled with its start number.'), true);
  const attachment = { id: 'ctx_0123456789abcdef', label: 'records.csv', text, contentHash: createHash('sha256').update(text).digest('hex') };
  const pkg = createToolset({ csvAttachments: [attachment] })['storyboard.propose'].run({ brief: 'Story', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }, { id: 's2', layout: 'hero', preferredFrames: 90 }] }).package;
  const input = { scene_id: 's2', id: attachment.id, filters: [], category_column: 'kind', colors: [{ value: 'A', color: '#ffffff' }, { value: 'B', color: '#0000ff' }], rules: [], require_categories: [], default_color: '#333333', background: '#000000', columns: 4, label_column: 'index' };
  assert.throws(() => applyProposalRevision(pkg, { edits: [], csvWallCreates: [input] }, 'Create a tile wall in the first scene.', [attachment]), /explicitly named/);
  const revised = applyProposalRevision(pkg, { edits: [], csvWallCreates: [input] }, 'Create a tile wall in the second scene; every tile is labeled.', [attachment]);
  assert.deepEqual(revised.scenes[1].drawing.elements.filter(e => e.type === 'text').map(e => e.text), ['1', '2', '3', '4']);
  assert.deepEqual(csvWallProblems(revised, 'One tile per record; every tile is labeled.', [attachment]), []);
  const unlabelled = applyProposalRevision(pkg, { edits: [], csvWallCreates: [{ ...input, label_column: undefined }] }, 'Create a tile wall in s2.', [attachment]);
  const labeled = applyProposalRevision(unlabelled, { edits: [], csvWalls: [{ scene_id: 's2', label_column: 'index', colors: input.colors, rules: [], require_categories: [] }] }, 'Label each tile in s2.', [attachment]);
  assert.deepEqual(labeled.scenes[1].drawing.elements.filter(e => e.type === 'text').map(e => e.text), ['1', '2', '3', '4']);
  const missing = structuredClone(revised);
  missing.scenes[1].drawing.elements.pop();
  assert.equal(csvWallProblems(missing, 'One tile per record; every tile is labeled.', [attachment]).length, 1);
  missing.datasets = { d: { note: 'Every tile is labeled with its index.' } };
  assert.match(visualClaimProblems(missing, [attachment]).join(' '), /no source-bound wall/);
  missing.scenes[0].narration = 'Four tiles show the results.';
  assert.match(visualClaimProblems(missing, [attachment]).join(' '), /Scene s1/);
  missing.scenes[0].narration = 'The story is built on results.';
  assert.doesNotMatch(visualClaimProblems(missing, [attachment]).join(' '), /Scene s1/);
});

test('agent repairs a missing source wall instead of accepting a decorative drawing', async t => {
  const root = mkdtempSync('/tmp/opencode/wall-agent-');
  const conversationId = 'chat_wall_repair001';
  const store = createContextAttachmentStore({ rootDir: root, chatId: conversationId });
  const { record } = store.addFile({ bytes: readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url)), filename: 'campaign.csv', mime: 'text/csv' });
  const brief = 'Each tile represents one actual race start, in chronological order.';
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief, scenes: [{ id: 's1', layout: 'hero', preferredFrames: 120 }] } },
    { name: 'storyboard.draw', args: { scene_id: 's1', drawing: { background: '#000000', elements: [{ type: 'rect', x: 100, y: 100, width: 20, height: 20, color: '#ffffff', start: 0, end: 0 }] } } },
    null,
    { name: 'storyboard.csv_tile_wall', args: { scene_id: 's1', id: record.id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff00aa' }], rules: [], require_categories: ['1'], default_color: '#333333', background: '#000000', columns: 19 } },
    null,
  ]);
  t.after(async () => { await provider.close(); rmSync(root, { recursive: true, force: true }); });
  const events = [];
  const result = await createCpuAgentRunner({ runtimeDir: root, providers: { custom: { baseUrl: provider.url } } })({ brief, provider: 'custom', conversationId, sessionId: 'wall-repair', onEvent: e => events.push(e) });
  assert.match(events.find(e => e.phase === 'initial' && e.status === 'validation').problems.join(' '), /source-bound wall/);
  assert.equal(result.package.scenes[0].drawing.elements.length, 190);
  assert.equal(result.package.scenes[0].drawing.elements[189].color, '#ff00aa');
});

test('replays a verified wall into the captured s11 decorative-grid target, refusing ambiguity and stale sources', () => {
  const text = readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url), 'utf8');
  const hash = createHash('sha256').update(text).digest('hex');
  assert.equal(hash, 'eb9561f8100be27146f219d865767d92e8cba6cad4c9e28ed923c32655ede941');
  const attachment = { id: 'ctx_eb9561f8100be271', label: 'perez-first-190-starts.csv', text, contentHash: hash };
  const brief = 'Each tile represents one actual race start, in chronological order.';
  const tools = createToolset({ csvAttachments: [attachment] });
  tools['storyboard.propose'].run({ brief, scenes: [{ id: 's3', layout: 'hero', preferredFrames: 120 }, { id: 's11', layout: 'hero', preferredFrames: 120 }] });
  const args = { scene_id: 's3', id: attachment.id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff2d7a' }, { value: '2', color: '#f2ede4' }, { value: '3', color: '#f2ede4' }], rules: [], require_categories: ['1', '2', '3'], default_color: '#2a2a2f', background: '#0a0a0b', columns: 19 };
  const pkg = structuredClone(tools['storyboard.csv_tile_wall'].run(args).package);
  pkg.assets = { a_grid: { gen: { caption: 'Abstract grid wall pattern of small graphite tiles on black, one single tile rendered vivid pink, restrained mechanical data-motif, no text' } }, a_other: { gen: { caption: 'P1 stamp' } } };
  pkg.scenes[1].foreground = [{ asset: 'a_grid' }, { asset: 'a_other' }];
  assert.match(csvWallProblems(pkg, brief, [attachment]).join(' '), /Scene s11/);
  const repaired = repairCsvWallScenes(pkg, brief, [attachment]);
  assert.deepEqual(repaired.sceneIds, ['s11']);
  assert.deepEqual(repaired.package.scenes[0], pkg.scenes[0]);
  assert.deepEqual(repaired.package.scenes[1].foreground, [{ asset: 'a_other' }]);
  assert.deepEqual(repaired.package.scenes[1].drawing, pkg.scenes[0].drawing);
  assert.equal(repaired.package.scenes[1].drawing.elements.filter(e => e.type === 'rect').length, 190);
  assert.deepEqual(csvWallProblems(repaired.package, brief, [attachment]), []);
  assert.deepEqual(repairCsvWallScenes(pkg, brief, [{ ...attachment, text: text + 'x' }]).sceneIds, []);
  const occupied = structuredClone(pkg); occupied.scenes[1].drawing = { background: '#000000', elements: [] };
  assert.deepEqual(repairCsvWallScenes(occupied, brief, [attachment]).sceneIds, []);
  const different = createToolset({ initialPackage: pkg, csvAttachments: [attachment] })['storyboard.csv_tile_wall'].run({ ...args, scene_id: 's11', default_color: '#111111' }).package;
  different.scenes.push({ ...pkg.scenes[1], id: 's12' });
  assert.deepEqual(repairCsvWallScenes(different, brief, [attachment]).sceneIds, []);
  const tooShort = structuredClone(pkg); tooShort.scenes[0].preferredFrames = 120;
  const animated = createToolset({ initialPackage: tooShort, csvAttachments: [attachment] })['storyboard.csv_tile_wall'].run({ ...args, reveal_frames: 100 }).package;
  animated.scenes[1].preferredFrames = 60;
  assert.deepEqual(repairCsvWallScenes(animated, brief, [attachment]).sceneIds, []);
});

test('runner replays a source wall after repair adds the captured decorative grid', async t => {
  const root = mkdtempSync('/tmp/opencode/wall-replay-');
  const conversationId = 'chat_wall_replay001';
  const store = createContextAttachmentStore({ rootDir: root, chatId: conversationId });
  const { record } = store.addFile({ bytes: readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url)), filename: 'perez-first-190-starts.csv', mime: 'text/csv' });
  const brief = 'Each tile represents one actual race start, in chronological order.';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#222222"/><circle cx="50" cy="50" r="10" fill="#ff2d7a"/></svg>';
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief, scenes: [{ id: 's3', layout: 'hero', preferredFrames: 120 }, { id: 's11', layout: 'split', preferredFrames: 120 }] } },
    { name: 'storyboard.csv_tile_wall', args: { scene_id: 's3', id: record.id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff2d7a' }], rules: [], require_categories: ['1'], default_color: '#2a2a2f', background: '#0a0a0b', columns: 19 } },
    null,
    { name: 'storyboard.edit', args: { scene_id: 's11', patch: { layout: 'hero' } } },
    { name: 'assets.generate_svg', args: { scene_id: 's11', kind: 'pattern', intent: 'Abstract grid wall pattern of small graphite tiles on black, one single tile rendered vivid pink, restrained mechanical data-motif, no text' } },
    null,
  ], { svgText: svg });
  t.after(async () => { await provider.close(); rmSync(root, { recursive: true, force: true }); });
  const events = [];
  const result = await createCpuAgentRunner({ runtimeDir: root, providers: { custom: { baseUrl: provider.url } } })({ brief, provider: 'custom', conversationId, onEvent: event => events.push(event) });
  assert.ok(events.some(event => event.phase === 'initial' && event.status === 'validation' && event.problems.some(problem => problem.includes('SEM_LAYOUT_REQUIRES_MEDIA'))));
  const repairRequest = provider.requests.find(request => JSON.stringify(request.messages).includes('Validation report: the current motion-graphics package is incomplete'));
  assert.ok(repairRequest.tools.some(tool => tool.function.name === 'storyboard_csv_tile_wall'));
  assert.deepEqual(events.find(event => event.status === 'csv_wall_replay')?.sceneIds, ['s11']);
  const scene = result.package.scenes.find(item => item.id === 's11');
  assert.equal(scene.drawing.source.sha256, record.contentHash);
  assert.equal(scene.drawing.elements.filter(item => item.type === 'rect').length, 190);
  assert.deepEqual(csvWallProblems(result.package, brief, [{ ...record, text: readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url), 'utf8') }]), []);
});

test('captured s3 repair grid gets one scoped source-wall turn when existing recipes conflict', async () => {
  const progress = JSON.parse(readFileSync(new URL('./fixtures/data-story-csvsequence-s3.json', import.meta.url), 'utf8'));
  const grid = progress.toolCall;
  assert.match(progress.problems[0], /Scene s3/);
  const text = readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url), 'utf8');
  const attachment = { id: 'ctx_eb9561f8100be271', label: 'perez-first-190-starts.csv', text, contentHash: createHash('sha256').update(text).digest('hex') };
  const brief = readFileSync(new URL('./fixtures/data-story-csvsequence-brief.txt', import.meta.url), 'utf8');
  const tools = createToolset({ csvAttachments: [attachment] });
  tools['storyboard.propose'].run({ brief, scenes: [{ id: 's3', layout: 'hero', preferredFrames: 96 }, { id: 's4', layout: 'hero', preferredFrames: 132 }, { id: 's9', layout: 'hero', preferredFrames: 96 }] });
  const args = { scene_id: 's4', id: attachment.id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff1f7a' }, { value: '2', color: '#f2ede4' }, { value: '3', color: '#f2ede4' }], require_categories: ['1', '2', '3'], default_color: '#1d1f22', background: '#0b0b0d', columns: 19 };
  tools['storyboard.csv_tile_wall'].run(args);
  const pkg = structuredClone(tools['storyboard.csv_tile_wall'].run({ ...args, scene_id: 's9', columns: 20 }).package);
  pkg.scenes[0].layout = 'stat';
  pkg.assets = { grid: { gen: { caption: grid.intent } } };
  pkg.scenes[0].foreground = [{ asset: 'grid' }];
  assert.match(csvWallProblems(pkg, brief, [attachment]).join(' '), /Scene s3/);
  assert.deepEqual(repairCsvWallScenes(pkg, brief, [attachment]).sceneIds, []);
  let request;
  const { id, scene_id, ...recipe } = args;
  const model = { async *stream(input) { request = input; yield { type: 'tool_call', name: 'storyboard.csv_tile_wall', id: '1', args: recipe }; yield { type: 'usage', input: 100, output: 20 }; yield { type: 'done' }; } };
  const result = await recoverCsvWallScene({ pkg, brief, attachments: [attachment], model, sessionId: 'test' });
  assert.deepEqual(request.tools.map(t => t.name), ['storyboard.csv_tile_wall']);
  assert.match(request.messages[0].content, /scene s3/i);
  assert.equal(request.tools[0].parameters.properties.id, undefined);
  assert.equal(request.tools[0].parameters.properties.scene_id, undefined);
  assert.deepEqual(result.sceneIds, ['s3']);
  assert.equal(result.package.scenes[0].drawing.elements.length, 190);
  assert.equal(result.package.scenes[0].drawing.elements[189].color, '#ff1f7a');
  assert.equal(result.package.scenes[0].drawing.elements[18].color, '#f2ede4');
  assert.deepEqual(result.package.scenes[0].foreground, []);
  assert.deepEqual(result.package.scenes.slice(1), pkg.scenes.slice(1));
  assert.deepEqual(csvWallProblems(result.package, brief, [attachment]), []);
  const wrong = { async *stream() { yield { type: 'tool_call', name: 'storyboard.csv_tile_wall', args: { ...args, scene_id: 's4' } }; } };
  const rejected = await recoverCsvWallScene({ pkg, brief, attachments: [attachment], model: wrong });
  assert.equal(rejected.package, pkg);
  assert.match(rejected.reason, /override/);
  assert.match((await recoverCsvWallScene({ pkg, brief, attachments: [{ ...attachment, text: 'changed' }], model })).reason, /unavailable|changed/);
  const wrongId = { async *stream() { yield { type: 'tool_call', name: 'storyboard.csv_tile_wall', args: { ...recipe, id: 'wall_starts' } }; } };
  assert.match((await recoverCsvWallScene({ pkg, brief, attachments: [attachment], model: wrongId })).reason, /override/);
  let called = false;
  const noCall = { async *stream() { called = true; } };
  assert.match((await recoverCsvWallScene({ pkg, brief: 'Each tile represents one actual race start.', attachments: [attachment, { ...attachment, id: 'ctx_other', label: 'other.csv' }], model: noCall })).reason, /exactly one referenced/);
  assert.match((await recoverCsvWallScene({ pkg, brief: `${brief} ${attachment.label}`, attachments: [attachment, { ...attachment, label: 'other.csv' }], model: noCall })).reason, /unambiguous/);
  assert.match((await recoverCsvWallScene({ pkg, brief, attachments: [attachment], model: noCall, targetSceneIds: ['s9'] })).reason, /exactly one affected scene/);
  assert.equal(called, false);
  const missingFilters = { async *stream() { const { filters, ...incomplete } = recipe; yield { type: 'tool_call', name: 'storyboard.csv_tile_wall', args: incomplete }; } };
  assert.match((await recoverCsvWallScene({ pkg, brief, attachments: [attachment], model: missingFilters })).reason, /filters/);
});

test('runner performs only one focused turn for the captured post-repair s3 grid and reports an actionable failure', async t => {
  const root = mkdtempSync('/tmp/opencode/wall-target-');
  const conversationId = 'chat_wall_target001';
  const store = createContextAttachmentStore({ rootDir: root, chatId: conversationId });
  const { record } = store.addFile({ bytes: readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url)), filename: 'perez-first-190-starts.csv', mime: 'text/csv' });
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/data-story-csvsequence-s3.json', import.meta.url), 'utf8'));
  const brief = 'Each tile represents one actual race start in chronological order. Pink for the win; graphite for the rest.';
  const args = { id: record.id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff1f7a' }], require_categories: ['1'], default_color: '#1d1f22', background: '#0b0b0d', columns: 19 };
  const initial = [
    { name: 'storyboard.propose', args: { brief, scenes: ['s3', 's4', 's9'].map(id => ({ id, layout: id === 's3' ? 'split' : 'hero', preferredFrames: 120 })) } },
    { name: 'storyboard.csv_tile_wall', args: { ...args, scene_id: 's4' } },
    { name: 'storyboard.csv_tile_wall', args: { ...args, scene_id: 's9', columns: 20 } }, null,
    { name: 'storyboard.edit', args: { scene_id: 's3', patch: { layout: 'hero' } } },
    { name: 'assets.generate_svg', args: recorded.toolCall }, null,
  ];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1d1f22"/></svg>';
  const { id, ...recipe } = args;
  const provider = await replayProvider([...initial, { name: 'storyboard.csv_tile_wall', args: recipe }], { svgText: svg });
  t.after(async () => { await provider.close(); rmSync(root, { recursive: true, force: true }); });
  const events = [];
  const runner = createCpuAgentRunner({ runtimeDir: root, providers: { custom: { baseUrl: provider.url } } });
  const result = await runner({ brief, provider: 'custom', conversationId, onEvent: event => events.push(event) });
  assert.ok(events.some(event => event.status === 'csv_wall_targeted'));
  assert.equal(result.package.scenes.find(scene => scene.id === 's3').drawing.elements.length, 190);
  const focused = provider.requests.filter(request => JSON.stringify(request.messages).includes('Validation target: scene s3'));
  assert.equal(focused.length, 1);
  assert.deepEqual(focused[0].tools.map(tool => tool.function.name), ['storyboard_csv_tile_wall']);
  provider.setCalls(initial);
  await assert.rejects(runner({ brief, provider: 'custom', conversationId }), error => {
    assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');
    assert.match(error.message, /exactly one storyboard.csv_tile_wall call/);
    assert.match(error.message, /filters and category colors/);
    return true;
  });
});

test('s8 failed wrong attachment id and missing background recover with a server-bound recipe', async t => {
  const root = mkdtempSync('/tmp/opencode/wall-s8-');
  const conversationId = 'chat_wall_s8_test001';
  const store = createContextAttachmentStore({ rootDir: root, chatId: conversationId });
  const bytes = readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url));
  const { record } = store.addFile({ bytes, filename: 'perez-first-190-starts.csv', mime: 'text/csv' });
  const brief = 'Each tile represents one actual race start, in chronological order. Pink for the win, graphite for the rest.';
  const recipe = { filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff1f7a' }], require_categories: ['1'], default_color: '#1d1f22', columns: 19 };
  const initial = [
    { name: 'storyboard.propose', args: { brief, scenes: [{ id: 's8', layout: 'hero', preferredFrames: 120 }] } },
    { name: 'storyboard.edit', args: { scene_id: 's8', patch: { background: '#0A0A0A' } } },
    null,
    { name: 'storyboard.csv_tile_wall', args: { ...recipe, id: 'wall_starts', scene_id: 's8' } },
    { name: 'storyboard.csv_tile_wall', args: { ...recipe, id: 'wall_starts', scene_id: 's8', background: '#0A0A0A' } }, null,
  ];
  const provider = await replayProvider([...initial, { name: 'storyboard.csv_tile_wall', args: recipe }]);
  t.after(async () => { await provider.close(); rmSync(root, { recursive: true, force: true }); });
  const events = [];
  const result = await createCpuAgentRunner({ runtimeDir: root, providers: { custom: { baseUrl: provider.url } } })({ brief, provider: 'custom', conversationId, onEvent: event => events.push(event) });
  const wall = result.package.scenes.find(scene => scene.id === 's8').drawing;
  assert.equal(wall.source.id, record.id);
  assert.equal(wall.source.sha256, record.contentHash);
  assert.equal(wall.background, result.package.theme.palette[0]);
  assert.equal(wall.elements.length, 190);
  assert.deepEqual(csvWallProblems(result.package, brief, [{ ...record, text: bytes.toString('utf8') }]), []);
  const focused = provider.requests.filter(request => JSON.stringify(request.messages).includes('Validation target: scene s8'));
  assert.equal(focused.length, 1);
  const params = focused[0].tools[0].function.parameters;
  assert.equal(params.properties.id, undefined);
  assert.equal(params.properties.scene_id, undefined);
  assert.ok(!params.required.includes('background'));
  assert.ok(params.required.includes('filters') && params.required.includes('colors') && params.required.includes('default_color'));
  assert.equal(events.filter(event => event.phase === 'csv_wall_recovery' && event.type === 'tool_call').length, 1);
  assert.equal(events.find(event => event.phase === 'csv_wall_recovery' && event.type === 'tool_call').args.id, record.id);
});
