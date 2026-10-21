import { attributionFor, canonicalLicenseId, DEFAULT_LICENSE_POLICY, isAssetRedistributable, licenseFamily, licenseUrl } from './licenses.js';
import type { CreditEntry, Credits, ExcludedAsset, LicensePolicy, PackageLike } from './types.js';

export interface BuildCreditsOptions {
  generatedAt?: string;
  policy?: LicensePolicy;
  excluded?: ExcludedAsset[];
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

export function buildCredits(pkg: PackageLike, options: BuildCreditsOptions = {}): Credits {
  const policy = options.policy ?? DEFAULT_LICENSE_POLICY;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const entries: CreditEntry[] = [];
  for (const [assetId, asset] of Object.entries(pkg.assets ?? {})) {
    const licenseId = canonicalLicenseId(asset.license?.id ?? (asset.origin === 'generated' ? 'CC0-1.0' : 'UNKNOWN'));
    const link = asset.license?.url ?? licenseUrl(licenseId);
    const attribution = asset.license?.attribution ?? attributionFor({ title: asset.source?.title, creator: asset.source?.creator, licenseId, licenseUrl: link });
    entries.push({
      assetId,
      title: asset.source?.title?.trim() || assetId,
      creator: asset.source?.creator?.trim() || (asset.origin === 'generated' ? 'Comfyrizz (generated)' : 'Unknown creator'),
      licenseId,
      ...(link ? { licenseUrl: link } : {}),
      ...(licenseId === 'MIT' && isAssetRedistributable(asset, policy) && !options.excluded?.some(item => item.assetId === assetId && (!item.file || item.file === asset.file)) ? { licenseNotice: 'licenses/MIT.txt' } : {}),
      ...(asset.source?.landing_url ? { sourceUrl: asset.source.landing_url } : {}),
      attribution,
      ...(asset.file ? { file: asset.file } : {}),
      redistributable: isAssetRedistributable(asset, policy),
    });
  }
  entries.sort((a, b) => a.assetId.localeCompare(b.assetId));
  const requiresEndCard = entries.some(entry => entry.redistributable && licenseFamily(entry.licenseId) === 'CC-BY');
  const excluded = options.excluded ?? [];
  const lines: string[] = [
    `# Credits — ${pkg.title ?? pkg.id ?? 'Comfyrizz package'}`,
    '',
    `Package: \`${pkg.id ?? 'unknown'}\` (revision ${pkg.revision ?? 'n/a'})`,
    `Generated: ${generatedAt}`,
    '',
    '## Assets',
    '',
    '| Asset | Title | Creator | Licence | Source | Ships in package.zip |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    const source = entry.sourceUrl ? `[source](${entry.sourceUrl})` : entry.file ? `\`${entry.file}\`` : '—';
    const licence = (entry.licenseUrl ? `[${entry.licenseId}](${entry.licenseUrl})` : entry.licenseId) + (entry.licenseNotice ? ` ([notice](${entry.licenseNotice}))` : '');
    lines.push(`| ${escapeCell(entry.assetId)} | ${escapeCell(entry.title)} | ${escapeCell(entry.creator)} | ${licence} | ${source} | ${entry.redistributable ? 'yes' : 'no'} |`);
  }
  if (entries.length === 0) lines.push('| — | No assets | — | — | — | — |');
  if (requiresEndCard) {
    lines.push('', '## End card', '', 'This video uses CC BY assets and must show a credits end card in the exported MP4.');
  }
  if (excluded.length > 0) {
    lines.push('', '## Not redistributable (fetch it yourself)', '', 'These assets are listed by source URL and hash. They are not included in package.zip; fetch them again before reproducing this edit.', '');
    for (const item of excluded) {
      lines.push(`- \`${item.assetId}\`${item.file ? ` (${item.file})` : ''}: ${item.reason}${item.sourceUrl ? ` — ${item.sourceUrl}` : ''}${item.sha256 ? ` — sha256 ${item.sha256}` : ''}`);
    }
  }
  return { version: 1, packageId: pkg.id ?? 'unknown', generatedAt, entries, requiresEndCard, markdown: `${lines.join('\n')}\n` };
}
