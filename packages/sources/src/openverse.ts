import { attributionFor, canonicalLicenseId, DEFAULT_LICENSE_POLICY, evaluateLicense, licenseFamily, licenseUrl } from './licenses.js';
import type { LicensePolicy, OpenverseCandidate, OpenverseSearchOptions, OpenverseSearchResult } from './types.js';

interface OpenverseResult {
  id?: string | number;
  title?: string;
  creator?: string;
  url?: string;
  thumbnail?: string;
  foreign_landing_url?: string;
  license?: string;
  license_version?: string;
  license_url?: string;
  width?: number;
  height?: number;
  mature?: boolean;
}

function policyLicenses(policy: LicensePolicy): string {
  // MIT is supported for packaged assets, but is not an Openverse search licence.
  const families = new Set(policy.allow.filter(id => canonicalLicenseId(id) !== 'MIT').map(id => {
    const family = licenseFamily(id);
    if (family === 'CC0') return 'cc0';
    if (family === 'PDM') return 'pdm';
    if (family === 'CC-BY') return 'by';
    return id.toLowerCase();
  }));
  return [...families].join(',');
}

export async function searchOpenverse(options: OpenverseSearchOptions): Promise<OpenverseSearchResult> {
  const query = options.query.trim();
  if (!query) throw new Error('Openverse query is required');
  const policy = options.policy ?? DEFAULT_LICENSE_POLICY;
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    page_size: String(pageSize),
    mature: 'false',
    license: policyLicenses(policy),
  });
  if (options.orientation) params.set('orientation', options.orientation);
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'comfyrizz/0.1' };
  if (options.apiToken) headers.authorization = `Bearer ${options.apiToken}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://api.openverse.org/v1/images/?${params.toString()}`, {
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 200);
    throw Object.assign(new Error(`Openverse HTTP ${response.status}${body ? `: ${body}` : ''}`), { status: response.status });
  }
  const payload = (await response.json()) as { results?: OpenverseResult[]; result_count?: number; page_count?: number };
  const candidates: OpenverseCandidate[] = [];
  for (const result of payload.results ?? []) {
    if (!result.url || result.id === undefined) continue;
    const id = String(result.id);
    const canonical = canonicalLicenseId(result.license, result.license_version);
    const licenseLink = result.license_url ?? licenseUrl(canonical);
    const attribution = attributionFor({ title: result.title, creator: result.creator, licenseId: canonical, licenseUrl: licenseLink });
    const decision = evaluateLicense(canonical, { policy, approvedByUser: false, attribution, origin: 'stock' });
    candidates.push({
      assetId: `openverse_${id.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
      provider: 'openverse',
      id,
      title: result.title?.trim() || `Openverse image ${id}`,
      creator: result.creator?.trim() || 'Unknown creator',
      ...(result.foreign_landing_url ? { landingUrl: result.foreign_landing_url } : {}),
      fileUrl: result.url,
      ...(result.thumbnail ? { thumbnailUrl: result.thumbnail } : {}),
      ...(result.width ? { width: result.width } : {}),
      ...(result.height ? { height: result.height } : {}),
      license: { id: canonical, ...(licenseLink ? { url: licenseLink } : {}), attribution },
      allowed: decision.allowed,
      redistributable: decision.redistributable,
      blocked: !decision.allowed,
      ...(decision.allowed ? {} : { blockedReason: decision.reason }),
      requiresAttribution: decision.requiresAttribution,
    });
  }
  return {
    candidates,
    page,
    pageSize,
    resultCount: Number(payload.result_count ?? candidates.length),
    pageCount: Number(payload.page_count ?? 1),
  };
}
