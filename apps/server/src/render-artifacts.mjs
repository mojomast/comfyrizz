// Durable normal-MP4 deliveries. Only a newly completed render may publish;
// historical lookup verifies the saved inputs and actual bytes, never today's package.
import { readFileSync, writeFileSync, renameSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../packages/planner/dist/src/index.js';
import { recordRenderedContribution, renderedContribution } from '../../../packages/jobs/src/model-contribution.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const validId = id => /^r_[a-f0-9]{12}$/.test(id);
const missing = () => Object.assign(new Error('The saved render is missing or its verified bytes have changed.'), { status: 404, code: 'ARTIFACT_MISSING' });

function safeRead(root, name) {
  const base = realpathSync(root), file = realpathSync(join(base, name));
  if (!file.startsWith(base + sep)) throw missing();
  return readFileSync(file);
}

export function publishRenderArtifact({ renderId, rendersDir, receiptDir, staged, snapshot, preflight, result, revision }) {
  if (!validId(renderId) || snapshot.intent !== 'final') throw new Error('Only a fresh final render can be published');
  const videoPath = join(rendersDir, `${renderId}.mp4`);
  if (resolve(result.output) !== resolve(videoPath)) throw new Error('Renderer returned a different output path');
  const pkg = clone(result.package ?? snapshot.package);
  const timeline = clone(result.timeline ?? snapshot.timeline);
  const receipt = recordRenderedContribution({ pkg, timeline, packageDir: staged.packageDir, receiptDir, videoPath });
  const bytes = safeRead(rendersDir, `${renderId}.mp4`);
  if (digest(bytes) !== receipt.videoSha256) throw new Error('Rendered bytes changed during publication');
  const record = {
    schema: 'comfyrizz.render-artifact/v1', exportId: renderId, packageId: pkg.id, revision: revision ?? pkg.revision,
    intent: 'final', archiveMode: snapshot.archiveMode, createdAt: new Date().toISOString(),
    files: [{ name: 'video.mp4', bytes: bytes.length, sha256: receipt.videoSha256 }],
    preflight: clone(preflight),
    snapshot: { schema: snapshot.schema, fingerprint: snapshot.fingerprint, packageRevision: revision, editorRevision: snapshot.editorRevision },
    packageHash: receipt.packageHash, timelineHash: receipt.timelineHash, videoSha256: receipt.videoSha256,
    inputs: { package: pkg, timeline },
  };
  const file = join(rendersDir, `${renderId}.artifact.json`);
  writeFileSync(file + '.tmp', JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  renameSync(file + '.tmp', file);
  return publicRenderArtifact(record);
}

export function publicRenderArtifact(record) {
  const { inputs, ...metadata } = record;
  return { ...metadata, videoUrl: `/api/render/artifacts/${record.exportId}/video` };
}

export function readRenderArtifact({ renderId, rendersDir, receiptDir }) {
  try {
    if (!validId(renderId)) throw missing();
    const record = JSON.parse(safeRead(rendersDir, `${renderId}.artifact.json`));
    const bytes = safeRead(rendersDir, `${renderId}.mp4`);
    if (record.schema !== 'comfyrizz.render-artifact/v1' || record.exportId !== renderId || record.intent !== 'final'
      || digest(bytes) !== record.videoSha256 || record.files?.[0]?.bytes !== bytes.length
      || record.files?.[0]?.sha256 !== record.videoSha256
      || record.packageId !== record.inputs?.package?.id || record.revision !== record.inputs?.package?.revision
      || digest(canonicalJson(record.inputs.package)) !== record.packageHash
      || record.inputs.timeline?.hash !== record.timelineHash
      || !renderedContribution({ packageDir: receiptDir, videoSha256: record.videoSha256,
        pkg: record.inputs.package, timelineHash: record.timelineHash })) throw missing();
    return { metadata: publicRenderArtifact(record), bytes };
  } catch { throw missing(); }
}

// Discover only exports of the current saved revision. Verification still reads
// historical bytes/receipts; discovery never renders or relabels an older movie.
export function latestRenderArtifact({ packageId, revision, rendersDir, receiptDir }) {
  const candidates = [];
  for (const name of readdirSync(rendersDir)) {
    if (!/^r_[a-f0-9]{12}\.artifact\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(safeRead(rendersDir, name));
      if (record.packageId === packageId && record.revision === revision && record.intent === 'final'
        && name === `${record.exportId}.artifact.json`) candidates.push(record);
    } catch { /* An unreadable record is not a discoverable export. */ }
  }
  candidates.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.exportId.localeCompare(a.exportId));
  if (!candidates.length) throw missing();
  return readRenderArtifact({ renderId: candidates[0].exportId, rendersDir, receiptDir });
}
