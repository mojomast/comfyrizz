import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCompositions, collectInputs, copyCompositionInputs, localFile, parseArgs } from './build.mjs';

test('CLI rejects ambiguous output and unknown arguments', () => {
  assert.deepEqual(parseArgs(['example', '--check']), { packageDir: 'example', check: true });
  for (const args of [[], ['example', '--out'], ['example', '--wat'], ['example', '--check', '--out', 'out']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('compile-only checks actual examples without creating artifacts and rejects out-of-scene cue frames', async () => {
  const root = mkdtempSync(join(tmpdir(), 'composition-check-'));
  try {
    mkdirSync(join(root, 'compositions'));
    const source = new URL('../../examples/composition-stories/', import.meta.url);
    const pkgBytes = readFileSync(new URL('package.json', source));
    const manifest = JSON.parse(readFileSync(new URL('compositions/manifest.json', source), 'utf8'));
    writeFileSync(join(root, 'package.json'), pkgBytes);
    writeFileSync(join(root, 'compositions/manifest.json'), JSON.stringify(manifest));
    const before = readdirSync(root, { recursive: true }).sort();
    let logged;
    const result = await buildCompositions({ packageDir: root, check: true }, { log: value => { logged = JSON.parse(value); } });
    assert.equal(result.frames, 480);
    assert.deepEqual(result.scenes.map(scene => scene.frames), [150, 180, 150]);
    assert.equal(logged.mode, 'compile-only');
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
    assert.deepEqual(readFileSync(join(root, 'package.json')), pkgBytes);
    assert.equal(existsSync(`${root}.composed`), false);
    manifest.scenes[0].cues.result.frame = 150;
    writeFileSync(join(root, 'compositions/manifest.json'), JSON.stringify(manifest));
    await assert.rejects(buildCompositions({ packageDir: root, check: true }, { log() {} }), /local cue frame/);
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('input allowlist copies declared media and measured narration, excludes credentials/artifacts and rejects links', () => {
  const root = mkdtempSync(join(tmpdir(), 'composition-inputs-'));
  try {
    mkdirSync(join(root, 'compositions'));
    mkdirSync(join(root, 'assets'));
    mkdirSync(join(root, 'audio/narration'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'compositions/manifest.json'), '{}');
    writeFileSync(join(root, 'assets/plate.mp4'), 'plate');
    writeFileSync(join(root, 'audio/narration/s_one.wav'), 'audio');
    writeFileSync(join(root, 'audio/durations.json'), JSON.stringify({ scenes: { s_one: { file: 'audio/narration/s_one.wav', chunks: [] } } }));
    writeFileSync(join(root, '.env'), 'SECRET=value');
    writeFileSync(join(root, 'assets/debug.json'), '{"token":"secret"}');
    writeFileSync(join(root, 'final.mp4'), 'artifact');
    const result = collectInputs(root, { assets: { a_one: { file: 'assets/plate.mp4' } } });
    assert.deepEqual(result.files, ['assets/plate.mp4', 'audio/durations.json', 'audio/narration/s_one.wav', 'compositions/manifest.json', 'package.json']);
    for (const file of ['../escape', '/etc/passwd', '.env', 'assets/../package.json', 'assets\\plate.mp4']) {
      assert.throws(() => localFile(root, file), /Unsafe/);
    }
    assert.throws(() => collectInputs(root, { assets: { a_one: { file: 'assets/debug.json' } } }), /supported media extension/);
    symlinkSync(join(root, '.env'), join(root, 'assets/leak.mp4'));
    assert.throws(() => collectInputs(root, { assets: { a_one: { file: 'assets/leak.mp4' } } }), /Symlink/);
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'SECRET=value');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI input copying preserves verified effective-package cache extras for a render-free roundtrip', async () => {
  const { materializeCompositions, collectCompositionCacheExtras } = await import('../../apps/renderer/scripts/composition-worker.mjs');
  const { collectCompositionExtras } = await import('../../packages/compositions/src/index.mjs');
  const { compileTimeline } = await import('../../packages/planner/dist/src/index.js');
  const root = mkdtempSync(join(tmpdir(), 'composition-roundtrip-'));
  const source = join(root, 'extracted');
  const output = join(root, 'rebuilt');
  try {
    mkdirSync(join(source, 'compositions'), { recursive: true });
    mkdirSync(output);
    const example = new URL('../../examples/composition-stories/', import.meta.url);
    const pkg = JSON.parse(readFileSync(new URL('package.json', example), 'utf8'));
    pkg.scenes = pkg.scenes.slice(0, 1);
    const manifest = JSON.parse(readFileSync(new URL('compositions/manifest.json', example), 'utf8'));
    manifest.scenes = manifest.scenes.slice(0, 1);
    writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(source, 'compositions/manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(source, 'compositions/untrusted.html'), '<script>arbitrary source</script>');
    let renders = 0;
    const workerOptions = {
      resolveRuntime: async () => ({ node: '/node22', cli: '/hyperframes.mjs', env: {}, fingerprint: { version: '0.8.181', browser: 'test' } }),
      command: async (bin, args) => {
        if (bin === 'ffprobe') return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1280, height: 720, r_frame_rate: '30/1', avg_frame_rate: '30/1', nb_read_frames: '150' }] }) };
        if (args[1] === 'check') return { code: 0, stdout: JSON.stringify({ ok: true, browserSkipped: false,
          ...Object.fromEntries(['lint', 'runtime', 'layout', 'motion', 'contrast'].map(key => [key, { ok: true, errorCount: 0, findings: [], enabled: true, samples: [0, 1] }])) }) };
        if (args[1] === 'render') {
          renders++;
          writeFileSync(args[args.indexOf('--output') + 1], 'owned-test-video');
          return { code: 0, stdout: '' };
        }
        throw new Error('Unexpected command');
      },
    };
    const first = await materializeCompositions({ pkg, packageDir: source, timeline: compileTimeline(pkg), ...workerOptions });
    assert.equal(renders, 1);
    writeFileSync(join(source, 'package.json'), JSON.stringify(first.pkg));
    const sourceExtras = collectCompositionExtras(first.pkg, source);
    const inputs = collectInputs(source, first.pkg, sourceExtras.map(extra => extra.path));
    const expected = await collectCompositionCacheExtras(first.pkg, source);
    assert.equal(expected.length, 3);
    await copyCompositionInputs({ packageDir: source, pkg: first.pkg, output, files: inputs.files, sourceExtras });
    for (const extra of expected) assert.deepEqual(readFileSync(join(output, extra.path)), extra.data);
    assert.equal(existsSync(join(output, 'compositions/untrusted.html')), false);
    const copied = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'));
    const second = await materializeCompositions({ pkg: copied, packageDir: output, timeline: compileTimeline(copied), ...workerOptions });
    assert.equal(second.report.scenes[0].cache, 'hit');
    assert.equal(renders, 1, 'verified receipt/source extras avoid rerendering the copied MP4');
    assert.deepEqual(second.pkg, first.pkg);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
