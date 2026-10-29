// UX10: reference-aware take freshness.
//
// A take is only fresh when the asset's generation inputs AND the content of every
// directly or transitively referenced asset still match the fingerprint recorded at
// ingest. The gate and the clips API must use the same reference index as ingest, and
// legacy evidence that cannot be verified is never turned into an approval.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import { PackageStore } from '../../src/store.mjs';
import { listClips } from '../../src/takes/clips.mjs';
import { finalGate } from '../../src/takes/gate.mjs';
import { ingestRun } from '../../src/takes/ingest.mjs';
import { TAKES_SCHEMA, deriveClipState, genFingerprint } from '../../src/takes/model.mjs';
import { createTakeRoutes } from '../../src/takes/routes.mjs';
import { selectTake } from '../../src/takes/select.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';

const FIXTURE_PATH = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const CLIP = 's1:a_plate1';
const ASSET_ID = 'a_plate1';
const REF_ASSET = 'a_plate1_still';
const TRANSITIVE_ASSET = 'a_hero';

const clone = value => JSON.parse(JSON.stringify(value));
const digest = seed => createHash('sha256').update(seed).digest('hex');

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-reference-freshness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    runtimeDir: join(root, 'runtime'),
    packageDir: join(root, 'packages'),
    outputDir: join(root, 'runs', 'run_ref', 'out'),
  };
}

function referencePackage({ transitive = false } = {}) {
  const pkg = clone(fixture);
  delete pkg.scenes.at(-1).transitionOut;
  pkg.assets[ASSET_ID].gen.inputs.image = REF_ASSET;
  if (transitive) pkg.assets[REF_ASSET].gen.inputs.image = TRANSITIVE_ASSET;
  return pkg;
}

function storeFor(space) {
  return createTakeStore({
    runtimeDir: space.runtimeDir,
    packageDir: space.packageDir,
    clock: () => new Date('2026-10-20T12:00:00.000Z'),
  });
}

function manifestFor(bytes) {
  return {
    v: 1,
    updatedAt: '2026-10-20T12:00:00.000Z',
    jobs: [
      {
        job: 'a_plate1.background',
        status: 'succeeded',
        outputs: [{ relative: 'assets/a_plate1.mp4', sha256: digest(bytes), bytes: bytes.length }],
      },
    ],
  };
}

function jobsFor() {
  return {
    v: 1,
    jobs: [
      {
        id: 'a_plate1.background',
        asset: ASSET_ID,
        kind: 'video',
        generator: 'ltx25',
        workflow: 'workflows/ltx.api.json',
        workflowSha256: digest('workflow'),
        inputs: { seed: 42, prompt: 'slow drift through a soft blue nebula' },
      },
    ],
  };
}

function writeOutput(space, bytes) {
  const target = join(space.outputDir, 'assets', 'a_plate1.mp4');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function fakeTake(pkg, { verdict = 'approved', sourceFingerprint = true } = {}) {
  const asset = pkg.assets[ASSET_ID];
  const take = {
    takeId: `tk_${'a'.repeat(12)}`,
    assetId: ASSET_ID,
    n: 1,
    file: `takes/${ASSET_ID}/tk_${'a'.repeat(12)}.mp4`,
    sha256: '1'.repeat(64),
    bytes: 10,
    media: clone(asset.media),
    gen: clone(asset.gen),
    createdAt: '2026-10-20T12:00:00.000Z',
    verdict,
  };
  if (sourceFingerprint) take.sourceGenFingerprint = genFingerprint(asset.gen, pkg);
  return take;
}

function takeDoc(pkg, take) {
  return {
    schema: TAKES_SCHEMA,
    packageId: pkg.id,
    clips: { [ASSET_ID]: { selected: take.takeId, takes: [take] } },
    overrides: [],
  };
}

function fakeResponse() {
  const out = { status: null, headers: null, raw: null, json: null };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(body) {
      out.raw = body;
      try {
        out.json = body ? JSON.parse(body) : null;
      } catch {
        out.json = null;
      }
    },
  };
}

function fakeRequest(body, method = 'GET') {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  stream.method = method;
  return stream;
}

async function call(routes, path, { method, body } = {}) {
  const response = fakeResponse();
  const matched = await routes.handle(
    fakeRequest(body, method ?? (body === undefined ? 'GET' : 'POST')),
    response,
    new URL(`http://127.0.0.1${path}`),
  );
  return { matched, ...response.out };
}

test('UX10: ingest records a reference-aware fingerprint and direct/transitive changes become stale', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const pkg = referencePackage({ transitive: true });
  const bytes = Buffer.from('reference-aware take bytes');
  writeOutput(space, bytes);

  const result = ingestRun({
    pkg,
    manifest: manifestFor(bytes),
    jobsDoc: jobsFor(),
    outputDir: space.outputDir,
    store,
    runId: 'run_ref',
  });

  assert.equal(result.takes.length, 1);
  const take = result.takes[0];
  const asset = pkg.assets[ASSET_ID];
  assert.equal(
    take.sourceGenFingerprint,
    genFingerprint(asset.gen, pkg),
    'ingest fingerprints the authored gen against the package reference index',
  );
  assert.notEqual(
    take.sourceGenFingerprint,
    genFingerprint(asset.gen),
    'the reference-aware fingerprint differs from the legacy gen-only digest',
  );
  assert.equal(take.verdict, 'unreviewed', 'auto-selection never invents a human review');
  assert.deepEqual(result.selected, { [ASSET_ID]: take.takeId });

  let doc = store.read(pkg.id);
  assert.equal(
    deriveClipState({ takes: doc.clips[ASSET_ID], assetGen: asset.gen, refs: pkg }),
    'review',
    'an auto-selected take still waits for human review',
  );

  store.setVerdict(pkg.id, ASSET_ID, take.takeId, 'approved');
  doc = store.read(pkg.id);
  assert.equal(deriveClipState({ takes: doc.clips[ASSET_ID], assetGen: asset.gen, refs: pkg }), 'approved');

  const changedDirect = clone(pkg);
  changedDirect.assets[REF_ASSET].sha256 = digest('changed-direct-reference');
  assert.equal(
    deriveClipState({ takes: doc.clips[ASSET_ID], assetGen: asset.gen, refs: changedDirect }),
    'stale',
    'a direct reference change invalidates the take',
  );

  const changedTransitive = clone(pkg);
  changedTransitive.assets[TRANSITIVE_ASSET].sha256 = digest('changed-transitive-reference');
  assert.equal(
    deriveClipState({ takes: doc.clips[ASSET_ID], assetGen: asset.gen, refs: changedTransitive }),
    'stale',
    'a transitive reference change invalidates the take',
  );
});

test('UX10: the final gate uses the package reference index', () => {
  const pkg = referencePackage();
  const take = fakeTake(pkg);
  const doc = takeDoc(pkg, take);
  const clips = listClips(pkg);

  assert.equal(finalGate(pkg, doc, clips).ok, true);

  const changed = clone(pkg);
  changed.assets[REF_ASSET].sha256 = digest('gate-direct-change');
  assert.deepEqual(
    finalGate(changed, doc, clips).blocking,
    [{ clipId: CLIP, state: 'stale' }],
    'the gate must not approve a take whose reference bytes changed',
  );
});

test('selecting a resolved take preserves the authored request and reference-aware freshness', () => {
  const pkg = referencePackage({ transitive: true });
  const authored = clone(pkg.assets[ASSET_ID].gen);
  authored.inputs.width = 1920;
  authored.inputs.height = 1080;
  pkg.assets[ASSET_ID].gen = clone(authored);
  const take = fakeTake(pkg);
  take.gen.inputs = { ...take.gen.inputs, image: 'assets/resolved.png', height: 1088, cutout: false };
  take.gen.job_id = 'job-real';
  const doc = takeDoc(pkg, take);
  const selected = selectTake(pkg, doc, ASSET_ID, take.takeId);
  assert.deepEqual(selected.assets[ASSET_ID].gen.inputs, authored.inputs);
  assert.equal(selected.assets[ASSET_ID].gen.job_id, 'job-real');
  assert.equal(take.gen.inputs.height, 1088, 'actual job inputs remain recorded');
  assert.equal(finalGate(selected, doc, listClips(selected)).ok, true);
  const edited = clone(selected);
  edited.assets[ASSET_ID].gen.inputs.height = 1088;
  assert.equal(deriveClipState({ takes: doc.clips[ASSET_ID], assetGen: edited.assets[ASSET_ID].gen, refs: edited }), 'stale');
  const changedRef = clone(selected);
  changedRef.assets[TRANSITIVE_ASSET].sha256 = digest('changed transitive');
  assert.equal(deriveClipState({ takes: doc.clips[ASSET_ID], assetGen: changedRef.assets[ASSET_ID].gen, refs: changedRef }), 'stale');
  const reselected = selectTake(edited, doc, ASSET_ID, take.takeId);
  assert.equal(deriveClipState({ takes: doc.clips[ASSET_ID], assetGen: reselected.assets[ASSET_ID].gen, refs: reselected }), 'stale', 'reselection cannot erase edits');
});

test('UX10: clips and takes reads derive state with the package reference index', async (t) => {
  const space = workspace(t);
  const store = new PackageStore(space.packageDir);
  const pkg = referencePackage();
  store.write(pkg);
  const takeStore = storeFor(space);
  const asset = pkg.assets[ASSET_ID];
  const source = join(space.root, 'read-take.mp4');
  writeFileSync(source, Buffer.from('read take bytes'));
  const take = takeStore.addTake(pkg.id, ASSET_ID, {
    srcPath: source,
    media: clone(asset.media),
    gen: clone(asset.gen),
    sourceGenFingerprint: genFingerprint(asset.gen, pkg),
    runId: 'run_read',
  });
  takeStore.setVerdict(pkg.id, ASSET_ID, take.takeId, 'approved');

  const routes = createTakeRoutes({
    store,
    takeStore,
    runs: { async start() { return { runId: 'run_unused' }; } },
  });

  const before = await call(routes, `/api/package/${pkg.id}/clips`);
  assert.equal(before.status, 200);
  assert.equal(before.json.clips.find(clip => clip.clipId === CLIP).state, 'approved');

  const current = store.read(pkg.id);
  const changed = clone(current);
  changed.assets[REF_ASSET].sha256 = digest('read-direct-change');
  store.save(pkg.id, changed, current.revision);

  const afterList = await call(routes, `/api/package/${pkg.id}/clips`);
  assert.equal(afterList.status, 200);
  assert.equal(
    afterList.json.clips.find(clip => clip.clipId === CLIP).state,
    'stale',
    'the clips API is reference-aware',
  );

  const afterTakes = await call(routes, `/api/package/${pkg.id}/clips/${CLIP}/takes`);
  assert.equal(afterTakes.status, 200);
  assert.equal(afterTakes.json.clip.state, 'stale', 'the takes API is reference-aware');
});

test('UX10: legacy approval without generation evidence stays unknown instead of becoming approved', () => {
  const pkg = referencePackage();
  const legacy = {
    takeId: `tk_${'b'.repeat(12)}`,
    assetId: ASSET_ID,
    n: 1,
    file: `takes/${ASSET_ID}/tk_${'b'.repeat(12)}.mp4`,
    sha256: '2'.repeat(64),
    bytes: 12,
    media: clone(pkg.assets[ASSET_ID].media),
    createdAt: '2026-10-20T12:00:00.000Z',
    verdict: 'approved',
  };
  const entry = { selected: legacy.takeId, takes: [legacy] };

  assert.equal(
    deriveClipState({ takes: entry, assetGen: pkg.assets[ASSET_ID].gen, refs: pkg }),
    'stale',
    'an approved legacy take with no gen evidence cannot be proven fresh',
  );
  assert.equal(legacy.sourceGenFingerprint, undefined, 'no fingerprint is invented for legacy evidence');
});
