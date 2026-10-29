import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { safeMediaFile } from './media-route.mjs';
import { MAX_FONT_BYTES, validateSuppliedTtf } from './supplied-font.mjs';

// Only a font explicitly declared by this package can be read. The app's
// normal token authentication runs before this handler; query tokens are not
// accepted here, since browser previews fetch bytes with an auth header.
export function handlePackageFont({ request, response, url, sendJson, store }) {
  const match = /^\/api\/package\/([^/]+)\/font$/.exec(url.pathname);
  if (!match) return false;
  if (!request.headers['x-comfyrizz-token'] && !request.headers.authorization) {
    sendJson(response, 401, { error: 'use header authentication' }); return true;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'method not allowed' }); return true;
  }
  try {
    const id = decodeURIComponent(match[1]);
    const root = dirname(store.path(id));
    const pkg = store.read(id);
    const path = url.searchParams.get('path') ?? '';
    const candidate = safeMediaFile(root, path);
    if (!pkg || !candidate || extname(path).toLowerCase() !== '.ttf'
      || !Array.isArray(pkg.theme?.fonts) || !pkg.theme.fonts.some(font => font?.file === path)) {
      sendJson(response, 404, { error: 'font not found' }); return true;
    }
    const stat = lstatSync(candidate);
    const realRoot = realpathSync(root);
    const realFile = realpathSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FONT_BYTES
      || !realFile.startsWith(resolve(realRoot) + sep)) throw new Error('unsafe font');
    const bytes = readFileSync(realFile);
    validateSuppliedTtf(bytes);
    response.writeHead(200, { 'content-type': 'font/ttf', 'content-length': bytes.length, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    sendJson(response, 404, { error: 'font not found' });
  }
  return true;
}
