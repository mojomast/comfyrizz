import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLivePreviewCollector } from '../src/live-previews.mjs';

test('live previews expose only verified completed jobs, retry failures, and deduplicate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-previews-'));
  const bytes = Buffer.from('verified clip');
  const output = { relative: 'assets/clip.mp4', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const jobsDoc = { hash: 'plan', packageId: 'pkg_demo', jobs: [{ id: 'clip.plate' }, { id: 'later.plate' }] };
  const manifest = { jobsHash: 'plan', packageId: 'pkg_demo', jobs: [
    { job: 'clip.plate', status: 'succeeded', outputs: [output] },
    { job: 'later.plate', status: 'pending', outputs: [output] },
    { job: 'unknown.plate', status: 'succeeded', outputs: [output] },
  ] };
  let corrupt = true;
  const landed = [], errors = [], downloads = [];
  const collector = createLivePreviewCollector({ jobsDoc, directory, remoteRoot: '/out',
    download: async ({ remote, local }) => { downloads.push(remote); writeFileSync(local, remote.endsWith('manifest.json') ? JSON.stringify(manifest) : corrupt ? 'bad' : bytes); },
    onReady: payload => landed.push(payload), onError: error => errors.push(error.message),
  });
  try {
    await collector.poll();
    assert.equal(landed.length, 0);
    assert.match(errors[0], /verification failed/);
    corrupt = false;
    await collector.poll();
    await collector.poll();
    assert.equal(landed.length, 1);
    assert.deepEqual(landed[0].manifest.jobs.map(job => job.job), ['clip.plate']);
    assert.equal(landed[0].manifest.complete, false);
    assert.deepEqual(readFileSync(join(directory, output.relative)), bytes);
    assert.equal(downloads.filter(path => path.endsWith('.mp4')).length, 2);
    manifest.jobsHash = 'wrong-plan';
    await assert.rejects(collector.poll(), /does not match/);
  } finally { await collector.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('unsafe output paths are never downloaded and stopping awaits in-flight work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-previews-'));
  const jobsDoc = { hash: 'plan', packageId: 'pkg_demo', jobs: [{ id: 'clip.plate' }] };
  let release;
  const downloaded = [];
  const collector = createLivePreviewCollector({ jobsDoc, directory, remoteRoot: '/out',
    download: async ({ remote, local }) => {
      downloaded.push(remote);
      await new Promise(resolve => { release = resolve; });
      writeFileSync(local, JSON.stringify({ jobsHash: 'plan', packageId: 'pkg_demo', jobs: [{ job: 'clip.plate', status: 'succeeded', outputs: [{ relative: '../escape.mp4', sha256: 'a'.repeat(64) }] }] }));
    }, onReady: () => assert.fail('no unsafe or stopped output may land'),
  });
  try {
    const pending = collector.poll();
    assert.equal(collector.poll(), pending);
    const stopping = collector.stop();
    release();
    await stopping;
    assert.deepEqual(downloaded, ['/out/manifest.json']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
