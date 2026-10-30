import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRenderedArtifact, resolveRenderedArtifact } from '../src/easy/render-artifact-client.ts';

const bytes = 'actual downloaded bytes', sha = createHash('sha256').update(bytes).digest('hex');
const id = 'r_123456789abc', url = `/api/render/artifacts/${id}`;
const record = { exportId: id, packageId: 'pkg_test', revision: 14 };
const saved = { ...record, intent: 'final', videoSha256: sha, videoUrl: url + '/video', files: [{ name: 'video.mp4', bytes: bytes.length }] };
const response = () => new Response(bytes, { headers: { 'x-comfyrizz-artifact-url': url, 'x-comfyrizz-video-sha256': sha } });

test('normal render and reopened authenticated downloads verify identity and exact bytes', async () => {
  const paths: string[] = [];
  const api = async (path: string) => { paths.push(path); return path === url ? Response.json(saved) : response(); };
  assert.deepEqual(await readRenderedArtifact(api, response(), new Blob([bytes]), record), saved);
  const access = await resolveRenderedArtifact(api, record);
  assert.equal(await (await fetch(access.href)).text(), bytes); URL.revokeObjectURL(access.href);
  assert.deepEqual(paths, [url, url, url + '/video']);
});

test('changed video, package identity/revision, or metadata cannot be represented as the saved export', async () => {
  for (const overrides of [{ revision: 15 }, { packageId: 'other' }, { videoSha256: '0'.repeat(64) }, { videoUrl: 'https://external.test/video' }]) {
    const api = async () => Response.json({ ...saved, ...overrides });
    await assert.rejects(readRenderedArtifact(api, response(), new Blob([bytes]), record));
  }
  await assert.rejects(readRenderedArtifact(async () => Response.json(saved), response(), new Blob(['changed']), record), /does not match/);
  await assert.rejects(resolveRenderedArtifact(async path => path === url ? Response.json(saved) : new Response('changed', { headers: { 'x-comfyrizz-video-sha256': sha } }), record), /no longer match/);
  await assert.rejects(resolveRenderedArtifact(async () => new Response('', { status: 404 }), record), { status: 404 });
});
