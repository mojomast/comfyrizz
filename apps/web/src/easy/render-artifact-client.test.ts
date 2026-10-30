import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadRenderedArtifact } from './render-artifact-client.ts';

test('reopened editor export checks revision, metadata and downloaded bytes before returning a blob', async () => {
  const bytes = 'synthetic receipt-bound video';
  const digest = createHash('sha256').update(bytes).digest('hex');
  const record = { exportId: 'r_123456789abc', packageId: 'pkg_test', revision: 7 };
  const metadata = { ...record, intent: 'final', videoSha256: digest,
    videoUrl: `/api/render/artifacts/${record.exportId}/video`, files: [{ bytes: bytes.length }] };
  for (const defect of ['none', 'revision', 'digest', 'size', 'url', 'bytes']) {
    const changed = structuredClone(metadata);
    if (defect === 'revision') changed.revision++;
    if (defect === 'digest') changed.videoSha256 = 'a'.repeat(64);
    if (defect === 'size') changed.files[0].bytes++;
    if (defect === 'url') changed.videoUrl = 'https://invalid.example/video';
    const api = async (path: string) => path.endsWith('/video')
      ? new Response(defect === 'bytes' ? 'overwritten bytes' : bytes, { headers: { 'x-comfyrizz-video-sha256': digest } })
      : Response.json(changed);
    if (defect === 'none') {
      const result = await loadRenderedArtifact(api, record);
      assert.equal(await result.blob.text(), bytes);
      assert.equal(result.exportId, record.exportId);
    } else await assert.rejects(loadRenderedArtifact(api, record), /match/);
  }
});
