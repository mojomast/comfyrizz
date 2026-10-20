const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

function normalizeVersion(version) {
  const value = String(version ?? '').trim();
  if (!value) return '4.0';
  return /^\d+$/.test(value) ? `${value}.0` : value;
}

function canonicalLicenseId(raw) {
  const value = String(raw ?? '').trim().toLowerCase().replace(/[\s_.]+/g, '-');
  if (!value) return 'UNKNOWN';
  if (value === 'mit') return 'MIT';
  if (value === 'cc0' || value === 'cc0-1.0' || value === 'cc-zero' || value === 'creativecommons-cc0') return 'CC0-1.0';
  if (value === 'pdm' || value === 'pdm-1.0' || value === 'public-domain-mark') return 'PDM-1.0';
  if (value === 'user-upload' || value === 'upload') return 'User-Upload';
  if (value.startsWith('cc-by') || value.startsWith('by-') || value === 'by') {
    const compact = value.replace(/^cc-/, '');
    const match = compact.match(/^(.*)-(\d+(?:\.\d+)?)$/);
    const base = match?.[1] || compact;
    const version = normalizeVersion(match?.[2]);
    const names = {
      by: 'CC-BY',
      'by-sa': 'CC-BY-SA',
      'by-nc': 'CC-BY-NC',
      'by-nd': 'CC-BY-ND',
      'by-nc-sa': 'CC-BY-NC-SA',
      'by-nc-nd': 'CC-BY-NC-ND',
    };
    if (names[base]) return `${names[base]}-${version}`;
  }
  const trimmed = String(raw ?? '').trim();
  return trimmed || 'UNKNOWN';
}

function licenseFamily(id) {
  if (id === 'CC0-1.0') return 'CC0';
  if (id === 'PDM-1.0') return 'PDM';
  if (id === 'MIT') return 'MIT';
  if (id === 'User-Upload') return 'UPLOAD';
  if (id.startsWith('CC-BY-NC')) return 'CC-BY-NC';
  if (id.startsWith('CC-BY-SA')) return 'CC-BY-SA';
  if (id.startsWith('CC-BY-ND')) return 'CC-BY-ND';
  if (id.startsWith('CC-BY')) return 'CC-BY';
  return 'UNKNOWN';
}

function displayLicense(id) {
  const family = licenseFamily(id);
  if (family === 'CC0') return 'CC0 1.0';
  if (family === 'PDM') return 'Public Domain Mark';
  if (family === 'MIT') return 'MIT';
  if (family === 'UPLOAD') return 'User upload';
  if (family === 'UNKNOWN') return id === 'UNKNOWN' ? 'unknown' : id;
  return id.replace(/^CC-/, 'CC ').replace(/-([\d.]+)$/, ' $1');
}

function safeUrl(value) {
  const raw = text(value);
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
}

function sourceUrlFor(asset) {
  return safeUrl(asset?.source?.landing_url)
    ?? safeUrl(asset?.source?.original_file)
    ?? safeUrl(asset?.license?.url);
}

function withCreator(label, creator) {
  return creator ? `${label} — ${creator}` : label;
}

function blocked(assetId, label, reason, sourceUrl) {
  return { assetId, label, tone: 'blocked', detail: reason, sourceUrl };
}

function chipForAsset(assetId, asset) {
  const creator = text(asset?.source?.creator);
  const origin = String(asset?.origin ?? '').trim().toLowerCase();
  const sourceUrl = sourceUrlFor(asset);
  const attribution = text(asset?.license?.attribution);
  const rawLicense = asset?.license?.id;
  const canonical = canonicalLicenseId(rawLicense);
  const family = licenseFamily(canonical);
  const display = displayLicense(canonical);

  if (origin === 'generated') {
    return {
      assetId,
      label: 'generated (CC0)',
      tone: 'ok',
      detail: 'generated output defaults to CC0-1.0',
      sourceUrl,
    };
  }

  if (origin === 'upload') {
    const shareable = asset?.redistributable === true || asset?.shareable === true || asset?.source?.shareable === true;
    if (shareable) {
      return {
        assetId,
        label: 'upload (shareable)',
        tone: 'ok',
        detail: 'user asserts rights and shareability',
        sourceUrl,
      };
    }
    return blocked(assetId, 'upload (not shareable)', 'upload not marked shareable', sourceUrl);
  }

  if (asset?.license?.blocked === true) {
    const reason = text(asset.license.blocked_reason) ?? `${display} is blocked by the v0.1 policy`;
    return blocked(assetId, withCreator(display, creator), reason, sourceUrl);
  }

  if (family === 'CC0' || family === 'PDM') {
    return {
      assetId,
      label: withCreator(display, creator),
      tone: 'ok',
      detail: `${canonical} has no attribution obligation`,
      sourceUrl,
    };
  }

  if (family === 'MIT') {
    const hasAttribution = Boolean(attribution);
    return {
      assetId,
      label: withCreator(display, creator),
      tone: hasAttribution ? 'ok' : 'warn',
      detail: hasAttribution
        ? 'MIT with stored attribution and bundled licence notice'
        : 'MIT needs a stored attribution/notice string',
      sourceUrl,
    };
  }

  if (family === 'CC-BY') {
    const approved = asset?.license?.approved_by_user === true;
    const hasAttribution = Boolean(attribution);
    if (!approved) {
      return {
        assetId,
        label: withCreator(display, creator),
        tone: 'warn',
        detail: `${display} needs approval${creator ? ` — ${creator}` : ''}`,
        sourceUrl,
      };
    }
    if (!hasAttribution) {
      return {
        assetId,
        label: withCreator(display, creator),
        tone: 'warn',
        detail: `${display} needs approval — a stored attribution string is required`,
        sourceUrl,
      };
    }
    return {
      assetId,
      label: withCreator(display, creator),
      tone: 'ok',
      detail: attribution,
      sourceUrl,
    };
  }

  if (family === 'CC-BY-SA') {
    return blocked(
      assetId,
      withCreator(display, creator),
      'share-alike obligations are not implemented in v0.1',
      sourceUrl,
    );
  }

  if (family === 'CC-BY-NC') {
    return blocked(
      assetId,
      withCreator(display, creator),
      'non-commercial licence is outside the v0.1 policy',
      sourceUrl,
    );
  }

  if (family === 'CC-BY-ND') {
    return blocked(
      assetId,
      withCreator(display, creator),
      'no-derivatives licence cannot be edited into a video',
      sourceUrl,
    );
  }

  return blocked(assetId, withCreator(display, creator), `unrecognised licence ${canonical}`, sourceUrl);
}

export function licenceChips(pkg) {
  if (!isObject(pkg) || !isObject(pkg.assets)) return [];
  return Object.entries(pkg.assets)
    .filter(([, asset]) => isObject(asset))
    .map(([assetId, asset]) => chipForAsset(assetId, asset));
}

export function renderLicenceChips(chips) {
  const list = Array.isArray(chips) ? chips : [];
  const items = list.map((chip, index) => {
    if (!isObject(chip)) return '';
    const label = String(chip.label ?? 'unknown licence');
    const detail = String(chip.detail ?? '');
    const tone = chip.tone === 'ok' || chip.tone === 'warn' || chip.tone === 'blocked' ? chip.tone : 'blocked';
    const assetId = String(chip.assetId ?? `asset-${index + 1}`);
    const href = safeUrl(chip.sourceUrl);
    const link = href
      ? `<a class="licence-chip-source" href="${esc(href)}" target="_blank" rel="noopener">source</a>`
      : '';

    return `<li class="licence-chip" data-tone="${tone}" data-asset-id="${esc(assetId)}" title="${esc(detail)}"><span class="licence-chip-dot" aria-hidden="true"></span><span class="licence-chip-label">${esc(label)}</span><span class="licence-chip-detail">${esc(detail)}</span>${link}</li>`;
  }).filter(Boolean);

  return `<ul class="licence-chips" aria-label="Asset licences">${items.length ? `\n${items.join('\n')}\n` : ''}</ul>`;
}
