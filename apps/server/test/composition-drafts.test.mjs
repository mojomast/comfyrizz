import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/app.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { loadCompositionManifest } from '../../../packages/compositions/src/index.mjs';
import { renderPackageIncremental } from '../../renderer/scripts/render-incremental.mjs';

const source = new URL('../../../examples/composition-stories/', import.meta.url);
const token = 'composition-drafts-test-token';

async function setup(t) {
  const runtimeDir = mkdtempSync('/tmp/opencode/composition-drafts-');
  const pkg = JSON.parse(readFileSync(new URL('package.json', source)));
  pkg.assets.a_marker = { kind: 'image', origin: 'upload', status: 'ready', file: 'assets/marker.png',
    sha256: createHash('sha256').update('original asset').digest('hex'),
    license: { id: 'CC0-1.0' }, redistributable: true };
  const calls = [];
  let failure = false;
  const render = async (path, output, options) => {
    const draft = JSON.parse(readFileSync(path));
    const dir = dirname(path);
    const manifest = loadCompositionManifest(dir, draft);
    calls.push({ path, dir, draft, manifest, options });
    if (draft.id === pkg.id) {
      assert.ok(manifest, 'existing projects must retain their manifest');
      assert.equal(readFileSync(join(dir, draft.assets.a_marker.file), 'utf8'), 'original asset');
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'media.json'))), { skipLayout: ['s_transfer'] });
    }
    if (failure) throw new Error('render deliberately failed');
    writeFileSync(output, 'test video');
    const timeline = compileTimeline(draft);
    return { output, bytes: 10, frames: timeline.durationInFrames, hash: timeline.hash, timeline, package: draft };
  };
  const app = createApp({ token, runtimeDir, render,
    // Exercise the actual incremental entry point while stubbing only the full renderer.
    renderScene: (path, output, options) => renderPackageIncremental(path, output, {
      ...options,
      renderFull: (input, target, opts) => {
        const draft = JSON.parse(readFileSync(input));
        assert.ok(loadCompositionManifest(dirname(input), draft));
        const timeline = compileTimeline(draft);
        calls.push({ path: input, dir: dirname(input), draft, manifest: loadCompositionManifest(dirname(input), draft) });
        writeFileSync(target, 'test video');
        return { output: target, bytes: 10, frames: timeline.durationInFrames, hash: timeline.hash, timeline, package: draft };
      },
      renderSegment: () => assert.fail('composition draft must not enter the segment renderer'),
    }),
  });
  app.store.seed(pkg);
  const dir = dirname(app.store.path(pkg.id));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'compositions'));
  writeFileSync(join(dir, 'assets/marker.png'), 'original asset');
  writeFileSync(join(dir, 'media.json'), JSON.stringify({ skipLayout: ['s_transfer'] }));
  const manifestPath = join(dir, 'compositions/manifest.json');
  writeFileSync(manifestPath, readFileSync(new URL('compositions/manifest.json', source)));
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-comfyrizz-token': token, origin: base,
    }, body: JSON.stringify(body) });
    const text = await response.text();
    // Client consumption and the server's finish/close cleanup are independent
    // event-loop callbacks. Assert eventual cleanup, not their scheduling order.
    const deadline = Date.now() + 2000;
    while (calls.some(call => existsSync(call.path)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return { status: response.status, headers: response.headers, text };
  };
  const assertClean = () => {
    assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('.draft-')), []);
    assert.deepEqual(app.store.read(pkg.id), pkg, 'draft edits never mutate the saved package');
  };
  return { app, pkg, dir, runtimeDir, calls, request, assertClean, manifestPath, fail: value => { failure = value; } };
}

test('draft full, scene and edited renders preserve project sources and clean temporary JSON', async t => {
  const h = await setup(t);
  const draft = structuredClone(h.pkg);
  draft.title = 'Unsaved title';
  for (const route of ['/api/render', '/api/scene/render', '/api/render/edited', '/api/render/edited']) {
    const result = await h.request(route, { package: draft, sceneId: 's_transfer' });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.text, 'test video');
    const call = h.calls.at(-1);
    assert.equal(call.dir, h.dir);
    assert.equal(call.draft.title, 'Unsaved title');
    assert.equal(call.manifest.scenes.length, 3);
    assert.equal(existsSync(call.path), false, 'temporary JSON is removed after response');
    if (route !== '/api/render') {
      assert.equal(result.headers.get('x-comfyrizz-full-render'), '1');
      assert.match(result.headers.get('x-comfyrizz-full-reason'), /compositions.*full render/);
    }
    h.assertClean();
  }
  assert.equal(existsSync(h.app.sceneCacheDir(draft.id)), false, 'no stale incremental cache is used');
});

test('draft export retains validated manifest and original assets in its archive', async t => {
  const h = await setup(t);
  // An empty, valid manifest exercises the exporter and archive without a browser runtime.
  writeFileSync(h.manifestPath, JSON.stringify({ version: 1, scenes: [] }));
  const result = await h.request('/api/export', { package: { ...h.pkg, title: 'Unsaved export' }, force: true });
  assert.equal(result.status, 200, result.text);
  const exported = JSON.parse(result.text);
  const zip = exported.files.find(file => file.name === 'package.zip').path;
  assert.deepEqual(JSON.parse(execFileSync('unzip', ['-p', zip, 'compositions/manifest.json'])), { version: 1, scenes: [] });
  assert.equal(execFileSync('unzip', ['-p', zip, 'assets/marker.png'], { encoding: 'utf8' }), 'original asset');
  assert.equal(JSON.parse(execFileSync('unzip', ['-p', zip, 'package.json'])).title, 'Unsaved export');
  assert.equal(h.calls.at(-1).dir, h.dir);
  assert.equal(h.calls.at(-1).options.final, true);
  h.assertClean();
});

test('failed draft rendering and invalid manifests clean up and never fall back to missing sources', async t => {
  const h = await setup(t);
  h.fail(true);
  const failed = await h.request('/api/render', { package: h.pkg });
  assert.equal(failed.status, 500);
  assert.match(failed.text, /render deliberately failed/);
  h.assertClean();
  h.fail(false);
  assert.equal((await h.request('/api/render', { package: h.pkg })).status, 200, 'busy state resets after failure');
  writeFileSync(h.manifestPath, '{"version":99,"scenes":[]}');
  const before = h.calls.length;
  for (const route of ['/api/export', '/api/scene/render', '/api/render/edited']) {
    const result = await h.request(route, { package: h.pkg, sceneId: 's_transfer', force: true });
    assert.equal(result.status, 500, result.text);
    assert.match(result.text, /manifest.version/);
    h.assertClean();
  }
  assert.equal(h.calls.length, before, 'invalid sources never reach the renderer');
});

test('draft IDs cannot escape the store; new unsaved IDs do not inherit stored source files', async t => {
  const h = await setup(t);
  for (const route of ['/api/render', '/api/export', '/api/scene/render', '/api/render/edited']) {
    const result = await h.request(route, { package: { ...h.pkg, id: '../outside' }, sceneId: 's_transfer' });
    assert.equal(result.status, 400, result.text);
    assert.match(result.text, /invalid package id/);
  }
  assert.equal(h.calls.length, 0);
  const result = await h.request('/api/render', { package: { ...h.pkg, id: 'pkg_unsaved_composition_draft' } });
  assert.equal(result.status, 200, result.text);
  assert.equal(h.calls.at(-1).dir, join(h.runtimeDir, 'renders'));
  assert.equal(h.calls.at(-1).manifest, null);
  assert.equal(existsSync(h.calls.at(-1).path), false);
  h.assertClean();
});
