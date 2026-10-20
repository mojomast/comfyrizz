import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_OUTPUT, buildManifest, durationSeconds, firstParagraph, serializeManifest } from './gallery-manifest.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SCRIPT = join(SCRIPT_DIR, 'gallery-manifest.mjs');

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Temp fixture tree:
//   alpha  full package + media + multi-line README paragraph
//   beta   package + timeline + README, no media
//   gamma  package with tags only (no timeline, no out, no README)
//   delta  no package.json at all, just an un-named mp4 in out/
//   not-a-dir.txt is ignored
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gallery-manifest-'));

  const alpha = join(root, 'examples', 'alpha');
  mkdirSync(join(alpha, 'out'), { recursive: true });
  writeJson(join(alpha, 'package.json'), {
    title: 'Alpha launch',
    description: 'Alpha description from the package.',
    tags: ['cpu'],
  });
  writeJson(join(alpha, 'timeline.json'), { fps: 30, durationInFrames: 60 });
  writeFileSync(join(alpha, 'out', 'alpha.mp4'), 'mp4');
  writeFileSync(join(alpha, 'out', 'alpha-extra.mp4'), 'mp4');
  writeFileSync(join(alpha, 'out', 'poster.png'), 'png');
  writeFileSync(join(alpha, 'README.md'), '# Alpha\n\nFirst line\nstill the first paragraph with a [link](https://example.test).\n\n- list item\n');

  const beta = join(root, 'examples', 'beta');
  mkdirSync(beta, { recursive: true });
  writeJson(join(beta, 'package.json'), { title: 'Beta demo' });
  writeJson(join(beta, 'timeline.json'), { fps: 24, durationInFrames: 96 });
  writeFileSync(join(beta, 'README.md'), '# Beta\n\nBeta readme paragraph only.\n');

  const gamma = join(root, 'examples', 'gamma');
  mkdirSync(gamma, { recursive: true });
  writeJson(join(gamma, 'package.json'), { title: 'Gamma charts', tags: ['charts', 'csv', 7, ''] });

  const delta = join(root, 'examples', 'delta');
  mkdirSync(join(delta, 'out'), { recursive: true });
  writeFileSync(join(delta, 'out', 'clip.mp4'), 'mp4');

  writeFileSync(join(root, 'examples', 'not-a-dir.txt'), 'ignored');
  return root;
}

function withFixture(fn) {
  const root = makeFixture();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('buildManifest reads every field from a temp fixture tree', () => {
  withFixture((root) => {
    const manifest = buildManifest(root);
    assert.deepEqual(manifest.map((entry) => entry.id), ['alpha', 'beta', 'delta', 'gamma']);

    const [alpha, beta, delta, gamma] = manifest;
    assert.deepEqual(alpha, {
      id: 'alpha',
      title: 'Alpha launch',
      description: 'Alpha description from the package.',
      durationSec: 2,
      video: 'examples/alpha/out/alpha.mp4',
      poster: 'examples/alpha/out/poster.png',
      readme: 'examples/alpha/README.md',
      tags: ['cpu'],
    });

    assert.deepEqual(beta, {
      id: 'beta',
      title: 'Beta demo',
      description: 'Beta readme paragraph only.',
      durationSec: 4,
      video: null,
      poster: null,
      readme: 'examples/beta/README.md',
      tags: [],
    });

    assert.deepEqual(gamma, {
      id: 'gamma',
      title: 'Gamma charts',
      description: null,
      durationSec: null,
      video: null,
      poster: null,
      readme: null,
      tags: ['charts', 'csv'],
    });

    assert.deepEqual(delta, {
      id: 'delta',
      title: 'delta',
      description: null,
      durationSec: null,
      video: 'examples/delta/out/clip.mp4',
      poster: null,
      readme: null,
      tags: [],
    });
  });
});

test('buildManifest returns [] when examples/ is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'gallery-manifest-empty-'));
  try {
    assert.deepEqual(buildManifest(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('firstParagraph skips headings, joins wrapped lines and stops at lists', () => {
  assert.equal(
    firstParagraph('# Title\n\nOne\n two  three.\n\n- bullet\n'),
    'One two three.',
  );
  assert.equal(
    firstParagraph('prose first\n\n# later heading stays out\n'),
    'prose first',
  );
  assert.equal(
    firstParagraph('# Only a heading\n'),
    null,
  );
  assert.equal(
    firstParagraph('See [docs](https://example.test) and `code`.\n'),
    'See docs and code.',
  );
  assert.equal(firstParagraph(undefined), null);
});

test('durationSeconds converts frames at fps and refuses bad input', () => {
  assert.equal(durationSeconds({ fps: 30, durationInFrames: 1100 }), 36.67);
  assert.equal(durationSeconds({ fps: 24, durationInFrames: 96 }), 4);
  assert.equal(durationSeconds({ durationInFrames: 100 }), null);
  assert.equal(durationSeconds({ fps: 30 }), null);
  assert.equal(durationSeconds({ fps: 0, durationInFrames: 100 }), null);
  assert.equal(durationSeconds(null), null);
});

test('buildManifest on the real repo lists every examples/* dir with repo-relative paths', () => {
  const manifest = buildManifest(REPO_ROOT);
  const dirs = readdirSync(join(REPO_ROOT, 'examples'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(manifest.map((entry) => entry.id), dirs);
  assert.equal(new Set(manifest.map((entry) => entry.id)).size, manifest.length);

  for (const entry of manifest) {
    for (const field of ['video', 'poster', 'readme']) {
      const value = entry[field];
      if (value === null) continue;
      assert.equal(typeof value, 'string', `${entry.id}.${field} must be a string or null`);
      assert.ok(!value.startsWith('/') && !value.includes('..') && !value.includes('\\'),
        `${entry.id}.${field} must be repo-relative: ${value}`);
      assert.ok(value.startsWith('examples/'), `${entry.id}.${field} must live under examples/: ${value}`);
      assert.ok(existsSync(join(REPO_ROOT, value)), `${entry.id}.${field} must point at an existing file: ${value}`);
    }
  }

  const launch = manifest.find((entry) => entry.id === 'launch-demo');
  assert.ok(launch, 'examples/launch-demo must be listed');
  assert.equal(launch.title, 'Comfyrizz launch demo');
  assert.equal(launch.durationSec, 36.67); // timeline.json: 1100 frames at 30 fps
  if (launch.video !== null) {
    assert.match(launch.video, /^examples\/launch-demo\/out\/[\w.-]+\.mp4$/);
  }
  if (launch.readme !== null) {
    assert.equal(launch.readme, 'examples/launch-demo/README.md');
  }

  const tools = manifest.find((entry) => entry.id === 'tools');
  assert.ok(tools, 'examples/tools must be listed');
  assert.equal(tools.title, 'tools'); // no package.json: fall back to the directory name
  assert.equal(tools.video, null);
  assert.equal(tools.durationSec, null);
});

test('--stdout prints the manifest and writes nothing', () => {
  withFixture((root) => {
    const result = spawnSync(process.execPath, [SCRIPT, '--stdout', '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), buildManifest(root));
    assert.equal(JSON.parse(result.stdout)[0].id, 'alpha');
    assert.equal(readdirSync(root).includes('docs'), false);
  });
});

test('default mode writes docs/gallery/gallery.json under --root', () => {
  withFixture((root) => {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const file = join(root, DEFAULT_OUTPUT);
    assert.equal(readFileSync(file, 'utf8'), serializeManifest(buildManifest(root)));
    assert.match(result.stdout, /wrote docs\/gallery\/gallery\.json \(\d+ entries\)/);
  });
});

test('unknown arguments exit 2 and --help prints usage', () => {
  const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument/);

  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /gallery-manifest\.mjs/);
});
