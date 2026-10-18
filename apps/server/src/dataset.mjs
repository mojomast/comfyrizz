// D1: turn a pasted/uploaded CSV (or a URL the server fetches) into a validated
// package dataset plus the chart scenes the agent proposes for it. No model and
// no Google Colab runtime: parsing is `@comfyrizz/agent`'s pure CSV module.
import { datasetFromCsv, proposeChartScenes } from '../../../packages/agent/dist/src/index.js';

export const MAX_CSV_BYTES = 256 * 1024;
export const DATASET_FETCH_TIMEOUT_MS = 5000;

/** Reject obvious SSRF targets before a fetch; tests never need a real socket. */
export function isBlockedHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** A schema-valid `d_...` id, derived from the label when the caller omits one. */
export function datasetIdFor(requested, label) {
  let source = typeof requested === 'string' && requested.trim() ? requested.trim() : String(label ?? 'data');
  if (source.startsWith('d_')) source = source.slice(2);
  const slug = source.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 63);
  const id = `d_${slug || 'data'}`;
  if (!/^d[A-Za-z0-9_-]{0,63}$/.test(id)) throw httpError(400, 'invalid dataset id');
  return id;
}

function parseBody(csv, body) {
  const { dataset, warnings, header } = datasetFromCsv(csv, {
    unit: body.unit,
    ...(body.label ? { label: body.label } : {}),
    ...(body.source ? { source: body.source } : {}),
    ...(body.note ? { note: body.note } : {}),
    ...(body.sourceUrl ? { sourceUrl: body.sourceUrl } : {}),
    ...(body.retrievedAt ? { retrievedAt: body.retrievedAt } : {}),
    ...(body.labelColumn ? { labelColumn: body.labelColumn } : {}),
    ...(body.valueColumn ? { valueColumn: body.valueColumn } : {}),
  });
  const datasetId = datasetIdFor(body.datasetId, dataset.label);
  const scenes = proposeChartScenes({ datasetId, dataset, ...(Array.isArray(body.kinds) ? { kinds: body.kinds } : {}) });
  return { datasetId, dataset, warnings, header, scenes };
}

/**
 * Resolve a `POST /api/dataset` body. Provide `csv` (paste/upload) or `url`
 * (server-side fetch with a byte cap and SSRF guard); one is required.
 */
export async function buildDataset(body, { fetchImpl = globalThis.fetch, maxBytes = MAX_CSV_BYTES, timeoutMs = DATASET_FETCH_TIMEOUT_MS, now = () => new Date().toISOString() } = {}) {
  if (!body || typeof body !== 'object') throw httpError(400, 'body required');
  if (typeof body.csv === 'string' && body.csv.length > 0) {
    if (Buffer.byteLength(body.csv) > maxBytes) throw httpError(413, `CSV is larger than ${maxBytes} bytes`);
    return parseBody(body.csv, body);
  }
  if (typeof body.url === 'string' && body.url.length > 0) {
    let url;
    try {
      url = new URL(body.url);
    } catch {
      throw httpError(400, 'url is not valid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError(400, 'url must be http or https');
    if (isBlockedHost(url.hostname)) throw httpError(400, 'url host is not allowed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url.href, { signal: controller.signal, redirect: 'error' });
    } catch (error) {
      throw httpError(502, `could not fetch url: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) throw httpError(502, `url returned ${response?.status ?? 'no response'}`);
    const declared = Number(response.headers?.get?.('content-length') ?? 0);
    if (declared > maxBytes) throw httpError(413, `CSV is larger than ${maxBytes} bytes`);
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw httpError(413, `CSV is larger than ${maxBytes} bytes`);
    return parseBody(text, { ...body, sourceUrl: body.sourceUrl ?? url.href, retrievedAt: body.retrievedAt ?? now() });
  }
  throw httpError(400, 'csv or url is required');
}
