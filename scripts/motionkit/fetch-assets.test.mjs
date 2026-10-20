import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAssets, main, sha256 } from './fetch-assets.mjs';

const FONT = Buffer.from('fixture-font-bytes');
const ICON = Buffer.from('<svg>fixture icon</svg>');
const OFL = Buffer.from('SIL OPEN FONT LICENSE Version 1.1\n');
const MIT = Buffer.from('MIT License\n\nPermission is hereby granted, free of charge...\n');

function fixture() {
  const manifest = {
    fonts: [
      {
        id: 'fixture-font',
        kind: 'font',
        name: 'Fixture Font',
        license: 'OFL-1.1',
        licenseUrl: 'https://assets.test/fixture-font/OFL.txt',
        source: 'https://assets.test/fixture-font',
        baseUrl: 'https://assets.test/fixture-font/',
        files: ['Fixture.ttf', 'OFL.txt'],
        sha256: sha256(FONT),
      },
    ],
    icons: [
      {
        id: 'fixture-icon',
        kind: 'icon',
        name: 'Fixture Icon',
        license: 'MIT',
        licenseUrl: 'https://assets.test/fixture-icon/LICENSE',
        source: 'https://assets.test/fixture-icon',
        baseUrl: 'https://assets.test/fixture-icon/',
        files: ['icon.svg', 'LICENSE'],
        sha256: null,
      },
    ],
  };
  const bodies = {
    'https://assets.test/fixture-font/Fixture.ttf': FONT,
    'https://assets.test/fixture-font/OFL.txt': OFL,
    'https://assets.test/fixture-icon/icon.svg': ICON,
    'https://assets.test/fixture-icon/LICENSE': MIT,
  };
  return { manifest, bodies };
}

function fakeFetch(bodies) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (!bodies[url]) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(bodies[url]).buffer };
  };
  impl.calls = calls;
  return impl;
}

async function tempDir() {
  return fs.mkdtemp(join(tmpdir(), 'motionkit-fetch-'));
}

async function exists(path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('M09 fetch-assets', () => {
  it('downloads files, licence files and NOTICE into a temp dir', async () => {
    const root = await tempDir();
    try {
      const outDir = join(root, 'assets', 'motionkit');
      const { manifest, bodies } = fixture();
      const result = await fetchAssets({ manifest, fetch: fakeFetch(bodies), fs, outDir, logger: silent() });

      assert.equal(result.ok, true);
      assert.equal(await fs.readFile(join(outDir, 'font', 'fixture-font', 'Fixture.ttf'), 'utf8'), FONT.toString());
      assert.match(await fs.readFile(join(outDir, 'font', 'fixture-font', 'LICENSE'), 'utf8'), /SIL OPEN FONT LICENSE/);
      assert.equal(await fs.readFile(join(outDir, 'icon', 'fixture-icon', 'icon.svg'), 'utf8'), ICON.toString());
      assert.match(await fs.readFile(join(outDir, 'icon', 'fixture-icon', 'LICENSE'), 'utf8'), /MIT License/);

      const lock = JSON.parse(await fs.readFile(join(outDir, 'lock.json'), 'utf8'));
      assert.equal(lock.files['font/fixture-font/Fixture.ttf'], sha256(FONT));
      assert.equal(lock.files['icon/fixture-icon/icon.svg'], sha256(ICON));

      const notice = await fs.readFile(join(outDir, 'NOTICE.txt'), 'utf8');
      assert.match(notice, /Fixture Font/);
      assert.match(notice, /Fixture Icon/);
      assert.match(notice, /OFL-1\.1/);
      assert.match(notice, /MIT/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a sha256 mismatch and keeps nothing', async () => {
    const root = await tempDir();
    try {
      const outDir = join(root, 'assets', 'motionkit');
      const { manifest, bodies } = fixture();
      manifest.fonts[0].sha256 = '0'.repeat(64);
      await assert.rejects(
        fetchAssets({ manifest, fetch: fakeFetch(bodies), fs, outDir, logger: silent() }),
        /sha256 mismatch/,
      );
      assert.equal(await exists(outDir), false);
      assert.equal(await exists(join(root, 'assets', 'motionkit', 'font')), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('writes nothing on --dry-run and does not fetch', async () => {
    const root = await tempDir();
    try {
      const outDir = join(root, 'assets', 'motionkit');
      const { manifest } = fixture();
      const fetchImpl = async () => {
        throw new Error('dry run must not fetch');
      };
      const result = await fetchAssets({ manifest, fetch: fetchImpl, fs, outDir, dryRun: true, logger: silent() });
      assert.equal(result.dryRun, true);
      assert.equal(result.written.length, 0);
      assert.equal(result.plan.length, 4);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a licence outside the allowlist before writing', async () => {
    const root = await tempDir();
    try {
      const outDir = join(root, 'assets', 'motionkit');
      const { manifest, bodies } = fixture();
      manifest.icons[0].license = 'GPL-3.0';
      const fetchImpl = fakeFetch(bodies);
      await assert.rejects(
        fetchAssets({ manifest, fetch: fetchImpl, fs, outDir, logger: silent() }),
        /disallowed license GPL-3\.0/,
      );
      assert.equal(fetchImpl.calls.length, 0);
      assert.equal(await exists(outDir), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('supports --only kind and the CLI exit code on mismatch', async () => {
    const root = await tempDir();
    try {
      const outDir = join(root, 'assets', 'motionkit');
      const { manifest, bodies } = fixture();
      const result = await fetchAssets({
        manifest,
        fetch: fakeFetch(bodies),
        fs,
        outDir,
        only: 'icon',
        logger: silent(),
      });
      assert.equal(result.written.some((file) => file.startsWith('font/')), false);
      assert.equal(await exists(join(outDir, 'font')), false);
      assert.equal(await exists(join(outDir, 'icon', 'fixture-icon', 'icon.svg')), true);

      const ok = await main([], { manifest, fetch: fakeFetch(bodies), fs, outDir, logger: silent() });
      assert.equal(ok, 0);

      const broken = { ...manifest, fonts: [{ ...manifest.fonts[0], sha256: 'f'.repeat(64) }] };
      const bad = await main([], { manifest: broken, fetch: fakeFetch(bodies), fs, outDir, logger: silent() });
      assert.equal(bad, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function silent() {
  return { log() {}, error() {} };
}
