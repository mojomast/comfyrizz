// Authenticated durable MP4 access. Neither API tokens nor object URLs are saved
// in the export record; every reopen verifies the server's historical bytes.
type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
type Saved = { exportId: string; packageId: string; revision: number | null };
const idPattern = /^r_[a-f0-9]{12}$/;

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function metadata(apiFetch: ApiFetch, id: string, expected: { packageId: string; revision: number | null }) {
  if (!idPattern.test(id)) throw new Error('Saved video details are invalid');
  const response = await apiFetch(`/api/render/artifacts/${id}`);
  if (!response.ok) throw Object.assign(new Error('Saved video is unavailable'), { status: response.status });
  const value = await response.json();
  if (value.exportId !== id || value.packageId !== expected.packageId || value.revision !== expected.revision
    || value.intent !== 'final' || !/^[a-f0-9]{64}$/.test(value.videoSha256)
    || value.videoUrl !== `/api/render/artifacts/${id}/video`) throw new Error('Saved video does not match this project');
  return value;
}

export async function readRenderedArtifact(apiFetch: ApiFetch, response: Response, blob: Blob, expected: { packageId: string; revision: number }) {
  const url = response.headers.get('x-comfyrizz-artifact-url');
  if (!url) return {}; // Older servers/draft previews do not claim durable delivery.
  const match = /^\/api\/render\/artifacts\/(r_[a-f0-9]{12})$/.exec(url);
  if (!match) throw new Error('The video download address is invalid');
  const saved = await metadata(apiFetch, match[1], expected);
  if (response.headers.get('x-comfyrizz-video-sha256') !== saved.videoSha256
    || await sha256(blob) !== saved.videoSha256 || saved.files?.[0]?.bytes !== blob.size) throw new Error('Downloaded MP4 does not match its verification record');
  return saved;
}

export async function loadRenderedArtifact(apiFetch: ApiFetch, record: Saved) {
  const saved = await metadata(apiFetch, record.exportId, record);
  const response = await apiFetch(saved.videoUrl);
  if (!response.ok) throw Object.assign(new Error('Saved video is unavailable'), { status: response.status });
  const blob = await response.blob();
  if (response.headers.get('x-comfyrizz-video-sha256') !== saved.videoSha256
    || await sha256(blob) !== saved.videoSha256 || saved.files?.[0]?.bytes !== blob.size) throw new Error('Saved MP4 bytes no longer match their receipt');
  return { blob, exportId: saved.exportId as string };
}

export async function resolveRenderedArtifact(apiFetch: ApiFetch, record: Saved) {
  const { blob } = await loadRenderedArtifact(apiFetch, record);
  return { href: URL.createObjectURL(blob) };
}
