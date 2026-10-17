import { createHash } from 'node:crypto';
import type { OpenverseCandidate, PackageAssetLike } from './types.js';

export interface DownloadCandidateOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface DownloadedCandidate {
  candidate: OpenverseCandidate;
  bytes: Buffer;
  sha256: string;
  mime: string;
  asset: PackageAssetLike;
}

function assertPublicHttps(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('candidate URL must be https');
  const host = parsed.hostname.toLowerCase();
  const blocked = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error('candidate URL points at a private or loopback host');
  return parsed;
}

function extensionFor(mime: string, pathname: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
  return match ? `.${match[1].toLowerCase()}` : '.img';
}

/**
 * Fetch a chosen Openverse candidate. Only https and public hosts are allowed;
 * bytes are capped and hashed. The asset stays a candidate until a human
 * approves the licence, so it is never redistributable here.
 */
export async function downloadOpenverseCandidate(candidate: OpenverseCandidate, options: DownloadCandidateOptions = {}): Promise<DownloadedCandidate> {
  const url = assertPublicHttps(candidate.fileUrl);
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { headers: { 'user-agent': 'comfyrizz/0.1' }, ...(options.signal ? { signal: options.signal } : {}) });
  if (!response.ok) throw Object.assign(new Error(`candidate download HTTP ${response.status}`), { status: response.status });
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`candidate exceeds ${maxBytes} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`candidate exceeds ${maxBytes} bytes`);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  if (!mime.startsWith('image/')) throw new Error(`candidate is not an image (${mime})`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = `assets/${candidate.assetId}${extensionFor(mime, url.pathname)}`;
  const asset: PackageAssetLike = {
    kind: 'image',
    origin: 'stock',
    status: 'candidate',
    file,
    sha256,
    bytes: bytes.byteLength,
    source: {
      provider: 'openverse',
      id: candidate.id,
      ...(candidate.landingUrl ? { landing_url: candidate.landingUrl } : {}),
      creator: candidate.creator,
      title: candidate.title,
    },
    license: {
      id: candidate.license.id,
      ...(candidate.license.url ? { url: candidate.license.url } : {}),
      attribution: candidate.license.attribution,
      approved_by_user: false,
    },
    redistributable: false,
    notes: 'downloaded candidate; awaiting licence approval before attach',
  };
  return { candidate, bytes, sha256, mime, asset };
}
