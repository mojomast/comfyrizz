#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const LICENSE_FAMILIES = {
  'CC0-1.0': 'CC0',
  'PDM-1.0': 'PDM',
  MIT: 'MIT',
  'Apache-2.0': 'OTHER',
  'BSD-2-Clause': 'OTHER',
  'BSD-3-Clause': 'OTHER',
  ISC: 'OTHER',
  'MPL-2.0': 'OTHER',
  'OFL-1.1': 'OTHER',
  'GPL-3.0-only': 'OTHER',
  'GPL-3.0-or-later': 'OTHER',
  'LGPL-3.0-only': 'OTHER',
  'LGPL-3.0-or-later': 'OTHER',
  'User-Upload': 'UPLOAD',
};

export function canonicalLicenseId(raw) {
  const value = String(raw ?? '').trim().toLowerCase().replace(/[\s_.]+/g, '-');
  if (!value) return 'UNKNOWN';
  if (value === 'mit') return 'MIT';
  if (value === 'apache-2.0' || value === 'apache-2') return 'Apache-2.0';
  if (value === 'cc0' || value === 'cc0-1.0' || value === 'cc-zero') return 'CC0-1.0';
  if (value === 'pdm' || value === 'pdm-1.0' || value === 'public-domain-mark') return 'PDM-1.0';
  if (value === 'user-upload' || value === 'user-provided') return 'User-Upload';
  if (value.startsWith('licenseref-')) return raw.trim();
  const match = /^cc-by(-nc|-nd|-sa){0,3}(?:-\d+(?:\.\d+)?)?$/.exec(value);
  if (match) {
    const parts = value.split('-');
    const base = parts.slice(0, parts.length - (/\d/.test(parts[parts.length - 1]) ? 1 : 0)).join('-').toUpperCase();
    const version = /\d/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : '4.0';
    return `${base}-${version}`;
  }
  return raw.trim();
}

export function licenseFamily(rawId) {
  const id = canonicalLicenseId(rawId);
  if (LICENSE_FAMILIES[id]) return LICENSE_FAMILIES[id];
  if (id.startsWith('LicenseRef-')) return 'CUSTOM';
  if (id.startsWith('CC-BY-SA')) return 'CC-BY-SA';
  if (id.startsWith('CC-BY-NC')) return 'CC-BY-NC';
  if (id.startsWith('CC-BY-ND')) return 'CC-BY-ND';
  if (id.startsWith('CC-BY')) return 'CC-BY';
  return 'UNKNOWN';
}

export function licenseUrl(rawId) {
  const id = canonicalLicenseId(rawId);
  const family = licenseFamily(id);
  const version = id.split('-').pop();
  if (family === 'CC0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (family === 'PDM') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  if (family === 'MIT') return 'https://opensource.org/license/mit/';
  if (family === 'CC-BY') return `https://creativecommons.org/licenses/by/${version}/`;
  if (family === 'CC-BY-SA') return `https://creativecommons.org/licenses/by-sa/${version}/`;
  if (family === 'CC-BY-NC') return `https://creativecommons.org/licenses/by-nc/${version}/`;
  if (family === 'CC-BY-ND') return `https://creativecommons.org/licenses/by-nd/${version}/`;
  return undefined;
}

function isRedistributable(asset) {
  if (asset?.license?.blocked) return false;
  if (asset?.redistributable === false) return false;
  const family = licenseFamily(asset?.license?.id);
  if (family === 'CC0' || family === 'PDM') return true;
  if (family === 'MIT') return Boolean(asset?.license?.attribution?.trim());
  if (family === 'CC-BY') {
    return asset?.origin !== 'generated'
      && asset?.license?.approved_by_user === true
      && Boolean(asset?.license?.attribution?.trim());
  }
  if (family === 'UPLOAD') return asset?.license?.approved_by_user === true;
  if (family === 'CUSTOM') return asset?.redistributable === true;
  return false;
}

function assetReferences(pkg) {
  const found = new Set();
  const assets = pkg?.assets ?? {};
  const visit = (value, key) => {
    if (key === 'assets') return;
    if (typeof value === 'string') {
      if (Object.prototype.hasOwnProperty.call(assets, value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  for (const [key, value] of Object.entries(pkg ?? {})) visit(value, key);
  for (const asset of Object.values(assets)) {
    for (const input of Object.values(asset?.gen?.inputs ?? {})) {
      if (typeof input === 'string' && Object.prototype.hasOwnProperty.call(assets, input)) found.add(input);
    }
  }
  return found;
}

function packageLabel(dir) {
  const absolute = resolve(dir);
  const rel = relative(REPO_ROOT, absolute);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  return basename(absolute);
}

function safeFilePresent(dir, file) {
  if (typeof file !== 'string' || !file.trim() || isAbsolute(file)) return false;
  const base = resolve(dir);
  const target = resolve(base, file);
  if (target !== base && !target.startsWith(`${base}${sep}`)) return false;
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function attributionFor(asset, licenseId) {
  if (asset?.license?.attribution?.trim()) return asset.license.attribution.trim();
  const title = asset?.source?.title?.trim();
  const creator = asset?.source?.creator?.trim();
  if (!title && !creator) return '';
  const label = licenseFamily(licenseId) === 'CC0'
    ? 'CC0 1.0'
    : licenseFamily(licenseId) === 'PDM'
      ? 'Public Domain Mark'
      : licenseId.replace(/^CC-/, 'CC ');
  return `${title ? `“${title}”` : 'Untitled'} by ${creator || 'Unknown creator'}, ${label}`;
}

function creatorFor(asset) {
  return asset?.source?.creator?.trim()
    || (asset?.origin === 'generated' ? 'Comfyrizz (generated)' : 'Unknown creator');
}

function titleFor(asset, assetId) {
  return asset?.source?.title?.trim() || assetId;
}

export function auditPackage(pkg, dir) {
  const packageName = packageLabel(dir);
  const used = assetReferences(pkg);
  const rows = [];

  for (const [assetId, asset] of Object.entries(pkg?.assets ?? {})) {
    const declaredId = asset?.license?.id;
    const licenseId = canonicalLicenseId(declaredId ?? (asset?.origin === 'generated' ? 'CC0-1.0' : 'UNKNOWN'));
    const family = licenseFamily(licenseId);
    const file = typeof asset?.file === 'string' ? asset.file : undefined;
    const filePresent = safeFilePresent(dir, file);
    const referenced = used.has(assetId);
    const declaredShipping = asset?.status === 'ready' && asset?.redistributable !== false;
    const wouldShip = referenced && (filePresent || declaredShipping);
    const redistributable = isRedistributable(asset);
    const attribution = attributionFor(asset, licenseId);
    const sourceUrl = asset?.source?.landing_url?.trim() || asset?.source?.original_file?.trim() || undefined;
    const problems = [];
    const details = [];

    if (family === 'UNKNOWN') {
      problems.push('unknown-license');
      details.push({
        code: 'unknown-license',
        message: `licence id ${declaredId ? `"${declaredId}"` : '(missing)'} is not recognised`,
      });
    }
    if (family === 'CC-BY' && wouldShip && !attribution) {
      problems.push('missing-attribution');
      details.push({ code: 'missing-attribution', message: 'CC BY asset would ship without an attribution string' });
    }
    const missingCcByAttribution = family === 'CC-BY' && wouldShip && !attribution;
    if (wouldShip && !redistributable && !missingCcByAttribution) {
      problems.push('non-redistributable-would-ship');
      details.push({
        code: 'non-redistributable-would-ship',
        message: asset?.license?.blocked_reason
          ? `non-redistributable asset would ship: ${asset.license.blocked_reason}`
          : 'non-redistributable asset is referenced by a shipping package',
      });
    }

    rows.push({
      package: packageName,
      assetId,
      title: titleFor(asset, assetId),
      creator: creatorFor(asset),
      licenseId,
      licenseFamily: family,
      licenseUrl: asset?.license?.url?.trim() || licenseUrl(licenseId),
      approval: asset?.license?.approved_by_user === true ? 'approved' : 'not approved',
      approvedByUser: asset?.license?.approved_by_user === true,
      redistributable,
      declaredRedistributable: asset?.redistributable === true,
      referenced,
      wouldShip,
      status: asset?.status ?? 'unknown',
      file: file ? file.split(sep).join('/') : undefined,
      filePresent,
      source: asset?.source?.provider ? `${asset.source.provider}${asset.source.id ? `:${asset.source.id}` : ''}` : (asset?.origin ?? 'unknown'),
      sourceUrl,
      attribution,
      problems,
      problemDetails: details,
    });
  }

  rows.sort((left, right) => left.assetId.localeCompare(right.assetId));
  return rows;
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

export function renderCredits(rows) {
  const packages = new Set(rows.map((row) => row.package));
  const problemRows = rows.flatMap((row) => row.problemDetails.map((detail) => ({ ...detail, package: row.package, assetId: row.assetId })));
  const ships = rows.filter((row) => row.wouldShip).length;
  const lines = [
    '# Credits audit',
    '',
    `${packages.size} package(s) · ${rows.length} asset(s) · ${ships} would ship · ${problemRows.length} problem(s)`,
    '',
  ];
  if (problemRows.length === 0) {
    lines.push('No problems found.');
    lines.push('');
  } else {
    lines.push('## Problems');
    lines.push('');
    for (const problem of problemRows) {
      lines.push(`- \`${problem.package}\` \`${problem.assetId}\` — ${problem.code}: ${problem.message}`);
    }
    lines.push('');
  }
  lines.push('## Assets');
  lines.push('');
  lines.push('| Package | Asset | Title | Creator | Licence | Approval | Redistributable | Ships | Source | Problems |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const licence = row.licenseUrl ? `[${escapeCell(row.licenseId)}](${row.licenseUrl})` : escapeCell(row.licenseId);
    const source = row.sourceUrl ? `[${escapeCell(row.source)}](${row.sourceUrl})` : escapeCell(row.source);
    lines.push([
      escapeCell(row.package),
      escapeCell(row.assetId),
      escapeCell(row.title),
      escapeCell(row.creator),
      licence,
      escapeCell(row.approval),
      row.redistributable ? 'yes' : 'no',
      row.wouldShip ? 'yes' : 'no',
      source,
      row.problems.length > 0 ? escapeCell(row.problems.join(', ')) : '—',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  if (rows.length === 0) lines.push('| — | — | No assets | — | — | — | — | — | — | — |');
  lines.push('');
  lines.push('“Ships” means the package references the asset and either its file is present or it is marked ready and not explicitly non-redistributable. Non-redistributable assets that would ship, unknown licence ids and CC BY assets without attribution are problems.');
  lines.push('');
  return `${lines.join('\n')}`;
}

export function buildReport(rows) {
  const packages = [...new Set(rows.map((row) => row.package))].sort();
  const problems = rows.flatMap((row) => row.problemDetails.map((detail) => ({
    package: row.package,
    assetId: row.assetId,
    ...detail,
  })));
  return {
    packages,
    summary: {
      packages: packages.length,
      assets: rows.length,
      wouldShip: rows.filter((row) => row.wouldShip).length,
      problems: problems.length,
    },
    rows,
    problems,
  };
}

function readPackage(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function auditRepo(root = REPO_ROOT) {
  const examplesDir = join(root, 'examples');
  const rows = [];
  const errors = [];
  if (!existsSync(examplesDir)) return { rows, errors };
  for (const name of readdirSync(examplesDir).sort()) {
    const file = join(examplesDir, name, 'package.json');
    if (!existsSync(file)) continue;
    try {
      rows.push(...auditPackage(readPackage(file), join(examplesDir, name)));
    } catch (error) {
      errors.push({
        package: `examples/${name}`,
        code: 'invalid-package',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { rows, errors };
}

function parseArgs(argv) {
  const options = { json: false, check: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--md') options.json = false;
    else if (arg === '--check') options.check = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.help) {
    console.log('Usage: node scripts/credits-audit.mjs [--md|--json] [--check]');
    return 0;
  }
  const { rows, errors } = auditRepo();
  const report = buildReport(rows);
  report.problems.push(...errors);
  report.summary.problems = report.problems.length;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const markdown = renderCredits(rows);
    console.log(errors.length > 0
      ? `${markdown}\n## Package errors\n\n${errors.map((error) => `- \`${error.package}\` — ${error.code}: ${error.message}`).join('\n')}\n`
      : markdown);
  }
  if (options.check && report.problems.length > 0) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
