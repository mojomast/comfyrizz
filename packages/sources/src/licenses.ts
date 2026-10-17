import type { LicenseDecision, LicensePolicy, PackageAssetLike } from './types.js';

export const DEFAULT_LICENSE_POLICY: LicensePolicy = {
  name: 'comfyrizz-v0.1',
  allow: ['CC0-1.0', 'PDM-1.0', 'CC-BY-4.0'],
  blockShareAlike: true,
  blockNonCommercial: true,
  blockNoDerivatives: true,
  requireAttribution: true,
};

/** Openverse returns bare ids like cc0, by, by-sa, by-nc; canonicalise them. */
export function canonicalLicenseId(raw: string | undefined, version?: string | number): string {
  const value = (raw ?? '').trim().toLowerCase().replace(/[\s_.]+/g, '-');
  if (!value) return 'UNKNOWN';
  if (value === 'cc0' || value === 'cc0-1.0' || value === 'cc-zero' || value === 'creativecommons-cc0') return 'CC0-1.0';
  if (value === 'pdm' || value === 'pdm-1.0' || value === 'public-domain-mark') return 'PDM-1.0';
  if (value === 'by' || value === 'cc-by' || value === 'cc-by-4.0') return version ? `CC-BY-${normalizeVersion(version)}` : 'CC-BY-4.0';
  if (value === 'by-sa' || value === 'cc-by-sa') return version ? `CC-BY-SA-${normalizeVersion(version)}` : 'CC-BY-SA-4.0';
  if (value === 'by-nc' || value === 'cc-by-nc') return version ? `CC-BY-NC-${normalizeVersion(version)}` : 'CC-BY-NC-4.0';
  if (value === 'by-nd' || value === 'cc-by-nd') return version ? `CC-BY-ND-${normalizeVersion(version)}` : 'CC-BY-ND-4.0';
  if (value === 'by-nc-sa' || value === 'cc-by-nc-sa') return version ? `CC-BY-NC-SA-${normalizeVersion(version)}` : 'CC-BY-NC-SA-4.0';
  if (value === 'by-nc-nd' || value === 'cc-by-nc-nd') return version ? `CC-BY-NC-ND-${normalizeVersion(version)}` : 'CC-BY-NC-ND-4.0';
  if (value === 'user-upload') return 'User-Upload';
  return (raw ?? '').trim();
}

function normalizeVersion(version: string | number): string {
  const text = String(version).trim();
  return /^\d+$/.test(text) ? `${text}.0` : text;
}

export function licenseFamily(id: string): LicenseDecision['family'] {
  if (id === 'CC0-1.0') return 'CC0';
  if (id === 'PDM-1.0') return 'PDM';
  if (id === 'User-Upload') return 'UPLOAD';
  if (id.startsWith('CC-BY-SA')) return 'CC-BY-SA';
  if (id.startsWith('CC-BY-NC')) return 'CC-BY-NC';
  if (id.startsWith('CC-BY-ND')) return 'CC-BY-ND';
  if (id.startsWith('CC-BY')) return 'CC-BY';
  return 'UNKNOWN';
}

export interface EvaluateLicenseOptions {
  policy?: LicensePolicy;
  approvedByUser?: boolean;
  attribution?: string;
  origin?: PackageAssetLike['origin'];
}

/**
 * v0.1 policy: CC0, PDM and CC BY pass; share-alike, non-commercial and
 * no-derivatives are blocked until their obligations exist. CC BY only becomes
 * redistributable once a human approved it and an attribution string is stored.
 */
export function evaluateLicense(rawId: string | undefined, options: EvaluateLicenseOptions = {}): LicenseDecision {
  const policy = options.policy ?? DEFAULT_LICENSE_POLICY;
  const canonicalId = canonicalLicenseId(rawId);
  const family = licenseFamily(canonicalId);
  const base = { canonicalId, family, redistributable: false, requiresAttribution: false, reason: '' };
  if (options.origin === 'generated' && (canonicalId === 'CC0-1.0' || canonicalId === 'UNKNOWN')) {
    return { ...base, canonicalId: canonicalId === 'UNKNOWN' ? 'CC0-1.0' : canonicalId, family: 'GENERATED', allowed: true, redistributable: true, reason: 'generated output defaults to CC0-1.0' };
  }
  if (family === 'UPLOAD') {
    const shareable = options.approvedByUser === true;
    return { ...base, allowed: shareable, redistributable: shareable, reason: shareable ? 'user asserts rights and shareability' : 'upload not marked shareable' };
  }
  if (family === 'CC0' || family === 'PDM') {
    return { ...base, allowed: true, redistributable: true, reason: `${canonicalId} has no attribution obligation` };
  }
  if (family === 'CC-BY') {
    const allowed = policy.allow.some(allowedId => allowedId === canonicalId || canonicalId.startsWith(`${allowedId.split('-').slice(0, 2).join('-')}-`));
    const approved = options.approvedByUser === true;
    const hasAttribution = Boolean(options.attribution && options.attribution.trim());
    const redistributable = allowed && approved && hasAttribution && !options.origin?.includes('generated');
    const reason = !allowed
      ? `${canonicalId} is outside the v0.1 allow list`
      : !approved
        ? 'CC BY needs explicit user approval'
        : !hasAttribution
          ? 'CC BY needs a stored attribution string'
          : 'CC BY approved with attribution';
    return { ...base, allowed, redistributable, requiresAttribution: true, reason };
  }
  if (family === 'CC-BY-SA' && policy.blockShareAlike) return { ...base, allowed: false, reason: 'share-alike obligations are not implemented in v0.1' };
  if (family === 'CC-BY-NC' && policy.blockNonCommercial) return { ...base, allowed: false, reason: 'non-commercial licence is outside the v0.1 policy' };
  if (family === 'CC-BY-ND' && policy.blockNoDerivatives) return { ...base, allowed: false, reason: 'no-derivatives licence cannot be edited into a video' };
  return { ...base, allowed: false, reason: `unrecognised licence ${canonicalId}` };
}

export function attributionFor(input: { title?: string; creator?: string; licenseId: string; licenseUrl?: string }): string {
  const title = input.title?.trim() || 'Untitled';
  const creator = input.creator?.trim() || 'Unknown creator';
  const family = licenseFamily(input.licenseId);
  const label = family === 'CC0' ? 'CC0 1.0' : family === 'PDM' ? 'Public Domain Mark' : input.licenseId.replace(/^CC-/, 'CC ');
  return `“${title}” by ${creator}, ${label}${input.licenseUrl ? ` (${input.licenseUrl})` : ''}`;
}

/** An asset only ships in package.zip when its rights and approval allow it. */
export function isAssetRedistributable(asset: PackageAssetLike, policy: LicensePolicy = DEFAULT_LICENSE_POLICY): boolean {
  if (asset.license?.blocked) return false;
  if (asset.redistributable === false) return false;
  const decision = evaluateLicense(asset.license?.id, {
    policy,
    approvedByUser: asset.license?.approved_by_user,
    attribution: asset.license?.attribution,
    origin: asset.origin,
  });
  if (!decision.redistributable) return false;
  return asset.redistributable === true || asset.origin === 'generated' || asset.origin === 'upload';
}

export function licenseUrl(id: string): string | undefined {
  const family = licenseFamily(id);
  const version = id.split('-').pop();
  if (family === 'CC0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (family === 'PDM') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  if (family === 'CC-BY') return `https://creativecommons.org/licenses/by/${version ?? '4.0'}/`;
  if (family === 'CC-BY-SA') return `https://creativecommons.org/licenses/by-sa/${version ?? '4.0'}/`;
  if (family === 'CC-BY-NC') return `https://creativecommons.org/licenses/by-nc/${version ?? '4.0'}/`;
  if (family === 'CC-BY-ND') return `https://creativecommons.org/licenses/by-nd/${version ?? '4.0'}/`;
  return undefined;
}
