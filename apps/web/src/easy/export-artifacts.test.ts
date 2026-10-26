// UX16: saved export records keep only the canonical artifact id and delivery
// facts, never a blob or an expiring URL. The resolver is the one place a new
// access URL comes from after reload. Fakes only: no network, no storage, no media.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createExportArtifactRecord,
  exportArtifactStorageKey,
  forgetExportArtifact,
  loadExportArtifact,
  renderDeliveryFacts,
  resolveSavedExport,
  saveExportArtifact,
} from './export-artifacts.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function deliveryResult(overrides = {}) {
  return {
    exportId: 'x_keep',
    packageId: 'pkg_ux16',
    revision: 4,
    files: [
      { name: 'video.mp4', bytes: 1234, path: '/exports/pkg_ux16/video.mp4' },
      { name: 'captions.vtt', bytes: 321, path: '/exports/pkg_ux16/captions.vtt' },
    ],
    intent: 'draft',
    archiveMode: 'private',
    preflight: {
      ok: false,
      final: false,
      intent: 'draft',
      blockers: [],
      warnings: [{ code: 'MISSING_SOURCE', message: '1 declared source file(s) are not present' }],
      facts: {
        intent: 'draft',
        format: { width: 1080, height: 1920, aspect: '9:16', fps: 30 },
        archiveMode: 'private',
        snapshotFingerprint: HASH_A,
        timelineHash: HASH_B,
        captionRevision: HASH_C,
        speechSha256: HASH_D,
        sourceCompleteness: {
          complete: false,
          missing: ['audio/durations.json'],
          inputs: [
            { path: 'package.json', sha256: HASH_A, bytes: 10 },
            { path: 'audio/durations.json', sha256: null, bytes: null },
          ],
        },
        rightsExclusions: [{ assetId: 'a_logo', file: 'assets/logo.png', reason: 'licence policy blocked this asset' }],
        reviews: [{ decisionId: 'dec_1', state: 'unknown', reason: 'waiting for a human' }],
      },
    },
    snapshot: {
      fingerprint: HASH_A,
      schema: 'comfyrizz.delivery-snapshot/v1',
      intent: 'final',
      archiveMode: 'redistributable',
      format: { width: 1, height: 1 },
      packageRevision: 4,
      editorRevision: 2,
      captionRevision: HASH_D,
      speechSha256: HASH_C,
      timelineHash: HASH_D,
      inputs: [{ path: 'ignored.json', sha256: null, bytes: null }],
    },
    excluded: [{ assetId: 'a_logo', file: 'assets/logo.png', reason: 'licence policy blocked this asset' }],
    ...overrides,
  };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test('builds one canonical record from the UX15 /api/export shape and never keeps a path', () => {
  const result = createExportArtifactRecord(deliveryResult({
    renderId: 'r_alias',
    bundleId: 'x_bundle_alias',
    manifest: { exportId: 'x_manifest_alias', files: [{ name: 'wrong.zip', bytes: 1 }] },
    facts: { intent: 'final', format: { width: 9, height: 9 } },
  }));

  assert.equal(result.ok, true);
  const record = result.record;
  assert.equal(record.exportId, 'x_keep');
  assert.equal(record.packageId, 'pkg_ux16');
  assert.equal(record.revision, 4);
  assert.equal(record.intent, 'draft');
  assert.equal(record.archiveMode, 'private');
  assert.deepEqual(record.files, [
    { name: 'video.mp4', bytes: 1234 },
    { name: 'captions.vtt', bytes: 321 },
  ]);
  assert.doesNotMatch(JSON.stringify(record), /\/exports\//);
  assert.doesNotMatch(JSON.stringify(record), /"path":"\//);
  assert.doesNotMatch(JSON.stringify(record), /"path":"[A-Za-z]:/);

  assert.equal(record.facts.format.width, 1080);
  assert.equal(record.facts.format.height, 1920);
  assert.equal(record.facts.archiveMode, 'private');
  assert.equal(record.facts.snapshotFingerprint, HASH_A);
  assert.equal(record.facts.captionRevision, HASH_C);
  assert.equal(record.facts.sourceCompleteness.missing[0], 'audio/durations.json');
  assert.deepEqual(record.facts.rightsExclusions, [
    { assetId: 'a_logo', file: 'assets/logo.png', reason: 'licence policy blocked this asset' },
  ]);
  assert.deepEqual(record.facts.reviews, [{ decisionId: 'dec_1', state: 'unknown', reason: 'waiting for a human' }]);

  assert.deepEqual(Object.keys(record.snapshot).sort(), [
    'editorRevision',
    'fingerprint',
    'packageRevision',
    'schema',
  ]);
  assert.equal(record.snapshot.fingerprint, HASH_A);
  assert.equal(record.snapshot.packageRevision, 4);
  assert.equal(record.snapshot.editorRevision, 2);
  assert.deepEqual(record.excluded, [
    { assetId: 'a_logo', file: 'assets/logo.png', reason: 'licence policy blocked this asset' },
  ]);
});

test('intent is canonical, unknown stays unknown, and final is only final when preflight agrees', () => {
  const unknown = createExportArtifactRecord(deliveryResult({
    intent: undefined,
    preflight: { ...deliveryResult().preflight, facts: { ...deliveryResult().preflight.facts, intent: undefined } },
  }));
  assert.equal(unknown.ok, true);
  assert.equal(unknown.record.intent, 'unknown');
  const unknownHtml = renderDeliveryFacts(unknown.record);
  assert.match(unknownHtml, /data-easy-export-intent[^>]*>Not recorded</);

  const blocked = createExportArtifactRecord(deliveryResult({
    intent: 'final',
    preflight: {
      ok: false,
      final: false,
      intent: 'final',
      blockers: [{ code: 'REJECTED_CREATIVE_REVIEW', message: 'review dec_1 rejected this output' }],
      warnings: [],
      facts: {
        ...deliveryResult().preflight.facts,
        intent: 'final',
        reviews: [{ decisionId: 'dec_1', state: 'rejected', verdict: 'rejected' }],
      },
    },
  }));
  const blockedHtml = renderDeliveryFacts(blocked.record);
  assert.match(blockedHtml, /data-easy-export-intent[^>]*>Final requested — blocked</);
  assert.match(blockedHtml, /review dec_1 rejected this output/);
  assert.doesNotMatch(blockedHtml, /data-easy-export-intent[^>]*>Final</);

  const final = createExportArtifactRecord(deliveryResult({
    intent: 'final',
    preflight: { ...deliveryResult().preflight, ok: true, final: true, intent: 'final', facts: { ...deliveryResult().preflight.facts, intent: 'final' } },
  }));
  assert.match(renderDeliveryFacts(final.record), /data-easy-export-intent[^>]*>Final</);
});

test('does not invent an artifact id and reports that the export cannot be reopened', () => {
  for (const value of [undefined, null, '', '   ', 42]) {
    const result = createExportArtifactRecord(deliveryResult({ exportId: value }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-export-id');
    assert.match(result.notice, /cannot be reopened after reload/);
  }
});

test('no preflight means delivery facts were not recorded, not a fabricated default', () => {
  const result = createExportArtifactRecord(deliveryResult({ preflight: undefined, snapshot: undefined, intent: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.record.facts, null);
  const html = renderDeliveryFacts(result.record);
  assert.match(html, /Delivery facts not recorded for this file\./);
  assert.doesNotMatch(html, /No creative reviews recorded/);
  assert.doesNotMatch(html, /data-easy-export-intent[^>]*>Final</);
});

test('the same preflight renders identical facts for an MP4 and a Studio bundle', () => {
  const mp4 = createExportArtifactRecord(deliveryResult({ kind: 'mp4', files: [{ name: 'video.mp4', bytes: 1 }] }));
  const bundle = createExportArtifactRecord(deliveryResult({
    kind: 'studio-bundle',
    exportId: 'x_bundle',
    files: [{ name: 'package.zip', bytes: 999 }],
  }));
  assert.equal(renderDeliveryFacts(mp4.record), renderDeliveryFacts(bundle.record));
});

test('storage saves typed success and reports quota, unavailable and invalid records', () => {
  const storage = fakeStorage();
  const built = createExportArtifactRecord(deliveryResult());
  assert.deepEqual(saveExportArtifact(built.record, storage), { saved: true });
  assert.ok(storage.map.has(exportArtifactStorageKey('pkg_ux16')));

  const quota = fakeStorage();
  quota.setItem = () => {
    const error = new Error('quota');
    error.name = 'QuotaExceededError';
    throw error;
  };
  assert.deepEqual(saveExportArtifact(built.record, quota), { saved: false, reason: 'quota' });

  const unavailable = fakeStorage();
  unavailable.setItem = () => {
    const error = new Error('denied');
    error.name = 'SecurityError';
    throw error;
  };
  assert.deepEqual(saveExportArtifact(built.record, unavailable), { saved: false, reason: 'unavailable' });
  assert.deepEqual(saveExportArtifact(built.record, null), { saved: false, reason: 'unavailable' });
  assert.deepEqual(saveExportArtifact({ ...built.record, exportId: '' }, storage), { saved: false, reason: 'invalid' });
});

test('loading distinguishes none, ok and corrupt stored JSON instead of treating corruption as empty', () => {
  const storage = fakeStorage();
  assert.deepEqual(loadExportArtifact('pkg_ux16', storage), { status: 'none' });

  const built = createExportArtifactRecord(deliveryResult());
  saveExportArtifact(built.record, storage);
  const loaded = loadExportArtifact('pkg_ux16', storage);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.record.exportId, 'x_keep');

  storage.setItem(exportArtifactStorageKey('pkg_ux16'), '{not json');
  assert.deepEqual(loadExportArtifact('pkg_ux16', storage), { status: 'corrupt' });
});

test('forget removes a saved record and reports storage failures', () => {
  const storage = fakeStorage();
  const built = createExportArtifactRecord(deliveryResult());
  saveExportArtifact(built.record, storage);
  assert.deepEqual(forgetExportArtifact('pkg_ux16', storage), { forgotten: true });
  assert.deepEqual(loadExportArtifact('pkg_ux16', storage), { status: 'none' });

  const broken = fakeStorage();
  broken.removeItem = () => {
    throw new Error('denied');
  };
  assert.deepEqual(forgetExportArtifact('pkg_ux16', broken), { forgotten: false, reason: 'unavailable' });
});

test('recovery is truthful for every resolver outcome', async () => {
  const built = createExportArtifactRecord(deliveryResult());
  const record = built.record;
  const now = () => Date.parse('2026-10-26T12:00:00.000Z');

  const notConnected = await resolveSavedExport(record, undefined, { now });
  assert.equal(notConnected.state, 'not-connected');
  assert.match(notConnected.message, /reopening saved downloads is not connected in this build yet/i);

  assert.equal((await resolveSavedExport(record, async () => null, { now })).state, 'missing');

  const notFound = Object.assign(new Error('not found'), { status: 404 });
  assert.equal((await resolveSavedExport(record, async () => { throw notFound; }, { now })).state, 'missing');

  const missingCode = Object.assign(new Error('not found'), { code: 'ARTIFACT_MISSING' });
  assert.equal((await resolveSavedExport(record, async () => { throw missingCode; }, { now })).state, 'missing');

  const gone = Object.assign(new Error('gone'), { status: 410 });
  assert.equal((await resolveSavedExport(record, async () => { throw gone; }, { now })).state, 'expired');

  const expiredCode = Object.assign(new Error('expired'), { code: 'ARTIFACT_EXPIRED' });
  assert.equal((await resolveSavedExport(record, async () => { throw expiredCode; }, { now })).state, 'expired');

  const broken = new Error('resolver down');
  const errored = await resolveSavedExport(record, async () => { throw broken; }, { now });
  assert.equal(errored.state, 'error');
  assert.match(errored.message, /couldn't check that saved download/i);

  const ready = await resolveSavedExport(record, async () => ({
    href: 'https://media.example.test/video.mp4?sig=fresh',
    expiresAt: '2026-10-26T12:30:00.000Z',
  }), { now });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.href, 'https://media.example.test/video.mp4?sig=fresh');
});

test('a past expiry is renewed a bounded number of times before it is called expired', async () => {
  const built = createExportArtifactRecord(deliveryResult());
  const record = built.record;
  const now = () => Date.parse('2026-10-26T12:00:00.000Z');
  let calls = 0;

  const expired = await resolveSavedExport(record, async () => {
    calls += 1;
    return { href: 'https://media.example.test/old.mp4', expiresAt: '2026-10-26T11:00:00.000Z' };
  }, { now });
  assert.equal(expired.state, 'expired');
  assert.equal(calls, 2);

  calls = 0;
  const renewed = await resolveSavedExport(record, async () => {
    calls += 1;
    return calls === 1
      ? { href: 'https://media.example.test/old.mp4', expiresAt: '2026-10-26T11:00:00.000Z' }
      : { href: 'https://media.example.test/new.mp4', expiresAt: '2026-10-26T13:00:00.000Z' };
  }, { now });
  assert.equal(renewed.state, 'ready');
  assert.equal(renewed.href, 'https://media.example.test/new.mp4');
  assert.equal(calls, 2);
});
