// Read-only historical review input. A legacy run is not a new render artifact:
// its completion record and original render input remain the authority.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson } from '../../../packages/planner/dist/src/index.js';
import { contributionStore, renderedContribution } from '../../../packages/jobs/src/model-contribution.mjs';
import { readRenderArtifact } from './render-artifacts.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(canonicalJson(value));
const missing = () => Object.assign(new Error('The saved review artifact, completed run or trusted receipt is missing or has changed.'), { status: 404, code: 'ARTIFACT_MISSING' });
const maxBytes = 512 * 1024 * 1024;

// Names are fixed internally or validated IDs. Check every owned directory, not
// just the final path: even an in-root symlink must not alias a different run.
function ownedPath(root, ...names) {
  let file = root;
  for (const name of names) {
    file = join(file, name);
    if (realpathSync(file) !== file) throw missing();
  }
  return file;
}

function identity(stat) {
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw missing();
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function readOwned(root, ...names) {
  const file = ownedPath(root, ...names);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = identity(fstatSync(fd, { bigint: true }));
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes || identity(fstatSync(fd, { bigint: true })) !== before
      || identity(statSync(file, { bigint: true })) !== before
      || ownedPath(root, ...names) !== file) throw missing();
    return bytes;
  } finally { closeSync(fd); }
}

function trustedReceipt(packageDir, metadata, pkg) {
  // renderedContribution is the existing trust lookup; constrain its file path
  // too, since that lookup by itself follows filesystem symlinks.
  const root = realpathSync(dirname(resolve(packageDir)));
  if (resolve(contributionStore(packageDir)) !== join(root, '.comfy-provenance')) throw missing();
  const raw = readOwned(root, '.comfy-provenance', 'renders', `${metadata.videoSha256}.json`);
  const receipt = renderedContribution({ packageDir, videoSha256: metadata.videoSha256,
    pkg, packageId: metadata.packageId, packageHash: metadata.packageHash, timelineHash: metadata.timelineHash });
  if (!receipt || canonicalJson(receipt) !== canonicalJson(JSON.parse(raw))) throw missing();
  return receipt;
}

function verifyInputs(metadata, inputs) {
  const pkg = inputs?.package, timeline = inputs?.timeline;
  const { hash, ...body } = timeline ?? {};
  if (!pkg || typeof pkg.id !== 'string' || !pkg.id || !Number.isSafeInteger(pkg.revision) || pkg.revision < 0
    || metadata.packageId !== pkg.id || metadata.revision !== pkg.revision
    || digest(pkg) !== metadata.packageHash || timeline?.sourceHash !== metadata.packageHash
    || hash !== metadata.timelineHash || digest(body) !== hash) throw missing();
}

/** No current package/source reads, publication, copying or receipt creation.
 * Callers re-read before/after inspection and bind recordBytes + receipt hashes.
 */
export function readReviewArtifact({ runtimeDir, packageDir, renderId }) {
  try {
    if (typeof renderId !== 'string' || !/^(?:r|run)_[a-f0-9]{12}$/.test(renderId)) throw missing();
    const root = realpathSync(runtimeDir);
    const rendersDir = ownedPath(root, 'renders');
    const file = ownedPath(rendersDir, `${renderId}.mp4`);
    // Bound the read before invoking the existing normal-artifact reader.
    const video = readOwned(rendersDir, `${renderId}.mp4`);
    let metadata, inputs, recordBytes;
    if (renderId.startsWith('r_')) {
      const raw = readOwned(rendersDir, `${renderId}.artifact.json`);
      const record = JSON.parse(raw);
      // Constrain the ledger path before the older reader opens that file.
      verifyInputs(record, record.inputs);
      if (sha(video) !== record.videoSha256) throw missing();
      trustedReceipt(packageDir, record, record.inputs.package);
      ({ metadata } = readRenderArtifact({ renderId, rendersDir, receiptDir: packageDir }));
      if (canonicalJson(record) !== canonicalJson(JSON.parse(readOwned(rendersDir, `${renderId}.artifact.json`)))) throw missing();
      inputs = record.inputs;
      recordBytes = raw;
    } else {
      const inputBytes = readOwned(root, 'runs', renderId, 'render-input.json');
      const stateBytes = readOwned(root, 'runs', renderId, 'state.json');
      const input = JSON.parse(inputBytes), state = JSON.parse(stateBytes);
      // run.mjs persists this schema with done + finished, not a synthetic
      // succeeded boolean. A completed media settlement alone is insufficient.
      if (state.schema !== 'comfyrizz.run-record/v1' || state.runId !== renderId || input.runId !== renderId
        || state.status !== 'done' || state.finished !== true || state.error != null || state.errorCode != null
        || state.renderError != null || state.manifest?.complete === false
        || state.settlement?.kind !== 'completed' || state.packageId !== input.packageId
        || !state.render || !input.render || canonicalJson(state.render) !== canonicalJson(input.render)) throw missing();
      const render = state.render;
      inputs = { package: input.package, timeline: input.timeline };
      metadata = { schema: state.schema, runId: renderId, packageId: state.packageId, revision: state.revision,
        packageHash: render.package_sha256, timelineHash: render.timeline_sha256, videoSha256: render.video_sha256,
        bytes: render.bytes, frames: render.frames, videoUrl: render.url };
      if (render.bytes !== video.length || render.frames !== inputs.timeline?.durationInFrames
        || render.url !== `/api/run/${renderId}/video`) throw missing();
      // Domain-separated, length-framed full original bytes bind BOTH records;
      // whitespace and completion metadata changes invalidate an earlier review.
      recordBytes = Buffer.concat([Buffer.from(`comfyrizz.review-run/v1\n${inputBytes.length}\n`), inputBytes,
        Buffer.from(`\n${stateBytes.length}\n`), stateBytes]);
    }
    verifyInputs(metadata, inputs);
    if (sha(video) !== metadata.videoSha256) throw missing();
    const receipt = trustedReceipt(packageDir, metadata, inputs.package);
    return { metadata, inputs, recordBytes, file, receipt };
  } catch { throw missing(); }
}
