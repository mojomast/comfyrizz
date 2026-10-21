import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createTakeStore, takesPath } from '../../src/takes/store.mjs';
import { MAX_TAKES_PER_ASSET, TAKES_SCHEMA } from '../../src/takes/model.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PACKAGE_ID = 'pkg_demo';
const ASSET_ID = 'a_bg';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-takes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    runtimeDir: join(root, 'runtime'),
    packageDir: join(root, 'packages'),
  };
}

function source(root, name, bytes = PNG) {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

function storeFor(space, extra = {}) {
  return createTakeStore({
    runtimeDir: space.runtimeDir,
    packageDir: space.packageDir,
    clock: () => new Date('2026-10-20T12:00:00.000Z'),
    ...extra,
  });
}

function emptyDoc(pkgId = PACKAGE_ID) {
  return { schema: TAKES_SCHEMA, packageId: pkgId, clips: {}, overrides: [] };
}

function snapshot(root) {
  const result = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result.set(relative(root, full), digest(readFileSync(full)));
    }
  };
  walk(root);
  return result;
}

test('TR02: write is atomic, mode 0600 and leaves no temp files', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const doc = emptyDoc();
  store.write(PACKAGE_ID, doc);

  const target = takesPath(space.runtimeDir, PACKAGE_ID);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), doc);
  assert.deepEqual(readdirSync(dirname(target)).sort(), [`${PACKAGE_ID}.json`]);
});

test('TR02: an invalid write leaves the previous sidecar intact', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  store.write(PACKAGE_ID, emptyDoc());

  assert.throws(
    () => store.write(PACKAGE_ID, { schema: 'comfyrizz.takes/v2', packageId: PACKAGE_ID, clips: {} }),
    error => error.code === 'INVALID_TAKES',
  );
  const after = store.read(PACKAGE_ID);
  assert.equal(after.schema, TAKES_SCHEMA);
  assert.deepEqual(after.clips, {});
  assert.equal(statSync(takesPath(space.runtimeDir, PACKAGE_ID)).mode & 0o777, 0o600);
});

test('TR02: package ids are validated like editorPath', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  for (const id of ['../escape', 'bad/id', '', 'with space']) {
    assert.throws(() => store.read(id), /invalid package id/, id);
    assert.throws(() => store.write(id, emptyDoc(id)), /invalid package id/, id);
  }
});

test('TR02: addTake copies the file and dedupes by sha256', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const first = source(space.root, 'first.png');
  const second = source(space.root, 'second.png', PNG);
  const sha256 = digest(PNG);

  const take = store.addTake(PACKAGE_ID, ASSET_ID, {
    srcPath: first,
    sha256,
    media: { mime: 'image/png', width: 640, height: 360 },
    gen: { generator: 'flux3-klein', prompt: 'a clean product shot', seed: 7 },
    runId: 'run_first',
  });

  assert.equal(take.takeId, `tk_${sha256.slice(0, 12)}`);
  assert.equal(take.n, 1);
  assert.equal(take.file, `takes/${ASSET_ID}/${take.takeId}.png`);
  assert.equal(take.sha256, sha256);
  assert.equal(take.bytes, PNG.length);
  assert.equal(take.verdict, 'unreviewed');
  assert.equal(take.createdAt, '2026-10-20T12:00:00.000Z');

  const copied = join(space.packageDir, PACKAGE_ID, take.file);
  assert.deepEqual(readFileSync(copied), PNG);
  assert.equal(statSync(copied).mode & 0o777, 0o600);

  const duplicate = store.addTake(PACKAGE_ID, ASSET_ID, { srcPath: second, sha256 });
  assert.deepEqual(duplicate, take);

  const computed = store.addTake(PACKAGE_ID, ASSET_ID, { srcPath: second });
  assert.deepEqual(computed, take);

  const doc = store.read(PACKAGE_ID);
  assert.equal(doc.clips[ASSET_ID].takes.length, 1);
  assert.equal(doc.clips[ASSET_ID].selected, take.takeId);
  assert.deepEqual(readFileSync(first), PNG);
});

test('TR02: addTake refuses an extension outside the allow-list', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const path = source(space.root, 'take.gif', Buffer.from('gif89a'));
  assert.throws(
    () => store.addTake(PACKAGE_ID, ASSET_ID, { srcPath: path, sha256: digest(Buffer.from('gif89a')) }),
    error => error.code === 'INVALID_EXT',
  );
  assert.equal(store.read(PACKAGE_ID), null);
  assert.equal(existsSync(join(space.packageDir, PACKAGE_ID, 'takes')), false);
});

test('TR02: take files cannot escape through a symlinked takes directory', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const packageRoot = join(space.packageDir, PACKAGE_ID);
  const outside = join(space.root, 'outside');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(packageRoot, 'takes'), 'dir');
  const path = source(space.root, 'take.png');

  assert.throws(
    () => store.addTake(PACKAGE_ID, ASSET_ID, { srcPath: path, sha256: digest(PNG) }),
    error => error.code === 'PATH_ESCAPE',
  );
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(store.read(PACKAGE_ID), null);
});

test('TR02: over the cap the oldest rejected unselected take is purged', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const takes = [];

  for (let index = 0; index < MAX_TAKES_PER_ASSET; index += 1) {
    const bytes = Buffer.concat([PNG, Buffer.from(`take-${index}`)]);
    takes.push(store.addTake(PACKAGE_ID, ASSET_ID, {
      srcPath: source(space.root, `take-${index}.png`, bytes),
      sha256: digest(bytes),
    }));
  }

  store.setVerdict(PACKAGE_ID, ASSET_ID, takes[0].takeId, 'rejected', 'logo hidden');
  store.setVerdict(PACKAGE_ID, ASSET_ID, takes[1].takeId, 'approved', 'keep this one');
  store.setSelected(PACKAGE_ID, ASSET_ID, takes[1].takeId);

  const freshBytes = Buffer.concat([PNG, Buffer.from('take-new')]);
  const fresh = store.addTake(PACKAGE_ID, ASSET_ID, {
    srcPath: source(space.root, 'take-new.png', freshBytes),
    sha256: digest(freshBytes),
  });

  const doc = store.read(PACKAGE_ID);
  const entry = doc.clips[ASSET_ID];
  const active = entry.takes.filter(take => take.purged !== true);
  const oldest = entry.takes.find(take => take.takeId === takes[0].takeId);
  const kept = entry.takes.find(take => take.takeId === takes[1].takeId);

  assert.equal(entry.takes.length, MAX_TAKES_PER_ASSET + 1);
  assert.equal(active.length, MAX_TAKES_PER_ASSET);
  assert.equal(oldest.purged, true);
  assert.equal(kept.purged, undefined);
  assert.equal(entry.selected, takes[1].takeId);
  assert.equal(existsSync(join(space.packageDir, PACKAGE_ID, takes[0].file)), false);
  assert.equal(existsSync(join(space.packageDir, PACKAGE_ID, takes[1].file)), true);
  assert.equal(existsSync(join(space.packageDir, PACKAGE_ID, fresh.file)), true);
});

test('TR02: adoptInitial makes take 1 from a ready generated asset and is idempotent', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const assetsDir = join(space.packageDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'a_bg.png'), PNG);
  writeFileSync(join(assetsDir, 'a_svg.svg'), Buffer.from('<svg/>'));

  const pkg = {
    id: PACKAGE_ID,
    assets: {
      [ASSET_ID]: {
        kind: 'image',
        status: 'ready',
        file: 'assets/a_bg.png',
        sha256: digest(PNG),
        bytes: 999,
        media: { mime: 'image/png', width: 640, height: 360 },
        gen: { generator: 'flux3-klein', prompt: 'a clean product shot', seed: 7 },
      },
      a_pending: {
        kind: 'image',
        status: 'pending',
        file: 'assets/a_pending.png',
        gen: { generator: 'flux3-klein' },
      },
      a_svg: {
        kind: 'svg',
        status: 'ready',
        file: 'assets/a_svg.svg',
        sha256: digest(Buffer.from('<svg/>')),
        gen: { generator: 'llm-svg' },
      },
      a_missing: {
        kind: 'image',
        status: 'ready',
        file: 'assets/a_missing.png',
        gen: { generator: 'flux3-klein' },
      },
    },
  };

  const doc = store.adoptInitial(pkg);
  const entry = doc.clips[ASSET_ID];
  const take = entry.takes[0];

  assert.deepEqual(Object.keys(doc.clips), [ASSET_ID]);
  assert.equal(take.n, 1);
  assert.equal(take.assetId, ASSET_ID);
  assert.equal(take.takeId, `tk_${digest(PNG).slice(0, 12)}`);
  assert.equal(take.file, `takes/${ASSET_ID}/${take.takeId}.png`);
  assert.equal(take.sha256, digest(PNG));
  assert.equal(take.bytes, PNG.length);
  assert.equal(take.verdict, 'unreviewed');
  assert.deepEqual(take.media, { mime: 'image/png', width: 640, height: 360 });
  assert.equal(take.gen.prompt, 'a clean product shot');
  assert.equal(take.correction.by, 'initial');
  assert.equal(entry.selected, take.takeId);
  assert.deepEqual(readFileSync(join(space.packageDir, PACKAGE_ID, take.file)), PNG);

  const again = store.adoptInitial(pkg);
  assert.equal(again.clips[ASSET_ID].takes.length, 1);
});

test('TR02: setSelected, setVerdict and setLastJob update only their fields', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const firstBytes = Buffer.concat([PNG, Buffer.from('one')]);
  const secondBytes = Buffer.concat([PNG, Buffer.from('two')]);
  const first = store.addTake(PACKAGE_ID, ASSET_ID, {
    srcPath: source(space.root, 'one.png', firstBytes),
    sha256: digest(firstBytes),
    gen: { generator: 'flux3-klein' },
  });
  const second = store.addTake(PACKAGE_ID, ASSET_ID, {
    srcPath: source(space.root, 'two.png', secondBytes),
    sha256: digest(secondBytes),
    gen: { generator: 'flux3-klein' },
  });

  let doc = store.setSelected(PACKAGE_ID, ASSET_ID, first.takeId);
  assert.equal(doc.clips[ASSET_ID].selected, first.takeId);

  doc = store.setVerdict(PACKAGE_ID, ASSET_ID, { takeId: second.takeId, verdict: 'approved', note: 'logo is readable' });
  const approved = doc.clips[ASSET_ID].takes.find(take => take.takeId === second.takeId);
  assert.equal(approved.verdict, 'approved');
  assert.equal(approved.verdictNote, 'logo is readable');
  assert.equal(doc.clips[ASSET_ID].selected, first.takeId);

  doc = store.setLastJob(PACKAGE_ID, ASSET_ID, { runId: 'run_2', state: 'failed', error: 'GPU ran out of memory' });
  assert.equal(doc.clips[ASSET_ID].lastJob.state, 'failed');
  assert.equal(doc.clips[ASSET_ID].selected, first.takeId);

  doc = store.setLastJob(PACKAGE_ID, ASSET_ID, null);
  assert.equal(doc.clips[ASSET_ID].lastJob, undefined);

  assert.throws(
    () => store.setSelected(PACKAGE_ID, ASSET_ID, 'tk_ffffffffffff'),
    error => error.code === 'UNKNOWN_TAKE',
  );
  assert.throws(
    () => store.setVerdict(PACKAGE_ID, ASSET_ID, first.takeId, 'maybe'),
    error => error.code === 'INVALID_VERDICT',
  );
});

test('TR02: addTake changes only the sidecar and the new take file', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const assetsDir = join(space.packageDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'a_bg.png'), PNG);
  writeFileSync(join(space.packageDir, 'package.json'), JSON.stringify({ id: PACKAGE_ID }));

  const before = snapshot(space.packageDir);
  const path = source(space.root, 'new-take.png', Buffer.concat([PNG, Buffer.from('new')]));
  const take = store.addTake(PACKAGE_ID, ASSET_ID, { srcPath: path, sha256: digest(readFileSync(path)) });
  const after = snapshot(space.packageDir);

  for (const [file, hash] of before) assert.equal(after.get(file), hash, file);
  const added = [...after.keys()].filter(file => !before.has(file));
  assert.deepEqual(added, [join(PACKAGE_ID, take.file)]);
  assert.equal(existsSync(takesPath(space.runtimeDir, PACKAGE_ID)), true);
});

test('TR02: write uses a temp file followed by rename', (t) => {
  const space = workspace(t);
  const calls = [];
  const store = storeFor(space, {
    fs: {
      writeFileSync: (path, ...args) => {
        if (path.endsWith('.tmp')) calls.push(['write', path]);
        return writeFileSync(path, ...args);
      },
      renameSync: (from, to) => {
        calls.push(['rename', from, to]);
        return renameSync(from, to);
      },
    },
  });
  store.write(PACKAGE_ID, emptyDoc());
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'write');
  assert.match(calls[0][1], /\.tmp$/);
  assert.deepEqual(calls[1], ['rename', calls[0][1], takesPath(space.runtimeDir, PACKAGE_ID)]);
});

test('TR02: purge is available on its own and enforces the cap', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const takes = [];
  for (let index = 0; index < MAX_TAKES_PER_ASSET + 1; index += 1) {
    const bytes = Buffer.concat([PNG, Buffer.from(`purge-${index}`)]);
    takes.push(store.addTake(PACKAGE_ID, ASSET_ID, {
      srcPath: source(space.root, `purge-${index}.png`, bytes),
      sha256: digest(bytes),
    }));
  }
  assert.equal(store.read(PACKAGE_ID).clips[ASSET_ID].takes.filter(take => !take.purged).length, MAX_TAKES_PER_ASSET + 1);

  store.setVerdict(PACKAGE_ID, ASSET_ID, takes[0].takeId, 'rejected');
  const doc = store.purge(PACKAGE_ID, ASSET_ID);
  const active = doc.clips[ASSET_ID].takes.filter(take => !take.purged);
  assert.equal(active.length, MAX_TAKES_PER_ASSET);
  assert.equal(doc.clips[ASSET_ID].takes.find(take => take.takeId === takes[0].takeId).purged, true);
  assert.equal(existsSync(join(space.packageDir, PACKAGE_ID, takes[0].file)), false);
  assert.deepEqual(store.purge(PACKAGE_ID, 'a_unknown'), store.read(PACKAGE_ID));
});
