export interface PackageAssetLike {
  kind?: string;
  origin?: 'generated' | 'stock' | 'upload' | string;
  status?: string;
  file?: string;
  sha256?: string;
  bytes?: number;
  source?: { provider?: string; id?: string; landing_url?: string; creator?: string; title?: string; retrieved_at?: string; original_file?: string };
  license?: { id?: string; url?: string; attribution?: string; approved_by_user?: boolean; approved_at?: string; blocked?: boolean; blocked_reason?: string };
  redistributable?: boolean;
  model_license?: { id?: string; commercial_ok_if?: string; note?: string };
  notes?: string;
}

export interface PackageLike {
  id?: string;
  title?: string;
  revision?: number;
  assets?: Record<string, PackageAssetLike>;
  [key: string]: unknown;
}

export interface LicenseDecision {
  allowed: boolean;
  canonicalId: string;
  family: 'CC0' | 'PDM' | 'CC-BY' | 'CC-BY-SA' | 'CC-BY-NC' | 'CC-BY-ND' | 'GENERATED' | 'UPLOAD' | 'UNKNOWN';
  redistributable: boolean;
  requiresAttribution: boolean;
  reason: string;
}

export interface LicensePolicy {
  name: string;
  allow: string[];
  blockShareAlike: boolean;
  blockNonCommercial: boolean;
  blockNoDerivatives: boolean;
  requireAttribution: boolean;
}

export interface OpenverseCandidate {
  assetId: string;
  provider: 'openverse';
  id: string;
  title: string;
  creator: string;
  landingUrl?: string;
  fileUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  license: { id: string; url?: string; attribution: string };
  allowed: boolean;
  redistributable: boolean;
  blocked: boolean;
  blockedReason?: string;
  requiresAttribution: boolean;
}

export interface OpenverseSearchOptions {
  query: string;
  page?: number;
  pageSize?: number;
  orientation?: 'landscape' | 'portrait' | 'square';
  policy?: LicensePolicy;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  apiToken?: string;
}

export interface OpenverseSearchResult {
  candidates: OpenverseCandidate[];
  page: number;
  pageSize: number;
  resultCount: number;
  pageCount: number;
}

export interface UploadOptions {
  filePath: string;
  rightsAsserted: boolean;
  shareable: boolean;
  title?: string;
  creator?: string;
  assetId?: string;
  retrievedAt?: string;
  maxBytes?: number;
}

export interface UploadResult {
  asset: PackageAssetLike;
  bytes: number;
  sha256: string;
  mime: string;
  file: string;
}

export interface CreditEntry {
  assetId: string;
  title: string;
  creator: string;
  licenseId: string;
  licenseUrl?: string;
  sourceUrl?: string;
  attribution: string;
  file?: string;
  redistributable: boolean;
}

export interface Credits {
  version: 1;
  packageId: string;
  generatedAt: string;
  entries: CreditEntry[];
  requiresEndCard: boolean;
  markdown: string;
}

export interface PackageZipInput {
  package: PackageLike;
  timeline?: unknown;
  assets?: Record<string, Uint8Array | Buffer | string>;
  workflows?: Record<string, Uint8Array | Buffer | string>;
  generatedAt?: string;
  credits?: Credits;
  licensePolicy?: LicensePolicy;
  /**
   * X1: extra bundle files (thumb, gif, card, chapters) the caller has already
   * cleared through the rights filter. Refused ones are listed in extraExcluded
   * and are not shipped.
   */
  extras?: ZipEntry[];
  extraExcluded?: ExcludedAsset[];
}

export interface ZipEntry {
  path: string;
  data: Uint8Array | Buffer | string;
}

export interface ExcludedAsset {
  assetId: string;
  file?: string;
  sha256?: string;
  licenseId?: string;
  sourceUrl?: string;
  reason: string;
}

export interface PackageZipResult {
  bytes: Buffer;
  complete: boolean;
  included: string[];
  excluded: ExcludedAsset[];
  entries: string[];
  manifest: Record<string, unknown>;
}
